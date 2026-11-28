import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { applyFinding, hermesApiConfig, proxyAgentEvents, readReviewSession, reviewSections, updateReviewSession, validateReviewResult, writeReviewSession } from '../review.mjs';

const FAKE_KEY = 'fake-test-key';

const hash = text => createHash('sha256').update(text).digest('hex');

test('sections follow ATX headings and hash only section content', () => {
  const sections = reviewSections('preface\n\n# One\nbody\n## Two\nnext');
  assert.deepEqual(sections.map(section => section.heading), ['本文', '# One', '## Two']);
  assert.deepEqual(sections.map(section => section.content), ['preface', '# One\nbody', '## Two\nnext']);
  assert.equal(sections[1].section_sha, hash('# One\nbody'));
  assert.match(sections[1].section_id, /^s-/);
});

test('headings inside a longer fenced block do not start sections', () => {
  const sections = reviewSections('## A\nintro\n````md\n```\n# not a section\n````\n## B\nnext');
  assert.deepEqual(sections.map(section => section.heading), ['## A', '## B']);
  assert.match(sections[0].content, /# not a section/);
});

test('finding validator accepts only anchored proposals for the reviewed section and revision', () => {
  const section = reviewSections('# One\nCurrent wording.')[0];
  const result = { findings: [{ finding_id: 'f1', section_id: section.section_id, base_revision: section.section_sha, anchor: { quote: 'Current wording.', occurrence: 1 }, category: 'auto', rationale: 'Clarify.', proposal: 'Clear wording.', decision_required: false, source_refs: [] }] };
  assert.deepEqual(validateReviewResult(result, section), { valid: true, findings: result.findings });
  assert.equal(validateReviewResult({ findings: [{ ...result.findings[0], section_id: 'wrong' }] }, section).valid, false);
  assert.equal(validateReviewResult({ findings: [{ ...result.findings[0], anchor: { quote: 'Current wording.', occurrence: 0 } }] }, section).valid, false);
  assert.equal(validateReviewResult({ ...result, extra: true }, section).valid, false);
});

test('agent endpoint configuration requires HTTP loopback and both values', () => {
  assert.equal(hermesApiConfig({}), null);
  assert.equal(hermesApiConfig({ BRAGI_HERMES_API_URL: 'http://127.0.0.1:9121', BRAGI_HERMES_API_KEY: FAKE_KEY }).base, 'http://127.0.0.1:9121');
  assert.throws(() => hermesApiConfig({ BRAGI_HERMES_API_URL: 'http://example.com', BRAGI_HERMES_API_KEY: FAKE_KEY }), { status: 503 });
  assert.throws(() => hermesApiConfig({ BRAGI_HERMES_API_URL: 'https://localhost', BRAGI_HERMES_API_KEY: FAKE_KEY }), { status: 503 });
});

test('parallel session updates serialize and preserve every decision', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wle-review-queue-'));
  const session = { id: '0123456789abcdef0123456789abcdef', decisions: [], counter: 0 };
  try {
    await writeReviewSession(root, 'target', session);
    await Promise.all(Array.from({ length: 32 }, (_, index) => updateReviewSession(root, 'target', session.id, current => {
      current.counter += 1;
      current.decisions.push({ findingId: `f${index}` });
      return current;
    })));
    const saved = await readReviewSession(root, 'target', session.id);
    assert.equal(saved.counter, 32);
    assert.equal(saved.decisions.length, 32);
    assert.equal(new Set(saved.decisions.map(item => item.findingId)).size, 32);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test('SSE proxy aborts on client close and destroys a response when the upstream fails after headers', async () => {
  const originalFetch = globalThis.fetch;
  let signal;
  const response = () => Object.assign(new EventEmitter(), {
    headersSent: false, writableEnded: false, destroyed: false,
    writeHead() { this.headersSent = true; },
    write() { return false; },
    end() { this.writableEnded = true; },
    destroy() { this.destroyed = true; },
  });
  try {
    globalThis.fetch = async (_url, options) => {
      signal = options.signal;
      return { ok: true, status: 200, body: { async *[Symbol.asyncIterator]() { yield Buffer.from('event'); } } };
    };
    const client = response();
    const pending = proxyAgentEvents({ base: 'http://127.0.0.1', key: FAKE_KEY }, 'run-1', undefined, client);
    await new Promise(resolve => setImmediate(resolve));
    client.emit('close');
    assert.equal((await pending).status, 200);
    assert.equal(signal.aborted, true);
    assert.equal(client.destroyed, true);

    const failed = response();
    failed.write = () => true;
    globalThis.fetch = async () => ({ ok: true, status: 200, body: { async *[Symbol.asyncIterator]() { yield Buffer.from('event'); throw new Error('upstream failed'); } } });
    assert.equal((await proxyAgentEvents({ base: 'http://127.0.0.1', key: FAKE_KEY }, 'run-2', undefined, failed)).status, 200);
    assert.equal(failed.destroyed, true);
  } finally { globalThis.fetch = originalFetch; }
});
test('proposal replacement requires a unique exact quote in the unchanged section', () => {
  const markdown = '# One\nCurrent wording.\n\n# Two\nOther paragraph.';
  const section = reviewSections(markdown)[0];
  const finding = { section_id: section.section_id, base_revision: section.section_sha, anchor: { quote: 'Current wording.', occurrence: 1 }, proposal: 'Clear wording.' };
  assert.equal(applyFinding(markdown, finding).markdown, '# One\nClear wording.\n\n# Two\nOther paragraph.');
  assert.throws(() => applyFinding(markdown.replace('Current wording.', 'Changed wording.'), finding), { status: 409, code: 'stale' });
  assert.throws(() => applyFinding('# One\nCurrent wording. Current wording.', finding), { status: 409, code: 'stale' });
});
