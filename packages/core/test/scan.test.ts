import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildQuery, ciOf, dueFromNotes, decodeRunKey, deriveStage, findPlaceholders, gateOf, listEditorRuns, loadTaskNotes, matchPrsByBranch, parseResponse, parseTaskNote, prCandidates, reportQuestionIds, reportStatus, resolveRecord, scanDrafts, scanResultSchema, slugBase, unresolvedReviews, type GithubClient, type PrInfo, type RawPr, type StageFacts } from '../src/index.ts';
process.env.BRAGI_TASK_IDS = String.raw`\bTASK-\d+\b|||\bjob_[0-9a-f]{8}\b`;

const fixtures = path.resolve('test/fixtures');
const fixture = path.join(fixtures, 'drafts');
const githubFixture = path.join(fixtures, 'github');
const tasknotes = path.join(fixtures, 'tasknotes');
const responseFile = path.resolve('test/github-response.json');

// ---- builders -------------------------------------------------------------------------------------------

const url = (n: number) => `https://github.com/example/site/pull/${n}`;
const pr = (number: number, state: PrInfo['state'], over: Partial<PrInfo> = {}): PrInfo => ({ url: url(number), number, state, repo: 'example/site', ...over });
const ciGreen = { state: 'success' as const, total: 3, failing: [], pending: 0 };
const gate = (verdict: 'MERGE_OK' | 'NEEDS_AUTHOR' | 'MANUAL_CHECK' | 'BLOCKED', stale = false) => ({ verdict, headSha: 'b2dc046', stale, at: '2026-11-14T03:24:38Z', url: null });
const facts = (over: Partial<StageFacts> = {}): StageFacts => ({ reports: [], editorRuns: [], prs: [], override: null, ...over });
const run = (...finished: boolean[]) => ({ relPath: 'r', targets: finished.map((f, i) => ({ id: `t${i}`, title: 't', medium: null, finished: f, placeholders: [] })) });
const report = (status: string | null, over = {}) => ({ file: 'copy-review-report-x.md', status, mtimeMs: 1, questionIds: ['Q01', 'Q02'], ...over });
const stageOf = (over: Partial<StageFacts>) => { const r = deriveStage(facts(over)); return [r.stage, r.waitingOn]; };

// ---- stage rules (pure) ---------------------------------------------------------------------------------

test('stage: nothing but a brief, or a report that is not needs_input -> 執筆中, waiting on the agent', () => {
  assert.deepEqual(stageOf({}), ['writing', 'agent']);
  assert.deepEqual(stageOf({ reports: [report('needs_edit')] }), ['writing', 'agent']);
});

test('stage: latest review report needs_input -> 著者判断待ち, with the number of open questions', () => {
  const r = deriveStage(facts({ reports: [report('needs_input')] }));
  assert.deepEqual([r.stage, r.waitingOn, r.openDecisions], ['awaiting-decision', 'author', 2]);
  assert.equal(stageOf({ reports: [report('needs_input', { mtimeMs: 1 }), report('needs_edit', { mtimeMs: 2 })] })[0], 'writing');
});

test('stage: an editor run with an open target -> 著者確定待ち, and it beats an older needs_input report', () => {
  assert.deepEqual(stageOf({ editorRuns: [run(true, false)], reports: [report('needs_input')] }), ['awaiting-confirm', 'author']);
});

test('stage: every target finished and no PR found -> PR不明 (not claimed as waiting for a PR); a closed-only PR does not count', () => {
  assert.deepEqual(stageOf({ editorRuns: [run(true, true)] }), ['pr-unknown', 'agent']);
  assert.deepEqual(stageOf({ editorRuns: [run(true)], prs: [pr(1, 'closed')] }), ['pr-unknown', 'agent']);
  assert.deepEqual(stageOf({ editorRuns: [run(true)], override: { stage: 'awaiting-pr' } }), ['awaiting-pr', 'agent']);
});

