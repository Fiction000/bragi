import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, writeFile, cp, symlink, rm, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { signWebhook, verifyWebhookSignature, validateWebhookUrl, sendOutboxEvent } from '../webhook-outbox.mjs';
import { ingestRevision } from '../ingest-revision.mjs';
import { createEditorServer } from '../server.mjs';
import { listEditorRuns } from '@wle/core';

const fixture = path.resolve('test/fixtures/run');
const hash = value => createHash('sha256').update(value).digest('hex');
async function temp() { return mkdtemp(path.join(os.tmpdir(), 'bragi-agent-link-')); }
async function treeBytes(dir, relative = '') {
  const output = {};
  for (const entry of await readdir(path.join(dir, relative), { withFileTypes: true })) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) Object.assign(output, await treeBytes(dir, child));
    else output[child] = (await readFile(path.join(dir, child))).toString('base64');
  }
  return output;
}

test('V2 signature matches timestamp-dot-raw-body and rejects stale timestamps', () => {
  const body = Buffer.from('{"event_type":"bragi.editor.finished"}');
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signed = signWebhook(body, 'secret', timestamp);
  assert.equal(signed['X-Webhook-Timestamp'], timestamp);
  assert.equal(signed['X-Webhook-Signature-V2'], createHmac('sha256', 'secret').update(timestamp + '.' + body).digest('hex'));
  assert.equal(verifyWebhookSignature(body, 'secret', { 'x-webhook-timestamp': timestamp, 'x-webhook-signature-v2': signed['X-Webhook-Signature-V2'] }), true);
  assert.equal(verifyWebhookSignature(Buffer.from('tampered'), 'secret', { 'x-webhook-timestamp': timestamp, 'x-webhook-signature-v2': signed['X-Webhook-Signature-V2'] }), false);
  assert.equal(validateWebhookUrl('http://[::1]:9121/webhooks/bragi'), 'http://[::1]:9121/webhooks/bragi');
  assert.throws(() => signWebhook(body, 'secret', '1'), /timestamp/i);
});

test('webhook destinations are limited to loopback', () => {
  assert.equal(validateWebhookUrl('http://127.0.0.1:9121/webhooks/bragi'), 'http://127.0.0.1:9121/webhooks/bragi');
  assert.equal(validateWebhookUrl('http://localhost:9121/webhooks/bragi'), 'http://localhost:9121/webhooks/bragi');
  assert.throws(() => validateWebhookUrl('https://example.com/hook'), /loopback/i);
  assert.throws(() => validateWebhookUrl('http://127.0.0.2/hook'), /loopback/i);
});

test('outbox persists before send, retries Retry-After, and quarantines permanent 4xx', async () => {
  const tmp = await temp();
  const requests = [];
  const waits = [];
  let count = 0;
  const file = path.join(tmp, 'outbox.json');
  const receiver = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      requests.push({ headers: req.headers, body: body.toString() });
      assert.equal(existsSync(file), true);
      count++;
      if (count === 1) { res.writeHead(429, { 'retry-after': '0' }); res.end(); }
      else { res.writeHead(409); res.end(); }
    });
  });
  await new Promise(resolve => receiver.listen(0, '127.0.0.1', resolve));
  try {
    const event = { schema_version: 1, event_id: '8a4b38e1-15b2-42fb-a678-f0f7c25e9754', event_type: 'bragi.editor.finished' };
    await writeFile(file, JSON.stringify({ event, attempts: 0, status: 'pending' }));
    const result = await sendOutboxEvent({ file, url: `http://127.0.0.1:${receiver.address().port}/hook`, signingKey: 'secret', sleep: async ms => waits.push(ms) });
    assert.equal(result.status, 'quarantined');
    assert.equal(requests.length, 2);
    assert.deepEqual(waits, [0]);
    assert.equal(requests[0].headers['x-request-id'], event.event_id);
    assert.equal(requests[0].headers['x-webhook-signature-v2'], createHmac('sha256', 'secret').update(requests[0].headers['x-webhook-timestamp'] + '.' + requests[0].body).digest('hex'));
    assert.equal(JSON.parse(await readFile(file, 'utf8')).status, 'quarantined');
    await sendOutboxEvent({ file, url: `http://127.0.0.1:${receiver.address().port}/hook`, signingKey: 'secret', sleep: async () => {} });
    assert.equal(requests.length, 2, 'terminal outbox state is not delivered again');
  } finally { await new Promise(resolve => receiver.close(resolve)); await rm(tmp, { recursive: true, force: true }); }
});

