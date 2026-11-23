import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { listDraftLines, type GithubClient, type PrInfo } from '../src/index.ts';

// Synthetic data only: the fixtures under test/fixtures are made up.
const fixture = path.resolve('test/fixtures/drafts');
const pr = (number: number, state: PrInfo['state'], over: Partial<PrInfo> = {}): PrInfo => ({ url: `https://github.com/example/site/pull/${number}`, number, state, repo: 'example/site', ...over });
const table = { 'example/site': [pr(7, 'open'), pr(8, 'merged'), pr(31, 'merged', { branch: 'content/branch-sample-intro-20261113' }), pr(32, 'merged', { branch: 'content/branch-sample-hero-20261114' }), pr(33, 'open', { branch: 'content/unrelated-20261113' })] };
const ok: GithubClient = async (request) => Object.fromEntries(Object.keys(request).map((repo) => [repo, (table as Record<string, PrInfo[]>)[repo] ?? []]));
const broken: GithubClient = async () => { throw new Error('gh: HTTP 401'); };

const rows = async (github: GithubClient | null) => {
  const r = await listDraftLines({ draftsRoot: fixture, taskNotesDir: null, github });
  return Object.fromEntries(r.lines.map((l) => { const c = l.split('\t'); return [c[0], c]; }));
};

test('list without --github: rows that depend on a PR say GitHub未照合 and make no claim about who waits', async () => {
  const by = await rows(null);
  assert.deepEqual(by['pr-sample'].slice(2, 4), ['GitHub未照合', '-']);
  assert.deepEqual(by['confirmed-sample'].slice(2, 4), ['GitHub未照合', '-']);
  for (const row of Object.values(by)) assert.ok(!/ゲート\/CI/.test(row.join('\t')), 'no provisional gate/CI label');
});

test('list without --github: rows that do not depend on a PR, and hand-set stages, keep their label', async () => {
  const by = await rows(null);
  assert.equal(by['writing-sample'][2], '執筆中');
  assert.equal(by['deciding-sample'][2], '著者判断待ち');
  assert.equal(by['editing-sample'][2], '著者確定待ち');
  assert.equal(by['override-sample'][2], '公開済み');
});

test('list with --github that fails: 照合失敗 on the same rows, no provisional state', async () => {
  const by = await rows(broken);
  assert.deepEqual(by['pr-sample'].slice(2, 4), ['照合失敗', '-']);
  assert.deepEqual(by['confirmed-sample'].slice(2, 4), ['照合失敗', '-']);
  assert.equal(by['writing-sample'][2], '執筆中');
  const r = await listDraftLines({ draftsRoot: fixture, taskNotesDir: null, github: broken });
  assert.match(r.notes.join('\n'), /401/);
  assert.ok(!r.lines.join('\n').includes('GitHub未照合'));
});

test('list with --github that works: the existing labels are unchanged', async () => {
  const by = await rows(ok);
  assert.equal(by['pr-sample'][2], 'ゲート/CI');
  assert.equal(by['pr-sample'][3], 'ci');
  assert.equal(by['branch-sample-20261113'][2], '公開済み');
  assert.equal(by['confirmed-sample'][2], 'PR不明');
  assert.equal(by['editing-sample'][2], '著者確定待ち');
  const text = Object.values(by).map((c) => c.join('\t')).join('\n');
  assert.ok(!/GitHub未照合|照合失敗/.test(text));
});