test('stage: a PR is open but finished.json is missing -> 著者確定待ち (not the gate), also with no editor run at all', () => {
  assert.deepEqual(stageOf({ editorRuns: [run(false)], prs: [pr(2, 'open', { ci: ciGreen })] }), ['awaiting-confirm', 'author']);
  assert.deepEqual(stageOf({ editorRuns: [], prs: [pr(114, 'open', { ci: ciGreen })] }), ['awaiting-confirm', 'author']);
  assert.deepEqual(stageOf({ editorRuns: [run(true, false)], prs: [pr(2, 'open')] }), ['awaiting-confirm', 'author']);
});

test('stage: finished and the PR is open -> ゲート/CI while CI is pending or red or no verdict exists', () => {
  const finished = { editorRuns: [run(true)] };
  assert.deepEqual(stageOf({ ...finished, prs: [pr(2, 'open')] }), ['gate-ci', 'ci']);
  assert.deepEqual(stageOf({ ...finished, prs: [pr(2, 'open', { ci: { ...ciGreen, state: 'pending', pending: 1 } })] }), ['gate-ci', 'ci']);
  assert.deepEqual(stageOf({ ...finished, prs: [pr(2, 'open', { ci: { ...ciGreen, state: 'failure', failing: ['build'] }, gate: gate('NEEDS_AUTHOR') })] }), ['gate-ci', 'ci']);
  assert.deepEqual(stageOf({ ...finished, prs: [pr(2, 'open', { ci: ciGreen })] }), ['gate-ci', 'ci']);
  assert.deepEqual(stageOf({ ...finished, prs: [pr(2, 'open', { ci: ciGreen, gate: gate('BLOCKED') })] }), ['gate-ci', 'ci']);
  assert.deepEqual(stageOf({ ...finished, prs: [pr(2, 'open', { ci: ciGreen, gate: gate('MANUAL_CHECK') })] }), ['gate-ci', 'ci']);
});

test('stage: finished, CI green and a pr_gate verdict for the current head -> マージ待ち; who waits depends on the verdict', () => {
  const finished = { editorRuns: [run(true)] };
  assert.deepEqual(stageOf({ ...finished, prs: [pr(2, 'open', { ci: ciGreen, gate: gate('NEEDS_AUTHOR') })] }), ['merge-ready', 'author']);
  assert.deepEqual(stageOf({ ...finished, prs: [pr(2, 'open', { ci: ciGreen, gate: gate('MERGE_OK') })] }), ['merge-ready', 'agent']);
});

test('stage: a verdict for an older head does not count, and says so', () => {
  const r = deriveStage(facts({ editorRuns: [run(true)], prs: [pr(2, 'open', { ci: ciGreen, headSha: 'ffffffff', gate: gate('MERGE_OK', true) })] }));
  assert.equal(r.stage, 'gate-ci');
  assert.match(r.warnings.join(), /古い head/);
});

test('stage: merged -> 公開済み; open beats merged (with a warning); an unreadable PR is assumed open', () => {
  assert.deepEqual(stageOf({ editorRuns: [run(true)], prs: [pr(2, 'merged')] }), ['published', 'none']);
  const mixed = deriveStage(facts({ editorRuns: [run(true)], prs: [pr(2, 'merged'), pr(3, 'open')] }));
  assert.equal(mixed.stage, 'gate-ci');
  assert.match(mixed.warnings.join(), /混在/);
  const unknown = deriveStage(facts({ editorRuns: [run(true)], prs: [pr(2, 'unknown')] }));
  assert.deepEqual([unknown.stage, unknown.warnings.length], ['gate-ci', 1]);
  assert.equal(deriveStage(facts({ editorRuns: [run(false)], prs: [pr(2, 'unknown')] })).stage, 'awaiting-confirm');
  assert.equal(deriveStage(facts({ prs: [pr(2, 'unknown'), pr(3, 'merged')] })).stage, 'published');
});

