import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDecision, loadLedger, parseDecision, retireDecision, serializeDecision, type DecisionInput } from '../src/index.ts';

const sample = (over: Partial<DecisionInput> = {}): DecisionInput => ({
  id: 'D-2026-11-16-sample-q02', scope: 'medium', medium: '合成の媒体', draft: null, kind: 'fact-policy', status: 'active',
  decided_by: '著者', decided_at: '2026-11-16', source: 'drafts/sample/copy-review-report.md#Q02', check: { type: 'none' },
  body: '確認表にない心情は書かない。\n\n**なぜ**：根拠のない人物評を避けるため。', ...over,
});
const tmpdir = () => mkdtemp(path.join(os.tmpdir(), 'wle-ledger-'));

test('ledger: the design note\'s example shape is accepted; a written decision reads back identically', () => {
  const text = serializeDecision(sample());
  assert.match(text, /^---\nid: D-2026-11-16-sample-q02\nscope: medium\nmedium: 合成の媒体\ndraft: null\nkind: fact-policy\nstatus: active\n/);
  const d = parseDecision(text, '/x/D-2026-11-16-sample-q02.md');
  assert.deepEqual([d.meta.scope, d.meta.medium, d.meta.check, d.body.startsWith('確認表にない')], ['medium', '合成の媒体', { type: 'none' }, true]);
  assert.equal(serializeDecision({ ...d.meta, body: d.body }), text);
});

test('ledger: zod refuses a bad shape (scope without its field, unknown key, bad id/date/kind, empty body, name mismatch)', () => {
  const bad = (over: Partial<DecisionInput> & Record<string, unknown>) => () => serializeDecision(sample(over));
  assert.throws(bad({ scope: 'medium', medium: null }), /scope=medium needs medium/);
  assert.throws(bad({ scope: 'draft', draft: null, medium: null }), /needs draft/);
  assert.throws(bad({ scope: 'global', medium: 'x' }), /only goes with scope=medium/);
  assert.throws(bad({ id: 'bad id' }), /id is D-/);
  assert.throws(bad({ decided_at: '16/11/2026' }), /YYYY-MM-DD/);
  assert.throws(bad({ kind: 'opinion' as never }));
  assert.throws(bad({ extra: 1 }));
  assert.throws(bad({ body: '  ' }));
  assert.throws(bad({ status: 'retired' }), /retired_at/);
  assert.throws(() => parseDecision(serializeDecision(sample()), '/x/other.md'), /file name must be/);
  assert.throws(() => parseDecision('no frontmatter', '/x/a.md'), /frontmatter/);
  assert.equal(parseDecision(serializeDecision(sample({ check: { type: 'regex', pattern: '極限まで' } })), '/x/D-2026-11-16-sample-q02.md').meta.check.type, 'regex');
});

