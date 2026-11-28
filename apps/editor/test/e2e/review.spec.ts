import { test, expect } from '@playwright/test';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createEditorServer } from '../../server.mjs';
import { reviewSections } from '../../review.mjs';

const FAKE_KEY = 'e2e-fake-key';

const fixture = path.resolve('test/fixtures/run');
const json = value => JSON.stringify(value);
const listen = server => new Promise<number>(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as any).port)));

test('review with agent stays section-scoped, applies valid findings, shows stale proposals, and fits 1440/820px', async ({ page }) => {
  const oldUrl = process.env.BRAGI_HERMES_API_URL, oldKey = process.env.BRAGI_HERMES_API_KEY;
  const runs = new Map<string, { input: string; reads: number }>();
  let count = 0;
  const hermes = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk as Buffer);
    if (req.method === 'POST' && req.url === '/v1/runs') {
      const body = JSON.parse(Buffer.concat(chunks).toString()); const id = `e2e-run-${++count}`; runs.set(id, { input: body.input, reads: 0 });
      res.writeHead(202, { 'content-type': 'application/json' }); res.end(json({ run_id: id, status: 'queued' })); return;
    }
    const match = req.url?.match(/^\/v1\/runs\/(e2e-run-\d+)$/);
    if (req.method === 'GET' && match) {
      const run = runs.get(match[1])!; run.reads++;
      const sectionId = run.input.match(/section_id=(s-[a-f0-9]+)/)![1]; const sectionSha = run.input.match(/section_sha=([a-f0-9]{64})/)![1];
      const quote = run.input.includes('First sentence is unclear.') ? 'First sentence is unclear.' : run.input.includes('First sentence is clearer.') ? 'First sentence is clearer.' : run.input.includes('First sentence changed elsewhere.') ? 'First sentence changed elsewhere.' : 'Second section remains untouched.';
      const output = { findings: [{ finding_id: 'finding-1', section_id: sectionId, base_revision: sectionSha, anchor: { quote, occurrence: 1 }, category: 'auto', rationale: '一文を短くします。', proposal: quote === 'First sentence is unclear.' ? 'First sentence is clearer.' : 'Second section stays as written.', decision_required: false, source_refs: [] }] };
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(json({ run_id: match[1], status: run.reads > 1 ? 'completed' : 'running', ...(run.reads > 1 ? { output: json(output) } : {}) })); return;
    }
    if (req.method === 'GET' && req.url?.includes('/events')) { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(''); return; }
    res.writeHead(404); res.end();
  });
  const hermesPort = await listen(hermes);
  process.env.BRAGI_HERMES_API_URL = `http://127.0.0.1:${hermesPort}`; process.env.BRAGI_HERMES_API_KEY = FAKE_KEY;
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'wle-review-e2e-')); const runDir = path.join(tmp, 'run'); await cp(fixture, runDir, { recursive: true });
  const targetFile = path.join(runDir, 'editor-targets.json');
  const listing = JSON.parse(await readFile(targetFile, 'utf8')); const targetId = 'review-sample';
  listing.targets = [{ id: targetId, title: 'Review sample', medium: 'Synthetic', version: 'test', source: '05_final/review-sample.md' }];
  await writeFile(targetFile, json(listing));
  await writeFile(path.join(runDir, '05_final/review-sample.md'), '# Review sample\n\nFirst sentence is unclear.\n\n## Second\nSecond section remains untouched.\n');
  const server = await createEditorServer({ run: runDir, port: 0 }); const origin = `http://127.0.0.1:${server.address().port}`;
  const api = (url: string, init: RequestInit = {}) => fetch(origin + url, { ...init, headers: { ...(init.body ? { 'content-type': 'application/json', origin } : {}), ...init.headers } });
  const evidence = process.env.WLE_EVIDENCE_DIR ?? path.resolve('test-results/review-evidence'); await mkdir(evidence, { recursive: true });
  try {
    await page.setViewportSize({ width: 1440, height: 1000 }); await page.goto(origin);
    await expect(page.getByRole('combobox', { name: 'レビューする節' })).toBeVisible();
    await page.getByRole('button', { name: 'この節をレビュー' }).click();
    await expect(page.getByText('レビューを生成中')).toBeVisible();
    await expect(page.getByText('一文を短くします。')).toBeVisible();
    await expect(page.getByRole('heading', { name: '① 修正案' })).toBeVisible();
    await expect(page.locator('.review-anchor-widget')).toHaveText('①');
    const overflowAt = () => page.evaluate(() => [...document.querySelectorAll('.review-layout,.editor-shell,.notes-layer,.review-panel,.ProseMirror,.review-finding')].filter(element => { const rect = element.getBoundingClientRect(); return element.scrollWidth > element.clientWidth + 1 || rect.left < -1 || rect.right > innerWidth + 1; }).map(element => ({ className: (element as HTMLElement).className, left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right, clientWidth: element.clientWidth, scrollWidth: element.scrollWidth })));
    await page.screenshot({ path: path.join(evidence, 'review-agent-1440-active.png'), fullPage: true });
    expect(await overflowAt()).toEqual([]);
    await page.setViewportSize({ width: 820, height: 900 });
    const activeCompact = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, viewport: innerWidth, panel: document.querySelector('.review-panel')!.getBoundingClientRect().width, columns: getComputedStyle(document.querySelector('.review-layout')!).gridTemplateColumns.split(' ').length }));
    expect(activeCompact.width).toBeLessThanOrEqual(activeCompact.viewport); expect(activeCompact.panel).toBeGreaterThan(0); expect(activeCompact.columns).toBe(2);
    expect(await overflowAt()).toEqual([]);
    await page.screenshot({ path: path.join(evidence, 'review-agent-820-active.png'), fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole('button', { name: '採る' }).click();
    await expect(page.locator('.ProseMirror')).toContainText('First sentence is clearer.');

    await page.getByRole('combobox', { name: 'レビューする節' }).selectOption({ label: '2. ## Second' });
    await page.getByRole('button', { name: 'この節をレビュー' }).click();
    await expect(page.getByText('Second section stays as written.')).toBeVisible();
    let draft = await (await api(`/api/drafts/${targetId}`)).json();
    const firstSection = reviewSections(draft.state.markdown)[0];
    const differentSectionEdit = draft.state.markdown.replace('First sentence is clearer.', 'First sentence changed elsewhere.');
    await api(`/api/drafts/${targetId}`, { method: 'PUT', body: json({ baseRevision: draft.revision, state: { ...draft.state, markdown: differentSectionEdit } }) });
    await page.getByRole('button', { name: '採る' }).click();
    await expect(page.locator('.ProseMirror')).toContainText('Second section stays as written.');
    draft = await (await api(`/api/drafts/${targetId}`)).json();
    expect(draft.state.markdown).toContain('Second section stays as written.');
    expect(firstSection.content).toContain('First sentence is clearer.');

    await page.reload();
    await page.getByRole('button', { name: '最新版で再レビュー' }).click();
    await expect(page.getByText('First sentence is clearer.')).toBeVisible();
    draft = await (await api(`/api/drafts/${targetId}`)).json();
    const changed = draft.state.markdown.replace('First sentence changed elsewhere.', 'First sentence changed again.');
    await api(`/api/drafts/${targetId}`, { method: 'PUT', body: json({ baseRevision: draft.revision, state: { ...draft.state, markdown: changed } }) });
    await page.reload();
    await expect(page.getByText('節が更新されています')).toBeVisible();
    await expect(page.locator('.review-anchor-widget')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '最新版で再レビュー' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'この案を捨てる' })).toBeVisible();
    await page.screenshot({ path: path.join(evidence, 'review-agent-1440-stale.png'), fullPage: true });
    const desktop = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, viewport: innerWidth })); expect(desktop.width).toBeLessThanOrEqual(desktop.viewport);
    expect(await overflowAt()).toEqual([]);
    await page.setViewportSize({ width: 820, height: 900 });
    const compact = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, viewport: innerWidth, panel: document.querySelector('.review-panel')!.getBoundingClientRect().width, columns: getComputedStyle(document.querySelector('.review-layout')!).gridTemplateColumns.split(' ').length }));
    expect(compact.width).toBeLessThanOrEqual(compact.viewport); expect(compact.panel).toBeGreaterThan(0); expect(compact.columns).toBe(2);
    expect(await overflowAt()).toEqual([]);
    await page.screenshot({ path: path.join(evidence, 'review-agent-820.png'), fullPage: true });
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve())); await new Promise<void>(resolve => hermes.close(() => resolve())); await rm(tmp, { recursive: true, force: true });
    if (oldUrl === undefined) delete process.env.BRAGI_HERMES_API_URL; else process.env.BRAGI_HERMES_API_URL = oldUrl;
    if (oldKey === undefined) delete process.env.BRAGI_HERMES_API_KEY; else process.env.BRAGI_HERMES_API_KEY = oldKey;
  }
});
