import { test, expect } from '@playwright/test';
import { cp, mkdtemp, readFile, writeFile, mkdir, rm, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createEditorServer } from '../../server.mjs';

// Screenshots go to test-results/evidence unless WLE_EVIDENCE_DIR says otherwise (they used to overwrite a fixed folder).
const EVIDENCE = (process.env.WLE_EVIDENCE_DIR ?? path.resolve('test-results/evidence')) + '/';
const fixture = path.resolve('test/fixtures/run');
const contexts = [];
let server, run, tmp, port, context, page;

async function start(custom = false) {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'wle-e2e-'));
  run = path.join(tmp, 'run');
  await cp(fixture, run, { recursive: true });
  if (custom) {
    const original = `---
title: Bulk Replace Fixture
---
Claude Code skill.

A Skill helps.

Use \`skills/list\`.

\`\`\`json
{"skills":"skill"}
\`\`\`
`;
    await writeFile(path.join(run, '05_final', 'bulk-original.md'), original);
    await writeFile(path.join(run, 'editor-targets.json'), JSON.stringify({ targets: [{ id: 'bulkreplace', title: 'Bulk Replace Fixture', medium: 'Zenn', version: 'review', source: '05_final/bulk-original.md' }] }));
  }
  server = await createEditorServer({ run, port: 0 });
  port = server.address().port;
}
async function browser(browserFixture) {
  context = await browserFixture.newContext();
  contexts.push(context);
  page = await context.newPage();
  await page.goto(`http://127.0.0.1:${port}`);
  await expect(page.locator('.ProseMirror')).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}
async function stop() {
  for (const item of contexts.splice(0)) await item.close();
  if (server) await new Promise(resolve => server.close(resolve));
  if (tmp) await rm(tmp, { recursive: true, force: true });
}
// 'clean' also reads 保存済み, so wait on the explicit state to prove an actual save completed.
const waitSaved = async () => { await expect(page.getByRole('status')).toHaveAttribute('data-save-state', 'saved', { timeout: 5000 }); await expect(page.getByRole('status')).toHaveText('保存済み'); };
const editor = () => page.locator('.ProseMirror');
const source = path.join('05_final', '川沿いの帰り道 レビュー反映稿.md');
async function addReasonToChanged(index = 0) {
  const node = editor().locator('[data-changed="true"]').nth(index);
  await node.click();
  await page.keyboard.press('Home');
  await page.keyboard.press('Shift+End');
  await page.getByRole('button', { name: '理由', exact: true }).click();
}

test.beforeEach(async ({ browser: browserFixture }) => { await start(); await browser(browserFixture); });
test.afterEach(async () => { await stop(); });

test('8 edit, autosave, reload, note persistence and changed-block marker', async () => {
  const original = await readFile(path.join(run, source));
  const p = editor().locator('p').first();
  await page.route('**/api/drafts/kawazoi', async route => {
    if (route.request().method() === 'PUT') { const response = await route.fetch(); await page.waitForTimeout(350); await route.fulfill({ response }); }
    else await route.continue();
  });
  await p.click();
  await page.keyboard.press('End');
  const savingResponse = page.waitForRequest(request => request.method() === 'PUT' && request.url().includes('/api/drafts/kawazoi'));
  await page.keyboard.insertText('（編集）');
  await savingResponse;
  await expect(page.getByRole('status')).toHaveText('保存中…');
  await waitSaved();
  await page.unroute('**/api/drafts/kawazoi');
  const changed = editor().locator('[data-changed="true"]');
  await expect(changed).toHaveCount(1);
  await addReasonToChanged();
  await expect(page.getByLabel('理由')).toBeVisible();
  await page.getByLabel('理由').fill('語尾の理由');
  await waitSaved();
  await page.reload();
  await expect(editor()).toContainText('（編集）');
  await expect(page.getByLabel('理由')).toHaveValue('語尾の理由');
  expect(await readFile(path.join(run, source))).toEqual(original);
});

test('16 idle draft reads 保存済み without saving or creating editor folders', async () => {
  let writes = 0;
  page.on('request', request => { if (request.method() !== 'GET' && request.url().includes('/api/drafts/')) writes++; });
  await expect(page.getByRole('status')).toHaveAttribute('data-save-state', 'clean');
  await expect(page.getByRole('status')).toHaveText('保存済み');
  await page.getByRole('button', { name: /川沿いの帰り道/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: /市場のひとこと/ }).click();
  await expect(page.getByRole('status')).toHaveText('保存済み');
  await page.waitForTimeout(1000);
  expect(writes).toBe(0);
  await expect(access(path.join(run, '05_final', 'editor'))).rejects.toThrow();
  await editor().locator('p').first().click(); await page.keyboard.press('End'); await page.keyboard.insertText('追記');
  await expect(page.getByRole('status')).not.toHaveText('保存済み');
  await waitSaved();
});

