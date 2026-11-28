import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const HERMES_WINDOW_SECONDS = 300;
const MAX_ATTEMPTS = 6;
const PERMANENT_FAILURES = new Set([400, 401, 403, 404, 409]);
const inFlight = new Map();

export function validateWebhookUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || !(url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1' || url.hostname === '[::1]')) throw new Error('BRAGI_WEBHOOK_URL must use a loopback host');
  if (url.username || url.password || url.hash) throw new Error('BRAGI_WEBHOOK_URL must not contain credentials or a fragment');
  return url.toString();
}

export function signWebhook(body, secret, timestamp = String(Math.floor(Date.now() / 1000)), now = Date.now()) {
  const seconds = Number(timestamp);
  if (!Number.isInteger(seconds) || Math.abs(Math.floor(now / 1000) - seconds) > HERMES_WINDOW_SECONDS) throw new Error('Webhook timestamp is outside the accepted replay window');
  const raw = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const signature = createHmac('sha256', secret).update(timestamp + '.').update(raw).digest('hex');
  return { 'X-Webhook-Timestamp': timestamp, 'X-Webhook-Signature-V2': signature };
}

export function verifyWebhookSignature(body, secret, headers, now = Date.now()) {
  const timestamp = headers['x-webhook-timestamp'];
  const signature = headers['x-webhook-signature-v2'];
  if (typeof timestamp !== 'string' || !/^\d+$/.test(timestamp) || typeof signature !== 'string' || !/^[a-f0-9]{64}$/i.test(signature)) return false;
  if (Math.abs(Math.floor(now / 1000) - Number(timestamp)) > HERMES_WINDOW_SECONDS) return false;
  const expected = createHmac('sha256', secret).update(timestamp + '.').update(body).digest();
  const received = Buffer.from(signature, 'hex');
  return received.length === expected.length && timingSafeEqual(received, expected);
}

async function persist(file, value) {
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await fs.rename(temp, file);
  } finally { await fs.rm(temp, { force: true }); }
}

function retryAfterMs(value, now = Date.now()) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

async function sendOutboxEventOnce({ file, url, signingKey, fetchImpl = fetch, sleep = ms => new Promise(resolve => { const timer = setTimeout(resolve, ms); timer.unref?.(); }), now = Date.now }) {
  const endpoint = validateWebhookUrl(url);
  const record = JSON.parse(await fs.readFile(file, 'utf8'));
  if (record.status !== 'pending') return record;
  const scheduled = Date.parse(record.next_attempt_at ?? '');
  if (Number.isFinite(scheduled) && scheduled > now()) await sleep(scheduled - now());
  const body = Buffer.from(JSON.stringify(record.event));
  for (;;) {
    if (record.attempts >= MAX_ATTEMPTS) { record.status = 'exhausted'; await persist(file, record); return record; }
    record.attempts += 1;
    await persist(file, record);
    const timestamp = String(Math.floor(now() / 1000));
    try {
      const response = await fetchImpl(endpoint, { method: 'POST', headers: {
        'content-type': 'application/json', 'X-Request-ID': record.event.event_id,
        ...signWebhook(body, signingKey, timestamp, now()),
      }, body, signal: AbortSignal.timeout(15_000), redirect: 'error' });
      if (response.ok) { record.status = 'sent'; record.last_status = response.status; await persist(file, record); return record; }
      record.last_status = response.status;
      if (PERMANENT_FAILURES.has(response.status)) { record.status = 'quarantined'; await persist(file, record); return record; }
      record.last_error = `HTTP ${response.status}`;
      const delay = response.status === 429 ? retryAfterMs(response.headers.get('retry-after'), now()) : null;
      if (record.attempts >= 6) { record.status = 'exhausted'; await persist(file, record); return record; }
      const wait = delay ?? 60_000 * 2 ** (record.attempts - 1);
      record.next_attempt_at = new Date(now() + wait).toISOString();
      await persist(file, record);
      await sleep(wait);
    } catch (error) {
      record.last_error = String(error?.message ?? error).slice(0, 300);
      if (record.attempts >= 6) { record.status = 'exhausted'; await persist(file, record); return record; }
      const delay = 60_000 * 2 ** (record.attempts - 1);
      record.next_attempt_at = new Date(now() + delay).toISOString();
      await persist(file, record);
      await sleep(delay);
    }
  }
}

export function sendOutboxEvent(options) {
  const key = path.resolve(options.file);
  const current = inFlight.get(key);
  if (current) return current;
  const delivery = sendOutboxEventOnce(options).finally(() => { if (inFlight.get(key) === delivery) inFlight.delete(key); });
  inFlight.set(key, delivery);
  return delivery;
}

export async function createFinishedEvent({ runDir, target, runId, record, eventId, now = () => new Date() }) {
  const files = path.join(runDir, '05_final', 'editor', target.id);
  const outbox = path.join(files, 'finished-event.json');
  try { return JSON.parse(await fs.readFile(outbox, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const event = {
    schema_version: 1, event_id: eventId, event_type: 'bragi.editor.finished', occurred_at: now().toISOString(), source: 'bragi',
    article: { slug: path.basename(path.dirname(runDir)), medium: target.medium || 'unknown' },
    editor_run: { key: runId, target_id: target.id, version: target.version },
    revision: { sha256: record.finalSha256, source_sha256: record.sourceSha256, finished_at: record.finishedAt },
    artifact_ref: path.relative(path.dirname(path.dirname(runDir)), path.join(files, 'nat-final.md')).split(path.sep).join('/'), actor: 'author',
  };
  const outboxRecord = { event, status: 'pending', attempts: 0, created_at: now().toISOString() };
  await fs.mkdir(files, { recursive: true });
  await persist(outbox, outboxRecord);
  return outboxRecord;
}

export async function listPendingOutboxes(root) {
  const output = [];
  const visit = async dir => {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const child = path.join(dir, entry.name);
      const outbox = path.join(child, '05_final', 'editor');
      let targets;
      try { targets = await fs.readdir(outbox, { withFileTypes: true }); } catch { targets = []; }
      for (const target of targets) if (target.isDirectory()) {
        const file = path.join(outbox, target.name, 'finished-event.json');
        try { if (JSON.parse(await fs.readFile(file, 'utf8')).status === 'pending') output.push(file); } catch {}
      }
      await visit(child);
    }
  };
  await visit(await fs.realpath(root));
  return output;
}
