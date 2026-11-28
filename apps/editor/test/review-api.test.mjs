import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, cp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createEditorServer } from '../server.mjs';
import { reviewSections } from '../review.mjs';

const FAKE_KEY = 'test-only-fake-key';

const fixture = path.resolve('test/fixtures/run');
const json = value => JSON.stringify(value);
const getFreePort = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

test('review API starts one authenticated run for a saved section, validates output, applies, and restores from disk', async () => {
  const oldUrl = process.env.BRAGI_HERMES_API_URL, oldKey = process.env.BRAGI_HERMES_API_KEY;
  let runPosts = 0, postHeaders, postBody, eventsLastEventId;
  const hermes = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (req.method === 'POST' && req.url === '/v1/runs') {
      runPosts++; postHeaders = req.headers; postBody = JSON.parse(Buffer.concat(chunks).toString());
      res.writeHead(202, { 'content-type': 'application/json' }); res.end(json({ run_id: 'fake-run-1', status: 'queued' })); return;
    }
    if (req.method === 'GET' && req.url === '/v1/runs/fake-run-1/events') {
      eventsLastEventId = req.headers['last-event-id'];
      res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('id: 8\ndata: {"type":"message.delta"}\n\n'); return;
    }
    if (req.method === 'GET' && req.url === '/v1/runs/fake-run-1') {
      const input = postBody.input;
      const sectionId = input.match(/section_id=(s-[a-f0-9]+)/)[1];
      const sectionSha = input.match(/section_sha=([a-f0-9]{64})/)[1];
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(json({ run_id: 'fake-run-1', status: 'completed', output: json({ findings: [{ finding_id: 'f1', section_id: sectionId, base_revision: sectionSha, anchor: { quote: '夕方、買い物の帰りに川沿いの道へ回りました。', occurrence: 1 }, category: 'auto', rationale: '文を簡潔にします。', proposal: '夕方、買い物の帰りに川沿いを歩きました。', decision_required: false, source_refs: [] }] }) })); return;
    }
    res.writeHead(404); res.end();
  });
  const hermesPort = await getFreePort(hermes);
  process.env.BRAGI_HERMES_API_URL = `http://127.0.0.1:${hermesPort}`;
  process.env.BRAGI_HERMES_API_KEY = FAKE_KEY;
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'wle-review-api-'));
  const run = path.join(tmp, 'run'); await cp(fixture, run, { recursive: true });
  const server = await createEditorServer({ run, port: 0 });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const api = (url, init = {}) => fetch(origin + url, { ...init, headers: { ...(init.body ? { 'content-type': 'application/json', origin } : {}), ...init.headers } });
  try {
    const targets = await (await api('/api/targets')).json();
    const targetId = targets[0].id;
    const draft = await (await api(`/api/drafts/${targetId}`)).json();
    const section = reviewSections(draft.state.markdown)[0];
    const start = await api(`/api/reviews/start?target=${targetId}`, { method: 'POST', body: json({ sectionId: section.section_id, baseRevision: draft.revision }) });
    assert.equal(start.status, 202);
    const session = await start.json();
    assert.equal(runPosts, 1);
    assert.equal(postHeaders.authorization, `Bearer ${FAKE_KEY}`);
    assert.equal(postHeaders['idempotency-key'], `bragi-review-${session.id}`);
    assert.equal(postBody.input.includes(section.content), true);
    const restored = await (await api(`/api/reviews/${session.id}?target=${targetId}`)).json();
    assert.equal(restored.result.state, 'valid');
    assert.equal(restored.result.findings.length, 1);
    const events = await api(`/api/reviews/${session.id}/events?target=${targetId}`, { headers: { 'last-event-id': '7' } });
    assert.equal(events.status, 200);
    assert.match(await events.text(), /id: 8/);
    assert.equal(eventsLastEventId, '7');
    const applied = await api(`/api/reviews/${session.id}/apply?target=${targetId}`, { method: 'POST', body: json({ findingId: 'f1' }) });
    assert.equal(applied.status, 200);
    const finalDraft = await (await api(`/api/drafts/${targetId}`)).json();
    assert.match(finalDraft.state.markdown, /夕方、買い物の帰りに川沿いを歩きました。/);
    const files = await readFile(path.join(run, '05_final', 'editor', targetId, 'reviews', `${session.id}.json`), 'utf8');
    assert.equal(JSON.parse(files).decisions[0].action, 'applied');
  } finally {
    await new Promise(resolve => server.close(resolve)); await new Promise(resolve => hermes.close(resolve)); await rm(tmp, { recursive: true, force: true });
    if (oldUrl === undefined) delete process.env.BRAGI_HERMES_API_URL; else process.env.BRAGI_HERMES_API_URL = oldUrl;
    if (oldKey === undefined) delete process.env.BRAGI_HERMES_API_KEY; else process.env.BRAGI_HERMES_API_KEY = oldKey;
  }
});