test('stage: status.override.json wins over the files', () => {
  const r = deriveStage(facts({ editorRuns: [run(false)], override: { stage: 'published' } }));
  assert.deepEqual([r.stage, r.waitingOn], ['published', 'none']);
  assert.equal(deriveStage(facts({ override: { waiting_on: 'author' } })).waitingOn, 'author');
});

test('stage: 未決 is null with nothing to count from, 0 once past the decision step, and placeholders add to it', () => {
  assert.equal(deriveStage(facts()).openDecisions, null);
  assert.equal(deriveStage(facts({ reports: [report('needs_input')], editorRuns: [run(false)] })).openDecisions, 0);
  assert.equal(deriveStage(facts({ reports: [report('needs_input')], editorRuns: [run(false)], placeholders: ['著者の体験：一言'] })).openDecisions, 1);
});

test('report parsing: status line and question ids (headings and bullets only)', () => {
  assert.equal(reportStatus('---\ntags: x\n---\nstatus: needs_input（補足）\n'), 'needs_input');
  assert.equal(reportStatus('no status'), null);
  assert.deepEqual(reportQuestionIds('### Q01 a\n## Q02\n- **Q03** c\n- Q04 d\n本文の Q09 は数えない\n  Q10 indented'), ['Q01', 'Q02', 'Q03', 'Q04']);
});

test('placeholders: 〔著者の…〕 and 要確認 count, structural 〔…〕 markers do not', () => {
  const text = '〔著者の体験：一言〕 〔図1：キャプション〕 〔図ここまで〕 〔画像：p.587〕 〔参考文献リスト（7件）〕 〔要確認：年〕 〔TODO 出典〕';
  assert.deepEqual(findPlaceholders(text), ['著者の体験：一言', '要確認：年', 'TODO 出典']);
  assert.deepEqual(findPlaceholders('plain text'), []);
});

// ---- GitHub: the one GraphQL call and what is read from it ------------------------------------------------

const response = JSON.parse(await readFile(responseFile, 'utf8'));
const raw = response.r0.n61 as RawPr;

