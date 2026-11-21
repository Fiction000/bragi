import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { adoptProposal, createDecision, getCandidates, getContext, getRecurrence, loadLedger, loadProposals, parseProposal, proposalsDirFor, proposeDecision, proposeDecisionFor, rejectProposal, UnknownDraft, type ProposalInput } from '../src/index.ts';

const fixtureDrafts = path.resolve(import.meta.dirname, 'fixtures/drafts');
const NOW = '2026-11-21';

// Everything lives under one temp dir: <tmp>/ledger (the ledger), <tmp>/proposals (proposals, its sibling), <tmp>/drafts.
async function setup() {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'wle-prop-'));
  await cp(fixtureDrafts, path.join(tmp, 'drafts'), { recursive: true });
  const ledger = path.join(tmp, 'ledger');
  const proposals = proposalsDirFor(ledger);
  const opts = { draftsRoot: path.join(tmp, 'drafts'), ledgerDir: ledger, taskNotesDir: null, github: null };
  return { tmp, ledger, proposals, opts, close: () => rm(tmp, { recursive: true, force: true }) };
}
const input = (over: Partial<ProposalInput> = {}): ProposalInput => ({ slug: 'no-feelings', proposed_by: 'test-agent', draft: 'deciding-sample', kind: 'fact', source: 'drafts/deciding-sample/copy-review-report-sample.md#Q01', body: '確認表にない心情は書かない。', ...over });

/** path -> text for every file under dir (a missing dir is empty). */
async function files(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) Object.assign(out, await files(p));
    else out[p] = await readFile(p, 'utf8');
  }
  return out;
}
const exists = (p: string) => stat(p).then(() => true, () => false);

test('propose: writes exactly one file in the proposals folder, with the proposal fields, and nothing in the ledger folder', async () => {
  const t = await setup();
  try {
    const r = await proposeDecision(t.proposals, t.ledger, input(), NOW);
    assert.equal(r.created, true);
    assert.equal(path.basename(r.proposal.file), 'P-2026-11-21-no-feelings.md');
    assert.deepEqual(Object.keys(await files(t.proposals)), [path.join(t.proposals, 'P-2026-11-21-no-feelings.md')]);
    assert.equal(await exists(t.ledger), false, 'the ledger folder was not even created');
    const text = await readFile(r.proposal.file, 'utf8');
    assert.match(text, /^proposed_by: test-agent$/m);
    assert.match(text, /^proposed_at: 2026-11-21$/m);
    assert.match(text, /^status: pending$/m);
    assert.match(text, /^scope: draft$/m, 'the default scope is draft');
    assert.match(text, /^draft: deciding-sample$/m);
    const back = parseProposal(text, r.proposal.file);
    assert.deepEqual([back.meta.status, back.meta.scope, back.body], ['pending', 'draft', '確認表にない心情は書かない。']);
    assert.deepEqual((await loadProposals(t.proposals)).proposals.map((p) => p.meta.id), ['P-2026-11-21-no-feelings']);
  } finally { await t.close(); }
});

test('a proposal never shows up in the ledger side: loadLedger, bragi context, candidates and recurrence are unchanged', async () => {
  const t = await setup();
  try {
    await createDecision(t.ledger, { id: 'D-2026-11-16-existing-q01', scope: 'draft', draft: 'deciding-sample', kind: 'fact', status: 'active', decided_by: '著者', decided_at: '2026-11-16', source: 's', body: '既存の判断。' });
    const read = async () => JSON.stringify({ ledger: (await loadLedger(t.ledger)).decisions.map((d) => d.meta.id), ctx: await getContext(t.opts, 'deciding-sample'), cand: (await getCandidates(t.opts, 'deciding-sample')).text, rec: (await getRecurrence(t.opts)).text });
    const before = await read();
    const ledgerBefore = await files(t.ledger);
    await proposeDecision(t.proposals, t.ledger, input({ body: '提案の文言。' }), NOW);
    await proposeDecision(t.proposals, t.ledger, input({ slug: 'second', scope: 'global', draft: null, body: '全体への提案。' }), NOW);
    assert.equal((await loadProposals(t.proposals)).proposals.length, 2);
    assert.equal(await read(), before);
    assert.deepEqual(await files(t.ledger), ledgerBefore);
    assert.equal((await loadLedger(t.ledger)).decisions.length, 1);
    const ctx = await getContext(t.opts, 'deciding-sample');
    assert.ok(!ctx.includes('全体への提案') && !ctx.includes('提案の文言') && !ctx.includes('P-2026'));
  } finally { await t.close(); }
});