test('outbox retries transient failures five times after the initial attempt', async () => {
  const tmp = await temp();
  const file = path.join(tmp, 'outbox.json');
  const waits = [];
  let requests = 0;
  await writeFile(file, JSON.stringify({ event: { event_id: '8a4b38e1-15b2-42fb-a678-f0f7c25e9754' }, attempts: 0, status: 'pending' }));
  try {
    const result = await sendOutboxEvent({ file, url: 'http://127.0.0.1:1/hook', signingKey: 'secret', sleep: async ms => waits.push(ms), fetchImpl: async () => { requests++; return new Response(null, { status: 503 }); } });
    assert.equal(result.status, 'exhausted');
    assert.equal(result.attempts, 6);
    assert.equal(requests, 6);
    assert.deepEqual(waits, [60_000, 120_000, 240_000, 480_000, 960_000]);
    const staleFile = path.join(tmp, 'stale.json');
    await writeFile(staleFile, JSON.stringify({ event: { event_id: '8a4b38e1-15b2-42fb-a678-f0f7c25e9754' }, attempts: 6, status: 'pending' }));
    const stale = await sendOutboxEvent({ file: staleFile, url: 'http://127.0.0.1:1/hook', signingKey: 'secret', sleep: async () => {}, fetchImpl: async () => { requests++; return new Response(null, { status: 503 }); } });
    assert.equal(stale.status, 'exhausted');
    assert.equal(requests, 6);
  } finally { await rm(tmp, { recursive: true, force: true }); }
});


test('concurrent sends share one delivery for an outbox file', async () => {
  const tmp = await temp();
  const file = path.join(tmp, 'outbox.json');
  let release;
  let requests = 0;
  const blocked = new Promise(resolve => { release = resolve; });
  await writeFile(file, JSON.stringify({ event: { event_id: '8a4b38e1-15b2-42fb-a678-f0f7c25e9754' }, attempts: 0, status: 'pending' }));
  try {
    const options = { file, url: 'http://127.0.0.1:1/hook', signingKey: 'secret', fetchImpl: async () => { requests++; await blocked; return new Response(null, { status: 202 }); } };
    const first = sendOutboxEvent(options);
    const second = sendOutboxEvent(options);
    assert.equal(first, second);
    release();
    assert.equal((await first).status, 'sent');
    assert.equal(requests, 1);
  } finally { release(); await rm(tmp, { recursive: true, force: true }); }
});

test('revision ingest creates a separate run once and leaves the parent run unchanged', async () => {
  const tmp = await temp();
  const drafts = path.join(tmp, 'drafts');
  const slugDir = path.join(drafts, 'story');
  const run = path.join(slugDir, 'editor-run-v1');
  const artifact = path.join(tmp, 'writer', 'revision.md');
  try {
    await cp(fixture, run, { recursive: true });
    const listing = JSON.parse(await readFile(path.join(run, 'editor-targets.json'), 'utf8'));
    const targetId = listing.targets[0].id;
    const parentEdit = path.join(run, '05_final', 'editor', targetId);
    await mkdir(parentEdit, { recursive: true });
    const parentFinal = path.join(parentEdit, 'nat-final.md');
    await writeFile(parentFinal, 'parent editor content');
    await writeFile(path.join(parentEdit, 'finished.json'), JSON.stringify({ finalSha256: 'a'.repeat(64) }));
    await mkdir(path.dirname(artifact), { recursive: true });
    await writeFile(artifact, '# Agent revision\n');
    const event = { event_type: 'bragi.agent.revision_ready', event_id: 'a350fb95-b3eb-44b9-bda4-ec6aa700e885', workflow_id: 'workflow-1', parent_event_id: '8a4b38e1-15b2-42fb-a678-f0f7c25e9754', slug: 'story', editor_run: 'story/editor-run-v1', target_id: targetId, artifact_ref: 'writer/revision.md', sha256: hash(await readFile(artifact)), source_sha256: 'a'.repeat(64), label: 'Agent revision' };
    const before = await treeBytes(run);
    const reordered = Object.fromEntries(Object.entries(event).reverse());
    const results = await Promise.all([
      ingestRevision(event, { draftsRoot: drafts, workflowRoot: tmp }),
      ingestRevision(reordered, { draftsRoot: drafts, workflowRoot: tmp }),
    ]);
    assert.notEqual(results[0].created, results[1].created);
    const first = results.find(result => result.created);
    const second = results.find(result => !result.created);
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(first.runKey, second.runKey);
    await rm(path.join(drafts, '.bragi-ingest-events', `${event.event_id}.json`));
    const recovered = await ingestRevision(reordered, { draftsRoot: drafts, workflowRoot: tmp });
    assert.equal(recovered.created, false);
    assert.equal(recovered.runKey, first.runKey);
    assert.deepEqual(await treeBytes(run), before);
    const newRun = path.join(slugDir, 'editor-run-v2');
    assert.equal(await readFile(path.join(newRun, '05_final', 'agent-revision.md'), 'utf8'), '# Agent revision\n');
    const targets = JSON.parse(await readFile(path.join(newRun, 'editor-targets.json'), 'utf8'));
    assert.equal(targets.targets.length, 1);
    assert.equal(targets.targets[0].version, 'Agent revision');
    const scanned = await listEditorRuns(drafts);
    assert.ok(scanned.some(item => item.relPath === 'story/editor-run-v2' && item.key === first.runKey && item.targets[0].agentRevision && !item.targets[0].verified));
  } finally { await rm(tmp, { recursive: true, force: true }); }
});

