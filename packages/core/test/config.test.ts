// Settings: nothing is found by a built-in path; environment and file decide, with defaults that name nobody.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { ConfigError, DEFAULT_AUTHOR, gateOf, renderCandidates, loadSettings, mentionedIds, proposalsDirFor, scanDrafts, today, type RawPr } from '../src/index.ts';

const run = promisify(execFile);
const drafts = path.resolve('test/fixtures/drafts');
const tmp = () => mkdtemp(path.join(os.tmpdir(), 'wle-config-'));

test('settings: with nothing set no folder is known, nobody is named, and no task id is recognised', () => {
  const s = loadSettings({});
  assert.deepEqual([s.vault, s.draftsRoot, s.ledgerDir, s.proposalsDir, s.taskNotesDir, s.author, s.taskIdPatterns], [null, null, null, null, null, DEFAULT_AUTHOR, []]);
  assert.equal(s.stageLabels['awaiting-decision'], `${DEFAULT_AUTHOR}判断待ち`);
  assert.deepEqual(mentionedIds('TASK-1 and job_12345678', s.taskIdPatterns), []);
});

test('settings: relative names are resolved against BRAGI_VAULT; an absolute path stands alone; the environment beats the file', async () => {
  const dir = await tmp();
  try {
    const file = path.join(dir, 'bragi.json');
    await writeFile(file, JSON.stringify({ vault: '/from/file', drafts: 'articles', ledger: 'decisions', proposals: 'ideas/proposed', taskNotes: 'tasks', author: 'Sam', taskIds: ['\\bWORK-\\d+\\b'], stageLabels: { writing: 'Drafting', 'awaiting-decision': '{author} to decide' } }));
    const a = loadSettings({ BRAGI_CONFIG: file });
    assert.deepEqual([a.draftsRoot, a.ledgerDir, a.proposalsDir, a.taskNotesDir, a.proposalsName, a.author], ['/from/file/articles', '/from/file/decisions', '/from/file/ideas/proposed', '/from/file/tasks', 'proposed', 'Sam']);
    assert.deepEqual([a.stageLabels.writing, a.stageLabels['awaiting-decision'], a.stageLabels.published], ['Drafting', 'Sam to decide', '公開済み']);
    assert.deepEqual(mentionedIds('see WORK-12, TASK-3', a.taskIdPatterns), ['WORK-12']);
    const b = loadSettings({ BRAGI_CONFIG: file, BRAGI_VAULT: '/v', BRAGI_LEDGER: '/elsewhere/ledger', BRAGI_AUTHOR: 'Kim', BRAGI_TASK_IDS: '\\bT-\\d+\\b|||\\bU-\\d+\\b' });
    assert.deepEqual([b.draftsRoot, b.ledgerDir, b.author, b.taskIdPatterns.length], ['/v/articles', '/elsewhere/ledger', 'Kim', 2]);
    assert.equal(b.stageLabels['awaiting-decision'], 'Kim to decide');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('settings: a broken or unknown-keyed config file is refused with its name in the message', async () => {
  const dir = await tmp();
  try {
    const bad = path.join(dir, 'bad.json'); await writeFile(bad, '{ nope');
    const unknown = path.join(dir, 'unknown.json'); await writeFile(unknown, JSON.stringify({ vualt: '/x' }));
    const badLabel = path.join(dir, 'label.json'); await writeFile(badLabel, JSON.stringify({ stageLabels: { nonsense: 'x' } }));
    for (const f of [bad, unknown, badLabel]) assert.throws(() => loadSettings({ BRAGI_CONFIG: f }), (e: Error) => e instanceof ConfigError && e.message.includes(f));
    assert.throws(() => loadSettings({ BRAGI_CONFIG: path.join(dir, 'missing.json') }), ConfigError);
    assert.throws(() => loadSettings({ BRAGI_TASK_IDS: '(' }), ConfigError);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('proposals sit next to the ledger folder under the configured name', () => {
  assert.equal(proposalsDirFor('/x/y/ledger', 'ideas'), '/x/y/ideas');
  assert.equal(proposalsDirFor('/x/y/ledger'), '/x/y/proposals');
});

test('today is a YYYY-MM-DD date in the named time zone', () => {
  assert.match(today({}), /^\d{4}-\d{2}-\d{2}$/);
  // UTC+14 and UTC-12 are 26 hours apart, so they never share a calendar date.
  assert.notEqual(today({ BRAGI_TIMEZONE: 'Pacific/Kiritimati' }), today({ BRAGI_TIMEZONE: 'Etc/GMT+12' }));
});

test('the scan names the author in stage labels and in its result; the labels come from the settings', async () => {
  const before = { a: process.env.BRAGI_AUTHOR, v: process.env.BRAGI_VAULT };
  process.env.BRAGI_AUTHOR = 'Sam';
  try {
    const s = await scanDrafts(drafts, { taskNotesDir: null });
    const d = s.drafts.find((x) => x.slug === 'deciding-sample')!;
    assert.deepEqual([s.author, d.stageLabel, d.waitingOn], ['Sam', 'Sam判断待ち', 'author']);
    assert.ok(d.reasons.some((r) => r.includes('Sam判断待ち')), 'the reasons use the same name');
  } finally { if (before.a === undefined) delete process.env.BRAGI_AUTHOR; else process.env.BRAGI_AUTHOR = before.a; }
});

test('a gate that says NEEDS_<anyone> is reported as NEEDS_AUTHOR; an unknown verdict is not a verdict', () => {
  const raw = (body: string) => ({ headRefOid: 'a'.repeat(40), comments: { nodes: [{ body, createdAt: '2026-11-14T00:00:00Z' }] } }) as unknown as RawPr;
  assert.equal(gateOf(raw('pr_gate NEEDS_SOMEONE, head aaaaaaa'))!.verdict, 'NEEDS_AUTHOR');
  assert.equal(gateOf(raw('pr_gate MERGE_OK, head aaaaaaa'))!.verdict, 'MERGE_OK');
  assert.equal(gateOf(raw('pr_gate MAYBE, head aaaaaaa')), null);
});

test('bragi with no configuration says what to set and exits 1; with BRAGI_VAULT the default layout works', async () => {
  const dir = await tmp();
  try {
    const env = { PATH: process.env.PATH ?? '', HOME: dir };
    const bare = await run('node', ['src/bragi.ts', 'list'], { env }).catch((e) => e);
    assert.equal(bare.code, 1);
    assert.match(bare.stderr, /the drafts folder is not configured.*BRAGI_DRAFTS.*BRAGI_VAULT/);
    await mkdir(path.join(dir, 'drafts', 'my-note-20261101'), { recursive: true });
    await mkdir(path.join(dir, 'ledger'));
    const ok = await run('node', ['src/bragi.ts', 'list'], { env: { ...env, BRAGI_VAULT: dir } });
    assert.match(ok.stdout, /^my-note-20261101\t/);
    const ctx = await run('node', ['src/bragi.ts', 'context', 'my-note-20261101'], { env: { ...env, BRAGI_VAULT: dir } });
    assert.match(ctx.stdout, /^# 判断台帳：my-note-20261101/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('the committed example config is valid and says what the README says it does', () => {
  const s = loadSettings({ BRAGI_CONFIG: path.resolve('../../bragi.config.example.json') });
  assert.deepEqual([s.draftsRoot, s.ledgerDir, s.proposalsDir, s.author, s.stageLabels['awaiting-decision'], s.stageLabels.writing], ['/path/to/your/vault/blog/drafts', '/path/to/your/vault/blog/decisions', '/path/to/your/vault/blog/proposed', 'Sam', 'Sam to decide', 'Drafting']);
});

test('the candidates text names the author it is given (and the configured one by default)', () => {
  assert.match(renderCandidates('my-note', [], [], 'Sam'), /^台帳には入れていません。採るのはSamだけ/m);
  assert.match(renderCandidates('my-note', [], []), new RegExp(`採るのは${DEFAULT_AUTHOR}だけ`));
});
