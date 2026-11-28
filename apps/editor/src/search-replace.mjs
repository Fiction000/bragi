const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function excludedRanges(text, excludeCode) {
  if (!excludeCode) return [];
  const ranges = [];
  const add = pattern => { for (const match of text.matchAll(pattern)) ranges.push([match.index, match.index + match[0].length]); };
  const lines = text.split('\n');
  let offset = 0;
  let frontMatterEnd = 0;
  const firstLine = lines[0].endsWith('\r') ? lines[0].slice(0, -1) : lines[0];
  if (/^---[ \t]*$/.test(firstLine)) {
    offset = lines[0].length + (lines.length > 1 ? 1 : 0);
    for (let index = 1; index < lines.length; index++) {
      const raw = lines[index];
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
      const lineEnd = offset + raw.length + (index < lines.length - 1 ? 1 : 0);
      if (/^---[ \t]*$/.test(line)) { frontMatterEnd = lineEnd; ranges.push([0, lineEnd]); break; }
      offset = lineEnd;
    }
  }
  offset = 0;
  let fence;
  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index];
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const lineEnd = offset + raw.length + (index < lines.length - 1 ? 1 : 0);
    if (offset < frontMatterEnd) {
      offset = lineEnd;
      continue;
    }
    if (!fence) {
      const open = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
      if (open && !(open[1][0] === '`' && open[2].includes('`'))) fence = { marker: open[1][0], size: open[1].length, start: offset };
    } else {
      const close = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/);
      if (close && close[1][0] === fence.marker && close[1].length >= fence.size) {
        ranges.push([fence.start, lineEnd]);
        fence = undefined;
      }
    }
    offset = lineEnd;
  }
  if (fence) ranges.push([fence.start, text.length]);
  for (let index = 0; index < text.length;) {
    const block = ranges.find(([start, end]) => index >= start && index < end);
    if (block) { index = block[1]; continue; }
    if (text[index] !== '`') { index++; continue; }
    let openEnd = index + 1;
    while (text[openEnd] === '`') openEnd++;
    const size = openEnd - index;
    let closeStart = -1;
    for (let cursor = openEnd; cursor < text.length;) {
      if (ranges.some(([start, end]) => cursor >= start && cursor < end)) break;
      if (text[cursor] !== '`') { cursor++; continue; }
      let closeEnd = cursor + 1;
      while (text[closeEnd] === '`') closeEnd++;
      if (closeEnd - cursor === size) { closeStart = cursor; break; }
      cursor = closeEnd;
    }
    if (closeStart < 0) index = openEnd;
    else { const end = closeStart + size; ranges.push([index, end]); index = end; }
  }
  const codeRanges = ranges.slice();
  for (const match of text.matchAll(/!?\[([^\]\n]*)\]\(([^)\n]*)\)/g)) {
    const start = match.index + match[0].indexOf('](') + 2;
    ranges.push([start, start + match[2].length]);
  }
  add(/^\s*\[[^\]]+\]:\s*\S+/gm);
  for (const match of text.matchAll(/[A-Za-z0-9_]+(?:[/:.][A-Za-z0-9_]+)+/g)) {
    if (/[A-Za-z]/.test(match[0])) ranges.push([match.index, match.index + match[0].length]);
  }
  add(/<https?:\/\/[^>\s]+>/gi);
  add(/https?:\/\/[^\s<>()\[\]{}]+/gi);
  const outsideCode = (start, end) => !codeRanges.some(([a, b]) => start < b && end > a);
  const addOutsideCode = pattern => {
    for (const match of text.matchAll(pattern)) {
      const start = match.index, end = start + match[0].length;
      if (outsideCode(start, end)) ranges.push([start, end]);
    }
  };
  addOutsideCode(/<!--(?:[\s\S]*?)-->/g);
  addOutsideCode(/<\/?[A-Za-z][^<>\n]*>/g);
  addOutsideCode(/<([A-Za-z][A-Za-z0-9_:-]*)[^<>\n]*>[\s\S]*?<[/]\1[ \t]*>/gi);
  return ranges.sort((a, b) => a[0] - b[0]);
}

function expandReplacement(template, matched, captures, text, start, end, groups) {
  return template.replace(/\$(\$|&|`|'|[0-9]{1,2}|<[^>]+>)/g, (token, key) => {
    if (key === '$') return '$';
    if (key === '&') return matched;
    if (key === '`') return text.slice(0, start);
    if (key === "'") return text.slice(end);
    if (key[0] === '<') {
      const name = key.slice(1, -1);
      return groups && Object.hasOwn(groups, name) ? (groups[name] ?? '') : token;
    }
    let number = Number(key);
    let suffix = '';
    if (number > captures.length && key.length > 1) {
      number = Number(key[0]);
      suffix = key.slice(1);
    }
    return number > 0 && number <= captures.length ? `${captures[number - 1] ?? ''}${suffix}` : token;
  });
}

export function findReplacements(text, query, options = {}) {
  if (!query) return { matches: [], error: '' };
  let regex;
  try {
    const source = options.regex ? query : escape(query);
    const flags = `g${options.caseSensitive ? '' : 'i'}u`;
    regex = new RegExp(options.wordBoundary ? `(?<![A-Za-z0-9_])(?:${source})(?![A-Za-z0-9_])` : source, flags);
  } catch (error) {
    return { matches: [], error: error.message };
  }
  const excluded = excludedRanges(text, options.excludeCode !== false);
  const matches = [];
  for (const match of text.matchAll(regex)) {
    if (!match[0].length) continue;
    const start = match.index, end = start + match[0].length;
    if (excluded.some(([a, b]) => start < b && end > a)) continue;
    const captures = match.slice(1);
    matches.push({ start, end, text: match[0], replacement: options.replacement === undefined ? undefined : options.regex ? expandReplacement(options.replacement, match[0], captures, text, start, end, match.groups) : options.replacement });
  }
  return { matches, error: '' };
}

export function replaceSelected(text, matches, selected, replacement) {
  let result = text;
  const chosen = matches.filter((_, index) => selected[index]).slice().sort((a, b) => b.start - a.start);
  for (const match of chosen) result = result.slice(0, match.start) + (match.replacement ?? replacement) + result.slice(match.end);
  return result;
}

export function previewContext(text, match, radius = 32) {
  let start = Math.max(0, match.start - radius);
  let end = Math.min(text.length, match.end + radius);
  const isLow = code => code >= 0xDC00 && code <= 0xDFFF;
  if (start > 0 && isLow(text.charCodeAt(start))) start--;
  if (end < text.length && isLow(text.charCodeAt(end))) end++;
  return { before: text.slice(start, match.start), hit: text.slice(match.start, match.end), after: text.slice(match.end, end) };
}