test('graphql: one query asks for every repository and every wanted number, once each', () => {
  const q = buildQuery({ 'example/site': [61, 51, 61], 'other/repo': [] });
  assert.equal((q.match(/repository\(/g) ?? []).length, 2);
  assert.equal((q.match(/n61:/g) ?? []).length, 1);
  assert.match(q, /n51: pullRequest\(number: 51\)/);
  assert.match(q, /fragment PrF on PullRequest/);
  assert.throws(() => buildQuery({ 'bad repo!': [1] }), /bad repository name/);
});

test('graphql: CI is success only when every check finished well (skipped is fine), failing names are listed', () => {
  assert.deepEqual(ciOf(raw), { state: 'success', total: 3, failing: [], pending: 0 });
  const withContexts = (nodes: unknown[], state: string) => ({ ...raw, commits: { nodes: [{ commit: { oid: 'x', statusCheckRollup: { state, contexts: { nodes } } } }] } }) as RawPr;
  assert.deepEqual(ciOf(withContexts([{ __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'FAILURE' }], 'FAILURE')).failing, ['build']);
  assert.equal(ciOf(withContexts([{ __typename: 'CheckRun', name: 'build', status: 'IN_PROGRESS', conclusion: null }], 'PENDING')).state, 'pending');
  assert.equal(ciOf(withContexts([{ __typename: 'StatusContext', context: 'Vercel', state: 'PENDING' }], 'PENDING')).pending, 1);
  assert.equal(ciOf({ ...raw, commits: { nodes: [{ commit: { oid: 'x', statusCheckRollup: null } }] } }).state, 'none');
});

test('graphql: the pr_gate verdict is the newest comment that carries one, matched against the current head', () => {
  const g = gateOf(raw)!;
  assert.deepEqual([g.verdict, g.stale, g.headSha, g.url], ['NEEDS_AUTHOR', false, 'b2dc046a47817bf60e450a7be599c8db78dca9d8', 'https://example/c2']);
  const moved = gateOf({ ...raw, headRefOid: 'ccccccccccccccccccccccccccccccccccccccc0' })!;
  assert.deepEqual([moved.verdict, moved.stale], ['NEEDS_AUTHOR', true]);
  assert.equal(gateOf({ ...raw, comments: { nodes: [{ body: 'looks good', createdAt: '2026-11-14T00:00:00Z' }] } }), null);
  assert.equal(gateOf({ ...raw, comments: undefined }), null);
  // "pr_gate NEEDS_AUTHOR" in the middle of a human sentence still counts (the Gatekeeper team writes them that way).
  assert.equal(gateOf({ ...raw, comments: { nodes: [{ body: 'Author OK 2026-11-14. pr_gate NEEDS_AUTHOR content-only, CI green, head b2dc046a47817bf60e450a7be599c8db78dca9d8.', createdAt: '2026-11-14T00:00:00Z' }] } })?.verdict, 'NEEDS_AUTHOR');
});

test('graphql: the comment pr_gate.py --post really writes is read (format_comment: verdict line, then head with 10 characters)', () => {
  const body = '### 自動レビューゲート: NEEDS_AUTHOR\nhead `b2dc046a47` / CI: passing\n\n理由:\n- content-only change needs the author\n';
  const at = (head: string) => gateOf({ ...raw, headRefOid: head, comments: { nodes: [{ body, createdAt: '2026-11-19T00:00:00Z' }] } })!;
  const fresh = at('b2dc046a47817bf60e450a7be599c8db78dca9d8');
  assert.deepEqual([fresh.verdict, fresh.headSha, fresh.stale], ['NEEDS_AUTHOR', 'b2dc046a47', false]);
  assert.equal(at('0123456789abcdef0123456789abcdef01234567').stale, true);
  assert.equal(gateOf({ ...raw, comments: { nodes: [{ body: '### 自動レビューゲート: BLOCKED\nhead `b2dc046a47` / CI: failing', createdAt: '2026-11-19T00:00:00Z' }] } })?.verdict, 'BLOCKED');
});

test('graphql: unresolved review threads are counted', () => {
  assert.equal(unresolvedReviews(raw), 2);
  assert.equal(unresolvedReviews({ ...raw, reviewThreads: undefined }), null);
});

test('graphql: the response becomes PrInfo per repository, listed PRs and asked-for numbers merged by number', () => {
  const result = parseResponse({ 'example/site': [61] }, response);
  assert.deepEqual(result['example/site'].map((p) => p.number).sort(), [61, 70]);
  const p61 = result['example/site'].find((p) => p.number === 61)!;
  assert.deepEqual([p61.state, p61.ci?.state, p61.gate?.verdict, p61.unresolvedReviews, p61.branch, p61.headSha?.slice(0, 7)], ['open', 'success', 'NEEDS_AUTHOR', 2, 'content/ready', 'b2dc046']);
  assert.deepEqual(parseResponse({ 'example/site': [61] }, { r0: null }), {});
});

// ---- PRs and articles --------------------------------------------------------------------------------------

test('pr candidates: URLs, plus bare "PR #n" when all URLs share one repository', () => {
  const text = 'https://github.com/o/r/pull/7 and PR #8 and PR #8 and https://github.com/o/r/pull/7';
  assert.deepEqual(prCandidates([text]).map((r) => `${r.repo}#${r.number}`), ['o/r#7', 'o/r#8']);
  assert.deepEqual(prCandidates(['https://github.com/a/b/pull/1 https://github.com/c/d/pull/2 PR #3']).map((r) => `${r.repo}#${r.number}`), ['a/b#1', 'c/d#2']);
  assert.deepEqual(prCandidates(['PR #3 only']), []);
  assert.equal(prCandidates([Array.from({ length: 20 }, (_, i) => `https://github.com/o/r/pull/${i + 1}`).join(' ')]).length, 8);
});

test('article record: numbers resolve against repo, URLs against themselves, anything else is reported', () => {
  const ok = resolveRecord({ repo: 'o/r', branch: 'b', pr: [1, 'https://github.com/x/y/pull/2'] });
  assert.deepEqual(ok.record.prs, [{ repo: 'o/r', number: 1 }, { repo: 'x/y', number: 2 }]);
  assert.deepEqual(ok.problems, []);
  assert.match(resolveRecord({ pr: [5] }).problems[0], /repo がない/);
});

test('branch matching: a recorded branch matches exactly; without one the folder name is looked for (a guess)', () => {
  assert.equal(slugBase('my-article-20261113'), 'my-article');
  const items = [pr(1, 'merged', { branch: 'content/my-article-part3-20261113' }), pr(2, 'merged', { branch: 'content/my-article-hero-20261114' }), pr(3, 'open', { branch: 'content/other-topic-20261115' })];
  assert.deepEqual(matchPrsByBranch('my-article-20261113', items).map((p) => [p.number, p.via]), [[1, 'branch'], [2, 'branch']]);
  assert.deepEqual(matchPrsByBranch('x-20261113', items), []);
  assert.deepEqual(matchPrsByBranch('my-article-20261113', items, 'content/my-article-hero-20261114').map((p) => [p.number, p.via]), [[2, 'record']]);
});

/** A GitHub client that answers from a table and remembers what it was asked. */
function fakeGithub(table: Record<string, PrInfo[]>): GithubClient & { calls: unknown[] } {
  const calls: unknown[] = [];
  const client = (async (request: Record<string, number[]>) => {
    calls.push(request);
    return Object.fromEntries(Object.keys(request).map((repo) => [repo, table[repo] ?? []]));
  }) as GithubClient & { calls: unknown[] };
  client.calls = calls;
  return client;
}
const bySlug = (r: Awaited<ReturnType<typeof scanDrafts>>) => Object.fromEntries(r.drafts.map((d) => [d.slug, d]));
const siteTable = { 'example/site': [pr(7, 'open'), pr(8, 'merged'), pr(31, 'merged', { branch: 'content/branch-sample-intro-20261113' }), pr(32, 'merged', { branch: 'content/branch-sample-hero-20261114' }), pr(33, 'open', { branch: 'content/unrelated-20261113' })] };

test('scan: synthetic articles get the stage their files say (執筆中 / 判断待ち / 確定待ち / 確定済み)', async () => {
  const result = await scanDrafts(fixture, { github: fakeGithub(siteTable) });
  const by = bySlug(result);
  assert.deepEqual(Object.keys(by).sort(), ['bad-override-sample', 'branch-sample-20261113', 'confirmed-sample', 'deciding-sample', 'editing-sample', 'override-sample', 'placeholder-sample', 'pr-sample', 'writing-sample']);
  assert.deepEqual([by['writing-sample'].stage, by['writing-sample'].openDecisions], ['writing', null]);
  assert.deepEqual([by['deciding-sample'].stage, by['deciding-sample'].openDecisions, by['deciding-sample'].medium], ['awaiting-decision', 3, '解説記事']);
  assert.equal(by['editing-sample'].stage, 'awaiting-confirm');
  assert.deepEqual([by['confirmed-sample'].stage, by['confirmed-sample'].waitingOn, by['confirmed-sample'].title], ['pr-unknown', 'agent', '合成データ：確定済みの記事']);
  assert.deepEqual(result.skippedFiles, ['loose-note.md']);
  assert.equal(by['confirmed-sample'].editorRuns[0].relPath, 'confirmed-sample/editor-run');
  scanResultSchema.parse(result);
});

test('scan: PRs named in a report are looked up in one GitHub call, and are marked as read from a report', async () => {
  const gh = fakeGithub(siteTable);
  const by = bySlug(await scanDrafts(fixture, { github: gh }));
  assert.equal(gh.calls.length, 1, 'all repositories and PRs in a single call');
  assert.deepEqual(by['pr-sample'].prs.map((p) => [p.number, p.state, p.via]), [[7, 'open', 'report'], [8, 'merged', 'report']]);
  assert.equal(by['pr-sample'].stage, 'gate-ci');
});

test('scan: override file sets stage and due; a broken one is a warning, not a failure', async () => {
  const by = bySlug(await scanDrafts(fixture, { github: fakeGithub(siteTable) }));
  assert.deepEqual([by['override-sample'].stage, by['override-sample'].due, by['override-sample'].overridden], ['published', '2026-12-01', true]);
  assert.match(by['bad-override-sample'].warnings[0], /status\.override\.json を読めなかった/);
  assert.equal(by['bad-override-sample'].stage, 'writing');
});

test('scan: when GitHub fails every article is still listed, the PRs are state unknown, and the scan says why', async () => {
  const broken: GithubClient = async () => { throw new Error('gh: HTTP 401'); };
  const result = await scanDrafts(fixture, { github: broken });
  assert.equal(result.drafts.length, 9);
  const d = bySlug(result)['pr-sample'];
  assert.deepEqual([d.stage, d.prs.every((p) => p.state === 'unknown')], ['gate-ci', true]);
  assert.match(d.warnings.join(), /401/);
  assert.match(result.warnings.join(), /GitHub から PR の情報を取れなかった.*401/);
  const none = bySlug(await scanDrafts(fixture, { github: null }));
  assert.equal(none['pr-sample'].prs[0].state, 'unknown');
});

test('GitHub fields: article.yaml is the record, and it overrides what a report says', async () => {
  const infos = parseResponse({ 'example/site': [61] }, response)['example/site'];
  const table = {
    'example/site': [
      pr(41, 'open', { branch: 'content/recorded-x', ci: ciGreen }),
      pr(99, 'merged'),
      pr(51, 'open', { ci: ciGreen }),
      infos.find((p) => p.number === 61)!,
      pr(62, 'open', { ci: { state: 'pending', total: 2, failing: [], pending: 1 } }),
      pr(63, 'open', { ci: ciGreen, headSha: 'dddddddddddddddddddddddddddddddddddddddd', gate: gate('MERGE_OK', true) }),
    ],
  };
  const gh = fakeGithub(table);
  const result = await scanDrafts(githubFixture, { github: gh });
  const by = bySlug(result);
  // The report names PR 99 (merged); the record names PR 41. The record wins, so 99 is never asked for.
  assert.deepEqual(by['recorded-sample'].prs.map((p) => [p.number, p.via]), [[41, 'record']]);
  assert.equal(by['recorded-sample'].stage, 'gate-ci');
  assert.deepEqual(Object.values(gh.calls[0] as Record<string, number[]>)[0].sort((a, b) => a - b), [41, 51, 61, 62, 63]);
  assert.deepEqual([by['unfinished-sample'].stage, by['unfinished-sample'].waitingOn], ['awaiting-confirm', 'author']);
  assert.deepEqual([by['ready-sample'].stage, by['ready-sample'].waitingOn], ['merge-ready', 'author']);
  assert.deepEqual([by['ready-sample'].prs[0].gate?.verdict, by['ready-sample'].prs[0].unresolvedReviews], ['NEEDS_AUTHOR', 2]);
  assert.equal(by['pending-sample'].stage, 'gate-ci');
  assert.equal(by['stale-sample'].stage, 'gate-ci');
  assert.match(by['stale-sample'].warnings.join(), /古い head/);
  // A record that cannot be read is a warning and the article falls back to guessing.
  assert.match(by['bad-article-yaml-sample'].warnings.join(), /article\.yaml を読めなかった/);
  assert.equal(by['bad-article-yaml-sample'].stage, 'writing');
});

test('GitHub fields: a PR the record names but GitHub does not return is state unknown, not dropped', async () => {
  const result = await scanDrafts(githubFixture, { github: fakeGithub({ 'example/site': [] }) });
  const d = bySlug(result)['ready-sample'];
  assert.deepEqual([d.prs[0].state, d.prs[0].via, d.stage], ['unknown', 'record', 'gate-ci']);
  assert.match(d.warnings.join(), /GitHub に見つからない/);
});

test('PR不明: finished with nothing linking a PR is not called PR待ち; a branch-name match (a guess) makes it 公開済み', async () => {
  const none = bySlug(await scanDrafts(fixture, { github: fakeGithub({ 'example/site': [pr(50, 'open', { branch: 'content/something-else' })] }), prRepos: ['example/site'] }));
  assert.deepEqual([none['branch-sample-20261113'].stage, none['branch-sample-20261113'].stageLabel], ['pr-unknown', 'PR不明']);
  const matched = bySlug(await scanDrafts(fixture, { github: fakeGithub(siteTable), prRepos: ['example/site'] }));
  const d = matched['branch-sample-20261113'];
  assert.deepEqual([d.stage, d.prs.map((p) => [p.number, p.state, p.via])], ['published', [[31, 'merged', 'branch'], [32, 'merged', 'branch']]]);
  assert.match(d.warnings.join(), /記録（article\.yaml）がなく/);
});

// ---- manual registration, due dates, read-only ------------------------------------------------------------

test('manual registration: an article with no folder is read from the files drafts.index.yaml names, with the same record fields', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'wle-index-'));
  try {
    await cp(fixtures, path.join(tmp, 'hq'), { recursive: true });
    const gh = fakeGithub({ 'example/site': [pr(114, 'open', { branch: 'content/loose-intro-20261106', ci: ciGreen })] });
    const result = await scanDrafts(path.join(tmp, 'hq', 'drafts'), { github: gh, indexFile: path.join(tmp, 'hq', 'index', 'loose.index.yaml') });
    assert.equal(result.drafts.length, 10);
    const loose = bySlug(result)['loose-20261106'];
    assert.deepEqual([loose.source, loose.title, loose.medium], ['manual', '合成データ：フォルダのない記事', 'ニュースレター']);
    // No finished.json (there is no editor run), so an open PR is still waiting for the author to confirm.
    assert.deepEqual([loose.stage, loose.waitingOn], ['awaiting-confirm', 'author']);
    assert.deepEqual(loose.prs.map((p) => [p.number, p.state, p.via]), [[114, 'open', 'record']]);
    assert.deepEqual(result.warnings, []);
  } finally { await rm(tmp, { recursive: true, force: true }); }
});

