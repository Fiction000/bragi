import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, readFile, writeFile, mkdir, symlink, rm, access, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createEditorServer, revisionFor, saveDraftIfCurrent } from '../server.mjs';

const fixture = path.resolve('test/fixtures/run');
async function setup() {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'wle-test-'));
  const run = path.join(tmp, 'run');
  await cp(fixture, run, { recursive: true });
  const server = await createEditorServer({ run, port: 0 });
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  const api = (url, init = {}) => fetch(origin + url, { ...init, headers: { ...(init.body ? { 'content-type': 'application/json', origin } : {}), ...init.headers } });
  return { tmp, run, server, port, origin, api, close: async () => { await new Promise(resolve => server.close(resolve)); await rm(tmp, { recursive: true, force: true }); } };
}
const json = value => JSON.stringify(value);

test('round trip preserves state and source bytes', async () => {
  const t = await setup();
  try {
    const sourcePath = path.join(t.run, '05_final', '川沿いの帰り道 レビュー反映稿.md');
    const before = await readFile(sourcePath);
    const initial = await (await t.api('/api/drafts/kawazoi')).json();
    const state = { markdown: initial.state.markdown.replace('夕方、', '夕方には、'), notes: [{ id: 'n1', anchor: { blockIndex: 0, text: '夕方には、買い物の帰りに川沿いの道へ回りました。' }, body: '理由' }] };
    const put = await t.api('/api/drafts/kawazoi', { method: 'PUT', body: json({ state, baseRevision: initial.revision }) });
    assert.equal(put.status, 200);
    assert.equal((await put.json()).revision, revisionFor(state));
    const after = await (await t.api('/api/drafts/kawazoi')).json();
    assert.deepEqual(after.state, state);
    assert.deepEqual(await readFile(sourcePath), before);
  } finally { await t.close(); }
});

test('stale revision rejects without changing files', async () => {
  const t = await setup();
  try {
    const initial = await (await t.api('/api/drafts/kawazoi')).json();
    const state = { markdown: initial.state.markdown + '\n追記', notes: [] };
    assert.equal((await t.api('/api/drafts/kawazoi', { method: 'PUT', body: json({ state, baseRevision: initial.revision }) })).status, 200);
    const files = path.join(t.run, '05_final', 'editor', 'kawazoi');
    const before = await Promise.all(['nat-final.md', 'nat-notes.json'].map(f => readFile(path.join(files, f))));
    const stale = await t.api('/api/drafts/kawazoi', { method: 'PUT', body: json({ state: initial.state, baseRevision: initial.revision }) });
    assert.equal(stale.status, 409);
    assert.deepEqual(await Promise.all(['nat-final.md', 'nat-notes.json'].map(f => readFile(path.join(files, f)))), before);
  } finally { await t.close(); }
});

test('review draft save refuses a stale revision without replacing a concurrent edit', async () => {
  const t = await setup();
  try {
    const initial = await (await t.api('/api/drafts/kawazoi')).json();
    const newerState = { markdown: initial.state.markdown + '\n別の節の編集', notes: [] };
    assert.equal((await t.api('/api/drafts/kawazoi', { method: 'PUT', body: json({ state: newerState, baseRevision: initial.revision }) })).status, 200);
    const latest = await (await t.api('/api/drafts/kawazoi')).json();
    const target = { id: 'kawazoi', source: path.join(t.run, '05_final', '川沿いの帰り道 レビュー反映稿.md') };
    const attempted = await saveDraftIfCurrent(await realpath(t.run), target, initial.state, initial.revision);
    assert.deepEqual(attempted, { saved: false, revision: latest.revision });
    assert.deepEqual((await (await t.api('/api/drafts/kawazoi')).json()).state, newerState);
  } finally { await t.close(); }
});

test('path traversal ids and symlinked draft files are rejected', async () => {
  const t = await setup();
  try {
    assert.equal((await t.api('/api/drafts/../x')).status, 404);
    assert.equal((await t.api('/api/drafts/%2e%2e')).status, 404);
    const outside = path.join(t.tmp, 'outside.md'); await writeFile(outside, 'external');
    const editor = path.join(t.run, '05_final', 'editor', 'kawazoi'); await mkdir(editor, { recursive: true });
    await symlink(outside, path.join(editor, 'nat-final.md'));
    assert.equal((await t.api('/api/drafts/kawazoi')).status, 500);
    const bad = path.join(t.tmp, 'bad'); await cp(fixture, bad, { recursive: true });
    const listing = JSON.parse(await readFile(path.join(bad, 'editor-targets.json'), 'utf8'));
    listing.targets[0].source = '../outside.md'; await writeFile(path.join(bad, 'editor-targets.json'), json(listing));
    await assert.rejects(createEditorServer({ run: bad, port: 0 }), /Unsafe source/);
  } finally { await t.close(); }
});

