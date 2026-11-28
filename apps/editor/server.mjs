import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAccessVerifier } from './access.mjs';
import { createFinishedEvent, listPendingOutboxes, sendOutboxEvent, validateWebhookUrl } from './webhook-outbox.mjs';
import { createGhGraphql, decodeRunKey, defaultLedgerDir, loadLedger, retireDecision, adoptProposal, rejectProposal, loadProposals, proposalsDirFor, defaultDraftsRoot, defaultTaskNotesDir, loadSettings, today, listEditorRuns, scanDrafts } from '@wle/core';

const root = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 4317);
const MAX_BODY = 2 * 1024 * 1024;

export function revisionFor(state) {
  return createHash('sha256').update(JSON.stringify({ markdown: state.markdown, notes: state.notes })).digest('hex');
}

function safeId(id) {
  return /^[a-z0-9-]{1,64}$/.test(id);
}

function inside(parent, child) {
  return child === parent || child.startsWith(parent + path.sep);
}

async function atomicWrite(file, contents) {
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await fs.open(temp, 'wx', 0o600);
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temp, file);
  const dir = await fs.open(path.dirname(file), 'r');
  try { await dir.sync(); } finally { await dir.close(); }
}

async function atomicWriteOnce(file, contents) {
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await fs.open(temp, 'wx', 0o600);
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.link(temp, file);
  } catch (error) {
    await fs.unlink(temp);
    if (error.code === 'EEXIST') return false;
    throw error;
  }
  await fs.unlink(temp);
  const dir = await fs.open(path.dirname(file), 'r');
  try { await dir.sync(); } finally { await dir.close(); }
  return true;
}

async function loadTargets(runDir) {
  const listing = JSON.parse(await fs.readFile(path.join(runDir, 'editor-targets.json'), 'utf8'));
  if (!Array.isArray(listing.targets)) throw new Error('editor-targets.json must contain targets');
  const targets = new Map();
  for (const target of listing.targets) {
    if (!safeId(target.id) || targets.has(target.id) || typeof target.title !== 'string' || typeof target.medium !== 'string' || typeof target.version !== 'string') throw new Error('Invalid target');
    if (typeof target.source !== 'string' || path.isAbsolute(target.source) || target.source.split(/[\\/]/).includes('..')) throw new Error(`Unsafe source for ${target.id}`);
    const source = await fs.realpath(path.resolve(runDir, target.source));
    if (!inside(runDir, source)) throw new Error(`Source outside run for ${target.id}`);
    targets.set(target.id, { ...target, source });
  }
  return targets;
}

function targetById(targets, id) {
  if (!safeId(id)) return null;
  return targets.get(id) ?? null;
}

async function realpathAllowMissing(target) {
  // Resolve the nearest existing ancestor so reads never have to create directories.
  const rest = [];
  let cur = target;
  for (;;) {
    try { return path.join(await fs.realpath(cur), ...rest.reverse()); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(cur);
      if (parent === cur) throw error;
      rest.push(path.basename(cur)); cur = parent;
    }
  }
}

async function draftFiles(runDir, id, { create = false } = {}) {
  const dir = path.join(runDir, '05_final', 'editor', id);
  if (create) await fs.mkdir(dir, { recursive: true });
  const real = await realpathAllowMissing(dir);
  if (!inside(runDir, real)) throw new Error('Editor path outside run');
  return { dir: real, markdown: path.join(real, 'nat-final.md'), notes: path.join(real, 'nat-notes.json'), finished: path.join(real, 'finished.json') };
}

// Obsidian YAML front matter is metadata, not prose: keep it out of the editor and re-attach it byte-for-byte on write.
export function splitFront(text) {
  const m = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n)+/.exec(text);
  return m ? { front: m[0], body: text.slice(m[0].length) } : { front: '', body: text };
}

async function readSource(target) {
  const raw = await fs.readFile(target.source, 'utf8');
  return { raw, ...splitFront(raw) };
}