test('manual registration: the default file is <root>/drafts.index.yaml; a bad or colliding entry is a scan warning, never a failure', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'wle-index-'));
  try {
    const root = path.join(tmp, 'drafts');
    await cp(fixture, root, { recursive: true });
    await writeFile(path.join(root, 'drafts.index.yaml'), 'drafts:\n  - slug: writing-sample\n    title: collides\n  - slug: ok-one\n    title: 合成データ\n    files: [missing.md]\n    pr: [5]\n');
    const result = await scanDrafts(root);
    assert.match(result.warnings.join(), /writing-sample は同名のフォルダがあるため無視/);
    assert.match(bySlug(result)['ok-one'].warnings.join(), /見つからない: missing\.md/);
    assert.match(bySlug(result)['ok-one'].warnings.join(), /PR #5 に repo がない/);
    assert.equal(bySlug(result)['ok-one'].stage, 'writing');
    await writeFile(path.join(root, 'drafts.index.yaml'), 'drafts: [{slug: x, title: t, files: ["../etc/passwd"]}]\n');
    const bad = await scanDrafts(root);
    assert.match(bad.warnings.join(), /drafts\.index\.yaml を読めなかった/);
    assert.equal(bad.drafts.length, 9);
  } finally { await rm(tmp, { recursive: true, force: true }); }
});

