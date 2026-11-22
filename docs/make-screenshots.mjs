// Regenerates docs/images/*.png from a small made-up vault. Run from the repository root after `npm run build`:
//   node docs/make-screenshots.mjs
// Nothing here reads your own folders: the vault is built in a temp directory and thrown away.
import { chromium } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEditorServer } from '../apps/editor/server.mjs';
import { proposeDecision } from '../packages/core/src/index.ts';

process.env.BRAGI_AUTHOR = 'Sam';
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), 'images');
const base = await mkdtemp(path.join(os.tmpdir(), 'bragi-docs-'));
const drafts = path.join(base, 'drafts'), ledger = path.join(base, 'decisions'), proposals = path.join(base, 'proposed');
const put = async (file, text) => { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, text); };
const run = (slug, id, title, medium, body) => Promise.all([
  put(path.join(drafts, slug, 'editor-run/editor-targets.json'), JSON.stringify({ targets: [{ id, title, medium, version: 'draft 2', source: '05_final/post.md' }] })),
  put(path.join(drafts, slug, 'editor-run/05_final/post.md'), body),
]);

// Articles, one folder each. The stage of each is derived from the files, as in real use.
await put(path.join(drafts, 'my-post-20261101/copy-review-report-1.md'),
  'status: needs_input\nmedium: explainer\n\n## Questions\n\n### Q01 Should the opening admit the first draft was wrong?\n### Q02 Is "surprised" in the source table, or ours?\n');
await put(path.join(drafts, 'my-post-20261101/status.override.json'), JSON.stringify({ due: '2026-11-28' }));
await run('tide-tables-20261104', 'main', 'Reading a tide table', 'explainer', 'Low water is at 〔Sam\'s own experience〕 on the north jetty.\n');
await run('slow-bread-20261106', 'main', 'Why slow bread is not slower', 'essay', 'A finished draft.\n');
await put(path.join(drafts, 'slow-bread-20261106/status.override.json'), JSON.stringify({ stage: 'gate-ci', waiting_on: 'ci' }));
await put(path.join(drafts, 'notes-on-maps-20261109/brief.md'), '# Brief\n\nA short piece on old survey maps.\n');
await put(path.join(drafts, 'harbour-walk-20261024/status.override.json'), JSON.stringify({ stage: 'published' }));
await put(path.join(drafts, 'harbour-walk-20261024/brief.md'), '# Brief\n');

// Decisions, one file each.
const decision = (id, fm, text) => put(path.join(ledger, `${id}.md`), `---\nid: ${id}\n${fm}\ndecided_by: Sam\ncheck:\n  type: none\n---\n\n${text}\n`);
await decision('D-2026-11-16-no-unsourced-feelings', 'scope: medium\nmedium: explainer\ndraft: null\nkind: fact-policy\nstatus: active\ndecided_at: 2026-11-16\nsource: drafts/harbour-walk-20261024/copy-review-report-1.md#Q01', 'State only the feelings the source table gives. Leave out "surprised" and "cast a shadow" unless a source says so.');
await decision('D-2026-11-18-no-superlatives', 'scope: global\nmedium: null\ndraft: null\nkind: phrasing\nstatus: active\ndecided_at: 2026-11-18\nsource: written by hand', 'No "the best" or "the most" unless the source ranks it.');
await decision('D-2026-11-12-open-with-the-mistake', 'scope: draft\nmedium: null\ndraft: slow-bread-20261106\nkind: structure\nstatus: retired\nretired_at: 2026-11-20\ndecided_at: 2026-11-12\nsource: drafts/slow-bread-20261106/copy-review-report-1.md#Q03', 'Open with the mistake, not the method.');

// Candidates an agent proposed. They sit in their own folder until a person adopts them.
await proposeDecision(proposals, ledger, { slug: 'secondary-source-label', proposed_by: 'writing-agent', scope: 'medium', medium: 'explainer', kind: 'fact',
  source: 'drafts/tide-tables-20261104/copy-review-report-1.md#Q02', body: 'When a date rests on a secondary source only, say so in the references.' }, '2026-11-21');
await proposeDecision(proposals, ledger, { slug: 'no-reader-address', proposed_by: 'writing-agent', scope: 'global', kind: 'phrasing',
  source: 'drafts/my-post-20261101/copy-review-report-1.md#Q02', body: 'Do not address the reader as "you" in the first paragraph.' }, '2026-11-21');

const server = await createEditorServer({ draftsRoot: drafts, port: 0, taskNotesDir: null, ledgerDir: ledger, proposalsDir: proposals });
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 300 }, deviceScaleFactor: 2 });
  // The footer prints the folder being read and the time. Hide it so the pictures carry no local path.
  const shoot = async (hash, file, ready) => {
    await page.goto(origin + '/#/' + hash); await page.waitForSelector(ready);
    await page.addStyleTag({ content: 'footer{display:none!important}' });
    await page.screenshot({ path: path.join(out, file), fullPage: true });
  };
  await shoot('', 'list.png', 'tbody tr');
  await shoot('proposals', 'proposals.png', 'button.adopt');
  await page.goto(origin + '/#/proposals'); await page.waitForSelector('button.adopt');
  page.once('dialog', d => d.accept());
  await page.locator('button.adopt').first().click();
  await page.waitForTimeout(600);
  await page.goto(origin + '/#/ledger'); await page.waitForSelector('.retire');
  const box = page.getByLabel(/取り消し済みも表示/); if (await box.count()) await box.check();
  await page.addStyleTag({ content: 'footer{display:none!important}' });
  await page.screenshot({ path: path.join(out, 'ledger.png'), fullPage: true });
} finally { await browser.close(); server.close(); await rm(base, { recursive: true, force: true }); }
