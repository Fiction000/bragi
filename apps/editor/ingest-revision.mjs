import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const inside = (parent, child) => child === parent || child.startsWith(parent + path.sep);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const idPattern = /^[a-z0-9-]{1,64}$/;
const shaPattern = /^[a-f0-9]{64}$/;

async function rejectLinkedPath(root, relative) {
  if (typeof relative !== 'string' || path.isAbsolute(relative) || relative.split(/[\\/]/).some(part => part === '..' || part === '.' || part === '')) throw new Error('Unsafe artifact path');
  const realRoot = await fs.realpath(root);
  let current = realRoot;
  for (const part of relative.split(/[\\/]/)) {
    current = path.join(current, part);
    try { if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('Artifact path contains a symlink'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const real = await fs.realpath(current);
  if (!inside(realRoot, real)) throw new Error('Artifact path escapes workflow root');
  if (!(await fs.stat(real)).isFile()) throw new Error('Revision artifact must be a regular file');
  return real;
}

async function readRegularFile(root, relative) {
  let current = root;
  const parts = relative.split(path.sep);
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    const info = await fs.lstat(current);
    if (info.isSymbolicLink() || (i === parts.length - 1 ? !info.isFile() : !info.isDirectory())) throw new Error('Run metadata path is not a regular file');
  }
  return fs.readFile(current);
}

async function atomicWrite(file, bytes) {
  const temp = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    await fs.writeFile(temp, bytes, { flag: 'wx', mode: 0o600 });
    await fs.link(temp, file);
  } finally { await fs.rm(temp, { force: true }); }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

async function acquireLock(dir, name) {
  const file = path.join(dir, `${name}.lock`);
  const token = `${process.pid}:${Math.random().toString(16).slice(2)}`;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const handle = await fs.open(file, 'wx', 0o600);
      try { await handle.writeFile(token); } finally { await handle.close(); }
      return async () => {
        try { if (await fs.readFile(file, 'utf8') === token) await fs.unlink(file); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      };
    } catch (error) { if (error.code !== 'EEXIST') throw error; }
    let info;
    try { info = await fs.lstat(file); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (info.isSymbolicLink()) throw new Error('Ingest lock is a symlink');
    let stale = Date.now() - info.mtimeMs > 5_000;
    try {
      const pid = Number((await fs.readFile(file, 'utf8')).split(':')[0]);
      if (Number.isInteger(pid) && pid > 0) {
        try { process.kill(pid, 0); stale = false; }
        catch (error) { stale = error.code === 'ESRCH'; }
      }
    } catch (error) { if (error.code !== 'ENOENT') stale = Date.now() - info.mtimeMs > 5_000; }
    if (stale) { await fs.rm(file, { force: true }); continue; }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for revision ingest lock');
}

function validateEvent(event) {
  if (!event || typeof event !== 'object' || event.event_type !== 'bragi.agent.revision_ready') throw new Error('Invalid revision event type');
  if (!/^[0-9a-f-]{36}$/i.test(event.event_id ?? '') || !event.workflow_id || !/^[0-9a-f-]{36}$/i.test(event.parent_event_id ?? '')) throw new Error('Invalid event identifiers');
  if (!idPattern.test(event.slug ?? '') || !idPattern.test(event.target_id ?? '')) throw new Error('Invalid slug or target id');
  if (typeof event.editor_run !== 'string' || path.isAbsolute(event.editor_run) || event.editor_run.split('/').length < 2 || event.editor_run.split('/')[0] !== event.slug || event.editor_run.split(/[\\/]/).some(p => p === '..' || p === '.' || p === '')) throw new Error('Invalid parent run path');
  if (typeof event.artifact_ref !== 'string' || !shaPattern.test(event.sha256 ?? '') || !shaPattern.test(event.source_sha256 ?? '')) throw new Error('Invalid revision hashes or artifact reference');
  if (typeof event.label !== 'string' || !event.label.trim() || event.label.length > 100 || /[\r\n]/.test(event.label)) throw new Error('Invalid revision label');
}

export async function ingestRevision(event, { draftsRoot, workflowRoot, now = new Date() }) {
  validateEvent(event);
  const root = await fs.realpath(draftsRoot);
  const sourceRoot = await fs.realpath(workflowRoot);
  const artifact = await rejectLinkedPath(sourceRoot, event.artifact_ref);
  const bytes = await fs.readFile(artifact);
  if (hash(bytes) !== event.sha256) throw new Error('Revision SHA-256 mismatch');
  const parent = path.resolve(root, event.editor_run);
  if (!inside(root, parent) || await fs.realpath(parent) !== parent) throw new Error('Parent run path escapes drafts root or contains a symlink');
  const listing = JSON.parse(await readRegularFile(parent, 'editor-targets.json').then(bytes => bytes.toString('utf8')));
  const target = listing.targets?.find(item => item.id === event.target_id);
  if (!target) throw new Error('Unknown parent target');
  const finished = JSON.parse(await readRegularFile(parent, path.join('05_final', 'editor', event.target_id, 'finished.json')).then(bytes => bytes.toString('utf8')));
  if (finished.finalSha256 !== event.source_sha256) throw new Error('source_sha256 does not match parent finished revision');

  const eventDir = path.join(root, '.bragi-ingest-events');
  await fs.mkdir(eventDir, { recursive: true });
  if ((await fs.lstat(eventDir)).isSymbolicLink() || !inside(root, await fs.realpath(eventDir))) throw new Error('Ingest event store escapes drafts root');
  const eventFile = path.join(eventDir, `${event.event_id}.json`);
  const requestHash = hash(Buffer.from(stableJson(event)));
  const releaseEventLock = await acquireLock(eventDir, `event-${event.event_id}`);
  try {
    try {
      const prior = JSON.parse((await readRegularFile(eventDir, `${event.event_id}.json`)).toString('utf8'));
      if (prior.requestHash !== requestHash) throw new Error('Event ID reused with different content');
      return { ...prior.result, created: false };
    } catch (error) { if (error.code !== 'ENOENT') throw error; }

    const slugDir = path.join(root, event.slug);
    await fs.mkdir(slugDir, { recursive: true });
    const slugInfo = await fs.lstat(slugDir);
    if (slugInfo.isSymbolicLink() || !inside(root, await fs.realpath(slugDir))) throw new Error('Article folder escapes drafts root');
    const releaseSlugLock = await acquireLock(eventDir, `slug-${event.slug}`);
    try {
      for (const entry of await fs.readdir(slugDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || !/^editor-run-v[1-9]\d*$/.test(entry.name)) continue;
        try {
          const saved = JSON.parse((await readRegularFile(slugDir, path.join(entry.name, '.bragi-agent-ingest.json'))).toString('utf8'));
          if (saved.eventId === event.event_id) {
            if (saved.requestHash !== requestHash) throw new Error('Event ID reused with different content');
            await atomicWrite(eventFile, Buffer.from(JSON.stringify({ requestHash, result: saved.result, createdAt: now.toISOString() }, null, 2) + '\n'));
            return { ...saved.result, created: false };
          }
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      const entries = await fs.readdir(slugDir, { withFileTypes: true });
      let max = 0;
      for (const entry of entries) {
        const match = /^editor-run-v([1-9]\d*)$/.exec(entry.name);
        if (entry.isDirectory() && match) max = Math.max(max, Number(match[1]));
      }
      const runName = `editor-run-v${max + 1}`;
      const runDir = path.join(slugDir, runName);
      const staging = path.join(slugDir, `.editor-run-${event.event_id}.tmp`);
      await fs.rm(staging, { recursive: true, force: true });
      await fs.mkdir(staging, { mode: 0o700 });
      try {
        await fs.mkdir(path.join(staging, '05_final'), { recursive: true });
        const artifactName = 'agent-revision.md';
        await atomicWrite(path.join(staging, '05_final', artifactName), bytes);
        const newTarget = { ...target, version: event.label, source: `05_final/${artifactName}`, finished: false, agentRevision: true, verified: false };
        await atomicWrite(path.join(staging, 'editor-targets.json'), Buffer.from(JSON.stringify({ targets: [newTarget] }, null, 2) + '\n'));
        await atomicWrite(path.join(staging, 'editor-source-sha256-before.txt'), Buffer.from(`${event.sha256}  ${artifactName}\n`));
        const relPath = path.relative(root, runDir).split(path.sep).join('/');
        const runKey = Buffer.from(relPath).toString('base64url');
        const result = { created: true, runKey, relPath, path: `/r/${runKey}/`, notice: `エージェントの新しい版が届きました。${target.title} ${event.label} /r/${runKey}/` };
        await atomicWrite(path.join(staging, '.bragi-agent-ingest.json'), Buffer.from(JSON.stringify({ eventId: event.event_id, requestHash, result }, null, 2) + '\n'));
        await fs.rename(staging, runDir);
        await atomicWrite(eventFile, Buffer.from(JSON.stringify({ requestHash, result, createdAt: now.toISOString() }, null, 2) + '\n'));
        return result;
      } catch (error) {
        await fs.rm(staging, { recursive: true, force: true });
        throw error;
      }
    } finally { await releaseSlugLock(); }
  } finally { await releaseEventLock(); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const option = name => { const index = args.indexOf(name); return index < 0 ? null : args[index + 1]; };
  try {
    const eventFile = option('--event');
    const workflowRoot = option('--workflow-root') ?? path.dirname(eventFile ?? '.');
    const draftsRoot = option('--drafts-root');
    if (!eventFile || !draftsRoot) throw new Error('Usage: node apps/editor/ingest-revision.mjs --event <event.json> --workflow-root <dir> --drafts-root <dir>');
    const result = await ingestRevision(JSON.parse(await fs.readFile(eventFile, 'utf8')), { workflowRoot, draftsRoot });
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