test('9 IME composition does not save uncommitted text and commits only final kana', async () => {
  let writes = 0;
  page.on('request', request => { if (request.method() === 'PUT' && request.url().includes('/api/drafts/')) writes++; });
  const p = editor().locator('p').first(); await p.click(); await page.keyboard.press('End');
  const cdp = await context.newCDPSession(page);
  await cdp.send('Input.imeSetComposition', { text: 'かわ', selectionStart: 2, selectionEnd: 2 });
  await page.waitForTimeout(1000);
  expect(writes).toBe(0);
  expect(await page.getByRole('status').innerText()).not.toBe('保存済み');
  await cdp.send('Input.insertText', { text: '川' });
  await waitSaved();
  await expect(editor()).toContainText('川');
  await expect(editor()).not.toContainText('かわ');
  expect(writes).toBe(1);
});

test('10 conflict preserves the outside edit and forks the local version', async () => {
  const folder = path.join(run, '05_final', 'editor', 'kawazoi');
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, 'nat-final.md'), '外部で変更された本文');
  await writeFile(path.join(folder, 'nat-notes.json'), '[]\n');
  const p = editor().locator('p').first();
  await p.click(); await page.keyboard.press('End'); await page.keyboard.insertText('ローカル変更');
  await expect(page.getByRole('status')).toHaveText('ファイルが別の場所で変更されました');
  await expect(page.getByText('自分の変更はこのMacに保持されています。')).toBeVisible();
  await page.getByRole('button', { name: '自分の版を別に保存' }).click();
  await expect(editor()).toContainText('外部で変更された本文');
  const files = await (await import('node:fs/promises')).readdir(folder);
  expect(files.some(name => name.startsWith('nat-final.conflict-'))).toBe(true);
  expect(await readFile(path.join(folder, 'nat-final.md'), 'utf8')).toBe('外部で変更された本文');
});

test('11 failed save retains recoverable local backup and retry saves', async () => {
  await page.route('**/api/drafts/kawazoi', async route => {
    if (route.request().method() === 'PUT') await route.fulfill({ status: 500, body: '{}' });
    else await route.continue();
  });
  const p = editor().locator('p').first(); await p.click(); await page.keyboard.press('End'); await page.keyboard.type('再試行対象');
  await expect(page.getByRole('status')).toHaveText('保存できませんでした');
  await expect(page.getByText('変更はこのMacに保持されています。')).toBeVisible();
  expect(await page.evaluate(() => Object.keys(localStorage).some(k => k.startsWith('wle:')))).toBe(true);
  await page.unroute('**/api/drafts/kawazoi');
  await page.getByRole('button', { name: '再試行' }).click();
  await waitSaved();
  expect(await readFile(path.join(run, '05_final/editor/kawazoi/nat-final.md'), 'utf8')).toContain('再試行対象');
});

test('12 market Markdown supported syntax round-trips byte-for-byte except edited sentence', async () => {
  await page.getByRole('button', { name: /川沿いの帰り道/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: /市場のひとこと/ }).click();
  const original = await readFile(path.join(run, '05_final/市場のひとこと レビュー反映稿.md'), 'utf8');
  await expect(page.locator('.unsupported')).toHaveCount(0);
  await expect(editor().locator('h1')).toHaveText('市場のひとこと');
  await expect(editor().locator('ul li')).toHaveCount(2);
  await expect(editor().locator('blockquote')).toContainText('書かれていないことも');
  await expect(editor().locator('a')).toHaveAttribute('href', 'https://example.com/market');
  await expect(editor().locator('strong')).toContainText('最後の一軒');
  const p = editor().locator('p').first(); await p.click(); await page.keyboard.press('End'); await page.keyboard.insertText('改');
  await waitSaved();
  const result = await readFile(path.join(run, '05_final/editor/market-note/nat-final.md'), 'utf8');
  expect(result).toBe(original.replace('違う顔を見せます。', '違う顔を見せます。改'));
});

test('13 finish records exact changed and reason counts; unchanged finish reports zero', async () => {
  const p = editor().locator('p').first(); await p.click(); await page.keyboard.press('End'); await page.keyboard.insertText('完了対象');
  await waitSaved();
  const changed = editor().locator('[data-changed="true"]'); await expect(changed).toHaveCount(1); await addReasonToChanged();
  await page.getByLabel('理由').fill('確認した'); await waitSaved();
  await page.getByRole('button', { name: '直し終えた' }).click();
  await expect(page.getByRole('heading', { name: '直し終えました' })).toBeVisible();
  await expect(page.getByText('編集版を保存しました。')).toBeVisible();
  await expect(page.getByText('元の原稿も残っています。')).toBeVisible();
  await expect(page.getByText('変更 1か所　理由 1件')).toBeVisible();
  const record = JSON.parse(await readFile(path.join(run, '05_final/editor/kawazoi/finished.json'), 'utf8'));
  expect(record.changedBlocks).toBe(1); expect(record.notes).toBe(1); expect(record.unchanged).toBe(false);
  await page.getByRole('button', { name: /川沿いの帰り道/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: /市場のひとこと/ }).click();
  await page.getByRole('button', { name: '直し終えた' }).click();
  await expect(page.getByText('変更 0か所　理由 0件')).toBeVisible();
});