test('bad Host, missing or foreign Origin, and text/plain cannot write', async () => {
  const t = await setup();
  try {
    const initial = await (await t.api('/api/drafts/kawazoi')).json();
    const body = json({ state: initial.state, baseRevision: initial.revision });
    const rawRequest = headers => new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port: t.port, path: '/api/drafts/kawazoi', method: 'PUT', headers }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      req.on('error', reject); req.end(body);
    });
    assert.equal(await rawRequest({ host: 'evil.test', origin: t.origin, 'content-type': 'application/json' }), 403);
    assert.equal(await rawRequest({ 'content-type': 'application/json' }), 403);
    assert.equal(await rawRequest({ origin: 'http://evil.test', 'content-type': 'application/json' }), 403);
    assert.equal(await rawRequest({ origin: t.origin, 'content-type': 'text/plain' }), 415);
    assert.equal((await t.api('/api/drafts/kawazoi')).status, 200);
    await assert.rejects(readFile(path.join(t.run, '05_final/editor/kawazoi/nat-final.md')), { code: 'ENOENT' });
  } finally { await t.close(); }
});

test('server binds to loopback and GET draft exposes exactly contract keys', async () => {
  const t = await setup();
  try {
    assert.equal(t.server.address().address, '127.0.0.1');
    const body = await (await t.api('/api/drafts/kawazoi')).json();
    assert.deepEqual(Object.keys(body).sort(), ['finished', 'revision', 'sourceMarkdown', 'state', 'target'].sort());
  } finally { await t.close(); }
});

test('fork does not overwrite an existing conflict file', async () => {
  const t = await setup();
  try {
    const draft = await (await t.api('/api/drafts/kawazoi')).json();
    const state = { markdown: draft.state.markdown + '\nPersonal', notes: [] };
    const first = await (await t.api('/api/drafts/kawazoi/fork', { method: 'POST', body: json({ state }) })).json();
    const file = path.join(t.run, first.paths[0]); await writeFile(file, 'do-not-overwrite');
    const second = await (await t.api('/api/drafts/kawazoi/fork', { method: 'POST', body: json({ state }) })).json();
    assert.notEqual(second.paths[0], first.paths[0]);
    assert.equal(await readFile(file, 'utf8'), 'do-not-overwrite');
  } finally { await t.close(); }
});

test('reading targets and drafts never creates editor folders; unchanged finish records once', async () => {
  const t = await setup();
  try {
    await t.api('/api/targets'); const d = await (await t.api('/api/drafts/market-note')).json();
    await assert.rejects(access(path.join(t.run, '05_final', 'editor')));
    const url = '/api/drafts/market-note/finish';
    const fin = await t.api(url, { method: 'POST', body: json({ baseRevision: d.revision }) });
    assert.equal(fin.status, 200);
    const finished = path.join(t.run, '05_final', 'editor', 'market-note', 'finished.json');
    const before = await readFile(finished);
    const again = await t.api(url, { method: 'POST', body: json({ baseRevision: d.revision }) });
    assert.equal(again.status, 409);
    assert.deepEqual(await readFile(finished), before);
    const rec = JSON.parse(before);
    assert.equal(rec.unchanged, true); assert.equal(rec.changedBlocks, 0);
  } finally { await t.close(); }
});

test('YAML front matter stays out of the editor and is preserved byte-for-byte on save', async () => {
  const t = await setup();
  try {
    const listing = JSON.parse(await readFile(path.join(t.run, 'editor-targets.json'), 'utf8'));
    const src = path.join(t.run, listing.targets[0].source);
    const front = '---\ntags:\n  - type/reference\ncreated: "2026-10-31"\n---\n\n';
    const original = front + await readFile(src, 'utf8');
    await writeFile(src, original);
    const d = await (await t.api(`/api/drafts/${listing.targets[0].id}`)).json();
    assert.ok(!d.state.markdown.includes('tags:')); assert.ok(!d.sourceMarkdown.startsWith('---'));
    assert.equal(d.revision, 'source');
    const edited = d.state.markdown.replace(/。/, '。追記。');
    const put = await t.api(`/api/drafts/${listing.targets[0].id}`, { method: 'PUT', body: json({ baseRevision: d.revision, state: { markdown: edited, notes: [] } }) });
    assert.equal(put.status, 200);
    const saved = await readFile(path.join(t.run, '05_final', 'editor', listing.targets[0].id, 'nat-final.md'), 'utf8');
    assert.ok(saved.startsWith(front)); assert.equal(saved, front + edited);
    assert.equal(await readFile(src, 'utf8'), original);
    const again = await (await t.api(`/api/drafts/${listing.targets[0].id}`)).json();
    assert.equal(again.state.markdown, edited);
  } finally { await t.close(); }
});
