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

test('front matter is excluded only at document index zero', () => {
  const text = '---\ntitle: skill\n---\nbody skill\n---\nHeading skill\n---\nTail skill';
  assert.deepEqual(findReplacements(text, 'skill').matches.map(m => m.text), ['skill', 'skill', 'skill']);
});

test('link and image destinations are excluded from the opening parenthesis, not matching label text', () => {
  const text = '[skill](skill) ![skill](skill)';
  const matches = findReplacements(text, 'skill').matches;
  assert.deepEqual(matches.map(m => m.start), [1, 17]);
});

test('raw HTML tag exclusion does not span prose comparisons or newlines', () => {
  const text = 'x < 10\nskill\nand y > 5';
  assert.deepEqual(findReplacements(text, 'skill').matches.map(m => m.text), ['skill']);
  assert.deepEqual(findReplacements(['<div>', 'skill', '</div>'].join(String.fromCharCode(10)), 'skill').matches, []);
});

test('context-dependent regex replacements retain lookbehind, lookahead and non-boundary context', () => {
  const before = findReplacements('xskill skillx', '(?<=x)skill', { regex: true, replacement: '$&!' });
  assert.deepEqual(before.matches.map(m => m.replacement), ['skill!']);
  const after = findReplacements('xskill skillx', 'skill(?=x)', { regex: true, replacement: '[$&]' });
  assert.deepEqual(after.matches.map(m => m.replacement), ['[skill]']);
  const inner = findReplacements('xskillx skill', '\\Bskill\\B', { regex: true, replacement: 'X' });
  assert.deepEqual(inner.matches.map(m => m.replacement), ['X']);
  assert.equal(replaceSelected('xskillx skill', inner.matches, [true], 'X'), 'xXx skill');
});

test('zero-width regular expressions cannot create replacement hits', () => {
  assert.deepEqual(findReplacements('abc', '(?=b)', { regex: true }).matches, []);
});

test('letter-only code identifiers are excluded but numeric dates, times and versions remain searchable', () => {
  const tokens = findReplacements('skills/list server:skill io.modelcontextprotocol/skills skill Skills', 'skill');
  assert.deepEqual(tokens.matches.map(m => m.text), ['skill', 'Skill']);
  assert.deepEqual(findReplacements('Skills', 'Skills').matches.map(m => m.text), ['Skills']);
  assert.equal(findReplacements('2026/11/28 10:30 1.2', '11').matches.length, 1);
  assert.equal(findReplacements('2026/11/28 10:30 1.2', '30').matches.length, 1);
  assert.equal(findReplacements('2026/11/28 10:30 1.2', '1').matches.length, 4);
});