test('14 desktop and compact screenshots render without horizontal clipping', async () => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await expect(editor()).toBeVisible();
  await page.screenshot({ path: EVIDENCE + 'desktop-editing.png', fullPage: true });
  expect(await editor().evaluate(el => getComputedStyle(el).fontFamily)).toContain('Noto Serif JP');
  expect(await editor().evaluate(el => el.getBoundingClientRect().width)).toBe(684);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: EVIDENCE + 'compact-editing.png', fullPage: true });
  const dimensions = await page.evaluate(() => ({ client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
  expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.client);
  expect(await editor().evaluate(el => getComputedStyle(el).fontSize)).toBe('17px');
});

test('17 changed paragraph shows vermilion bar and margin note (evidence screenshot)', async () => {
  await page.setViewportSize({ width: 1440, height: 960 });
  const p = editor().locator('p').nth(1); await p.click(); await page.keyboard.press('End'); await page.keyboard.insertText('川の音だけが残りました。');
  await waitSaved();
  await addReasonToChanged(); await page.getByLabel('理由').fill('橋の場面に音を足した。');
  await editor().locator('p').nth(3).click(); await waitSaved();
  const bar = await editor().locator('[data-changed="true"]').first().evaluate(el => { const s = getComputedStyle(el, '::before'); return { content: s.content, color: s.backgroundColor }; });
  expect(bar.color).toBe('rgb(163, 68, 50)');
  await expect(page.getByText('橋の場面に音を足した。')).toBeVisible();
  const noteTop = await page.locator('.note').first().evaluate(el => el.getBoundingClientRect().top);
  const paraTop = await editor().locator('[data-changed="true"]').first().evaluate(el => el.getBoundingClientRect().top);
  expect(Math.abs(noteTop - paraTop)).toBeLessThan(4);
  await page.screenshot({ path: EVIDENCE + 'desktop-changed.png' });
});

test('18 margin ＋ is a real button: hover the text, move right, click opens a note', async () => {
  await page.setViewportSize({ width: 1440, height: 960 });
  const para = editor().locator('p').nth(2); await para.click(); await page.keyboard.press('End'); await page.keyboard.insertText('袋は軽かった。');
  await waitSaved();
  await page.locator('.top').click({ position: { x: 5, y: 5 } });
  await page.mouse.move(10, 900);
  const plus = page.getByRole('button', { name: '理由を書く' });
  await expect(plus).toHaveCount(1);
  await expect(plus).not.toHaveClass(/visible/);
  const box = (await para.boundingBox())!;
  await page.mouse.move(box.x + 40, box.y + 10);
  await expect(plus).toHaveClass(/visible/);
  const pb = (await plus.boundingBox())!;
  await page.mouse.move(pb.x + pb.width / 2, pb.y + pb.height / 2, { steps: 12 });
  await expect(plus).toHaveClass(/visible/);
  await page.mouse.down(); await page.mouse.up();
  const note = page.getByLabel('理由'); await expect(note).toBeFocused();
  await page.keyboard.insertText('ほんとうに軽かった。'); await page.mouse.move(10, 600); await waitSaved();
  await expect(plus).toHaveCount(0);
  const noteTop = (await page.locator('.note').first().boundingBox())!.y;
  expect(Math.abs(noteTop - box.y)).toBeLessThan(4);
});

test('19 links use the paper ink color, not the browser default blue', async () => {
  await page.locator('.doc-title').click();
  await page.getByRole('dialog').getByRole('button', { name: /市場のひとこと/ }).click();
  const link = editor().locator('a').first();
  await expect(link).toBeVisible();
  expect(await link.evaluate(el => getComputedStyle(el).color)).toBe('rgb(48, 45, 40)');
});

test('20 bulk replacement saves selected prose only and one undo restores exact fixture bytes', async ({ browser: browserFixture }) => {
  await stop();
  await start(true);
  await browser(browserFixture);
  const original = await readFile(path.join(run, '05_final/bulk-original.md'));
  await page.keyboard.press('Meta+Shift+h');
  const dialog = page.getByRole('dialog', { name: '検索・置換' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('検索語').fill('skill');
  await dialog.getByLabel('置換後').fill('スキル');
  await expect(dialog.getByText('該当 2 件')).toBeVisible();
  await dialog.getByRole('checkbox', { name: '置換候補 2' }).uncheck();
  await dialog.getByRole('button', { name: '選択した 1 件を置換' }).click();
  await expect(dialog.getByText('1件を置換しました。')).toBeVisible();
  await expect(editor().locator('[data-changed="true"]')).toHaveCount(1);
  await waitSaved();
  const saved = Buffer.from(`---
title: Bulk Replace Fixture
---
Claude Code スキル.

A Skill helps.

Use \`skills/list\`.

\`\`\`json
{"skills":"skill"}
\`\`\`
`);
  expect(await readFile(path.join(run, '05_final/editor/bulkreplace/nat-final.md'))).toEqual(saved);
  await dialog.getByRole('button', { name: '元に戻す' }).click();
  await waitSaved();
  expect(await readFile(path.join(run, '05_final/editor/bulkreplace/nat-final.md'))).toEqual(original);
});
