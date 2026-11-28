import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findReplacements, previewContext, replaceSelected } from '../src/search-replace.mjs';

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

test('fenced code excludes empty blocks, CRLF blocks and longer closing fences without hiding later prose', () => {
  const text = ['before skill', '```json', '```', 'after skill', '~~~~', 'skill', '~~~~~', 'tail skill'].join(String.fromCharCode(13, 10));
  assert.deepEqual(findReplacements(text, 'skill').matches.map(m => m.text), ['skill', 'skill', 'skill']);
});

test('inline code spans with embedded backticks require an exactly matching delimiter run', () => {
  const text = 'before skill ``code `skill` here`` after skill';
  assert.deepEqual(findReplacements(text, 'skill').matches.map(m => m.start), [7, 41]);
});

test('link labels containing parentheses do not shift destination exclusion', () => {
  const text = '[Guide (v2)](skill) [skill (guide)](skill)';
  assert.deepEqual(findReplacements(text, 'skill').matches.map(m => m.start), [21]);
});

test('comparison-like type text before a real same-line tag remains searchable', () => {
  const text = 'x<T で skill を <span>表示</span>';
  assert.deepEqual(findReplacements(text, 'skill').matches.map(m => m.text), ['skill']);
});

test('empty front matter does not consume a following horizontal rule and prose', () => {
  const text = ['---', '---', 'skill', '---', 'section skill'].join(String.fromCharCode(10));
  assert.deepEqual(findReplacements(text, 'skill').matches.map(m => m.text), ['skill', 'skill']);
});

test('preview context never slices a surrogate pair', () => {
  const text = 'A😀BCskillDE😀F';
  const match = findReplacements(text, 'skill').matches[0];
  const context = previewContext(text, match, 3);
  const pieces = [context.before, context.hit, context.after];
  const hasBrokenSurrogate = value => {
    const first = value.charCodeAt(0), last = value.charCodeAt(value.length - 1);
    return (first >= 0xDC00 && first <= 0xDFFF) || (last >= 0xD800 && last <= 0xDBFF);
  };
  assert.ok(pieces.every(value => !hasBrokenSurrogate(value)));
  assert.ok(context.before.endsWith('😀BC'));
  assert.ok(context.after.startsWith('DE😀'));
});

test('prose backtick runs with backticks in their info text are inline spans, not unclosed fences', () => {
  assert.deepEqual(findReplacements('```foo``` and inline skill', 'skill').matches.map(m => m.text), ['skill']);
});

test('fence-looking lines inside front matter do not hide the article body', () => {
  const text = ['---', 'metadata: yes', '```yaml', '---', 'body skill'].join(String.fromCharCode(10));
  assert.deepEqual(findReplacements(text, 'skill').matches.map(m => m.text), ['skill']);
});

test('unmatched inline backticks do not pair across fenced code and hide prose', () => {
  const text = ['prefix `unmatched', 'prose skill before fence', '```js', 'const value = `template`;', '```', 'after skill'].join(String.fromCharCode(10));
  assert.deepEqual(findReplacements(text, 'skill').matches.map(m => m.start), [24, 85]);
});

test('HTML comment or element patterns do not pair across separate code spans and hide prose', () => {
  const inline = '開く `<div>` の後に skill、閉じる `</div>`。 コメント `<!--` と skill と `-->`。';
  assert.deepEqual(findReplacements(inline, 'skill').matches.map(m => m.text), ['skill', 'skill']);
  const fenced = '```html\n<div>\n```\n本文の skill\n```html\n</div>\n```\n';
  assert.deepEqual(findReplacements(fenced, 'skill').matches.map(m => m.text), ['skill']);
  const real = '前 skill <details>中の skill</details> 後 skill';
  assert.deepEqual(findReplacements(real, 'skill').matches.map(m => m.start), [real.indexOf('skill'), real.lastIndexOf('skill')]);
});
