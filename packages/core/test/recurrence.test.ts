import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { buildCandidates, countRecurrence, getCandidates, getRecurrence, isCopyReviewReport, listReportFiles, loadLedger, matchFinding, parseReport, readReports, sourceKey, UnknownDraft } from '../src/index.ts';

const run = promisify(execFile);
const root = path.resolve('test/fixtures/recurrence');
const drafts = path.join(root, 'drafts');
const ledger = path.join(root, 'ledger');
const bragi = path.resolve('src/bragi.ts');
const opts = { draftsRoot: drafts, ledgerDir: ledger, taskNotesDir: null };

async function everything() {
  const { reports } = await listReportFiles(drafts);
  const { parsed } = await readReports(reports);
  const { decisions, problems } = await loadLedger(ledger);
  assert.deepEqual(problems, [], 'every ledger fixture (with Vault metadata) reads');
  return { parsed, decisions };
}
async function snapshot(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...await snapshot(p));
    else out.push(`${p} ${(await stat(p)).size} ${(await stat(p)).mtimeMs}`);
  }
  return out.sort();
}

test('report names: copy-review reports only, not briefs, reflection logs or ledgers', () => {
  assert.ok(['copy-review-report-x.md', '10-copy-review-report-r1.md', 'copy-review 報告 サンプル 記事1.md'].every(isCopyReviewReport));
  assert.ok(!['copy-review-brief-x.md', 'copy-review 反映記録 x.md', '11-copy-review-ledger-r1.md', 'review-report.md', 'copy-review-report-x.mdx'].some(isCopyReviewReport));
});

test('findings: ID/旧/区分 columns found by header in either order; auto and decision told apart; Q ids normalised; non-findings tables skipped', async () => {
  const first = parseReport(await readFile(path.join(drafts, 'first-sample/copy-review-report-first.md'), 'utf8'), 'first-sample', 'copy-review-report-first.md');
  assert.equal(first.status, 'needs_input');
  assert.deepEqual(first.findings.map((f) => [f.id, f.klass, f.questionIds]), [['E01', 'decision', ['Q01']], ['E02', 'auto', []], ['E03', 'decision', ['Q02']], ['E04', 'other', []]]);
  assert.equal(first.findings[2].old, 'AまたはB（A|B の形）', 'an escaped pipe stays inside its cell');
  // 区分 in the third column (the three-column layout)
  const second = parseReport(await readFile(path.join(drafts, 'second-sample/copy-review-report-second.md'), 'utf8'), 'second-sample', 'r.md');
  assert.deepEqual(second.findings.slice(0, 2).map((f) => [f.id, f.klass, f.old]), [['E01', 'decision', '驚いた家族の申し立てにより、'], ['E02', 'auto', '極限まで高めた作品。']]);
  // no 区分 column at all
  const third = parseReport(await readFile(path.join(drafts, 'third-sample/copy-review-report-third.md'), 'utf8'), 'third-sample', 'r.md');
  assert.deepEqual(third.findings.map((f) => [f.id, f.klass]), [['E1', 'unclassified']]);
});

test('questions: inline, bullet and plain layouts; Q2 is Q02; a mention in prose and "Q01〜Q03" are not questions', async () => {
  const first = parseReport(await readFile(path.join(drafts, 'first-sample/copy-review-report-first.md'), 'utf8'), 'first-sample', 'copy-review-report-first.md');
  assert.deepEqual(first.questions.map((q) => q.id), ['Q01', 'Q02', 'Q03']);
  const [q1, q2, q3] = first.questions;
  assert.deepEqual([q1.title, q1.label, q1.refs, q1.basis, q1.recommended, q1.answer], ['題に「驚いた」を残すか。', 'E01・資料不足を含む', ['E01'], '表にない心情', 'A', null]);
  assert.deepEqual(q1.choices, [{ key: 'A', text: '削る' }, { key: 'B', text: '資料を足して残す' }]);
  assert.deepEqual([q2.title, q2.refs, q2.recommended, q2.answer, q2.choices.map((c) => c.text)], ['結びを足すか。', ['E03'], 'A', 'A（著者・合成）', ['足さない', '足す']]);
  assert.deepEqual([q3.title, q3.recommended, q3.choices.map((c) => `${c.key}${c.text}`)], ['年表の出典を付けるか', 'B', ['A付ける', 'B付けない']]);
});