test('talk starts one continued run and only a completed answer creates a deduplicated draft proposal', async () => {
  const oldUrl = process.env.BRAGI_HERMES_API_URL, oldKey = process.env.BRAGI_HERMES_API_KEY;
  const posts = [];
  const hermes = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    if (req.method === 'POST' && req.url === '/v1/runs') {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const runId = `fake-talk-${posts.length + 1}`;
      posts.push({ body, headers: req.headers, runId });
      res.writeHead(202, { 'content-type': 'application/json' }); res.end(json({ run_id: runId, status: 'queued' })); return;
    }
    const match = req.url?.match(/^\/v1\/runs\/(fake-talk-\d+)$/);
    if (req.method === 'GET' && match) {
      const post = posts.find(item => item.runId === match[1]);
      const input = post.body.input;
      const sectionId = input.match(/section_id=(s-[a-f0-9]+)/)[1];
      const sectionSha = input.match(/section_sha=([a-f0-9]{64})/)[1];
      const output = { findings: [{ finding_id: 'f-decision', section_id: sectionId, base_revision: sectionSha, anchor: { quote: 'Source line.', occurrence: 1 }, category: 'decision', rationale: '判断の根拠を確認します。', proposal: 'Use a checked fact.', decision_required: true, source_refs: [] }] };
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(json({ run_id: match[1], status: 'completed', output: json(output) })); return;
    }
    res.writeHead(404); res.end();
  });
  const hermesPort = await getFreePort(hermes);
  process.env.BRAGI_HERMES_API_URL = `http://127.0.0.1:${hermesPort}`;
  process.env.BRAGI_HERMES_API_KEY = FAKE_KEY;
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'wle-review-talk-'));
  const draftsRoot = path.join(tmp, 'drafts');
  const coreDrafts = path.resolve('../../packages/core/test/fixtures/drafts');
  await cp(coreDrafts, draftsRoot, { recursive: true });
  const run = path.join(draftsRoot, 'deciding-sample', 'editor-run');
  await cp(fixture, run, { recursive: true });
  const targetsFile = path.join(run, 'editor-targets.json');
  const targets = JSON.parse(await readFile(targetsFile, 'utf8'));
  targets.targets = [{ id: 'review-sample', title: 'Sample', medium: 'Synthetic', version: 'test', source: '05_final/review-sample.md' }];
  await writeFile(targetsFile, json(targets));
  await writeFile(path.join(run, '05_final/review-sample.md'), '# Sample\n\nSource line.\n');
  const server = await createEditorServer({ run, draftsRoot, ledgerDir: path.join(tmp, 'ledger'), github: null, taskNotesDir: null, port: 0 });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const api = (url, init = {}) => fetch(origin + url, { ...init, headers: { ...(init.body ? { 'content-type': 'application/json', origin } : {}), ...init.headers } });
  try {
    const draft = await (await api('/api/drafts/review-sample')).json();
    const section = reviewSections(draft.state.markdown)[0];
    const started = await api('/api/reviews/start?target=review-sample', { method: 'POST', body: json({ sectionId: section.section_id, baseRevision: draft.revision }) });
    const session = await started.json();
    const initial = await (await api(`/api/reviews/${session.id}?target=review-sample`)).json();
    assert.equal(initial.result.state, 'valid');
    assert.equal((await api(`/api/reviews/${session.id}/propose?target=review-sample`, { method: 'POST', body: json({ findingId: 'f-decision', answer: 'Keep only the verified detail.' }) })).status, 400);

    const talked = await api(`/api/reviews/${session.id}/talk?target=review-sample`, { method: 'POST', body: json({ message: 'この判断の出典を確認してください。' }) });
    assert.equal(talked.status, 202);
    assert.equal(posts.length, 2);
    assert.equal(posts[1].headers['idempotency-key'], `bragi-review-${session.id}-talk-0`);
    assert.equal(posts[1].headers['x-hermes-session-key'], posts[0].headers['x-hermes-session-key']);
    const answered = await (await api(`/api/reviews/${session.id}?target=review-sample`)).json();
    assert.equal(answered.result.state, 'valid');
    const payload = { findingId: 'f-decision', answer: 'Keep only the verified detail.' };
    const first = await api(`/api/reviews/${session.id}/propose?target=review-sample`, { method: 'POST', body: json(payload) });
    assert.equal(first.status, 200);
    const firstResult = await first.json();
    assert.equal(firstResult.created, true);
    assert.equal(firstResult.proposal.scope, 'draft');
    const second = await api(`/api/reviews/${session.id}/propose?target=review-sample`, { method: 'POST', body: json(payload) });
    assert.equal(second.status, 200);
    assert.equal((await second.json()).created, false);
    const proposals = await (await api('/api/proposals')).json();
    assert.equal(proposals.proposals.length, 1);
    assert.equal(proposals.proposals[0].meta.scope, 'draft');
  } finally {
    await new Promise(resolve => server.close(resolve)); await new Promise(resolve => hermes.close(resolve)); await rm(tmp, { recursive: true, force: true });
    if (oldUrl === undefined) delete process.env.BRAGI_HERMES_API_URL; else process.env.BRAGI_HERMES_API_URL = oldUrl;
    if (oldKey === undefined) delete process.env.BRAGI_HERMES_API_KEY; else process.env.BRAGI_HERMES_API_KEY = oldKey;
  }
});

test('unconfigured review API reports disabled and refuses a review start', async () => {
  const oldUrl = process.env.BRAGI_HERMES_API_URL, oldKey = process.env.BRAGI_HERMES_API_KEY;
  delete process.env.BRAGI_HERMES_API_URL; delete process.env.BRAGI_HERMES_API_KEY;
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'wle-review-off-'));
  const run = path.join(tmp, 'run'); await cp(fixture, run, { recursive: true });
  const server = await createEditorServer({ run, port: 0 });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const api = (url, init = {}) => fetch(origin + url, { ...init, headers: { ...(init.body ? { 'content-type': 'application/json', origin } : {}), ...init.headers } });
  try {
    assert.deepEqual(await (await api('/api/reviews/enabled?target=kawazoi')).json(), { enabled: false });
    assert.equal((await api('/api/reviews/start?target=kawazoi', { method: 'POST', body: json({}) })).status, 503);
  } finally {
    await new Promise(resolve => server.close(resolve)); await rm(tmp, { recursive: true, force: true });
    if (oldUrl !== undefined) process.env.BRAGI_HERMES_API_URL = oldUrl;
    if (oldKey !== undefined) process.env.BRAGI_HERMES_API_KEY = oldKey;
  }
});
