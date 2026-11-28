const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function excludedRanges(text, excludeCode) {
  if (!excludeCode) return [];
  const ranges = [];
  const add = pattern => { for (const match of text.matchAll(pattern)) ranges.push([match.index, match.index + match[0].length]); };
  add(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/g);
  add(/(^|\n)[ \t]*(```+|~~~+)[^\n]*\n[\s\S]*?(?:\n[ \t]*\2[ \t]*(?=\n|$)|$)/g);
  add(/`+[^`\n]*`+/g);
  for (const match of text.matchAll(/!?\[[^\]\n]*\]\(([^)\n]*)\)/g)) {
    const openParen = match[0].indexOf('(');
    const start = match.index + openParen + 1;
    ranges.push([start, start + match[1].length]);
  }
  add(/^\s*\[[^\]]+\]:\s*\S+/gm);
  for (const match of text.matchAll(/[A-Za-z0-9_]+(?:[/:.][A-Za-z0-9_]+)+/g)) {
    if (/[A-Za-z]/.test(match[0])) ranges.push([match.index, match.index + match[0].length]);
  }
  add(/<https?:\/\/[^>\s]+>/gi);
  add(/https?:\/\/[^\s<>()\[\]{}]+/gi);
  add(/<!--(?:[\s\S]*?)-->/g);
  add(/<\/?[A-Za-z][^<>\n]*>/g);
  add(/<([A-Za-z][A-Za-z0-9_:-]*)[^<>\n]*>[\s\S]*?<[/]\1[ \t]*>/gi);
  let offset = 0;
  for (const line of text.split('\n')) {
    for (const match of line.matchAll(/<([A-Za-z][A-Za-z0-9_:-]*)[^>]*>[^<]*<[/][A-Za-z][A-Za-z0-9_:-]* *>/gi)) ranges.push([offset + match.index, offset + match.index + match[0].length]);
    offset += line.length + 1;
  }
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
  return { before: text.slice(Math.max(0, match.start - radius), match.start), hit: text.slice(match.start, match.end), after: text.slice(match.end, Math.min(text.length, match.end + radius)) };
}