test('questions: inline layouts (inline with 箇所/根拠/選択肢, label before the colon)', () => {
  const text = [
    '**Q01（資料不足を含む）: 架空の『月刊サンプル』創刊号に「12本」を載せたと書いてよいか。** 箇所: 年表（5行）、9行、FAQ（31行）。根拠: 表 L2 は「創刊号の原稿は12本」。選択肢: A（推奨）E01のとおり創刊号の12本を削り、9行の「創刊号の原稿は12本」だけ残す。B 創刊号の掲載数を示す資料を足してから残す。',
    '',
    '**Q08（資料不足）: `<Figure>` の `lang` が、図の言語と合っていない。** 箇所: 12・18・21行。根拠: brief 6行は言語を指定している。選択肢: A 既定の言語を確認する。B 著者に確認。',
    '',
    '## 固定事実と範囲',
  ].join('\n');
  const [q1, q8] = parseReport(text, 'b', 'r.md').questions;
  assert.deepEqual([q1.id, q1.title, q1.label, q1.recommended], ['Q01', '架空の『月刊サンプル』創刊号に「12本」を載せたと書いてよいか。', '資料不足を含む', 'A']);
  assert.match(q1.basis, /^表 L2 は「創刊号の原稿は12本」$/);
  assert.deepEqual(q1.choices.map((c) => c.key), ['A', 'B']);
  assert.equal(q1.choices[0].text, 'E01のとおり創刊号の12本を削り、9行の「創刊号の原稿は12本」だけ残す');
  assert.deepEqual([q8.id, q8.recommended, q8.choices.map((c) => c.key)], ['Q08', null, ['A', 'B']]);
});

test('candidates: in-ledger (a decision cites file#Q), answered (the report says 回答), open; the proposal defaults to one article', async () => {
  const { parsed, decisions } = await everything();
  const c = buildCandidates(parsed.filter((r) => r.slug === 'first-sample'), decisions);
  assert.deepEqual(c.map((x) => [x.id, x.state]), [['Q01', 'in-ledger'], ['Q02', 'answered'], ['Q03', 'open']]);
  assert.deepEqual(c[0].decision, { id: 'D-2026-11-16-first-q01', status: 'active' });
  assert.deepEqual(c[0].findingIds, ['E01']);
  assert.deepEqual([c[1].answerKey, c[1].suggestion], ['A', '足さない']);
  assert.deepEqual([c[2].answerKey, c[2].suggestion], [null, '付けない'], 'an open question suggests its recommended option');
  assert.deepEqual(c[2].proposed, { scope: 'draft', draft: 'first-sample', source: 'drafts/first-sample/copy-review-report-first.md#Q03' });
  assert.deepEqual(sourceKey('Projects/x/drafts/a/copy-review-report-a.md#Q2'), { file: 'copy-review-report-a.md', question: 'Q02' });
  assert.equal(sourceKey('サンプル紹介-実行報告.md#著者に聞いたこと（12）'), null);
});

test('recurrence: id, check, phrase and tag rules; the origin article, retired decisions and other/unclassified rows do not count; an article counts once', async () => {
  const { parsed, decisions } = await everything();
  const rows = countRecurrence(parsed, decisions);
  const by = Object.fromEntries(rows.map((r) => [r.decision, r]));
  assert.ok(!('D-2026-11-16-first-retired' in by), 'a retired decision is not counted');
  assert.deepEqual([by['D-2026-11-16-first-q01'].count, by['D-2026-11-16-first-q01'].articles], [2, ['loose-sample', 'second-sample']]);
  assert.deepEqual(by['D-2026-11-16-first-q01'].hits.map((h) => `${h.slug}/${h.finding}/${h.rule}`), ['second-sample/E01/phrase', 'second-sample/E03/tag', 'loose-sample/E01/phrase'], 'in the order the reports are found: folders, then the index');
  assert.deepEqual(by['D-2026-11-16-first-check'].hits.map((h) => `${h.slug}/${h.finding}/${h.rule}/${h.via}`), ['second-sample/E02/check/極限まで']);
  assert.deepEqual(by['D-2026-11-16-first-id'].hits.map((h) => `${h.slug}/${h.finding}/${h.rule}`), ['second-sample/E05/id']);
  // not counted: second E04 (other), E06 (phrase of the retired one), E08 (「評価」 without a no-basis statement); third E1 (unclassified); first-sample's own findings (origin)
  const all = rows.flatMap((r) => r.hits.map((h) => `${h.slug}/${h.finding}`));
  for (const gone of ['second-sample/E04', 'second-sample/E06', 'second-sample/E08', 'third-sample/E1', 'first-sample/E01', 'first-sample/E02']) assert.ok(!all.includes(gone), gone);
  assert.deepEqual(rows.map((r) => r.count), [2, 1, 1], 'sorted by count, then id');
});

