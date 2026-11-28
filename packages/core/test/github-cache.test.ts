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

test('keeps the previous result when a background refresh fails', async () => {
  let calls = 0;
  const fake: GithubClient = async () => {
    calls++;
    if (calls === 1) return first;
    throw new Error('offline');
  };
  const client = staleClient()(fake, 10);
  assert.equal(await client(request), first);
  await delay(15);
  assert.equal(await client(request), first);
  await delay(0);
  assert.equal(calls, 2);
});
