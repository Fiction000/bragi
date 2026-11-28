import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { applyFinding, hermesApiConfig, reviewSections, validateReviewResult } from '../review.mjs';

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

test('proposal replacement requires a unique exact quote in the unchanged section', () => {
  const markdown = '# One\nCurrent wording.\n\n# Two\nOther paragraph.';
  const section = reviewSections(markdown)[0];
  const finding = { section_id: section.section_id, base_revision: section.section_sha, anchor: { quote: 'Current wording.', occurrence: 1 }, proposal: 'Clear wording.' };
  assert.equal(applyFinding(markdown, finding).markdown, '# One\nClear wording.\n\n# Two\nOther paragraph.');
  assert.throws(() => applyFinding(markdown.replace('Current wording.', 'Changed wording.'), finding), { status: 409, code: 'stale' });
  assert.throws(() => applyFinding('# One\nCurrent wording. Current wording.', finding), { status: 409, code: 'stale' });
});