test('recurrence by article: only the decisions that article\'s findings fall under; an article with no report is an unknown draft', async () => {
  const r = await getRecurrence(opts, 'loose-sample');
  assert.deepEqual(r.rows.map((x) => x.decision), ['D-2026-11-16-first-q01']);
  assert.deepEqual((await getRecurrence(opts, 'third-sample')).rows, []);
  await assert.rejects(getRecurrence(opts, 'no-such'), UnknownDraft);
  await assert.rejects(getCandidates(opts, 'no-such'), /unknown draft "no-such"\. Known: first-sample, loose-sample, second-sample, third-sample/);
});

test('matchFinding: a bad check pattern does not stop the count, and the first rule that fits is the one recorded', async () => {
  const { parsed, decisions } = await everything();
  const d = decisions.find((x) => x.meta.id === 'D-2026-11-16-first-check')!;
  const f = parsed.find((r) => r.slug === 'second-sample')!.findings.find((x) => x.id === 'E02')!;
  assert.equal(matchFinding({ ...d, meta: { ...d.meta, check: { type: 'regex', pattern: '(' } } }, f)?.rule, 'phrase', 'the broken regex is skipped, the phrase still matches');
  assert.equal(matchFinding(d, f)?.rule, 'check');
});

test('guards: a 2-character 「…」 is not a phrase; "Q05〜Q06 に分けた" opens no question; a stray capital is not an option', async () => {
  const { parsed, decisions } = await everything();
  const d = decisions.find((x) => x.meta.id === 'D-2026-11-16-first-q01')!;
  const f = parsed.find((r) => r.slug === 'second-sample')!.findings.find((x) => x.id === 'E08')!;
  assert.equal(matchFinding({ ...d, body: '「評価」は避ける。' }, f), null, '「評価」 (2 characters) is in the finding but is too short to be a phrase');
  assert.equal(matchFinding({ ...d, body: '「評価の高い」は避ける。' }, f)?.rule, 'phrase', 'the same word at 3+ characters matches');
  const text = ['Q05〜Q06 に分けた。', '', 'Q07: 例の質問', '- 選択肢: 例えば C など。A そのまま。B 直す。', '- 推奨: A'].join('\n');
  const qs = parseReport(text, 's', 'r.md').questions;
  assert.deepEqual(qs.map((q) => q.id), ['Q07']);
  assert.deepEqual(qs[0].choices, [{ key: 'A', text: 'そのまま' }, { key: 'B', text: '直す' }]);
});

test('discovery: folders and drafts.index.yaml entries; a loose report no entry owns is reported, not guessed; briefs are skipped', async () => {
  const { reports, unowned } = await listReportFiles(drafts);
  assert.deepEqual(reports.map((r) => `${r.slug}/${r.name}`), ['first-sample/copy-review-report-first.md', 'second-sample/copy-review-report-second.md', 'third-sample/copy-review-report-third.md', 'loose-sample/copy-review-report-loose.md']);
  assert.deepEqual(unowned, ['copy-review 報告 旧 2026-11-03.md']);
  assert.deepEqual((await listReportFiles(drafts, null)).reports.map((r) => r.slug), ['first-sample', 'second-sample', 'third-sample']);
});

test('bragi candidates / recurrence: text and --json, read-only, errors exit 1', async () => {
  const before = await snapshot(root);
  const args = ['--drafts-root', drafts, '--ledger', ledger, '--tasknotes', path.join(root, 'none')];
  const cand = (await run('node', [bragi, 'candidates', 'first-sample', ...args])).stdout;
  assert.match(cand, /質問 3件：台帳に未登録で回答あり 1・未登録で回答なし 1・台帳に登録済み 1/);
  assert.match(cand, /## Q02（回答あり・未登録）結びを足すか。/);
  assert.match(cand, /## Q01（台帳に登録済み D-2026-11-16-first-q01）/);
  const json = JSON.parse((await run('node', [bragi, 'candidates', 'first-sample', '--json', ...args])).stdout);
  assert.deepEqual(json.candidates.map((c: { id: string; state: string }) => `${c.id}:${c.state}`), ['Q01:in-ledger', 'Q02:answered', 'Q03:open']);
  const rec = (await run('node', [bragi, 'recurrence', ...args])).stdout;
  assert.match(rec, /## D-2026-11-16-first-q01：2本（範囲 medium・元 first-sample）/);
  assert.match(rec, /- second-sample：E01（decision・phrase：「驚いた家族」）、E03（decision・tag：unsourced-feeling-evaluation）/);
  assert.match(rec, /> フォルダのない報告は数えていない.*copy-review 報告 旧 2026-11-03\.md/);
  const bad = await run('node', [bragi, 'candidates', 'nope', ...args]).catch((e) => e);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /unknown draft "nope"/);
  assert.equal((await run('node', [bragi, 'candidates', ...args]).catch((e) => e)).code, 2, 'candidates needs a slug');
  assert.deepEqual(await snapshot(root), before, 'reading changed nothing');
});