test('due dates: the TaskNote an article mentions most gives the due date; finished notes and stray mentions do not', async () => {
  const notes = await loadTaskNotes(tasknotes);
  assert.equal(notes.length, 3);
  assert.deepEqual(parseTaskNote('---\ntitle: x\nkey: TASK-1\ndue: 2026-11-19\nkanban: job_12345678\nstatus: "open"\n---\n'), { key: 'TASK-1', kanban: 'job_12345678', status: 'open', due: '2026-11-19' });
  assert.equal(parseTaskNote('no frontmatter'), null);
  assert.deepEqual(dueFromNotes(['TASK-901', 'job_aaaa0001', 'TASK-902'], notes), { due: '2026-12-05', from: 'TASK-901' });
  assert.equal(dueFromNotes(['TASK-903', 'job_bbbb0003'], notes), null);
  assert.equal(dueFromNotes(['TASK-999'], notes), null);
  const by = bySlug(await scanDrafts(fixture, { taskNotesDir: tasknotes }));
  assert.deepEqual([by['deciding-sample'].due, by['deciding-sample'].dueFrom], ['2026-12-05', 'TASK-901']);
  assert.equal(by['writing-sample'].due, null);
  assert.deepEqual([by['override-sample'].due, by['override-sample'].dueFrom], ['2026-12-01', 'status.override.json']);
});