test('revision CLI emits its JSON result and rejects missing roots', async () => {
  const tmp = await temp();
  const drafts = path.join(tmp, 'drafts');
  const parent = path.join(drafts, 'story', 'editor-run-v1');
  const workflow = path.join(tmp, 'workflow');
  const targetId = 'market-note';
  const artifact = path.join(workflow, 'writer', 'revision.md');
  const eventFile = path.join(tmp, 'event.json');
  try {
    await cp(fixture, parent, { recursive: true });
    await mkdir(path.join(parent, '05_final', 'editor', targetId), { recursive: true });
    await writeFile(path.join(parent, '05_final', 'editor', targetId, 'finished.json'), JSON.stringify({ finalSha256: 'a'.repeat(64) }));
    await mkdir(path.dirname(artifact), { recursive: true });
    await writeFile(artifact, 'revision');
    const event = { event_type: 'bragi.agent.revision_ready', event_id: 'aa23ca82-1fed-47a2-ad6f-f43d03c58589', workflow_id: 'workflow', parent_event_id: '8a4b38e1-15b2-42fb-a678-f0f7c25e9754', slug: 'story', editor_run: 'story/editor-run-v1', target_id: targetId, artifact_ref: 'writer/revision.md', sha256: hash(await readFile(artifact)), source_sha256: 'a'.repeat(64), label: 'Agent revision' };
    await writeFile(eventFile, JSON.stringify(event));
    const cli = path.resolve('ingest-revision.mjs');
    const missing = spawnSync(process.execPath, [cli], { encoding: 'utf8' });
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /Usage/);
    const result = spawnSync(process.execPath, [cli, '--event', eventFile, '--workflow-root', workflow, '--drafts-root', drafts], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).created, true);
  } finally { await rm(tmp, { recursive: true, force: true }); }
});