test('the proposals folder can never be the ledger folder, inside it, or hold it: refused before anything is written', async () => {
  const t = await setup();
  try {
    await assert.rejects(proposeDecision(t.ledger, t.ledger, input(), NOW), /outside the ledger/);
    await assert.rejects(proposeDecision(path.join(t.ledger, 'proposals'), t.ledger, input(), NOW), /outside the ledger/);
    await assert.rejects(proposeDecision(t.tmp, t.ledger, input(), NOW), /outside the ledger/);
    await assert.rejects(proposeDecisionFor({ ...t.opts, proposalsDir: t.ledger }, input(), NOW), /outside the ledger/);
    assert.equal(await exists(t.ledger), false);
    assert.equal(path.dirname(t.proposals), path.dirname(t.ledger));
  } finally { await t.close(); }
});

test('duplicates: the same wording for the same scope/target/kind returns the existing proposal and writes nothing; any difference is a new one', async () => {
  const t = await setup();
  try {
    const first = await proposeDecision(t.proposals, t.ledger, input(), NOW);
    const before = await files(t.proposals);
    // other slug, other agent, other day, extra whitespace: still the same proposal
    const dup = await proposeDecision(t.proposals, t.ledger, input({ slug: 'another-slug', proposed_by: 'other-agent', body: '  確認表にない心情は書かない。 \n' }), '2026-11-22');
    assert.equal(dup.created, false);
    assert.equal(dup.proposal.meta.id, first.proposal.meta.id);
    const dupSource = await proposeDecision(t.proposals, t.ledger, input({ slug: 'wide', source: 'x#Q9' }), NOW);
    assert.equal(dupSource.created, false);
    assert.deepEqual(await files(t.proposals), before, 'no file was added or changed');
    // spacing inside the text and full-width letters do not make a different proposal
    const w = await proposeDecision(t.proposals, t.ledger, input({ slug: 'spaced', draft: 'writing-sample', body: 'ＡＢ　心情は   書かない。' }), NOW);
    assert.equal(w.created, true);
    const w2 = await proposeDecision(t.proposals, t.ledger, input({ slug: 'spaced-2', draft: 'writing-sample', body: 'AB 心情は\n書かない。' }), NOW);
    assert.deepEqual([w2.created, w2.proposal.meta.id], [false, 'P-2026-11-21-spaced']);
    await rm(w.proposal.file);
    // a different kind, article, wording or scope is a different proposal
    for (const [slug, over] of [['s-kind', { kind: 'phrasing' }], ['s-draft', { draft: 'writing-sample' }], ['s-text', { body: '別の文言。' }], ['s-global', { scope: 'global', draft: null }]] as const) {
      assert.equal((await proposeDecision(t.proposals, t.ledger, input({ slug, ...over } as Partial<ProposalInput>), NOW)).created, true, slug);
    }
    assert.equal(Object.keys(await files(t.proposals)).length, 5);
    // a rejected proposal still counts: the agent cannot push the same thing again
    await rejectProposal(t.proposals, 'P-2026-11-21-no-feelings', NOW);
    assert.equal((await proposeDecision(t.proposals, t.ledger, input({ slug: 'again' }), NOW)).created, false);
    // same id, different wording: refused, not overwritten
    await assert.rejects(proposeDecision(t.proposals, t.ledger, input({ body: '同じ id で別の文言。' }), NOW), /already has the id/);
  } finally { await t.close(); }
});

