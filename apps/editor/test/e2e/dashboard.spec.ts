import { test, expect } from '@playwright/test';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { createEditorServer } from '../../server.mjs';
process.env.BRAGI_TASK_IDS = String.raw`\bTASK-\d+\b|||\bjob_[0-9a-f]{8}\b`;

const EVIDENCE = process.env.WLE_EVIDENCE_DIR ?? path.resolve('test-results/evidence');
const fixture = path.resolve('../../packages/core/test/fixtures/drafts');
const infos = (list: Record<string, unknown>[]) => async () => ({ 'example/site': list });
const fakeGithub = infos([
  { url: 'https://github.com/example/site/pull/7', number: 7, state: 'open', repo: 'example/site' },
  { url: 'https://github.com/example/site/pull/8', number: 8, state: 'merged', repo: 'example/site' },
]);
let server: any, tmp: string, origin: string;

test.beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'wle-dash-e2e-'));
  await cp(fixture, path.join(tmp, 'drafts'), { recursive: true });
  server = await createEditorServer({ draftsRoot: path.join(tmp, 'drafts'), port: 0, github: fakeGithub, taskNotesDir: path.resolve('../../packages/core/test/fixtures/tasknotes') });
  origin = `http://127.0.0.1:${server.address().port}`;
});
test.afterEach(async () => { await new Promise(r => server.close(r)); await rm(tmp, { recursive: true, force: true }); });

