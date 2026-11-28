import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const sha = value => createHash('sha256').update(value).digest('hex');
const sectionId = (index, heading) => `s-${sha(`${index}\0${heading}`).slice(0, 16)}`;

export function reviewSections(markdown) {
  const lines = markdown.split('\n');
  const sections = [];
  let current = null;
  let offset = 0;
  let fence = null;
  const flush = () => {
    if (!current) return;
    const content = current.lines.join('\n').replace(/\n+$/, '');
    sections.push({ index: current.index, heading: current.heading, section_id: sectionId(current.index, current.heading), content, start: current.start, end: current.start + content.length, section_sha: sha(content) });
  };
  for (const line of lines) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      const closing = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/);
      if (closing && closing[1][0] === fence.character && closing[1].length >= fence.length) fence = null;
      if (current) current.lines.push(line);
      else if (line.trim()) current = { index: 0, heading: '本文', lines: [line], start: offset };
      offset += line.length + 1;
      continue;
    }
    if (marker && !(marker[1][0] === '`' && marker[2].includes('`'))) {
      fence = { character: marker[1][0], length: marker[1].length };
      if (current) current.lines.push(line);
      else if (line.trim()) current = { index: 0, heading: '本文', lines: [line], start: offset };
      offset += line.length + 1;
      continue;
    }
    const heading = line.match(/^ {0,3}(#{1,6})(?:[ \t]+|$)(.*?)[ \t]*#*[ \t]*$/);
    if (heading) {
      flush();
      current = { index: sections.length, heading: line.trim() || '本文', lines: [line], start: offset };
    } else if (current) current.lines.push(line);
    else if (line.trim()) current = { index: 0, heading: '本文', lines: [line], start: offset };
    offset += line.length + 1;
  }
  flush();
  if (!sections.length) {
    const content = markdown;
    sections.push({ index: 0, heading: '本文', section_id: sectionId(0, '本文'), content, start: 0, end: content.length, section_sha: sha(content) });
  }
  return sections;
}

const exactKeys = (obj, keys) => obj && typeof obj === 'object' && !Array.isArray(obj) && Object.keys(obj).every(k => keys.includes(k)) && keys.every(k => Object.hasOwn(obj, k));

export function validateReviewResult(value, section) {
  if (!exactKeys(value, ['findings']) || !Array.isArray(value.findings) || value.findings.length > 30) return { valid: false, reason: 'findings must be an array' };
  const seen = new Set();
  for (const finding of value.findings) {
    if (!exactKeys(finding, ['finding_id', 'section_id', 'base_revision', 'anchor', 'category', 'rationale', 'proposal', 'decision_required', 'source_refs']) ||
        typeof finding.finding_id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(finding.finding_id) || seen.has(finding.finding_id) ||
        finding.section_id !== section.section_id || finding.base_revision !== section.section_sha ||
        !exactKeys(finding.anchor, ['quote', 'occurrence']) || typeof finding.anchor.quote !== 'string' || !finding.anchor.quote.trim() || finding.anchor.quote.length > 2000 || finding.anchor.occurrence !== 1 ||
        !['auto', 'decision'].includes(finding.category) || typeof finding.rationale !== 'string' || !finding.rationale.trim() || typeof finding.proposal !== 'string' || !finding.proposal.trim() ||
        typeof finding.decision_required !== 'boolean' || (finding.category === 'auto' && finding.decision_required) ||
        !Array.isArray(finding.source_refs) || !finding.source_refs.every(ref => typeof ref === 'string' && ref.length <= 500)) return { valid: false, reason: 'finding does not match the review contract' };
    seen.add(finding.finding_id);
    const quoteCount = section.content.split(finding.anchor.quote).length - 1;
    if (quoteCount !== 1) return { valid: false, reason: 'anchor quote must occur exactly once' };
  }
  return { valid: true, findings: value.findings };
}

export function applyFinding(markdown, finding) {
  const section = reviewSections(markdown).find(item => item.section_id === finding.section_id);
  if (!section || section.section_sha !== finding.base_revision) throw Object.assign(new Error('節が更新されています'), { status: 409, code: 'stale' });
  const pieces = section.content.split(finding.anchor.quote);
  if (pieces.length !== 2) throw Object.assign(new Error('節が更新されています'), { status: 409, code: 'stale' });
  const updated = pieces[0] + finding.proposal + pieces[1];
  const next = markdown.slice(0, section.start) + updated + markdown.slice(section.end);
  return { markdown: next, section: reviewSections(next).find(item => item.index === section.index) };
}

