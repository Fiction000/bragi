import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createDecision, decisionsFor, getContext, getDraft, listDrafts, loadLedger, renderContext, retireDecision, UnknownDraft, type DecisionInput } from '../src/index.ts';

const run = promisify(execFile);
const drafts = path.resolve('test/fixtures/drafts');
const base = { status: 'active' as const, decided_by: '著者', decided_at: '2026-11-16', kind: 'fact' as const, source: 'synthetic#Q', check: { type: 'none' as const } };
const mk = (id: string, over: Partial<DecisionInput>): DecisionInput => ({ ...base, id, scope: 'draft', draft: 'deciding-sample', medium: null, body: `合成の判断 ${id}`, ...over });

async function ledger() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wle-ctx-'));
  const L = path.join(dir, 'ledger');
  await createDecision(L, mk('D-2026-11-16-g-q01', { scope: 'global', draft: null, body: '合成：全体の判断' }));
  await createDecision(L, mk('D-2026-11-16-m-q02', { scope: 'medium', draft: null, medium: '解説記事', body: '合成：解説記事の判断' }));
  await createDecision(L, mk('D-2026-11-16-other-medium', { scope: 'medium', draft: null, medium: '別の媒体', body: '合成：別媒体の判断' }));
  await createDecision(L, mk('D-2026-11-16-d-q03', { body: '合成：deciding-sample だけの判断' }));
  await createDecision(L, mk('D-2026-11-16-other-draft', { draft: 'writing-sample', body: '合成：別記事の判断' }));
  await createDecision(L, mk('D-2026-11-16-old', { scope: 'medium', draft: null, medium: '解説記事', body: '合成：取り消した判断' }));
  await retireDecision(L, 'D-2026-11-16-old', '2026-11-18');
  return { dir, L };
}

test('context: global + the medium + the draft, active only; another draft, another medium and retired ones stay out', async () => {
  const { dir, L } = await ledger();
  try {
    const { decisions } = await loadLedger(L);
    const g = decisionsFor(decisions, { draft: 'deciding-sample', medium: '解説記事' });
    assert.deepEqual([g.global, g.medium, g.draft].map((l) => l.map((d) => d.meta.id)), [['D-2026-11-16-g-q01'], ['D-2026-11-16-m-q02'], ['D-2026-11-16-d-q03']]);
    const other = decisionsFor(decisions, { draft: 'writing-sample', medium: '解説記事' });
    assert.deepEqual([other.global.length, other.medium.length, other.draft.map((d) => d.meta.id)], [1, 1, ['D-2026-11-16-other-draft']]);
    // A draft with no known medium gets no medium decisions at all.
    assert.equal(decisionsFor(decisions, { draft: 'x', medium: null }).medium.length, 0);
    const md = renderContext(decisions, { draft: 'deciding-sample', medium: '解説記事' });
    assert.match(md, /有効な判断 3件（全体 1・媒体 1・この記事 1）/);
    assert.ok(md.includes('合成：全体の判断') && md.includes('合成：解説記事の判断') && md.includes('合成：deciding-sample だけの判断'));
    assert.ok(!md.includes('別記事') && !md.includes('別媒体') && !md.includes('取り消した'));
    assert.match(renderContext([], { draft: 'x', medium: null }), /この記事に効く判断はありません/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('service: list / get / context read the fixture drafts and the ledger; an unknown draft is an error that names the known ones', async () => {
  const { dir, L } = await ledger();
  try {
    const o = { draftsRoot: drafts, ledgerDir: L, taskNotesDir: null };
    const list = await listDrafts(o);
    assert.equal(list.drafts.length, 9);
    assert.deepEqual(list.drafts.find((d) => d.slug === 'deciding-sample')?.stage, 'awaiting-decision');
    assert.equal((await getDraft(o, 'deciding-sample')).medium, '解説記事');
    const md = await getContext(o, 'deciding-sample');
    assert.match(md, /有効な判断 3件/);
    await assert.rejects(getContext(o, 'nope'), (e: Error) => e instanceof UnknownDraft && /deciding-sample/.test(e.message));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('bragi context <draft> prints the same Markdown; an unknown draft exits 1 with a message', async () => {
  const { dir, L } = await ledger();
  try {
    const args = ['--drafts-root', drafts, '--ledger', L, '--tasknotes', path.join(dir, 'none')];
    const ok = await run('node', ['src/bragi.ts', 'context', 'deciding-sample', ...args]);
    assert.match(ok.stdout, /^# 判断台帳：deciding-sample に効く判断/);
    assert.match(ok.stdout, /全体 1・媒体 1・この記事 1/);
    await assert.rejects(run('node', ['src/bragi.ts', 'context', 'nope', ...args]), (e: { code: number; stderr: string }) => e.code === 1 && /unknown draft "nope"/.test(e.stderr));
    await assert.rejects(run('node', ['src/bragi.ts']), (e: { code: number }) => e.code === 2);
    const list = await run('node', ['src/bragi.ts', 'list', ...args]);
    assert.equal(list.stdout.trim().split('\n').length, 9);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('service: context reads a ledger with Vault metadata, and a refused file is listed with its reason', async () => {
  const { dir, L } = await ledger();
  try {
    await cp(path.resolve('test/fixtures/ledger-vault/D-2026-11-16-vault-q01.md'), path.join(L, 'D-2026-11-16-vault-q01.md'));
    const o = { draftsRoot: drafts, ledgerDir: L, taskNotesDir: null };
    const md = await getContext(o, 'deciding-sample');
    assert.match(md, /有効な判断 4件/);
    assert.match(md, /Vault のメタデータが付いた判断/);
    assert.doesNotMatch(md, /読めなかった/);
    await writeFile(path.join(L, 'D-2026-11-16-bad.md'), '---\nid: D-2026-11-16-bad\nsurprise: 1\n---\nx\n');
    const bad = await getContext(o, 'deciding-sample');
    assert.match(bad, /読めなかった台帳ファイル 1件\n> - D-2026-11-16-bad\.md：.*unknown key surprise/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