test('validation: what the ledger schema would refuse is refused, and nothing is written', async () => {
  const t = await setup();
  try {
    const bad: [string, Partial<ProposalInput>, RegExp][] = [
      ['draft scope without a draft', { draft: null }, /draft/],
      ['medium scope without a medium', { scope: 'medium', draft: null }, /medium/],
      ['medium with the draft scope', { medium: '解説記事' }, /medium/],
      ['global with a draft', { scope: 'global' }, /draft/],
      ['empty text', { body: '   ' }, /empty/],
      ['bad kind', { kind: 'nope' as never }, /kind/],
      ['bad scope', { scope: 'nope' as never }, /scope/],
      ['bad slug', { slug: 'Has Space' }, /slug/],
      ['empty source', { source: '' }, /source/],
      ['empty agent name', { proposed_by: '' }, /proposed_by/],
      ['regex check without a pattern', { check: { type: 'regex', pattern: '' } }, /pattern/],
    ];
    for (const [name, over, re] of bad) {
      await assert.rejects(proposeDecision(t.proposals, t.ledger, input(over), NOW), (e: Error) => re.test(JSON.stringify((e as { issues?: unknown }).issues ?? e.message)), name);
    }
    await assert.rejects(proposeDecision(t.proposals, t.ledger, input(), 'yesterday'), /YYYY-MM-DD/);
    assert.equal(await exists(t.proposals), false, 'the folder was never created');
    // a good regex check and a medium proposal pass
    assert.equal((await proposeDecision(t.proposals, t.ledger, input({ slug: 'with-check', check: { type: 'regex', pattern: '影を落とした', message: '人物評' }, body: 'x' }), NOW)).created, true);
    assert.equal((await proposeDecision(t.proposals, t.ledger, input({ slug: 'medium-one', scope: 'medium', draft: null, medium: '解説記事', body: 'y' }), NOW)).created, true);
  } finally { await t.close(); }
});

test('proposeDecisionFor: a draft-scope proposal must name an existing article (nothing written otherwise); the folder is next to the ledger', async () => {
  const t = await setup();
  try {
    await assert.rejects(proposeDecisionFor(t.opts, input({ draft: 'no-such-article' }), NOW), UnknownDraft);
    assert.equal(await exists(t.proposals), false);
    const r = await proposeDecisionFor(t.opts, input(), NOW);
    assert.equal(r.created, true);
    assert.equal(path.dirname(r.proposal.file), t.proposals);
    assert.equal((await proposeDecisionFor(t.opts, input({ scope: undefined }), NOW)).created, false);
  } finally { await t.close(); }
});

test('adopt: one new ledger file and one changed proposal file (status lines only); the proposal stays as adopted', async () => {
  const t = await setup();
  try {
    await proposeDecision(t.proposals, t.ledger, input(), NOW);
    await proposeDecision(t.proposals, t.ledger, input({ slug: 'other', body: '別の候補。' }), NOW);
    await createDecision(t.ledger, { id: 'D-2026-11-16-existing-q01', scope: 'draft', draft: 'writing-sample', kind: 'fact', status: 'active', decided_by: '著者', decided_at: '2026-11-16', source: 's', body: '既存。' });
    const pBefore = await files(t.proposals);
    const lBefore = await files(t.ledger);

    const { proposal, decision } = await adoptProposal(t.proposals, t.ledger, 'P-2026-11-21-no-feelings', '2026-11-22', '著者');
    assert.equal(decision.meta.id, 'D-2026-11-22-no-feelings');

    const lAfter = await files(t.ledger);
    assert.deepEqual(Object.keys(lAfter).filter((f) => !(f in lBefore)).map((f) => path.basename(f)), ['D-2026-11-22-no-feelings.md']);
    assert.equal(Object.keys(lAfter).length, Object.keys(lBefore).length + 1);
    for (const [f, text] of Object.entries(lBefore)) assert.equal(lAfter[f], text, 'existing ledger files are untouched');

    const pAfter = await files(t.proposals);
    assert.deepEqual(Object.keys(pAfter).sort(), Object.keys(pBefore).sort(), 'no proposal file was added or removed');
    const f = path.join(t.proposals, 'P-2026-11-21-no-feelings.md');
    assert.deepEqual(Object.keys(pAfter).filter((k) => pAfter[k] !== pBefore[k]), [f]);
    assert.equal(pAfter[f], pBefore[f].replace('status: pending\n', 'status: adopted\nresolved_at: 2026-11-22\nadopted_as: D-2026-11-22-no-feelings\n'));
    assert.deepEqual([proposal.meta.status, proposal.meta.adopted_as], ['adopted', 'D-2026-11-22-no-feelings']);

    // the new decision is a normal active ledger decision, decided by the person, and now reaches the brief
    const { decisions, problems } = await loadLedger(t.ledger);
    assert.deepEqual(problems, []);
    const d = decisions.find((x) => x.meta.id === 'D-2026-11-22-no-feelings')!;
    assert.deepEqual([d.meta.status, d.meta.decided_by, d.meta.decided_at, d.meta.scope, d.meta.draft, d.body], ['active', '著者', '2026-11-22', 'draft', 'deciding-sample', '確認表にない心情は書かない。']);
    assert.match(await getContext(t.opts, 'deciding-sample'), /確認表にない心情は書かない/);
    // the other proposal is still pending; the adopted one cannot be adopted or rejected again
    assert.deepEqual((await loadProposals(t.proposals)).proposals.map((p) => p.meta.status), ['adopted', 'pending']);
    await assert.rejects(adoptProposal(t.proposals, t.ledger, 'P-2026-11-21-no-feelings', '2026-11-22', '著者'), /already adopted/);
    await assert.rejects(rejectProposal(t.proposals, 'P-2026-11-21-no-feelings', '2026-11-22'), /already adopted/);
    assert.deepEqual(await files(t.ledger), lAfter);
  } finally { await t.close(); }
});

