import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findReplacements, replaceSelected } from '../src/search-replace.mjs';

test('default exclusion skips inline/fenced code, links and URLs but keeps Japanese prose', () => {
  const text = '日本語 skill、`skills/list`。 https://example.com/skill [label](https://x.test/skill)\n```json\n{"skills":"skill"}\n```\n次の skill';
  const { matches, error } = findReplacements(text, 'skill', { replacement: 'スキル' });
  assert.equal(error, '');
  assert.deepEqual(matches.map(match => match.text), ['skill', 'skill']);
  assert.equal(replaceSelected(text, matches, [true, true], 'スキル'), '日本語 スキル、`skills/list`。 https://example.com/skill [label](https://x.test/skill)\n```json\n{"skills":"skill"}\n```\n次の スキル');
});

test('plain code-like identifiers containing slash, colon or dot are protected', () => {
  const text = 'skills/list server:skill io.modelcontextprotocol/skills prose skill';
  assert.deepEqual(findReplacements(text, 'skill').matches.map(m => m.text), ['skill']);
});

test('front matter and raw HTML are excluded by default', () => {
  const text = '---\ntitle: skill\n---\n本文 skill <span>skill</span>.';
  assert.deepEqual(findReplacements(text, 'skill').matches.map(m => m.text), ['skill']);
});

test('link labels remain searchable while link, image, autolink and bare URL destinations stay excluded', () => {
  const text = '[skill](https://x/skill) ![skill](https://x/skill.png) <https://x/skill> https://x/skill';
  assert.deepEqual(findReplacements(text, 'skill').matches.map(m => m.text), ['skill', 'skill']);
});

test('case sensitivity and ASCII word boundaries are optional', () => {
  assert.deepEqual(findReplacements('Skill skill skills/list', 'skill', { caseSensitive: true }).matches.map(m => m.text), ['skill']);
  assert.deepEqual(findReplacements('日本語skill語 Skill skill skills/list', 'skill', { wordBoundary: true }).matches.map(m => m.text), ['skill', 'Skill', 'skill']);
});

test('regular expressions support capture-group replacements and invalid patterns report errors', () => {
  const found = findReplacements('skill skills', '(skill)(s?)', { regex: true, replacement: '$1-$2' });
  assert.deepEqual(found.matches.map(m => m.replacement), ['skill-', 'skill-s']);
  assert.equal(findReplacements('skill', 'skill', { replacement: '$1' }).matches[0].replacement, '$1');
  assert.match(findReplacements('skill', '(', { regex: true }).error, /unterminated|group|parenthesis/i);
});

test('adjacent and overlapping candidates are handled by normal non-overlapping regex matches', () => {
  const adjacent = findReplacements('skillskill skill', 'skill');
  assert.deepEqual(adjacent.matches.map(m => [m.start, m.end]), [[0, 5], [5, 10], [11, 16]]);
  assert.equal(replaceSelected('skillskill skill', adjacent.matches, [false, true, true], 'X'), 'skillX X');
});

test('zero-width regular expressions cannot create replacement hits', () => {
  assert.deepEqual(findReplacements('abc', '(?=b)', { regex: true }).matches, []);
});