export function hermesApiConfig(env = process.env) {
  if (!env.BRAGI_HERMES_API_URL || !env.BRAGI_HERMES_API_KEY) return null;
  let url;
  try { url = new URL(env.BRAGI_HERMES_API_URL); } catch { throw Object.assign(new Error('BRAGI_HERMES_API_URL is invalid'), { status: 503 }); }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash) throw Object.assign(new Error('Agent API URL must use loopback HTTP'), { status: 503 });
  return { base: url.toString().replace(/\/$/, ''), key: env.BRAGI_HERMES_API_KEY };
}

export async function readReviewSession(runDir, targetId, sessionId) {
  if (!/^[a-f0-9]{32}$/.test(sessionId)) return null;
  try { return JSON.parse(await fs.readFile(path.join(runDir, '05_final', 'editor', targetId, 'reviews', `${sessionId}.json`), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export async function writeReviewSession(runDir, targetId, session) {
  const dir = path.join(runDir, '05_final', 'editor', targetId, 'reviews');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${session.id}.json`);
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temp, file);
}

const reviewSessionQueues = new Map();
export async function updateReviewSession(runDir, targetId, sessionId, update, initial = null) {
  const file = path.join(runDir, '05_final', 'editor', targetId, 'reviews', `${sessionId}.json`);
  const previous = reviewSessionQueues.get(file) ?? Promise.resolve();
  let release;
  const current = new Promise(resolve => { release = resolve; });
  const queued = previous.then(() => current);
  reviewSessionQueues.set(file, queued);
  await previous;
  try {
    const session = await readReviewSession(runDir, targetId, sessionId) ?? initial;
    if (!session) return null;
    const before = JSON.stringify(session);
    const updated = await update(session);
    if (JSON.stringify(updated) !== before) await writeReviewSession(runDir, targetId, updated);
    return updated;
  } finally {
    release();
    if (reviewSessionQueues.get(file) === queued) reviewSessionQueues.delete(file);
  }
}

export async function startAgentReview(config, { section, target, idempotencyKey, conversationKey, instruction }) {
  const response = await fetch(`${config.base}/v1/runs`, { method: 'POST', headers: { Authorization: `Bearer ${config.key}`, 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey, 'x-hermes-session-key': conversationKey }, body: JSON.stringify({ input: `${instruction}\n\n対象節 ${section.heading}\nsection_id=${section.section_id}\nsection_sha=${section.section_sha}\n\n${section.content}` }) });
  if (!response.ok) throw Object.assign(new Error(`Agent API returned ${response.status}`), { status: response.status === 401 || response.status === 403 ? 502 : response.status === 429 || response.status >= 500 ? 503 : 502 });
  const data = await response.json();
  if (typeof data.run_id !== 'string' || !data.run_id) throw Object.assign(new Error('Agent API response omitted run_id'), { status: 502 });
  return { runId: data.run_id, status: data.status ?? 'queued' };
}

export async function getAgentRun(config, runId) {
  const response = await fetch(`${config.base}/v1/runs/${encodeURIComponent(runId)}`, { headers: { Authorization: `Bearer ${config.key}` } });
  if (!response.ok) throw Object.assign(new Error(`Agent API returned ${response.status}`), { status: response.status === 401 || response.status === 403 ? 502 : 503 });
  return response.json();
}

export function parseStructuredOutput(output, section) {
  let value;
  try { value = JSON.parse(output); } catch { return { valid: false, reason: '出力をJSONとして読めません' }; }
  return validateReviewResult(value, section);
}

export function sessionIdFor(runId, targetId, section) { return sha(`${runId}\0${targetId}\0${section.section_id}\0${section.section_sha}`).slice(0, 32); }

export async function proxyAgentEvents(config, runId, lastEventId, res) {
  const headers = { Authorization: `Bearer ${config.key}`, Accept: 'text/event-stream' };
  if (lastEventId) headers['Last-Event-ID'] = lastEventId;
  const controller = new AbortController();
  const disconnected = () => { if (!res.writableEnded) controller.abort(); };
  res.once('close', disconnected);
  try {
    const upstream = await fetch(`${config.base}/v1/runs/${encodeURIComponent(runId)}/events`, { headers, signal: controller.signal });
    if (!upstream.ok || !upstream.body) return { status: upstream.status || 502 };
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive' });
    for await (const chunk of upstream.body) {
      if (controller.signal.aborted) break;
      if (!res.write(Buffer.from(chunk))) await new Promise((resolve, reject) => {
        const cleanup = () => { res.removeListener('drain', drained); res.removeListener('close', closed); res.removeListener('error', failed); controller.signal.removeEventListener('abort', aborted); };
        const drained = () => { cleanup(); resolve(); };
        const closed = () => { cleanup(); reject(new Error('client disconnected')); };
        const failed = error => { cleanup(); reject(error); };
        const aborted = () => { cleanup(); reject(new Error('client disconnected')); };
        if (controller.signal.aborted) { reject(new Error('client disconnected')); return; }
        res.once('drain', drained); res.once('close', closed); res.once('error', failed); controller.signal.addEventListener('abort', aborted, { once: true });
      });
    }
    if (!controller.signal.aborted && !res.destroyed) res.end();
    return { status: 200 };
  } catch (error) {
    if (res.headersSent) {
      if (!res.destroyed) res.destroy();
      return { status: 200 };
    }
    throw error;
  } finally {
    res.removeListener('close', disconnected);
  }
}

export async function handleReviewApi({ req, res, apiPath, runDir, targets, currentDraft, saveDraft, readBody, send, slug, proposalOptions }) {
  if (!apiPath.startsWith('/api/reviews')) return false;
  const config = hermesApiConfig();
  if (req.method === 'GET' && apiPath === '/api/reviews/enabled') return send(res, 200, { enabled: Boolean(config) });
  if (!config) return send(res, 503, { error: 'Agent API is not configured' });
  const targetId = new URL(req.url, `http://${req.headers.host}`).searchParams.get('target') || '';
  const target = targets.get(targetId);
  if (!target) return send(res, 404, { error: 'Unknown target' });
  const current = async () => currentDraft(runDir, target);
  const sectionFor = async (state, sectionId) => reviewSections(state.markdown).find(section => section.section_id === sectionId);
  if (req.method === 'GET' && apiPath === '/api/reviews/sections') {
    const draft = await current();
    return send(res, 200, { revision: draft.revision, sections: reviewSections(draft.state.markdown).map(({ index, heading, section_id, section_sha }) => ({ index, heading, section_id, section_sha })) });
  }
  const refreshSessionState = async latest => {
    if (!latest.runId || ['failed', 'cancelled', 'interrupted', 'discarded'].includes(latest.status) || (['completed', 'succeeded'].includes(latest.status) && latest.result)) return latest;
    const runId = latest.runId;
    const status = await getAgentRun(config, runId);
    if (latest.runId !== runId || latest.status === 'discarded') return latest;
    const nextStatus = status.status ?? latest.status;
    const turn = latest.turns?.find(item => item.runId === runId);
    if (turn) turn.status = nextStatus;
    latest.status = nextStatus;
    if (['completed', 'succeeded'].includes(nextStatus)) {
      const output = typeof status.output === 'string' ? status.output : '';
      const section = { section_id: latest.section_id, section_sha: latest.section_sha, content: latest.section_content };
      const checked = parseStructuredOutput(output, section);
      latest.result = checked.valid ? { state: 'valid', findings: checked.findings } : { state: 'invalid', reason: checked.reason };
    } else if (['failed', 'cancelled', 'interrupted'].includes(nextStatus)) latest.result = { state: 'failed' };
    return latest;
  };
  const refresh = async session => await updateReviewSession(runDir, targetId, session.id, refreshSessionState) ?? session;
  if (req.method === 'GET' && apiPath === '/api/reviews/session') {
    const draft = await current();
    const section = await sectionFor(draft.state, new URL(req.url, `http://${req.headers.host}`).searchParams.get('sectionId'));
    if (!section) return send(res, 404, { error: 'Unknown section' });
    const id = sessionIdFor(path.basename(runDir), targetId, section);
    const session = await readReviewSession(runDir, targetId, id);
    if (session) return send(res, 200, { ...(await refresh(session)), stale: session.section_sha !== section.section_sha });
    const dir = path.join(runDir, '05_final', 'editor', targetId, 'reviews');
    let prior = null;
    try {
      for (const name of await fs.readdir(dir)) {
        if (!name.endsWith('.json') || !/^[a-f0-9]{32}/.test(name)) continue;
        const candidate = JSON.parse(await fs.readFile(path.join(dir, name), 'utf8'));
        if (candidate.section_id === section.section_id && candidate.section_sha !== section.section_sha && (!prior || candidate.createdAt > prior.createdAt)) prior = candidate;
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return send(res, 200, prior && prior.status !== 'discarded' ? { ...(await refresh(prior)), stale: true } : null);
  }
  if (req.method === 'POST' && apiPath === '/api/reviews/start') {
    const body = await readBody(req), draft = await current();
    if (typeof body.baseRevision !== 'string' || body.baseRevision !== draft.revision) return send(res, 409, { error: '本文が更新されています', code: 'stale' });
    const section = await sectionFor(draft.state, body.sectionId);
    if (!section) return send(res, 404, { error: 'Unknown section' });
    const id = sessionIdFor(path.basename(runDir), targetId, section);
    const instruction = 'Review this article section only. Return only JSON matching {"findings":[{"finding_id":"f1","section_id":"...","base_revision":"...","anchor":{"quote":"exact unique text","occurrence":1},"category":"auto|decision","rationale":"...","proposal":"...","decision_required":false,"source_refs":[]}]} . Do not invent facts. Use category decision when meaning or judgment changes. Keep proposals in the same language as the source.';
    let responseStatus = 202;
    const initial = { id, targetId, section_id: section.section_id, section_sha: section.section_sha, section_content: section.content, heading: section.heading, conversationKey: `bragi-review-${id}`, runId: null, status: 'queued', result: null, decisions: [], turns: [], attempt: 0, createdAt: new Date().toISOString() };
    const session = await updateReviewSession(runDir, targetId, id, async latest => {
      latest = await refreshSessionState(latest);
      if (latest.runId && !(['failed', 'cancelled', 'interrupted', 'discarded'].includes(latest.status) || latest.result?.state === 'invalid')) { responseStatus = 200; return latest; }
      const attempt = (latest.attempt ?? 0) + 1;
      const launched = await startAgentReview(config, { section, target, idempotencyKey: attempt === 1 ? `bragi-review-${id}` : `bragi-review-${id}-retry-${attempt}`, conversationKey: `bragi-review-${id}`, instruction });
      return { ...latest, id, targetId, section_id: section.section_id, section_sha: section.section_sha, section_content: section.content, heading: section.heading, conversationKey: `bragi-review-${id}`, runId: launched.runId, status: launched.status, result: null, decisions: [], turns: [], attempt, createdAt: latest.createdAt ?? new Date().toISOString() };
    }, initial);
    return send(res, responseStatus, session);
  }
  const sessionMatch = apiPath.match(/^\/api\/reviews\/([a-f0-9]{32})(?:\/(events|apply|discard|talk|propose))?$/);
  if (!sessionMatch) return send(res, 404, { error: 'Not found' });
  const [, id, action] = sessionMatch;
  let session = await readReviewSession(runDir, targetId, id);
  if (!session) return send(res, 404, { error: 'Review session not found' });
  if (req.method === 'GET' && !action) return send(res, 200, await refresh(session));
  if (req.method === 'GET' && action === 'events') {
    const result = await proxyAgentEvents(config, session.runId, req.headers['last-event-id'], res);
    return result.status === 200 ? true : send(res, result.status, { error: 'Agent event stream unavailable' });
  }
  if (req.method === 'POST' && action === 'apply') {
    const body = await readBody(req);
    let outcome;
    try {
      await updateReviewSession(runDir, targetId, id, async latest => {
        if (latest.result?.state !== 'valid') { outcome = { status: 409, body: { error: '有効なレビュー結果がありません' } }; return latest; }
        const finding = latest.result.findings.find(item => item.finding_id === body.findingId);
        if (!finding || latest.decisions.some(item => item.findingId === finding.finding_id) || latest.status === 'discarded') { outcome = { status: 404, body: { error: 'Finding unavailable' } }; return latest; }
        const draft = await current();
        let applied;
        try { applied = applyFinding(draft.state.markdown, finding); }
        catch (error) { if (error.status === 409) { outcome = { status: 409, body: { error: error.message, code: 'stale' } }; return latest; } throw error; }
        const state = { ...draft.state, markdown: applied.markdown };
        const saved = await saveDraft(target, state, draft.revision);
        if (!saved.saved) { outcome = { status: 409, body: { error: '本文が更新されています', code: 'stale', revision: saved.revision } }; return latest; }
        latest.decisions.push({ findingId: finding.finding_id, action: 'applied', at: new Date().toISOString() });
        outcome = { status: 200, body: { revision: saved.revision, markdown: state.markdown } };
        return latest;
      });
    } catch (error) { if (error.status === 409) return send(res, 409, { error: error.message, code: 'stale' }); throw error; }
    return send(res, outcome?.status ?? 404, outcome?.body ?? { error: 'Review session not found' });
  }
  if (req.method === 'POST' && action === 'discard') {
    const body = await readBody(req);
    if (body.discardAll === true) {
      session = await updateReviewSession(runDir, targetId, id, latest => {
        latest.status = 'discarded';
        latest.decisions.push(...(latest.result?.findings ?? []).filter(item => !latest.decisions.some(decision => decision.findingId === item.finding_id)).map(item => ({ findingId: item.finding_id, action: 'discarded', at: new Date().toISOString() })));
        return latest;
      });
      return send(res, 200, session);
    }
    if (!session.result?.findings?.some(item => item.finding_id === body.findingId)) return send(res, 404, { error: 'Finding unavailable' });
    session = await updateReviewSession(runDir, targetId, id, latest => {
      if (!latest.result?.findings?.some(item => item.finding_id === body.findingId) || latest.decisions.some(item => item.findingId === body.findingId)) return latest;
      latest.decisions.push({ findingId: body.findingId, action: 'discarded', at: new Date().toISOString() });
      return latest;
    });
    return send(res, 200, session);
  }
  if (req.method === 'POST' && action === 'talk') {
    const body = await readBody(req);
    if (typeof body.message !== 'string' || !body.message.trim() || body.message.length > 4000) return send(res, 400, { error: 'Message must be 1-4000 characters' });
    let rejected = false;
    session = await updateReviewSession(runDir, targetId, id, async latest => {
      if (latest.status === 'discarded') { rejected = true; return latest; }
      const turn = latest.turns.length;
      const launched = await startAgentReview(config, { section: { heading: latest.heading, section_id: latest.section_id, section_sha: latest.section_sha, content: latest.section_content }, target, idempotencyKey: `bragi-review-${id}-a${latest.attempt}-talk-${turn}`, conversationKey: latest.conversationKey, instruction: `Continue the review conversation. The reviewed section is fixed to sha ${latest.section_sha}. Respond with the structured review JSON contract, and include any reply in rationale. User: ${body.message}` });
      latest.turns.push({ message: body.message, runId: launched.runId, status: launched.status, at: new Date().toISOString() });
      latest.runId = launched.runId; latest.status = launched.status; latest.result = null;
      return latest;
    });
    if (rejected) return send(res, 409, { error: 'Review session was discarded' });
    return send(res, 202, session);
  }
  if (req.method === 'POST' && action === 'propose') {
    const body = await readBody(req);
    const finding = session.result?.findings?.find(item => item.finding_id === body.findingId);
    if (!finding || !finding.decision_required || typeof body.answer !== 'string' || !body.answer.trim() || !session.turns?.some(turn => turn.runId === session.runId && ['completed', 'succeeded'].includes(turn.status))) return send(res, 400, { error: '話した後の判断回答が必要です' });
    if (!proposalOptions) return send(res, 503, { error: 'Proposal storage is not configured' });
    const { proposeDecisionFor } = await import('@wle/core');
    const result = await proposeDecisionFor(proposalOptions, { slug: `${slug}-review-${finding.finding_id.toLowerCase()}`, proposed_by: 'Bragi review', body: body.answer.trim(), kind: 'phrasing', source: `drafts/${slug}/review-${id}.md#${finding.finding_id}`, scope: 'draft', draft: slug, check: { type: 'none' } });
    session = await updateReviewSession(runDir, targetId, id, latest => {
      latest.decisions.push({ findingId: finding.finding_id, action: 'proposed', proposalId: result.proposal.meta.id, created: result.created, at: new Date().toISOString() });
      return latest;
    });
    return send(res, 200, { created: result.created, proposal: result.proposal.meta });
  }
  return send(res, 404, { error: 'Not found' });
}