test('adopt: an id the ledger already has is refused and the proposal stays pending; unknown and malformed ids are refused', async () => {
  const t = await setup();
  try {
    await proposeDecision(t.proposals, t.ledger, input(), NOW);
    await createDecision(t.ledger, { id: 'D-2026-11-22-no-feelings', scope: 'global', kind: 'fact', status: 'active', decided_by: '著者', decided_at: '2026-11-22', source: 's', body: '先にある。' });
    const l = await files(t.ledger), p = await files(t.proposals);
    await assert.rejects(adoptProposal(t.proposals, t.ledger, 'P-2026-11-21-no-feelings', '2026-11-22', '著者'), /already has/);
    await assert.rejects(adoptProposal(t.proposals, t.ledger, 'P-2026-11-21-none', '2026-11-22', '著者'), /not found/);
    await assert.rejects(adoptProposal(t.proposals, t.ledger, '../x', '2026-11-22', '著者'), /bad proposal id/);
    assert.deepEqual([await files(t.ledger), await files(t.proposals)], [l, p]);
  } finally { await t.close(); }
});

test('reject: the status lines of that one proposal change, the ledger is untouched, and a rejected proposal cannot be adopted', async () => {
  const t = await setup();
  try {
    await proposeDecision(t.proposals, t.ledger, input(), NOW);
    await proposeDecision(t.proposals, t.ledger, input({ slug: 'other', body: '別の候補。' }), NOW);
    const p = await files(t.proposals);
    const r = await rejectProposal(t.proposals, 'P-2026-11-21-no-feelings', '2026-11-22');
    assert.equal(r.meta.status, 'rejected');
    const after = await files(t.proposals);
    const f = path.join(t.proposals, 'P-2026-11-21-no-feelings.md');
    assert.deepEqual(Object.keys(after).filter((k) => after[k] !== p[k]), [f]);
    assert.equal(after[f], p[f].replace('status: pending\n', 'status: rejected\nresolved_at: 2026-11-22\n'));
    assert.equal(await exists(t.ledger), false);
    await assert.rejects(adoptProposal(t.proposals, t.ledger, 'P-2026-11-21-no-feelings', '2026-11-22', '著者'), /already rejected/);
    assert.equal(await exists(t.ledger), false);
  } finally { await t.close(); }
});

test('a proposal file that does not read is reported, not fatal; a hand-edited file that breaks the schema cannot be adopted', async () => {
  const t = await setup();
  try {
    await proposeDecision(t.proposals, t.ledger, input(), NOW);
    const good = await readFile(path.join(t.proposals, 'P-2026-11-21-no-feelings.md'), 'utf8');
    await writeFile(path.join(t.proposals, 'P-2026-11-21-extra.md'), good.replace('P-2026-11-21-no-feelings', 'P-2026-11-21-extra').replace('status: pending', 'status: pending\nsurprise: 1'));
    await writeFile(path.join(t.proposals, 'P-2026-11-21-draftless.md'), good.replace('P-2026-11-21-no-feelings', 'P-2026-11-21-draftless').replace('draft: deciding-sample', 'draft: null'));
    await writeFile(path.join(t.proposals, 'notes.md'), 'no frontmatter');
    const { proposals, problems } = await loadProposals(t.proposals);
    assert.deepEqual(proposals.map((p) => p.meta.id), ['P-2026-11-21-no-feelings']);
    assert.deepEqual(problems.map((p) => p.file).sort(), ['P-2026-11-21-draftless.md', 'P-2026-11-21-extra.md', 'notes.md']);
    await assert.rejects(adoptProposal(t.proposals, t.ledger, 'P-2026-11-21-draftless', '2026-11-22', '著者'));
    assert.equal(await exists(t.ledger), false);
  } finally { await t.close(); }
});