test('revision ingest rejects symlinked parent metadata before creating any run', async () => {
  const tmp = await temp();
  const drafts = path.join(tmp, 'drafts');
  const run = path.join(drafts, 'story', 'editor-run-v1');
  const workflow = path.join(tmp, 'workflow');
  const artifact = path.join(workflow, 'revision.md');
  try {
    await cp(fixture, run, { recursive: true });
    const targetId = JSON.parse(await readFile(path.join(run, 'editor-targets.json'), 'utf8')).targets[0].id;
    await mkdir(path.join(run, '05_final', 'editor', targetId), { recursive: true });
    await writeFile(path.join(run, '05_final', 'editor', targetId, 'finished.json'), JSON.stringify({ finalSha256: 'a'.repeat(64) }));
    await mkdir(workflow, { recursive: true });
    await writeFile(artifact, 'revision');
    const event = { event_type: 'bragi.agent.revision_ready', event_id: 'aa23ca82-1fed-47a2-ad6f-f43d03c58589', workflow_id: 'workflow', parent_event_id: '8a4b38e1-15b2-42fb-a678-f0f7c25e9754', slug: 'story', editor_run: 'story/editor-run-v1', target_id: targetId, artifact_ref: 'revision.md', sha256: hash(await readFile(artifact)), source_sha256: 'a'.repeat(64), label: 'Agent revision' };
    const listing = path.join(run, 'editor-targets.json');
    const external = path.join(tmp, 'external-targets.json');
    await writeFile(external, await readFile(listing));
    await rm(listing);
    await symlink(external, listing);
    await assert.rejects(ingestRevision(event, { draftsRoot: drafts, workflowRoot: workflow }), /symlink|regular file/i);
    assert.deepEqual((await readdir(path.join(drafts, 'story'))).filter(name => /^editor-run-v/.test(name)), ['editor-run-v1']);
  } finally { await rm(tmp, { recursive: true, force: true }); }
});

test('revision ingest rejects hash mismatch, source mismatch, traversal, symlink, and event ID reuse with changed content', async () => {
  const tmp = await temp();
  const drafts = path.join(tmp, 'drafts');
  const run = path.join(drafts, 'story', 'editor-run-v1');
  const artifact = path.join(tmp, 'writer.md');
  try {
    await cp(fixture, run, { recursive: true });
    const listing = JSON.parse(await readFile(path.join(run, 'editor-targets.json'), 'utf8'));
    const targetId = listing.targets[0].id;
    await mkdir(path.join(run, '05_final', 'editor', targetId), { recursive: true });
    await writeFile(path.join(run, '05_final', 'editor', targetId, 'finished.json'), JSON.stringify({ finalSha256: 'b'.repeat(64) }));
    await writeFile(artifact, 'revision');
    const event = { event_type: 'bragi.agent.revision_ready', event_id: 'aa23ca82-1fed-47a2-ad6f-f43d03c58589', workflow_id: 'w', parent_event_id: '8a4b38e1-15b2-42fb-a678-f0f7c25e9754', slug: 'story', editor_run: 'story/editor-run-v1', target_id: targetId, artifact_ref: 'writer.md', sha256: 'c'.repeat(64), source_sha256: 'b'.repeat(64), label: 'Agent revision' };
    await assert.rejects(ingestRevision(event, { draftsRoot: drafts, workflowRoot: tmp }), /SHA/i);
    const correctHash = hash(await readFile(artifact));
    await assert.rejects(ingestRevision({ ...event, sha256: correctHash, source_sha256: 'd'.repeat(64) }, { draftsRoot: drafts, workflowRoot: tmp }), /source/i);
    await assert.rejects(ingestRevision({ ...event, sha256: correctHash, artifact_ref: '../outside.md' }, { draftsRoot: drafts, workflowRoot: tmp }), /path|outside/i);
    const linked = path.join(tmp, 'linked.md'); await symlink(artifact, linked);
    await assert.rejects(ingestRevision({ ...event, sha256: correctHash, artifact_ref: 'linked.md' }, { draftsRoot: drafts, workflowRoot: tmp }), /symlink|link/i);
    const good = { ...event, sha256: correctHash };
    await ingestRevision(good, { draftsRoot: drafts, workflowRoot: tmp });
    await assert.rejects(ingestRevision({ ...good, label: 'Different content' }, { draftsRoot: drafts, workflowRoot: tmp }), /event ID|content/i);
    assert.deepEqual(await readdir(path.join(drafts, 'story')), ['editor-run-v1', 'editor-run-v2']);
  } finally { await rm(tmp, { recursive: true, force: true }); }
});