test('due dates: a missing TaskNotes folder is a warning and the list still shows', async () => {
  const result = await scanDrafts(fixture, { taskNotesDir: path.join(fixture, 'nope') });
  assert.equal(result.drafts.length, 9);
  assert.match(result.warnings.join(), /TaskNotes を読めなかった/);
});

test('placeholders add to 未決: the editor draft is read when it exists, else the source file', async () => {
  const by = bySlug(await scanDrafts(fixture));
  const p = by['placeholder-sample'];
  assert.deepEqual([p.stage, p.openDecisions, p.placeholders], ['awaiting-confirm', 1, ['著者の体験：初めて読んだときの記憶を一言']]);
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'wle-ph-'));
  try {
    const root = path.join(tmp, 'drafts');
    await cp(fixture, root, { recursive: true });
    const edited = path.join(root, 'placeholder-sample/editor-run/05_final/editor/placeholder-v1');
    await mkdir(edited, { recursive: true });
    await writeFile(path.join(edited, 'nat-final.md'), '# 合成データ\n\n著者が書いた一言。\n');
    assert.equal(bySlug(await scanDrafts(root))['placeholder-sample'].openDecisions, 0);
  } finally { await rm(tmp, { recursive: true, force: true }); }
});

test('scan is read-only: the tree (names, sizes, mtimes) is identical afterwards, and nothing is created', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'wle-core-'));
  try {
    await cp(fixtures, path.join(tmp, 'f'), { recursive: true });
    const snapshot = async (dir: string): Promise<string[]> => {
      const out: string[] = [];
      for (const e of await readdir(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) out.push(`${p}/`, ...(await snapshot(p)));
        else { const s = await stat(p); out.push(`${p} ${s.size} ${s.mtimeMs}`); }
      }
      return out.sort();
    };
    const before = await snapshot(tmp);
    await scanDrafts(path.join(tmp, 'f', 'drafts'), { github: fakeGithub(siteTable), taskNotesDir: path.join(tmp, 'f', 'tasknotes') });
    await scanDrafts(path.join(tmp, 'f', 'github'), { github: fakeGithub(siteTable) });
    await listEditorRuns(path.join(tmp, 'f', 'drafts'));
    assert.deepEqual(await snapshot(tmp), before);
  } finally { await rm(tmp, { recursive: true, force: true }); }
});

test('editor runs: each scanned run has a key that decodes to its folder under the root', async () => {
  const runs = await listEditorRuns(fixture);
  assert.deepEqual(runs.map((r) => r.relPath).sort(), ['branch-sample-20261113/editor-run', 'confirmed-sample/editor-run', 'editing-sample/editor-run', 'placeholder-sample/editor-run', 'pr-sample/editor-run']);
  for (const r of runs) assert.equal(decodeRunKey(r.key), r.relPath);
});

test('a missing root is an error the caller can report, not an empty list', async () => {
  await assert.rejects(scanDrafts(path.join(fixture, 'nope')), /ENOENT/);
});
