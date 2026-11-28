const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function excludedRanges(text, excludeCode) {
  if (!excludeCode) return [];
  const ranges = [];
  const add = pattern => { for (const match of text.matchAll(pattern)) ranges.push([match.index, match.index + match[0].length]); };
  add(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/gm);
  add(/(^|\n)[ \t]*(```+|~~~+)[^\n]*\n[\s\S]*?(?:\n[ \t]*\2[ \t]*(?=\n|$)|$)/g);
  add(/`+[^`\n]*`+/g);
  for (const match of text.matchAll(/!?\[[^\]\n]*\]\(([^)\n]*)\)/g)) {
    const start = match.index + match[0].indexOf(match[1]);
    ranges.push([start, start + match[1].length]);
  }
  add(/^\s*\[[^\]]+\]:\s*\S+/gm);
  for (const match of text.matchAll(/[A-Za-z0-9_]+(?:[/:.][A-Za-z0-9_]+)+/g)) ranges.push([match.index, match.index + match[0].length]);
  add(/<https?:\/\/[^>\s]+>/gi);
  add(/https?:\/\/[^\s<>()\[\]{}]+/gi);
  add(/<!--(?:[\s\S]*?)-->/g);
  add(/<([a-z][\w:-]*)\b[^>]*>[\s\S]*?<\/\1\s*>/gi);
  add(/<[^>]+>/g);
  return ranges.sort((a, b) => a[0] - b[0]);
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
    matches.push({ start, end, text: match[0], replacement: options.replacement === undefined ? undefined : options.regex ? match[0].replace(regexForSingle(regex), options.replacement) : options.replacement });
  }
  return { matches, error: '' };
}

function regexForSingle(regex) {
  return new RegExp(regex.source, regex.flags.replace('g', ''));
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