test('finish durably queues a signed webhook without waiting for delivery; unset config keeps finish offline', async () => {
  const tmp = await temp();
  const run = path.join(tmp, 'story', 'editor-run-v1');
  await cp(fixture, run, { recursive: true });
  let entered;
  const called = new Promise(resolve => { entered = resolve; });
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const sends = [];
  const fetchImpl = async (url, init) => {
    sends.push({ url, init });
    entered();
    await blocked;
    return new Response(null, { status: 202 });
  };
  const server = await createEditorServer({ run, port: 0, webhookUrl: 'http://127.0.0.1:9121/webhooks/bragi', webhookSecret: 'secret', webhookFetch: fetchImpl });
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const targets = await (await fetch(`${origin}/api/targets`)).json();
    const target = targets.find(item => item.id === 'market-note');
    const draft = await (await fetch(`${origin}/api/drafts/${target.id}`)).json();
    const response = await Promise.race([
      fetch(`${origin}/api/drafts/${target.id}/finish`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ baseRevision: draft.revision }) }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('finish waited for webhook delivery')), 300)),
    ]);
    assert.equal(response.status, 200);
    await called;
    const outboxFile = path.join(run, '05_final', 'editor', target.id, 'finished-event.json');
    const outbox = JSON.parse(await readFile(outboxFile, 'utf8'));
    assert.equal(outbox.status, 'pending');
    assert.equal(sends.length, 1);
    const bytes = Buffer.from(sends[0].init.body);
    assert.equal(sends[0].init.headers['X-Request-ID'], outbox.event.event_id);
    assert.equal(verifyRequest(bytes, 'secret', sends[0].init.headers), true);
    release();
    for (let i = 0; i < 30 && JSON.parse(await readFile(outboxFile, 'utf8')).status !== 'sent'; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(JSON.parse(await readFile(outboxFile, 'utf8')).status, 'sent');
  } finally {
    release();
    await new Promise(resolve => server.close(resolve));
    await rm(tmp, { recursive: true, force: true });
  }
});

function verifyRequest(body, secret, headers) {
  const timestamp = headers['X-Webhook-Timestamp'];
  const signature = headers['X-Webhook-Signature-V2'];
  return signature === createHmac('sha256', secret).update(timestamp + '.').update(body).digest('hex');
}

test('server restart retries a persisted pending outbox with the same delivery ID', async () => {
  const tmp = await temp();
  const drafts = path.join(tmp, 'drafts');
  const run = path.join(drafts, 'story', 'editor-run-v1');
  const outboxFile = path.join(run, '05_final', 'editor', 'market-note', 'finished-event.json');
  const event = { schema_version: 1, event_id: 'ea526def-688e-41be-8ee8-b811aa4876c4', event_type: 'bragi.editor.finished' };
  await cp(fixture, run, { recursive: true });
  await mkdir(path.dirname(outboxFile), { recursive: true });
  await writeFile(outboxFile, JSON.stringify({ event, status: 'pending', attempts: 0 }));
  const sent = [];
  const server = await createEditorServer({ draftsRoot: drafts, port: 0, github: null, taskNotesDir: null, webhookUrl: 'http://127.0.0.1:9121/webhooks/bragi', webhookSecret: 'secret', webhookFetch: async (_url, init) => { sent.push(init.headers['X-Request-ID']); return new Response(null, { status: 202 }); } });
  try {
    for (let i = 0; i < 30 && JSON.parse(await readFile(outboxFile, 'utf8')).status !== 'sent'; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(sent, [event.event_id]);
    assert.equal(JSON.parse(await readFile(outboxFile, 'utf8')).status, 'sent');
  } finally { await new Promise(resolve => server.close(resolve)); await rm(tmp, { recursive: true, force: true }); }
});

test('server rejects remote webhook configuration and leaves finish behavior unchanged when disabled', async () => {
  assert.throws(() => validateWebhookUrl('https://example.com/hook'), /loopback/i);
  await assert.rejects(createEditorServer({ run: fixture, port: 0, webhookUrl: 'https://example.com/hook', webhookSecret: 'secret' }), /loopback/i);
  const tmp = await temp();
  const run = path.join(tmp, 'run');
  await cp(fixture, run, { recursive: true });
  const server = await createEditorServer({ run, port: 0, webhookUrl: null, webhookSecret: 'secret' });
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const draft = await (await fetch(`${origin}/api/drafts/market-note`)).json();
    const response = await fetch(`${origin}/api/drafts/market-note/finish`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ baseRevision: draft.revision }) });
    assert.equal(response.status, 200);
    await assert.rejects(readFile(path.join(run, '05_final', 'editor', 'market-note', 'finished-event.json')), { code: 'ENOENT' });
  } finally { await new Promise(resolve => server.close(resolve)); await rm(tmp, { recursive: true, force: true }); }
});