async function currentDraft(runDir, target) {
  const files = await draftFiles(runDir, target.id);
  for (const file of [files.markdown, files.notes, files.finished]) {
    try { if (!inside(runDir, await fs.realpath(file))) throw new Error('Draft path outside run'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  let state;
  try {
    const markdown = splitFront(await fs.readFile(files.markdown, 'utf8')).body;
    const notes = JSON.parse(await fs.readFile(files.notes, 'utf8'));
    state = { markdown, notes };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    state = { markdown: (await readSource(target)).body, notes: [] };
  }
  const revision = state.markdown === (await readSource(target)).body && state.notes.length === 0 && !(await exists(files.markdown)) ? 'source' : revisionFor(state);
  return { files, state, revision, finished: await exists(files.finished) };
}

async function exists(file) {
  try { await fs.access(file); return true; } catch { return false; }
}

async function validateState(state) {
  if (!state || typeof state.markdown !== 'string' || !Array.isArray(state.notes)) return false;
  if (Buffer.byteLength(state.markdown, 'utf8') > MAX_BODY) return false;
  return state.notes.every(n => n && typeof n.id === 'string' && typeof n.body === 'string' && Number.isInteger(n.anchor?.blockIndex) && typeof n.anchor?.text === 'string');
}

async function writeState(files, state, front = '') {
  await atomicWrite(files.markdown, front + state.markdown);
  await atomicWrite(files.notes, JSON.stringify(state.notes, null, 2) + '\n');
}

function response(res, status, value, headers = {}) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length, 'cache-control': 'no-store', ...headers });
  res.end(body);
}

// Today in Japan, as YYYY-MM-DD (the date a decision is retired on).
const localDate = () => today();

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw Object.assign(new Error('Body too large'), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('Invalid JSON'), { status: 400 }); }
}

