// The list endpoint and the /r/<key>/ routes, against the synthetic drafts folder of @wle/core.
process.env.BRAGI_TASK_IDS = String.raw`\bTASK-\d+\b|||\bjob_[0-9a-f]{8}\b`;
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { encodeRunKey } from '@wle/core';
import { createEditorServer } from '../server.mjs';

const fixture = path.resolve('../../packages/core/test/fixtures/drafts');
const pr = (number, state, extra = {}) => ({ url: `https://github.com/example/site/pull/${number}`, number, state, repo: 'example/site', ...extra });
const fakeGithub = async () => ({ 'example/site': [pr(7, 'open'), pr(8, 'merged')] });

async function setup(options = {}) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'wle-dash-'));
  const drafts = path.join(tmp, 'drafts');
  await cp(fixture, drafts, { recursive: true });
  const server = await createEditorServer({ draftsRoot: drafts, port: 0, github: fakeGithub, taskNotesDir: null, ...options });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const api = (url, init = {}) => fetch(origin + url, { ...init, headers: { ...(init.body ? { 'content-type': 'application/json', origin } : {}), ...init.headers } });
  return { tmp, drafts, server, origin, api, close: async () => { await new Promise(resolve => server.close(resolve)); await rm(tmp, { recursive: true, force: true }); } };
}

async function snapshot(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(`${p}/`, ...await snapshot(p));
    else { const s = await stat(p); out.push(`${p} ${s.size} ${s.mtimeMs}`); }
  }
  return out.sort();
}

test('GET /api/dashboard lists every article with its stage; PR state comes from the lookup', async () => {
  const t = await setup();
  try {
    const body = await (await t.api('/api/dashboard')).json();
    const by = Object.fromEntries(body.drafts.map(d => [d.slug, d]));
    assert.equal(body.drafts.length, 9);
    assert.deepEqual([by['writing-sample'].stage, by['deciding-sample'].stage, by['editing-sample'].stage, by['confirmed-sample'].stage, by['pr-sample'].stage], ['writing', 'awaiting-decision', 'awaiting-confirm', 'pr-unknown', 'gate-ci']);
    assert.deepEqual(by['pr-sample'].prs.map(p => p.state), ['open', 'merged']);
    assert.deepEqual(body.skippedFiles, ['loose-note.md']);
    assert.deepEqual(await (await t.api('/api/mode')).json(), { run: false, dashboard: true, ledger: false });
  } finally { await t.close(); }
});

test('the list is read-only: reading it changes nothing, and nothing but GET is accepted', async () => {
  const t = await setup();
  try {
    const before = await snapshot(t.tmp);
    await t.api('/api/dashboard'); await t.api('/api/dashboard');
    assert.deepEqual(await snapshot(t.tmp), before);
    for (const method of ['POST', 'PUT', 'DELETE']) {
      const r = await t.api('/api/dashboard', { method, body: '{}' });
      assert.equal(r.status, 404, method);
    }
    const badHost = await new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port: t.server.address().port, path: '/api/dashboard', headers: { host: 'evil.test' } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      req.on('error', reject); req.end();
    });
    assert.equal(badHost, 403);
    assert.deepEqual(await snapshot(t.tmp), before);
  } finally { await t.close(); }
});

test('a GitHub call that throws still returns the whole list, with the PRs as state unknown and a warning', async () => {
  const t = await setup({ github: async () => { throw new Error('gh failed'); } });
  try {
    const body = await (await t.api('/api/dashboard')).json();
    assert.equal(body.drafts.length, 9);
    const d = body.drafts.find(d => d.slug === 'pr-sample');
    assert.deepEqual([d.stage, d.prs.map(p => p.state)], ['gate-ci', ['unknown', 'unknown']]);
    assert.match(body.warnings.join(), /gh failed/);
  } finally { await t.close(); }
});