test('ledger: create writes one file, never overwrites, and a bad input writes nothing', async () => {
  const dir = await tmpdir();
  try {
    const sub = path.join(dir, 'ledger');
    await createDecision(sub, sample());
    assert.deepEqual(await readdir(sub), ['D-2026-11-16-sample-q02.md']);
    await assert.rejects(createDecision(sub, sample({ body: 'another' })), /EEXIST/);
    assert.match(await readFile(path.join(sub, 'D-2026-11-16-sample-q02.md'), 'utf8'), /確認表にない/);
    await assert.rejects(createDecision(sub, sample({ id: 'D-2026-11-16-x', scope: 'draft', draft: null, medium: null })));
    assert.deepEqual(await readdir(sub), ['D-2026-11-16-sample-q02.md']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('ledger: retire changes status to retired and adds retired_at, touching nothing else (a two-line diff)', async () => {
  const dir = await tmpdir();
  try {
    await createDecision(dir, sample());
    await createDecision(dir, sample({ id: 'D-2026-11-16-sample-q03', scope: 'draft', draft: 'sample-20261113', medium: null }));
    const file = path.join(dir, 'D-2026-11-16-sample-q02.md');
    const other = await readFile(path.join(dir, 'D-2026-11-16-sample-q03.md'), 'utf8');
    const before = (await readFile(file, 'utf8')).split('\n');
    const d = await retireDecision(dir, 'D-2026-11-16-sample-q02', '2026-11-19');
    assert.deepEqual([d.meta.status, d.meta.retired_at], ['retired', '2026-11-19']);
    const after = (await readFile(file, 'utf8')).split('\n');
    const removed = before.filter((l) => !after.includes(l));
    const added = after.filter((l) => !before.includes(l));
    assert.deepEqual([removed, added], [['status: active'], ['status: retired', 'retired_at: 2026-11-19']]);
    assert.equal(after.length, before.length + 1);
    assert.equal(await readFile(path.join(dir, 'D-2026-11-16-sample-q03.md'), 'utf8'), other);
    await assert.rejects(retireDecision(dir, 'D-2026-11-16-sample-q02', '2026-11-20'), /already retired/);
    await assert.rejects(retireDecision(dir, 'D-2026-11-16-nope', '2026-11-20'), /not found/);
    await assert.rejects(retireDecision(dir, '../../etc/passwd', '2026-11-20'), /bad decision id/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('ledger: a hand-edited file keeps its own formatting when retired', async () => {
  const dir = await tmpdir();
  try {
    const text = '---\nid: D-2026-11-16-hand-q01\nscope: global   # edited in Obsidian\nmedium: null\ndraft: null\nkind: phrasing\nstatus: active\ndecided_by: 著者\ndecided_at: 2026-11-16\nsource: memo\ncheck:\n  type: none\n---\n本文。\n';
    await writeFile(path.join(dir, 'D-2026-11-16-hand-q01.md'), text);
    await retireDecision(dir, 'D-2026-11-16-hand-q01', '2026-11-19');
    assert.equal(await readFile(path.join(dir, 'D-2026-11-16-hand-q01.md'), 'utf8'), text.replace('status: active\n', 'status: retired\nretired_at: 2026-11-19\n'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('ledger: loading lists decisions in date order, reports a broken file without failing, and a missing folder is empty', async () => {
  const dir = await tmpdir();
  try {
    await createDecision(dir, sample({ id: 'D-2026-11-17-b-q01', decided_at: '2026-11-17' }));
    await createDecision(dir, sample());
    await writeFile(path.join(dir, 'D-2026-11-18-broken.md'), '---\nid: D-2026-11-18-broken\nscope: nope\n---\nx\n');
    await writeFile(path.join(dir, 'README.txt'), 'not a decision');
    const { decisions, problems } = await loadLedger(dir);
    assert.deepEqual(decisions.map((d) => d.meta.id), ['D-2026-11-16-sample-q02', 'D-2026-11-17-b-q01']);
    assert.equal(problems.length, 1);
    assert.equal(problems[0].file, 'D-2026-11-18-broken.md');
    assert.deepEqual(await loadLedger(path.join(dir, 'nope')), { decisions: [], problems: [] });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

const vaultFixture = path.resolve('test/fixtures/ledger-vault');
const vaultFile = 'D-2026-11-16-vault-q01.md';

test('ledger: note-vault metadata (tags, created, updated, agent_generated, aliases) is accepted and is not part of the decision', async () => {
  const { decisions, problems } = await loadLedger(vaultFixture);
  assert.deepEqual(problems, []);
  assert.equal(decisions.length, 1);
  assert.deepEqual([decisions[0].meta.id, decisions[0].meta.scope, decisions[0].meta.medium], ['D-2026-11-16-vault-q01', 'medium', '解説記事']);
  assert.deepEqual(Object.keys(decisions[0].meta).filter((k) => ['tags', 'created', 'updated', 'agent_generated', 'aliases', 'owner'].includes(k)), []);
});

test('ledger: the decision keys stay strict next to Vault metadata, and a wrong-typed Vault key is refused', async () => {
  const text = await readFile(path.join(vaultFixture, vaultFile), 'utf8');
  const file = `/x/${vaultFile}`;
  assert.throws(() => parseDecision(text.replace('\n---\n\n', '\nsurprise: 1\n---\n\n'), file), /unrecognized|Unrecognized/);
  assert.throws(() => parseDecision(text.replace('agent_generated: true', 'agent_generated: maybe'), file), /agent_generated|boolean/);
  assert.throws(() => parseDecision(text.replace('scope: medium', 'scope: nope'), file), /scope/);
});

test('ledger: a refused file is reported with a one-line reason that names the key', async () => {
  const dir = await tmpdir();
  try {
    const text = await readFile(path.join(vaultFixture, vaultFile), 'utf8');
    await writeFile(path.join(dir, 'D-2026-11-16-extra.md'), text.replace('id: D-2026-11-16-vault-q01', 'id: D-2026-11-16-extra').replace('\n---\n\n', '\nsurprise: 1\n---\n\n'));
    await writeFile(path.join(dir, 'D-2026-11-16-badscope.md'), text.replace('id: D-2026-11-16-vault-q01', 'id: D-2026-11-16-badscope').replace('scope: medium', 'scope: nope'));
    const { decisions, problems } = await loadLedger(dir);
    assert.deepEqual(decisions, []);
    const by = Object.fromEntries(problems.map((p) => [p.file, p.message]));
    assert.match(by['D-2026-11-16-extra.md'], /unknown key surprise/);
    assert.match(by['D-2026-11-16-badscope.md'], /scope:/);
    for (const m of Object.values(by)) assert.ok(!m.includes('\n') && !m.startsWith('['), m);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('ledger: retiring a file that carries Vault metadata changes only the status lines', async () => {
  const dir = await tmpdir();
  try {
    const text = await readFile(path.join(vaultFixture, vaultFile), 'utf8');
    await writeFile(path.join(dir, vaultFile), text);
    const d = await retireDecision(dir, 'D-2026-11-16-vault-q01', '2026-11-19');
    assert.equal(d.meta.status, 'retired');
    assert.equal(await readFile(path.join(dir, vaultFile), 'utf8'), text.replace('status: active\n', 'status: retired\nretired_at: 2026-11-19\n'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