test('20 the home screen is a read-only list, one row per article, and sends no write request', async ({ page }) => {
  const writes: string[] = [];
  page.on('request', r => { if (r.method() !== 'GET') writes.push(`${r.method()} ${r.url()}`); });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(origin);
  await expect(page.getByRole('heading', { name: '下書きの一覧' })).toBeVisible();
  await expect(page.getByRole('columnheader')).toHaveText(['題名', '媒体', '段階', '待ち先', '未決', '期限', 'PR', '開く']);
  const rows = page.locator('tbody tr[data-slug]');
  await expect(rows).toHaveCount(8);
  const publishedToggle = page.getByLabel('公開済みも表示');
  await expect(publishedToggle).not.toBeChecked();
  await expect(stageRow(page, 'override-sample')).toHaveCount(0);
  const initiallyVisible = await rows.evaluateAll(items => items.map(item => item.getAttribute('data-slug')));
  await publishedToggle.check();
  await expect(rows).toHaveCount(9);
  await expect(stageRow(page, 'override-sample')).toBeVisible();
  const allSlugs = await rows.evaluateAll(items => items.map(item => item.getAttribute('data-slug')));
  expect(allSlugs.filter(slug => slug !== 'override-sample')).toEqual(initiallyVisible);
  await publishedToggle.uncheck();
  await expect(rows).toHaveCount(8);
  expect(await rows.evaluateAll(items => items.map(item => item.getAttribute('data-slug')))).toEqual(initiallyVisible);
  await publishedToggle.check();
  await expect(stageRow(page, 'override-sample')).toBeVisible();
  await page.reload();
  await expect(publishedToggle).not.toBeChecked();
  await expect(rows).toHaveCount(8);
  await expect(stageRow(page, 'override-sample')).toHaveCount(0);
  // The stages the files say, for the three kinds of synthetic run and the rest.
  const stage = (slug: string) => page.locator(`tr[data-slug="${slug}"]`);
  await expect(stage('writing-sample').locator('td').nth(2)).toHaveText('執筆中');
  await expect(stage('deciding-sample').locator('td').nth(2)).toHaveText('著者判断待ち');
  await expect(stage('deciding-sample').locator('td').nth(4)).toHaveText('3');
  await expect(stage('editing-sample').locator('td').nth(2)).toHaveText('著者確定待ち');
  await expect(stage('placeholder-sample').locator('td').nth(4)).toHaveText('1');
  await expect(stage('deciding-sample').locator('td').nth(5)).toHaveText('2026-12-05');
  await expect(stage('confirmed-sample').locator('td').nth(2)).toHaveText('PR不明');
  await expect(stage('pr-sample').locator('td').nth(2)).toHaveText('ゲート/CI');
  await publishedToggle.check();
  await expect(stage('override-sample').locator('td').nth(2)).toContainText('公開済み');
  await expect(stage('override-sample').locator('td').nth(5)).toHaveText('2026-12-01');
  await publishedToggle.uncheck();
  await expect(stage('pr-sample').getByRole('link', { name: /#7 open/ })).toHaveAttribute('href', 'https://github.com/example/site/pull/7');
  // 著者待ち is on top.
  await expect(rows.first()).toHaveAttribute('data-waiting', 'author');
  await page.waitForTimeout(500);
  expect(writes).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByLabel('公開済みも表示')).toBeVisible();
  await mkdir(EVIDENCE, { recursive: true });
  await page.screenshot({ path: path.join(EVIDENCE, 'dashboard-synthetic-mobile.png'), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.screenshot({ path: path.join(EVIDENCE, 'dashboard-synthetic.png'), fullPage: true });
});

test('20b empty states distinguish no drafts from all-published drafts', async ({ page }) => {
  await page.route('**/api/dashboard', async route => {
    const response = await route.fetch();
    const data = await response.json();
    data.drafts = data.drafts.filter((draft: { stage: string }) => draft.stage === 'published');
    await route.fulfill({ response, json: data });
  });
  await page.goto(origin);
  await expect(page.getByText('未公開の下書きはありません。')).toBeVisible();
  await expect(page.getByText(/に記事のフォルダがありません。/)).toHaveCount(0);
  const toggle = page.getByLabel('公開済みも表示');
  await toggle.check();
  await expect(page.locator('tbody tr[data-slug]')).toHaveCount(1);
  await expect(page.getByText('未公開の下書きはありません。')).toHaveCount(0);

  await page.unroute('**/api/dashboard');
  await page.route('**/api/dashboard', async route => {
    const response = await route.fetch();
    const data = await response.json();
    data.drafts = [];
    await route.fulfill({ response, json: data });
  });
  await page.reload();
  await expect(page.getByText(/に記事のフォルダがありません。/)).toBeVisible();
  await expect(page.getByText('未公開の下書きはありません。')).toHaveCount(0);
});

test('21 開く opens the run in the existing editor under /r/<key>/, and 一覧へ comes back', async ({ page }) => {
  await page.goto(origin);
  await expect(stageRow(page, 'editing-sample')).toBeVisible();
  await stageRow(page, 'editing-sample').getByRole('link', { name: '開く' }).click();
  await expect(page).toHaveURL(/\/r\/[A-Za-z0-9_-]+\/$/);
  await expect(page.locator('.ProseMirror')).toBeVisible();
  await expect(page.locator('.ProseMirror')).toContainText('合成データ');
  // Opening a run reads only; the first request that writes is the person's own edit.
  await page.getByRole('link', { name: '一覧へ' }).click();
  await expect(page.getByRole('heading', { name: '下書きの一覧' })).toBeVisible();
  // An article with no editor run has nothing to open.
  await expect(stageRow(page, 'writing-sample').getByRole('link', { name: '開く' })).toHaveCount(0);
});

test('switching runs from the list displays and saves only the selected run', async ({ page }) => {
  const makeRun = async (slug: string, title: string, body: string) => {
    const dir = path.join(tmp, 'drafts', slug, 'editor-run');
    await mkdir(path.join(dir, '05_final', 'editor', 'shared-v1'), { recursive: true });
    await writeFile(path.join(dir, 'editor-targets.json'), JSON.stringify({ targets: [{ id: 'shared-v1', title, medium: 'Test', version: 'review', source: '05_final/article.md' }] }));
    await writeFile(path.join(dir, '05_final', 'article.md'), `${title} source\n`);
    const working = path.join(dir, '05_final', 'editor', 'shared-v1', 'nat-final.md');
    await writeFile(working, body);
    await writeFile(path.join(dir, '05_final', 'editor', 'shared-v1', 'nat-notes.json'), '[]\n');
    return working;
  };
  const aPath = await makeRun('run-a', 'Run A', 'RUN A ARTICLE ONLY\n');
  const bPath = await makeRun('run-b', 'Run B', 'RUN B ARTICLE ONLY\n');
  const sha = (value: Buffer) => createHash('sha256').update(value).digest('hex');
  const aBefore = await readFile(aPath);
  const bBefore = await readFile(bPath);

  await page.goto(origin);
  await expect(stageRow(page, 'run-a')).toBeVisible();
  await stageRow(page, 'run-a').getByRole('link', { name: '開く' }).click();
  await expect(page.locator('.ProseMirror')).toContainText('RUN A ARTICLE ONLY');
  await page.getByRole('link', { name: '一覧へ' }).click();
  await expect(page.getByRole('heading', { name: '下書きの一覧' })).toBeVisible();
  await expect(page.locator('.app')).toHaveCount(0);
  await stageRow(page, 'run-b').getByRole('link', { name: '開く' }).click();
  await expect(page.locator('.ProseMirror')).toBeVisible();
  const displayedB = await page.locator('.ProseMirror').innerText();

  const saveResponse = page.waitForResponse(response => response.request().method() === 'PUT' && new URL(response.url()).pathname.endsWith('/api/drafts/shared-v1'));
  await page.locator('.ProseMirror p').first().click();
  await page.keyboard.press('End');
  await page.keyboard.insertText(' B EDITED');
  const response = await saveResponse;
  const aAfter = await readFile(aPath);
  const bAfter = await readFile(bPath);
  expect({
    displayedB: displayedB.includes('RUN B ARTICLE ONLY'),
    saveStatus: response.status(),
    aShaUnchanged: sha(aAfter) === sha(aBefore),
    bShaChanged: sha(bAfter) !== sha(bBefore),
    savedBContainsB: bAfter.toString().includes('RUN B ARTICLE ONLY'),
    savedBContainsEdit: bAfter.toString().includes('B EDITED'),
  }).toEqual({ displayedB: true, saveStatus: 200, aShaUnchanged: true, bShaChanged: true, savedBContainsB: true, savedBContainsEdit: true });
});

test('browser back from the list restores the prior editor run and its save target', async ({ page }) => {
  const makeRun = async (slug: string, title: string, body: string) => {
    const dir = path.join(tmp, 'drafts', slug, 'editor-run');
    await mkdir(path.join(dir, '05_final', 'editor', 'shared-v1'), { recursive: true });
    await writeFile(path.join(dir, 'editor-targets.json'), JSON.stringify({ targets: [{ id: 'shared-v1', title, medium: 'Test', version: 'review', source: '05_final/article.md' }] }));
    await writeFile(path.join(dir, '05_final', 'article.md'), `${title} source\n`);
    const working = path.join(dir, '05_final', 'editor', 'shared-v1', 'nat-final.md');
    await writeFile(working, body);
    await writeFile(path.join(dir, '05_final', 'editor', 'shared-v1', 'nat-notes.json'), '[]\n');
    return working;
  };
  const aPath = await makeRun('run-a', 'Run A', 'RUN A ARTICLE ONLY\n');
  const bPath = await makeRun('run-b', 'Run B', 'RUN B ARTICLE ONLY\n');
  const sha = (value: Buffer) => createHash('sha256').update(value).digest('hex');
  const aBefore = await readFile(aPath);
  const bBefore = await readFile(bPath);

  await page.goto(origin);
  await stageRow(page, 'run-a').getByRole('link', { name: '開く' }).click();
  await expect(page.locator('.ProseMirror')).toContainText('RUN A ARTICLE ONLY');
  await page.getByRole('link', { name: '一覧へ' }).click();
  await expect(page.getByRole('heading', { name: '下書きの一覧' })).toBeVisible();
  await stageRow(page, 'run-b').getByRole('link', { name: '開く' }).click();
  await expect(page.locator('.ProseMirror')).toContainText('RUN B ARTICLE ONLY');
  await page.getByRole('link', { name: '一覧へ' }).click();
  await expect(page.getByRole('heading', { name: '下書きの一覧' })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/r\/[A-Za-z0-9_-]+\/$/);
  await expect(page.locator('.ProseMirror')).toContainText('RUN B ARTICLE ONLY');

  const saveResponse = page.waitForResponse(response => response.request().method() === 'PUT' && new URL(response.url()).pathname.endsWith('/api/drafts/shared-v1'));
  await page.locator('.ProseMirror p').first().click();
  await page.keyboard.press('End');
  await page.keyboard.insertText(' B POPSTATE EDITED');
  const response = await saveResponse;
  const aAfter = await readFile(aPath);
  const bAfter = await readFile(bPath);
  expect({
    displayedB: await page.locator('.ProseMirror').innerText().then(text => text.includes('RUN B ARTICLE ONLY')),
    saveStatus: response.status(),
    aShaUnchanged: sha(aAfter) === sha(aBefore),
    bShaChanged: sha(bAfter) !== sha(bBefore),
    savedBContainsEdit: bAfter.toString().includes('B POPSTATE EDITED'),
  }).toEqual({ displayedB: true, saveStatus: 200, aShaUnchanged: true, bShaChanged: true, savedBContainsEdit: true });
});

test('direct editor URL returns to the list when clicking 一覧へ', async ({ page }) => {
  await page.goto(origin);
  const href = await stageRow(page, 'editing-sample').getByRole('link', { name: '開く' }).getAttribute('href');
  expect(href).toMatch(/^\/r\/[A-Za-z0-9_-]+\/$/);
  await page.goto(`${origin}${href}`);
  await expect(page.locator('.ProseMirror')).toContainText('合成データ');
  await page.getByRole('link', { name: '一覧へ' }).click();
  await expect(page.getByRole('heading', { name: '下書きの一覧' })).toBeVisible();
});

test('22 --run alone still opens the editor at /', async ({ page }) => {
  await new Promise(r => server.close(r));
  server = await createEditorServer({ run: path.resolve('test/fixtures/run'), port: 0 });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await expect(page.locator('.ProseMirror')).toBeVisible();
  await expect(page.getByRole('link', { name: '一覧へ' })).toHaveCount(0);
});

const stageRow = (page: import('@playwright/test').Page, slug: string) => page.locator(`tr[data-slug="${slug}"]`);

test('23 判断台帳: the list shows the decisions, 取り消す asks first, and retiring keeps the file and marks it', async ({ page }) => {
  const { createDecision } = await import('@wle/core');
  const led = await mkdtemp(path.join(os.tmpdir(), 'wle-led-e2e-'));
  const base = { scope: 'medium' as const, medium: '合成の媒体', kind: 'fact-policy' as const, status: 'active' as const, decided_by: '著者', decided_at: '2026-11-16', source: 'synthetic#Q02' };
  await createDecision(led, { ...base, id: 'D-2026-11-16-syn-q02', body: '合成：確認表にない心情は書かない。\n\n**なぜ**：合成の理由。<img src=x onerror="window.__xss=1"> `code`' });
  await createDecision(led, { ...base, id: 'D-2026-11-16-syn-q03', scope: 'draft', medium: null, draft: 'writing-sample', kind: 'fact', body: '合成：この記事だけの判断。' });
  await new Promise(r => server.close(r));
  server = await createEditorServer({ draftsRoot: path.join(tmp, 'drafts'), port: 0, github: fakeGithub, taskNotesDir: null, ledgerDir: led });
  origin = `http://127.0.0.1:${server.address().port}`;
  try {
    await page.setViewportSize({ width: 1100, height: 700 });
    await page.goto(origin);
    await page.getByRole('link', { name: '判断台帳' }).click();
    await expect(page.getByRole('heading', { name: '判断台帳' })).toBeVisible();
    const row = (id: string) => page.locator(`tr[data-id="${id}"]`);
    await expect(page.locator('tbody tr')).toHaveCount(2);
    // The body is shown as Markdown: bold is bold, markers are gone, and HTML in a file stays text.
    await expect(row('D-2026-11-16-syn-q02').locator('strong')).toHaveText('なぜ');
    await expect(row('D-2026-11-16-syn-q02').locator('.ledger-body')).not.toContainText('**');
    await expect(row('D-2026-11-16-syn-q02').locator('.ledger-body img')).toHaveCount(0);
    await expect(row('D-2026-11-16-syn-q02').locator('.ledger-body')).toContainText('<img src=x');
    expect(await page.evaluate(() => (window as any).__xss)).toBeUndefined();
    // The date and the button each stay on one line.
    const height = (sel: string) => row('D-2026-11-16-syn-q02').locator(sel).first().evaluate(e => e.getBoundingClientRect().height);
    expect(await row('D-2026-11-16-syn-q02').locator('td').nth(3).evaluate(e => getComputedStyle(e).whiteSpace)).toBe('nowrap');
    expect(await height('button.retire')).toBeLessThan(36);
    await expect(row('D-2026-11-16-syn-q02')).toContainText('媒体');
    await expect(row('D-2026-11-16-syn-q03')).toContainText('記事');
    // Dismissing the confirmation changes nothing.
    page.once('dialog', d => d.dismiss());
    await row('D-2026-11-16-syn-q02').getByRole('button', { name: '取り消す' }).click();
    await expect(page.locator('tbody tr')).toHaveCount(2);
    expect(await readFile(path.join(led, 'D-2026-11-16-syn-q02.md'), 'utf8')).toContain('status: active');
    page.once('dialog', d => d.accept());
    await row('D-2026-11-16-syn-q02').getByRole('button', { name: '取り消す' }).click();
    await expect(page.locator('tbody tr')).toHaveCount(1);
    await page.getByLabel('取り消し済みも表示').check();
    await expect(row('D-2026-11-16-syn-q02')).toContainText('取り消し済み');
    expect(await readFile(path.join(led, 'D-2026-11-16-syn-q02.md'), 'utf8')).toContain('status: retired');
    await mkdir(EVIDENCE, { recursive: true });
    await page.screenshot({ path: path.join(EVIDENCE, 'ledger-synthetic.png') });
  } finally { await rm(led, { recursive: true, force: true }); }
});

test('24 判断の候補: the list shows pending proposals, 採る asks first and writes one ledger decision, 捨てる keeps the file as rejected', async ({ page }) => {
  const { proposeDecision } = await import('@wle/core');
  const base = await mkdtemp(path.join(os.tmpdir(), 'wle-prop-e2e-'));
  const led = path.join(base, 'ledger'), prop = path.join(base, 'proposals');
  const mk = (slug: string, body: string, over = {}) => proposeDecision(prop, led, { slug, proposed_by: 'e2e-agent', draft: 'writing-sample', kind: 'fact', source: 'synthetic#Q01', body, ...over }, '2026-11-21');
  await mk('adopt-me', '合成：確認表にない心情は書かない。\n\n**なぜ**：合成の理由。<img src=x onerror="window.__xss=1"> `code`');
  await mk('reject-me', '合成：捨てる候補。', { scope: 'medium', draft: null, medium: '合成の媒体', kind: 'phrasing' });
  await new Promise(r => server.close(r));
  server = await createEditorServer({ draftsRoot: path.join(tmp, 'drafts'), port: 0, github: fakeGithub, taskNotesDir: null, ledgerDir: led });
  origin = `http://127.0.0.1:${server.address().port}`;
  try {
    await page.setViewportSize({ width: 1100, height: 700 });
    await page.goto(origin);
    await page.getByRole('link', { name: '判断台帳' }).click();
    await expect(page.locator('tbody tr')).toHaveCount(0);
    await page.getByRole('link', { name: '判断の候補' }).click();
    await expect(page.getByRole('heading', { name: '判断の候補' })).toBeVisible();
    const row = (id: string) => page.locator(`tr[data-id="${id}"]`);
    await expect(page.locator('tbody tr')).toHaveCount(2);
    await expect(row('P-2026-11-21-adopt-me').locator('strong')).toHaveText('なぜ');
    await expect(row('P-2026-11-21-adopt-me').locator('.ledger-body img')).toHaveCount(0);
    await expect(row('P-2026-11-21-adopt-me').locator('.ledger-body')).toContainText('<img src=x');
    expect(await page.evaluate(() => (window as any).__xss)).toBeUndefined();
    await expect(row('P-2026-11-21-adopt-me')).toContainText('記事');
    await expect(row('P-2026-11-21-reject-me')).toContainText('媒体');
    await expect(row('P-2026-11-21-adopt-me')).toContainText('e2e-agent');
    expect(await row('P-2026-11-21-adopt-me').locator('td').nth(3).evaluate(e => getComputedStyle(e).whiteSpace)).toBe('nowrap');
    expect(await row('P-2026-11-21-adopt-me').getByRole('button', { name: '採る' }).evaluate(e => e.getBoundingClientRect().height)).toBeLessThan(36);
    await mkdir(EVIDENCE, { recursive: true });
    await page.screenshot({ path: path.join(EVIDENCE, 'proposals-synthetic.png') });
    // Dismissing the confirmation changes nothing.
    page.once('dialog', d => d.dismiss());
    await row('P-2026-11-21-adopt-me').getByRole('button', { name: '採る' }).click();
    await expect(page.locator('tbody tr')).toHaveCount(2);
    await expect(readdir(led).catch(() => [])).resolves.toEqual([]);
    // Adopting writes one decision and leaves the proposal as adopted.
    page.once('dialog', d => d.accept());
    await row('P-2026-11-21-adopt-me').getByRole('button', { name: '採る' }).click();
    await expect(page.locator('tbody tr')).toHaveCount(1);
    expect((await readdir(led)).length).toBe(1);
    expect(await readFile(path.join(led, (await readdir(led))[0]), 'utf8')).toContain('decided_by: 著者');
    expect(await readFile(path.join(prop, 'P-2026-11-21-adopt-me.md'), 'utf8')).toContain('status: adopted');
    // Rejecting keeps the file and writes nothing to the ledger.
    page.once('dialog', d => d.accept());
    await row('P-2026-11-21-reject-me').getByRole('button', { name: '捨てる' }).click();
    await expect(page.locator('tbody tr')).toHaveCount(0);
    expect((await readdir(led)).length).toBe(1);
    expect(await readFile(path.join(prop, 'P-2026-11-21-reject-me.md'), 'utf8')).toContain('status: rejected');
    await page.getByLabel('採った・捨てたものも表示').check();
    await expect(row('P-2026-11-21-adopt-me')).toContainText('採った');
    await expect(row('P-2026-11-21-reject-me')).toContainText('捨てた');
    await page.getByRole('link', { name: '判断台帳' }).click();
    await expect(page.locator('tbody tr')).toHaveCount(1);
  } finally { await rm(base, { recursive: true, force: true }); }
});