test('/r/<key>/ opens a scanned run with the same API as --run; anything else is not a run', async () => {
  const t = await setup();
  try {
    const body = await (await t.api('/api/dashboard')).json();
    const run = body.drafts.find(d => d.slug === 'editing-sample').editorRuns[0];
    const targets = await (await t.api(`/r/${run.key}/api/targets`)).json();
    assert.deepEqual(targets.map(x => x.id), ['editing-v1']);
    const draft = await (await t.api(`/r/${run.key}/api/drafts/editing-v1`)).json();
    assert.deepEqual(Object.keys(draft).sort(), ['finished', 'revision', 'sourceMarkdown', 'state', 'target']);
    // Keys come from the scanner only: a path, a missing run and a folder that is not a run are all refused.
    assert.equal((await t.api(`/r/${encodeRunKey('../outside')}/api/targets`)).status, 404);
    assert.equal((await t.api(`/r/${encodeRunKey('nope/editor-run')}/api/targets`)).status, 404);
    assert.equal((await t.api(`/r/${encodeRunKey('writing-sample')}/api/targets`)).status, 404);
    assert.equal((await t.api('/r/not-base64!/api/targets')).status, 404);
    assert.equal((await t.api(`/r/${run.key}/api/drafts/..%2Fx`)).status, 404);
  } finally { await t.close(); }
});

test('editing through /r/<key>/ writes only under that run (the editor, not the list, is what writes)', async () => {
  const t = await setup();
  try {
    const run = (await (await t.api('/api/dashboard')).json()).drafts.find(d => d.slug === 'editing-sample').editorRuns[0];
    const first = await (await t.api(`/r/${run.key}/api/drafts/editing-v1`)).json();
    const state = { markdown: first.state.markdown + '\n追記', notes: [] };
    const put = await t.api(`/r/${run.key}/api/drafts/editing-v1`, { method: 'PUT', body: JSON.stringify({ state, baseRevision: first.revision }) });
    assert.equal(put.status, 200);
    assert.equal(await readFile(path.join(t.drafts, 'editing-sample/editor-run/05_final/editor/editing-v1/nat-final.md'), 'utf8'), state.markdown);
    // Origin and content type are still required there.
    assert.equal((await fetch(`${t.origin}/r/${run.key}/api/drafts/editing-v1`, { method: 'PUT', body: '{}' })).status, 403);
    // The run is now being edited; finishing it (a write the person triggers) moves the article on at the next read.
    const again = await (await t.api(`/r/${run.key}/api/drafts/editing-v1`)).json();
    assert.equal((await t.api(`/r/${run.key}/api/drafts/editing-v1/finish`, { method: 'POST', body: JSON.stringify({ baseRevision: again.revision }) })).status, 200);
    const after = (await (await t.api('/api/dashboard')).json()).drafts.find(d => d.slug === 'editing-sample');
    assert.equal(after.stage, 'pr-unknown');
  } finally { await t.close(); }
});

test('--run alone is unchanged: no list endpoint, /api/mode says so, /r/ is not routed', async () => {
  const server = await createEditorServer({ run: path.resolve('test/fixtures/run'), port: 0 });
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.deepEqual(await (await fetch(`${origin}/api/mode`)).json(), { run: true, dashboard: false, ledger: false });
    assert.equal((await fetch(`${origin}/api/dashboard`)).status, 404);
    assert.equal((await fetch(`${origin}/api/targets`)).status, 200);
    assert.equal((await fetch(`${origin}/r/abc/api/targets`)).status, 404);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('--run together with a drafts folder: the list is at /, the run is still at /api', async () => {
  const t = await setup({ run: path.resolve('test/fixtures/run') });
  try {
    assert.deepEqual(await (await t.api('/api/mode')).json(), { run: true, dashboard: true, ledger: false });
    assert.equal((await t.api('/api/targets')).status, 200);
  } finally { await t.close(); }
});

test('neither --run nor a drafts folder is refused', async () => {
  await assert.rejects(createEditorServer({ port: 0 }), /--run <dir> is required/);
});

test('the server passes the index, the TaskNotes folder and the PR list through to the scan', async () => {
  const core = path.resolve('../../packages/core/test/fixtures');
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'wle-dash-idx-'));
  try {
    await cp(core, path.join(tmp, 'hq'), { recursive: true });
    const server = await createEditorServer({
      draftsRoot: path.join(tmp, 'hq', 'drafts'), port: 0,
      github: async () => ({ 'example/site': [pr(31, 'merged', { branch: 'content/branch-sample-intro-20261113' }), pr(114, 'open', { branch: 'content/loose-intro-20261106' })] }),
      prRepos: ['example/site'], taskNotesDir: path.join(tmp, 'hq', 'tasknotes'), draftsIndex: path.join(tmp, 'hq', 'index', 'loose.index.yaml'),
    });
    try {
      const body = await (await fetch(`http://127.0.0.1:${server.address().port}/api/dashboard`)).json();
      const by = Object.fromEntries(body.drafts.map(d => [d.slug, d]));
      assert.equal(body.drafts.length, 10);
      assert.deepEqual([by['loose-20261106'].source, by['loose-20261106'].stage], ['manual', 'awaiting-confirm']);
      assert.equal(by['branch-sample-20261113'].stage, 'published');
      assert.equal(by['deciding-sample'].due, '2026-12-05');
    } finally { await new Promise(resolve => server.close(resolve)); }
  } finally { await rm(tmp, { recursive: true, force: true }); }
});

