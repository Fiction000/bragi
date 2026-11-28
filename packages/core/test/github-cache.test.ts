import assert from 'node:assert/strict';
import test from 'node:test';
import type { GithubClient, GithubResult, PrRequest } from '../src/github.ts';
import * as github from '../src/github.ts';

const staleClient = () => {
  const factory = (github as unknown as { createStaleWhileRevalidate?: unknown }).createStaleWhileRevalidate;
  assert.equal(typeof factory, 'function', 'stale-while-revalidate client is available');
  return factory as typeof import('../src/github.ts').createStaleWhileRevalidate;
};

const request: PrRequest = { 'Fiction000/bragi': [] };
const first: GithubResult = { 'Fiction000/bragi': [] };
const second: GithubResult = { 'Fiction000/bragi': [{ url: 'https://github.com/Fiction000/bragi/pull/1', number: 1, state: 'open', repo: 'Fiction000/bragi', title: 'one', isDraft: false, branch: 'one', headSha: 'abc', ci: { state: 'none', total: 0, failing: [], pending: 0 }, gate: null, unresolvedReviews: null }] };

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('returns stale GitHub data immediately and coalesces refreshes', async () => {
  let calls = 0;
  let finishRefresh!: (value: GithubResult) => void;
  const fake: GithubClient = async () => {
    calls++;
    if (calls === 1) return first;
    return new Promise((resolve) => { finishRefresh = resolve; });
  };
  const client = staleClient()(fake, 10);
  assert.equal(await client(request), first);
  await delay(15);

  const stale = await client(request);
  const sameStale = await client(request);
  assert.equal(stale, first);
  assert.equal(sameStale, first);
  assert.equal(calls, 2);

  finishRefresh(second);
  await delay(0);
  assert.equal(await client(request), second);
});

test('backs off stale GitHub refresh after a background failure', async () => {
  let calls = 0;
  let now = 1_000;
  const originalNow = Date.now;
  Date.now = () => now;
  try {
    const fake: GithubClient = async () => {
      calls++;
      if (calls === 1) return first;
      throw new Error('offline');
    };
    const client = staleClient()(fake, 10);
    assert.equal(await client(request), first);
    now += 11;
    assert.equal(await client(request), first);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 2);
    assert.equal(await client(request), first);
    now += 29_999;
    assert.equal(await client(request), first);
    assert.equal(calls, 2);
    now += 1;
    assert.equal(await client(request), first);
    assert.equal(calls, 3);
  } finally { Date.now = originalNow; }
});
