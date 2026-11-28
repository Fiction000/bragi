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
      const output = { findings: [
        { finding_id: 'finding-1', section_id: sectionId, base_revision: sectionSha, anchor: { quote, occurrence: 1 }, category: 'auto', rationale: '一文を短くします。', proposal: quote === 'First sentence is unclear.' ? 'First sentence is clearer.' : 'Second section stays as written.', decision_required: false, source_refs: [] },
        { finding_id: 'finding-2', section_id: sectionId, base_revision: sectionSha, anchor: { quote, occurrence: 1 }, category: 'decision', rationale: '判断の根拠を確認します。', proposal: 'A verified alternative.', decision_required: true, source_refs: [] },
        { finding_id: 'finding-3', section_id: sectionId, base_revision: sectionSha, anchor: { quote, occurrence: 1 }, category: 'decision', rationale: '別の観点も確認します。', proposal: 'Another verified alternative.', decision_required: true, source_refs: [] },
      ] };
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
    await expect(page.getByRole('heading', { name: '② 判断が必要' })).toBeVisible();
    await expect(page.getByRole('heading', { name: '③ 判断が必要' })).toBeVisible();
    const badges = page.locator('.review-anchor-widget');
    await expect(badges).toHaveCount(3);
    await expect(badges.nth(0)).toHaveText('①');
    await expect(badges.nth(1)).toHaveText('②');
    await expect(badges.nth(2)).toHaveText('③');
    await page.getByRole('button', { name: '話す' }).first().click();
    await page.locator('#review-message').fill('Please verify the alternatives.');
    await page.getByRole('button', { name: '送る' }).click();
    await expect(page.locator('.review-answer textarea')).toHaveCount(2);
    await page.locator('.review-answer textarea').nth(0).fill('First answer');
    await expect(page.locator('.review-answer textarea').nth(1)).toHaveValue('');
    const overflowAt = () => page.evaluate(() => [...document.querySelectorAll('.review-layout,.editor-shell,.notes-layer,.review-panel,.ProseMirror,.review-finding')].filter(element => { const rect = element.getBoundingClientRect(); return element.scrollWidth > element.clientWidth + 1 || rect.left < -1 || rect.right > innerWidth + 1; }).map(element => ({ className: (element as HTMLElement).className, left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right, clientWidth: element.clientWidth, scrollWidth: element.scrollWidth })));
    await page.screenshot({ path: path.join(evidence, 'review-agent-1440-active.png'), fullPage: true });
    expect(await overflowAt()).toEqual([]);
    await page.setViewportSize({ width: 820, height: 900 });
    const activeCompact = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, viewport: innerWidth, panel: document.querySelector('.review-panel')!.getBoundingClientRect().width, columns: getComputedStyle(document.querySelector('.review-layout')!).gridTemplateColumns.split(' ').length }));
    expect(activeCompact.width).toBeLessThanOrEqual(activeCompact.viewport); expect(activeCompact.panel).toBeGreaterThan(0); expect(activeCompact.columns).toBe(2);
    expect(await overflowAt()).toEqual([]);
    await page.screenshot({ path: path.join(evidence, 'review-agent-820-active.png'), fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    let releaseApply!: () => void;
    const applyGate = new Promise<void>(resolve => { releaseApply = resolve; });
    await page.route('**/api/reviews/*/apply?*', async route => { await applyGate; await route.continue(); });
    await page.getByRole('button', { name: '採る' }).first().click();
    await expect(page.getByRole('combobox', { name: 'レビューする節' })).toBeDisabled();
    await expect(page.getByRole('button', { name: '採る' }).first()).toBeDisabled();
    await expect(page.locator('.ProseMirror')).toHaveAttribute('contenteditable', 'false');
    releaseApply();
    await expect(page.locator('.ProseMirror')).toContainText('First sentence is clearer.');
    await page.unroute('**/api/reviews/*/apply?*');

    await page.getByRole('combobox', { name: 'レビューする節' }).selectOption({ label: '2. ## Second' });
    await page.getByRole('button', { name: 'この節をレビュー' }).click();
    await expect(page.getByText('Second section stays as written.')).toBeVisible();
    let draft = await (await api(`/api/drafts/${targetId}`)).json();
    const firstSection = reviewSections(draft.state.markdown)[0];
    const differentSectionEdit = draft.state.markdown.replace('First sentence is clearer.', 'First sentence changed elsewhere.');
    await api(`/api/drafts/${targetId}`, { method: 'PUT', body: json({ baseRevision: draft.revision, state: { ...draft.state, markdown: differentSectionEdit } }) });
    await page.getByRole('button', { name: '採る' }).first().click();
    await expect(page.locator('.ProseMirror')).toContainText('Second section stays as written.');
    draft = await (await api(`/api/drafts/${targetId}`)).json();
    expect(draft.state.markdown).toContain('Second section stays as written.');
    expect(firstSection.content).toContain('First sentence is clearer.');

    await page.reload();
    await page.getByRole('button', { name: '最新版で再レビュー' }).click();
    await expect(page.locator('.review-current').first()).toHaveText('現在: First sentence changed elsewhere.');
    draft = await (await api(`/api/drafts/${targetId}`)).json();
    const changed = draft.state.markdown.replace('First sentence changed elsewhere.', 'First sentence changed again.');
    await api(`/api/drafts/${targetId}`, { method: 'PUT', body: json({ baseRevision: draft.revision, state: { ...draft.state, markdown: changed } }) });
    await page.reload();
    await expect(page.getByText('節が更新されています')).toBeVisible();
    await expect(page.locator('#review-message')).toHaveCount(0);
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

test('a delayed apply response cannot replace the newly selected draft', async ({ page }) => {
  const oldUrl = process.env.BRAGI_HERMES_API_URL, oldKey = process.env.BRAGI_HERMES_API_KEY;
  const runs = new Map<string, string>();
  let count = 0;
  const hermes = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk as Buffer);
    if (req.method === 'POST' && req.url === '/v1/runs') {
      const id = `switch-run-${++count}`; runs.set(id, JSON.parse(Buffer.concat(chunks).toString()).input);
      res.writeHead(202, { 'content-type': 'application/json' }); res.end(json({ run_id: id, status: 'queued' })); return;
    }
    const match = req.url?.match(/^\/v1\/runs\/(switch-run-\d+)$/);
    if (req.method === 'GET' && match) {
      const input = runs.get(match[1])!;
      const sectionId = input.match(/section_id=(s-[a-f0-9]+)/)![1]; const sectionSha = input.match(/section_sha=([a-f0-9]{64})/)![1];
      const output = { findings: [{ finding_id: 'finding-1', section_id: sectionId, base_revision: sectionSha, anchor: { quote: 'Opening text.', occurrence: 1 }, category: 'auto', rationale: 'Clarify the sentence.', proposal: 'Applied wording.', decision_required: false, source_refs: [] }] };
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(json({ run_id: match[1], status: 'completed', output: json(output) })); return;
    }
    res.writeHead(404); res.end();
  });
  const hermesPort = await listen(hermes);
  process.env.BRAGI_HERMES_API_URL = `http://127.0.0.1:${hermesPort}`; process.env.BRAGI_HERMES_API_KEY = FAKE_KEY;
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'wle-review-switch-')); const runDir = path.join(tmp, 'run'); await cp(fixture, runDir, { recursive: true });
  const targetFile = path.join(runDir, 'editor-targets.json');
  const listing = JSON.parse(await readFile(targetFile, 'utf8'));
  listing.targets = [
    { id: 'first', title: 'First', medium: 'Synthetic', version: 'test', source: '05_final/first.md' },
    { id: 'second', title: 'Second', medium: 'Synthetic', version: 'test', source: '05_final/second.md' },
  ];
  await writeFile(targetFile, json(listing));
  await writeFile(path.join(runDir, '05_final/first.md'), 'Opening text.\n');
  await writeFile(path.join(runDir, '05_final/second.md'), 'Second draft remains.\n\n<!-- preserve this note -->\n');
  const server = await createEditorServer({ run: runDir, port: 0 }); const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    await page.goto(origin);
    await expect(page.getByRole('combobox', { name: 'レビューする節' })).toBeVisible();
    await expect(page.locator('.ProseMirror')).toHaveAttribute('contenteditable', 'true');
    await page.getByRole('button', { name: 'この節をレビュー' }).click();
    await expect(page.getByText('Clarify the sentence.')).toBeVisible();
    let releaseApply!: () => void;
    let resolveApplyReceived!: () => void;
    const applyGate = new Promise<void>(resolve => { releaseApply = resolve; });
    const applyReceived = new Promise<void>(resolve => { resolveApplyReceived = resolve; });
    await page.route('**/api/reviews/*/apply?*', async route => { const response = await route.fetch(); resolveApplyReceived(); await applyGate; await route.fulfill({ response }); });
    await page.getByRole('button', { name: '採る' }).click();
    await applyReceived;
    await page.getByRole('button', { name: 'First ／ Synthetic・test' }).click();
    await page.getByRole('button', { name: 'Second Synthetic・test' }).click();
    await expect(page.locator('.ProseMirror')).toContainText('Second draft remains.');
    await expect(page.locator('.ProseMirror')).toHaveAttribute('contenteditable', 'false');
    const appliedResponse = page.waitForResponse(response => response.url().includes('/apply') && response.status() === 200);
    releaseApply();
    await appliedResponse;
    await expect(page.locator('.ProseMirror')).toContainText('Second draft remains.');
    await expect(page.locator('.ProseMirror')).toHaveAttribute('contenteditable', 'false');
    const secondDraft = await (await page.request.get(`${origin}/api/drafts/second`)).json();
    expect(secondDraft.state.markdown).toBe('Second draft remains.\n\n<!-- preserve this note -->\n');
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve())); await new Promise<void>(resolve => hermes.close(() => resolve())); await rm(tmp, { recursive: true, force: true });
    if (oldUrl === undefined) delete process.env.BRAGI_HERMES_API_URL; else process.env.BRAGI_HERMES_API_URL = oldUrl;
    if (oldKey === undefined) delete process.env.BRAGI_HERMES_API_KEY; else process.env.BRAGI_HERMES_API_KEY = oldKey;
  }
});