test('ledger endpoints: list, retire writes only that one file, bad ids and bad origin are refused; off without a folder', async () => {
  const { createDecision } = await import('@wle/core');
  const led = await mkdtemp(path.join(os.tmpdir(), 'wle-led-'));
  const mk = (id, over = {}) => createDecision(led, { id, scope: 'draft', draft: 'sample-20261113', kind: 'fact', status: 'active', decided_by: '著者', decided_at: '2026-11-16', source: 'synthetic', body: `合成の判断 ${id}`, ...over });
  await mk('D-2026-11-16-a-q01'); await mk('D-2026-11-16-a-q02');
  const t = await setup({ ledgerDir: led });
  try {
    const stray = path.join(led, 'D-2026-11-16-stray.md');
    await writeFile(stray, '---\nid: D-2026-11-16-stray\nsurprise: 1\n---\nx\n');
    const withProblem = await (await t.api('/api/ledger')).json();
    assert.equal(withProblem.decisions.length, 2);
    assert.deepEqual(withProblem.problems.map(p => p.file), ['D-2026-11-16-stray.md']);
    assert.match(withProblem.problems[0].message, /unknown key surprise/);
    await rm(stray);
    assert.deepEqual(await (await t.api('/api/mode')).json(), { run: false, dashboard: true, ledger: true });
    const list = await (await t.api('/api/ledger')).json();
    assert.deepEqual(list.decisions.map(d => [d.meta.id, d.meta.status, d.file]), [['D-2026-11-16-a-q01', 'active', 'D-2026-11-16-a-q01.md'], ['D-2026-11-16-a-q02', 'active', 'D-2026-11-16-a-q02.md']]);
    const before = await snapshot(led);
    assert.equal((await fetch(`${t.origin}/api/ledger/retire`, { method: 'POST', body: '{}' })).status, 403);
    assert.equal((await t.api('/api/ledger/retire', { method: 'POST', body: JSON.stringify({ id: '../x' }) })).status, 400);
    assert.equal((await t.api('/api/ledger/retire', { method: 'POST', body: JSON.stringify({ id: 'D-2026-11-16-none' }) })).status, 404);
    assert.equal((await t.api('/api/ledger', { method: 'POST', body: '{}' })).status, 404);
    assert.deepEqual(await snapshot(led), before);
    const r = await t.api('/api/ledger/retire', { method: 'POST', body: JSON.stringify({ id: 'D-2026-11-16-a-q01' }) });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).meta.status, 'retired');
    const after = await snapshot(led);
    assert.equal(after.filter((l, i) => l !== before[i]).length, 1, 'exactly one file changed');
    assert.equal((await t.api('/api/ledger/retire', { method: 'POST', body: JSON.stringify({ id: 'D-2026-11-16-a-q01' }) })).status, 409);
  } finally { await t.close(); await rm(led, { recursive: true, force: true }); }
  const off = await setup();
  try { assert.equal((await off.api('/api/ledger')).status, 404); } finally { await off.close(); }
});