function changedCount(source, markdown) {
  const blocks = text => text.split(/\n\s*\n/).map(s => s.trim().replace(/^#{1,6}\s+|^>\s?|^[-*+]\s+|^\d+\.\s+/gm, '').replace(/[*_`\[\]()]/g, '').trim()).filter(Boolean);
  const a = blocks(source), b = blocks(markdown), rows = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) rows[i][j] = a[i] === b[j] ? rows[i + 1][j + 1] + 1 : Math.max(rows[i + 1][j], rows[i][j + 1]);
  const common = rows[0][0];
  return Math.max(a.length, b.length) - common;
}

// One run's API (everything under /api/targets and /api/drafts). `apiPath` is the path with any /r/<key> prefix removed.
async function handleRun({ req, res, url, apiPath, runDir, targets, runId, webhookUrl, webhookSecret, webhookEnabled, webhookFetch }) {
  if (req.method === 'GET' && apiPath === '/api/targets') {
    const items = [];
    for (const target of targets.values()) items.push({ id: target.id, title: target.title, medium: target.medium, version: target.version, finished: (await currentDraft(runDir, target)).finished });
    return response(res, 200, items, { 'x-editor-run-id': runId });
  }
  const match = apiPath.match(/^\/api\/drafts\/([^/]+)(?:\/(fork|finish))?$/);
  if (apiPath.startsWith('/api/') && !match && req.method === 'GET') return response(res, 404, { error: 'Not found' });
  if (!match) return false;
  const id = decodeURIComponent(match[1]);
  const target = targetById(targets, id);
  if (!target) return response(res, 404, { error: 'Unknown target' });
  if (req.method === 'GET' && !match[2]) {
    const draft = await currentDraft(runDir, target);
    return response(res, 200, { target: { id: target.id, title: target.title, medium: target.medium, version: target.version }, sourceMarkdown: (await readSource(target)).body, state: draft.state, revision: draft.revision, finished: draft.finished }, { 'x-editor-run-id': runId });
  }
  if (req.method === 'PUT' && !match[2]) {
    const body = await readBody(req);
    if (!await validateState(body.state) || typeof body.baseRevision !== 'string') return response(res, 400, { error: 'Invalid state' });
    const draft = await currentDraft(runDir, target);
    if (body.baseRevision !== draft.revision) return response(res, 409, { revision: draft.revision });
    const files = await draftFiles(runDir, id, { create: true });
    await writeState(files, body.state, (await readSource(target)).front);
    return response(res, 200, { revision: revisionFor(body.state) });
  }
  if (req.method === 'POST' && match[2] === 'fork') {
    const body = await readBody(req);
    if (!await validateState(body.state)) return response(res, 400, { error: 'Invalid state' });
    const files = await draftFiles(runDir, id, { create: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    let markdownFile = `nat-final.conflict-${stamp}.md`, notesFile = markdownFile.replace('.md', '.notes.json');
    while (await exists(path.join(files.dir, markdownFile))) {
      const suffix = randomUUID().slice(0, 8); markdownFile = `nat-final.conflict-${stamp}-${suffix}.md`; notesFile = markdownFile.replace('.md', '.notes.json');
    }
    await atomicWrite(path.join(files.dir, markdownFile), (await readSource(target)).front + body.state.markdown);
    await atomicWrite(path.join(files.dir, notesFile), JSON.stringify(body.state.notes, null, 2) + '\n');
    return response(res, 200, { paths: [path.relative(runDir, path.join(files.dir, markdownFile)), path.relative(runDir, path.join(files.dir, notesFile))] });
  }
  if (req.method === 'POST' && match[2] === 'finish') {
    const body = await readBody(req), existingFiles = await draftFiles(runDir, id);
    if (await exists(existingFiles.finished)) return response(res, 409, { error: 'Already finished' });
    const draft = await currentDraft(runDir, target);
    if (body.baseRevision !== draft.revision) return response(res, 409, { revision: draft.revision });
    const finishFiles = await draftFiles(runDir, id, { create: true });
    const src = await readSource(target), sourceMarkdown = src.body;
    const record = { id, finishedAt: new Date().toISOString(), sourceSha256: createHash('sha256').update(src.raw).digest('hex'), finalSha256: createHash('sha256').update(src.front + draft.state.markdown).digest('hex'), changedBlocks: changedCount(sourceMarkdown, draft.state.markdown), notes: draft.state.notes.length, unchanged: sourceMarkdown === draft.state.markdown };
    if (!await atomicWriteOnce(finishFiles.finished, JSON.stringify(record, null, 2) + '\n')) return response(res, 409, { error: 'Already finished' });
    if (webhookEnabled) {
      const outbox = await createFinishedEvent({ runDir, target, runId, record, eventId: randomUUID() });
      void sendOutboxEvent({ file: outbox.file ?? path.join(finishFiles.dir, 'finished-event.json'), url: webhookUrl, signingKey: webhookSecret, fetchImpl: webhookFetch }).catch(() => {});
    }
    return response(res, 200, record);
  }
  return false;
}

async function serveStatic(res, pathname) {
  const file = pathname === '/' ? path.join(root, 'dist', 'index.html') : path.resolve(root, 'dist', `.${decodeURIComponent(pathname)}`);
  const realRoot = await fs.realpath(path.join(root, 'dist'));
  let real;
  try { real = await fs.realpath(file); } catch { return response(res, 404, { error: 'Not found' }); }
  if (!inside(realRoot, real)) return response(res, 404, { error: 'Not found' });
  const bytes = await fs.readFile(real);
  res.writeHead(200, { 'content-type': real.endsWith('.html') ? 'text/html; charset=utf-8' : real.endsWith('.css') ? 'text/css; charset=utf-8' : real.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'application/octet-stream', 'content-length': bytes.length });
  return res.end(bytes);
}

// run: the one run opened with --run (served at /, as before). draftsRoot: turns on the read-only list at / and
// opens any scanned run at /r/<key>/. ledgerDir: the decision ledger folder (null: no ledger; the CLI passes the default). Only runs the scanner finds can be opened; a key is never a path.
// publicHost: also answer for this hostname (behind Cloudflare Access, reached through the tunnel). Then
// verifyAccess must be given, and every request with that Host needs a verified Access assertion.
export async function createEditorServer({ run: runPath, draftsRoot, port = PORT, github, prRepos = [], taskNotesDir, draftsIndex, ledgerDir = null, proposalsDir = null, publicHost = null, verifyAccess = null, webhookUrl = process.env.BRAGI_WEBHOOK_URL, webhookSecret = process.env.BRAGI_WEBHOOK_SECRET, webhookFetch = fetch }) {
  if (!runPath && draftsRoot === undefined) throw new Error('--run <dir> is required');
  if (publicHost && typeof verifyAccess !== 'function') throw new Error('--public-host needs Access settings');
  if (webhookUrl) webhookUrl = validateWebhookUrl(webhookUrl);
  const webhookEnabled = Boolean(webhookUrl && typeof webhookSecret === 'string' && webhookSecret.trim());
  const runDir = runPath ? await fs.realpath(path.resolve(runPath)) : null;
  const targets = runDir ? await loadTargets(runDir) : null;
  const dashboard = draftsRoot !== undefined;
  // github: undefined -> `gh api graphql` (one call, cached 60 s); null -> do not ask GitHub; or a function (tests).
  const gh = github === undefined ? createGhGraphql() : github;
  // taskNotesDir: undefined -> the configured TaskNotes folder (BRAGI_TASKNOTES), if any; null -> none. draftsIndex: undefined -> <root>/drafts.index.yaml if present.
  const notesDir = taskNotesDir === undefined ? defaultTaskNotesDir() : taskNotesDir;
  const keyed = new Map();
  let runsCache = { at: 0, runs: [] };
  const scannedRuns = async () => {
    if (Date.now() - runsCache.at > 3000) runsCache = { at: Date.now(), runs: await listEditorRuns(draftsRoot) };
    return runsCache.runs;
  };
  const keyedRun = async (key) => {
    let relPath;
    try { relPath = decodeRunKey(key); } catch { return null; }
    const found = (await scannedRuns()).find(r => r.relPath === relPath && r.key === key);
    if (!found) return null;
    const dir = await fs.realpath(found.dir);
    if (!keyed.has(dir)) keyed.set(dir, loadTargets(dir).catch(error => { keyed.delete(dir); throw error; }));
    return { dir, targets: await keyed.get(dir), runId: key };
  };
  const server = http.createServer(async (req, res) => {
    const actualPort = server.address()?.port ?? port;
    const host = req.headers.host;
    const isPublic = Boolean(publicHost) && host === publicHost;
    if (!isPublic && host !== `127.0.0.1:${actualPort}` && host !== `localhost:${actualPort}`) return response(res, 403, { error: 'Bad Host' });
    if (isPublic && !(await verifyAccess(req.headers['cf-access-jwt-assertion']))) return response(res, 403, { error: 'Access required' });
    let url;
    try { url = new URL(req.url, `http://${host}`); } catch { return response(res, 400, { error: 'Bad URL' }); }
    if (req.method !== 'GET') {
      const expectedOrigin = isPublic ? `https://${host}` : `http://${host}`;
      if (req.headers.origin !== expectedOrigin) return response(res, 403, { error: 'Bad Origin' });
      if (req.headers['content-type']?.split(';')[0] !== 'application/json') return response(res, 415, { error: 'Expected application/json' });
    }
    try {
      const rawPath = req.url.split('?')[0];
      if (req.method === 'GET' && rawPath === '/api/mode') return response(res, 200, { run: runDir !== null, dashboard, ledger: dashboard && Boolean(ledgerDir) });
      if (req.method === 'GET' && rawPath === '/api/dashboard') {
        if (!dashboard) return response(res, 404, { error: 'No drafts folder is configured' });
        try { return response(res, 200, await scanDrafts(draftsRoot, { github: gh, prRepos, taskNotesDir: notesDir, indexFile: draftsIndex })); }
        catch (error) { return response(res, 500, { error: `Cannot read ${draftsRoot}: ${error.message}` }); }
      }
      if (rawPath === '/api/ledger' || rawPath === '/api/ledger/retire') {
        if (!dashboard || !ledgerDir) return response(res, 404, { error: 'No ledger folder is configured' });
        if (req.method === 'GET' && rawPath === '/api/ledger') {
          const { decisions, problems } = await loadLedger(ledgerDir);
          return response(res, 200, { dir: ledgerDir, decisions: decisions.map(({ file, ...d }) => ({ ...d, file: path.basename(file) })), problems });
        }
        if (req.method === 'POST' && rawPath === '/api/ledger/retire') {
          const body = await readBody(req);
          const decision = await retireDecision(ledgerDir, String(body?.id ?? ''), localDate());
          const { file, ...rest } = decision;
          return response(res, 200, { ...rest, file: path.basename(file) });
        }
        return response(res, 404, { error: 'Not found' });
      }
      // Proposals (step 6): agents put them in via MCP; only here does a person adopt (one new ledger file + the proposal marked adopted) or reject.
      if (rawPath === '/api/proposals' || rawPath === '/api/proposals/adopt' || rawPath === '/api/proposals/reject') {
        if (!dashboard || !ledgerDir) return response(res, 404, { error: 'No ledger folder is configured' });
        const pdir = proposalsDir ?? proposalsDirFor(ledgerDir);
        const out = ({ file, ...p }) => ({ ...p, file: path.basename(file) });
        if (req.method === 'GET' && rawPath === '/api/proposals') {
          const { proposals, problems } = await loadProposals(pdir);
          return response(res, 200, { dir: pdir, proposals: proposals.map(out), problems });
        }
        if (req.method === 'POST' && rawPath !== '/api/proposals') {
          const body = await readBody(req);
          const id = String(body?.id ?? '');
          if (rawPath === '/api/proposals/reject') return response(res, 200, { proposal: out(await rejectProposal(pdir, id, localDate())) });
          const { proposal, decision } = await adoptProposal(pdir, ledgerDir, id, localDate(), loadSettings().author);
          return response(res, 200, { proposal: out(proposal), decision: out(decision) });
        }
        return response(res, 404, { error: 'Not found' });
      }
      const keyedMatch = dashboard ? rawPath.match(/^\/r\/([A-Za-z0-9_-]+)(\/.*)?$/) : null;
      if (keyedMatch) {
        const found = await keyedRun(keyedMatch[1]);
        if (!found) return response(res, 404, { error: 'Unknown run' });
        const rest = keyedMatch[2] ?? '/';
        if (req.method === 'GET' && !rest.startsWith('/api/')) return rest === '/' ? await serveStatic(res, '/') : response(res, 404, { error: 'Not found' });
        const handled = await handleRun({ req, res, url, apiPath: rest, runDir: found.dir, targets: found.targets, runId: found.runId, webhookUrl, webhookSecret, webhookEnabled, webhookFetch });
        return handled === false ? response(res, 404, { error: 'Not found' }) : handled;
      }
      if (runDir) {
        const handled = await handleRun({ req, res, url, apiPath: rawPath, runDir, targets, runId: path.basename(runDir), webhookUrl, webhookSecret, webhookEnabled, webhookFetch });
        if (handled !== false) return handled;
      } else if (rawPath.startsWith('/api/')) return response(res, 404, { error: 'Not found' });
      if (req.method === 'GET') return await serveStatic(res, url.pathname);
      response(res, 404, { error: 'Not found' });
    } catch (error) {
      response(res, error.status ?? 500, { error: error.message });
    }
  });
  if (webhookEnabled) {
    const outboxRoot = draftsRoot ?? runDir;
    void listPendingOutboxes(outboxRoot).then(files => Promise.all(files.map(file => sendOutboxEvent({ file, url: webhookUrl, signingKey: webhookSecret, fetchImpl: webhookFetch })))).catch(() => {});
  }
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const option = name => { const i = args.indexOf(name); return i < 0 ? null : args[i + 1]; };
  // --run alone keeps the original behaviour (the editor at /). Without --run, or with --drafts-root, / is the read-only list.
  const run = option('--run');
  const draftsRoot = option('--drafts-root') ?? (run ? undefined : defaultDraftsRoot());
  const ledgerDir = draftsRoot === undefined ? null : (option('--ledger') ?? defaultLedgerDir());
  const prRepos = args.flatMap((a, i) => (a === '--pr-repo' ? [args[i + 1]] : []));
  const publicHost = option('--public-host');
  const verifyAccess = publicHost ? createAccessVerifier({
    teamDomain: option('--access-team'),
    audience: option('--access-aud'),
    emails: args.flatMap((a, i) => (a === '--access-email' ? [args[i + 1]] : [])),
  }) : null;
  createEditorServer({ run, draftsRoot, port: Number(option('--port') ?? PORT), prRepos, ledgerDir, proposalsDir: option('--proposals') ?? null, draftsIndex: option('--drafts-index') ?? undefined, taskNotesDir: option('--tasknotes') ?? undefined, publicHost, verifyAccess }).then(server => {
    process.stdout.write(`Local Editor listening at http://127.0.0.1:${server.address().port}\n`);
  }).catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