test('proposal endpoints: list, adopt (one new ledger file, one proposal file changed), reject (one proposal file), refusals; nothing here proposes; off without a ledger', async () => {
  const { createDecision, proposeDecision } = await import('@wle/core');
  const base = await mkdtemp(path.join(os.tmpdir(), 'wle-prop-'));
  const led = path.join(base, 'ledger'), prop = path.join(base, 'proposals');
  await createDecision(led, { id: 'D-2026-11-16-a-q01', scope: 'draft', draft: 'sample-20261113', kind: 'fact', status: 'active', decided_by: '著者', decided_at: '2026-11-16', source: 'synthetic', body: '既存の判断。' });
  const mk = (slug, body) => proposeDecision(prop, led, { slug, proposed_by: 'test-agent', draft: 'sample-20261113', kind: 'phrasing', source: 'synthetic#Q1', body }, '2026-11-21');
  await mk('one', '一つ目の候補。'); await mk('two', '二つ目の候補。'); await mk('three', '三つ目の候補。');
  const t = await setup({ ledgerDir: led });   // the proposals folder is found next to the ledger
  const post = (p, body) => t.api(p, { method: 'POST', body: JSON.stringify(body) });
  try {
    const list = await (await t.api('/api/proposals')).json();
    assert.equal(list.dir, prop);
    assert.deepEqual(list.proposals.map(p => [p.meta.id, p.meta.status, p.meta.proposed_by, p.file]), ['one', 'three', 'two'].map(s => [`P-2026-11-21-${s}`, 'pending', 'test-agent', `P-2026-11-21-${s}.md`]));
    // reading changes nothing; the ledger list does not contain proposals
    const pBefore = await snapshot(prop), lBefore = await snapshot(led);
    assert.deepEqual((await (await t.api('/api/ledger')).json()).decisions.map(d => d.meta.id), ['D-2026-11-16-a-q01']);
    assert.deepEqual([await snapshot(prop), await snapshot(led)], [pBefore, lBefore]);

    // refusals: no Origin, bad id, unknown id, a POST to the list, nobody can propose over HTTP
    assert.equal((await fetch(`${t.origin}/api/proposals/adopt`, { method: 'POST', body: '{}' })).status, 403);
    assert.equal((await post('/api/proposals/adopt', { id: '../x' })).status, 400);
    assert.equal((await post('/api/proposals/adopt', { id: 'P-2026-11-21-none' })).status, 404);
    assert.equal((await post('/api/proposals/reject', { id: 'P-2026-11-21-none' })).status, 404);
    assert.equal((await post('/api/proposals', { slug: 'x' })).status, 404);
    assert.equal((await post('/api/proposals/propose', { slug: 'x' })).status, 404);
    assert.deepEqual([await snapshot(prop), await snapshot(led)], [pBefore, lBefore]);

    // adopt: a new decision in the ledger, the proposal kept as adopted; nothing else changes
    const r = await post('/api/proposals/adopt', { id: 'P-2026-11-21-one' });
    assert.equal(r.status, 200);
    const done = await r.json();
    assert.deepEqual([done.proposal.meta.status, done.proposal.meta.adopted_as, done.decision.meta.status, done.decision.meta.decided_by, done.decision.file], ['adopted', done.decision.meta.id, 'active', '著者', `${done.decision.meta.id}.md`]);
    const lAfter = await snapshot(led), pAfter = await snapshot(prop);
    assert.equal(lAfter.length, lBefore.length + 1, 'one new ledger file');
    assert.equal(lAfter.filter(x => !lBefore.includes(x)).length, 1 + 0, 'and no ledger file changed');
    assert.equal(pAfter.length, pBefore.length);
    assert.equal(pAfter.filter((l, i) => l !== pBefore[i]).length, 1, 'exactly one proposal file changed');
    assert.deepEqual((await (await t.api('/api/ledger')).json()).decisions.map(d => d.meta.id).sort(), ['D-2026-11-16-a-q01', done.decision.meta.id].sort());
    assert.equal((await post('/api/proposals/adopt', { id: 'P-2026-11-21-one' })).status, 409);
    assert.equal((await post('/api/proposals/reject', { id: 'P-2026-11-21-one' })).status, 409);
    assert.equal((await snapshot(led)).length, lAfter.length);

    // reject: one proposal file, the ledger untouched, and it cannot be adopted afterwards
    const rj = await post('/api/proposals/reject', { id: 'P-2026-11-21-two' });
    assert.equal(rj.status, 200);
    assert.equal((await rj.json()).proposal.meta.status, 'rejected');
    assert.deepEqual(await snapshot(led), lAfter);
    assert.equal((await snapshot(prop)).filter((l, i) => l !== pAfter[i]).length, 1);
    assert.equal((await post('/api/proposals/adopt', { id: 'P-2026-11-21-two' })).status, 409);
    assert.deepEqual((await (await t.api('/api/proposals')).json()).proposals.map(p => p.meta.status), ['adopted', 'pending', 'rejected']);
  } finally { await t.close(); await rm(base, { recursive: true, force: true }); }
  const off = await setup();
  try { assert.equal((await off.api('/api/proposals')).status, 404); } finally { await off.close(); }
});
