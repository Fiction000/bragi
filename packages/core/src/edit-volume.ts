// How much the author changed a draft before confirming it. Read-only: it reads a run folder's source file,
// the editor's nat-final.md and finished.json, and writes nothing.
//
// This is a record, not a verdict. Nothing here compares runs, computes a rate, or says whether the ledger
// helped; the output says so on every print (EDIT_VOLUME_NOTE).
//
// Where things are (read off real runs, see the editor's server.mjs):
//   <run>/editor-targets.json                       targets[]: { id, title, source (path relative to <run>) }
//   <run>/<source>                                  the draft the editor opened (may start with YAML front matter)
//   <run>/05_final/editor/<id>/nat-final.md         the author's confirmed text (front matter re-attached)
//   <run>/05_final/editor/<id>/finished.json        { sourceSha256 (whole source file), finalSha256 (whole nat-final.md), ... }
//
// Counting rules:
//   sentence   a line, cut again after 。！？ (and after . ! ? that is followed by a space or the end of the line).
//              Nothing ends a sentence inside 「」『』（）【】. Markup such as "# " stays part of the sentence.
//   chars      Unicode code points, whitespace excluded. Front matter is dropped on both sides first.
//   changed    sentences are aligned by a longest-common-subsequence over exact (trimmed) sentences. Each run of
//              sentences that did not match is one hunk: n old sentences replaced by m new ones count max(n, m).
//   added/removed chars   inside each hunk, the characters not in the longest common subsequence of old and new text.
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

export type Measure = { sentences: number; chars: number };
export type Volume = {
  source: Measure;
  final: Measure;
  changedSentences: number;
  removedSentences: number;
  addedSentences: number;
  addedChars: number;
  removedChars: number;
  /** true when a hunk was too large to align exactly; then the counts for that hunk are upper bounds. */
  approximate: boolean;
};
export type TargetStatus = 'measured' | 'unfinished' | 'source-missing' | 'source-changed' | 'final-missing' | 'final-changed' | 'invalid-record';
export type TargetResult = { run: string; id: string; title: string; status: TargetStatus; reason: string | null; finishedAt: string | null; volume: Volume | null };
export type EditVolumeReport = { root: string; results: TargetResult[]; warnings: string[]; note: string };

export const EDIT_VOLUME_NOTE = '記録のみ。因果は言わない（台帳が効いたかどうかの評価・比較はしません）。';

// ---- text -----------------------------------------------------------------------------------------------

/** Same front-matter rule as the editor, so source and nat-final.md are cut the same way. */
export function stripFrontMatter(text: string): string {
  const m = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n)+/.exec(text);
  return m ? text.slice(m[0].length) : text;
}

const OPEN = new Set(['「', '『', '（', '【']);
const CLOSE = new Set(['」', '』', '）', '】']);
const JP_END = new Set(['。', '！', '？', '!', '?']);
const ASCII_END = new Set(['.', '!', '?']);
const ASCII_CLOSE = new Set(['"', "'", ')', '”', '’']);

export function splitSentences(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const cs = [...line];
    let buf = '', depth = 0;
    const push = () => { const s = buf.trim(); if (s) out.push(s); buf = ''; };
    for (let i = 0; i < cs.length; i++) {
      const c = cs[i];
      buf += c;
      if (OPEN.has(c)) depth++;
      else if (CLOSE.has(c)) depth = Math.max(0, depth - 1);
      else if (depth === 0 && (c === '。' || c === '！' || c === '？')) {
        while (i + 1 < cs.length && JP_END.has(cs[i + 1])) buf += cs[++i];
        push();
      } else if (depth === 0 && ASCII_END.has(c)) {
        let j = i;
        while (j + 1 < cs.length && (ASCII_END.has(cs[j + 1]) || JP_END.has(cs[j + 1]))) j++;
        let k = j;
        while (k + 1 < cs.length && ASCII_CLOSE.has(cs[k + 1])) k++;
        if (k + 1 >= cs.length || /\s/u.test(cs[k + 1])) { buf += cs.slice(i + 1, k + 1).join(''); i = k; push(); }
      }
    }
    push();
  }
  return out;
}

const dropSpace = (s: string): string[] => [...s].filter((c) => !/\s/u.test(c));
export const countChars = (text: string): number => dropSpace(text).length;

// ---- diff -----------------------------------------------------------------------------------------------

const MAX_ALIGN_CELLS = 30_000_000;
const MAX_LCS_CELLS = 400_000_000;

/** Length of the longest common subsequence; two rows, so memory is O(min). null when the work would be too large. */
function lcsLength(a: string[], b: string[]): number | null {
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let e = 0;
  while (e < a.length - s && e < b.length - s && a[a.length - 1 - e] === b[b.length - 1 - e]) e++;
  const x = a.slice(s, a.length - e), y = b.slice(s, b.length - e);
  if (x.length === 0 || y.length === 0) return s + e;
  if (x.length * y.length > MAX_LCS_CELLS) return null;
  const [p, q] = x.length >= y.length ? [x, y] : [y, x];
  let prev = new Uint32Array(q.length + 1), cur = new Uint32Array(q.length + 1);
  for (let i = 1; i <= p.length; i++) {
    for (let j = 1; j <= q.length; j++) cur[j] = p[i - 1] === q[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    [prev, cur] = [cur, prev];
  }
  return s + e + prev[q.length];
}

type Hunk = { removed: string[]; added: string[] };

/** The runs of sentences that are not shared by both texts. approximate: the middle was too large to align and is one hunk. */
function sentenceHunks(a: string[], b: string[]): { hunks: Hunk[]; approximate: boolean } {
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let e = 0;
  while (e < a.length - s && e < b.length - s && a[a.length - 1 - e] === b[b.length - 1 - e]) e++;
  const x = a.slice(s, a.length - e), y = b.slice(s, b.length - e);
  if (x.length === 0 && y.length === 0) return { hunks: [], approximate: false };
  if (x.length === 0 || y.length === 0 || x.length * y.length > MAX_ALIGN_CELLS) return { hunks: [{ removed: x, added: y }], approximate: x.length > 0 && y.length > 0 };
  const w = y.length + 1;
  const t = new Uint32Array((x.length + 1) * w);
  for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) t[i * w + j] = x[i] === y[j] ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1]);
  const hunks: Hunk[] = [];
  let cur: Hunk | null = null;
  const flush = () => { if (cur) hunks.push(cur); cur = null; };
  let i = 0, j = 0;
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) { flush(); i++; j++; continue; }
    cur ??= { removed: [], added: [] };
    if (j >= y.length || (i < x.length && t[(i + 1) * w + j] >= t[i * w + j + 1])) cur.removed.push(x[i++]);
    else cur.added.push(y[j++]);
  }
  flush();
  return { hunks, approximate: false };
}

export function measureText(source: string, final: string): Volume {
  const a = splitSentences(stripFrontMatter(source)), b = splitSentences(stripFrontMatter(final));
  const { hunks, approximate: sentenceApprox } = sentenceHunks(a, b);
  let changed = 0, removedS = 0, addedS = 0, removedC = 0, addedC = 0, approximate = sentenceApprox;
  for (const h of hunks) {
    changed += Math.max(h.removed.length, h.added.length);
    removedS += h.removed.length;
    addedS += h.added.length;
    const old = dropSpace(h.removed.join('')), neu = dropSpace(h.added.join(''));
    const common = lcsLength(old, neu);
    if (common === null) { approximate = true; removedC += old.length; addedC += neu.length; } else { removedC += old.length - common; addedC += neu.length - common; }
  }
  return {
    source: { sentences: a.length, chars: a.reduce((n, s) => n + countChars(s), 0) },
    final: { sentences: b.length, chars: b.reduce((n, s) => n + countChars(s), 0) },
    changedSentences: changed, removedSentences: removedS, addedSentences: addedS, addedChars: addedC, removedChars: removedC, approximate,
  };
}

// ---- a run ----------------------------------------------------------------------------------------------

const SAFE_ID = /^[a-z0-9-]{1,64}$/;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const short = (h: string) => h.slice(0, 8);
const inside = (parent: string, child: string) => child === parent || child.startsWith(parent + path.sep);
const readOrNull = (file: string) => fs.readFile(file, 'utf8').then((t) => t, (e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null; throw e; });
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Every target of one run folder (the folder that holds editor-targets.json). One result per target; a target
 * that cannot be measured says why and carries no numbers.
 */
export async function measureRun(runDir: string, label: string = path.basename(runDir)): Promise<TargetResult[]> {
  const listingText = await readOrNull(path.join(runDir, 'editor-targets.json'));
  if (listingText === null) throw new Error(`editor-targets.json がありません: ${runDir}`);
  let listing: unknown;
  try { listing = JSON.parse(listingText); } catch { throw new Error(`editor-targets.json を読めません（JSON ではありません）: ${runDir}`); }
  if (!isObject(listing) || !Array.isArray(listing.targets)) throw new Error(`editor-targets.json に targets がありません: ${runDir}`);
  const realRun = await fs.realpath(runDir);
  const results: TargetResult[] = [];
  for (const t of listing.targets as unknown[]) {
    if (!isObject(t) || typeof t.id !== 'string') { results.push({ run: label, id: '?', title: '?', status: 'invalid-record', reason: 'editor-targets.json の target に id がありません', finishedAt: null, volume: null }); continue; }
    results.push(await measureTarget(realRun, label, t.id, typeof t.title === 'string' ? t.title : t.id, t.source));
  }
  return results;
}

async function measureTarget(realRun: string, run: string, id: string, title: string, sourceField: unknown): Promise<TargetResult> {
  const base = { run, id, title, finishedAt: null as string | null, volume: null };
  const fail = (status: TargetStatus, reason: string, finishedAt: string | null = null): TargetResult => ({ ...base, status, reason, finishedAt });
  if (!SAFE_ID.test(id)) return fail('invalid-record', `id が使えない形です（${id}）`);
  const dir = path.join(realRun, '05_final', 'editor', id);
  const contained = async (file: string) => { try { return inside(realRun, await fs.realpath(file)); } catch { return true; } };

  const finishedFile = path.join(dir, 'finished.json');
  if (!(await contained(finishedFile))) return fail('invalid-record', 'finished.json が run の外を指しています');
  const finishedText = await readOrNull(finishedFile);
  if (finishedText === null) return fail('unfinished', 'finished.json がありません（著者が確定していません）');
  let record: unknown;
  try { record = JSON.parse(finishedText); } catch { return fail('invalid-record', 'finished.json を JSON として読めません'); }
  if (!isObject(record)) return fail('invalid-record', 'finished.json がオブジェクトではありません');
  const finishedAt = typeof record.finishedAt === 'string' ? record.finishedAt : null;

  if (typeof sourceField !== 'string' || sourceField === '') return fail('source-missing', '元稿が見つかりません（editor-targets.json に source の記載がありません）', finishedAt);
  if (path.isAbsolute(sourceField) || sourceField.split(/[\\/]/).includes('..')) return fail('source-missing', `元稿が見つかりません（source が run の外を指す形です: ${sourceField}）。run の外は読みません`, finishedAt);
  const sourceFile = path.join(realRun, sourceField);
  let sourceText: string | null;
  try {
    if (!inside(realRun, await fs.realpath(sourceFile))) return fail('source-missing', `元稿が見つかりません（source が run の外を指しています: ${sourceField}）。run の外は読みません`, finishedAt);
    sourceText = await readOrNull(sourceFile);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') sourceText = null; else throw e;
  }
  if (sourceText === null) return fail('source-missing', `元稿が見つかりません（editor-targets.json の source: ${sourceField}）`, finishedAt);

  const finalFile = path.join(dir, 'nat-final.md');
  if (!(await contained(finalFile))) return fail('final-missing', '確定稿 nat-final.md が run の外を指しています', finishedAt);
  const finalText = await readOrNull(finalFile);
  if (finalText === null) return fail('final-missing', '確定稿 nat-final.md がありません', finishedAt);

  if (typeof record.sourceSha256 === 'string' && record.sourceSha256 !== sha256(sourceText)) return fail('source-changed', `元稿の sha256 が確定時と違います（確定時 ${short(record.sourceSha256)}…、いま ${short(sha256(sourceText))}…）。確定後に元稿が書き換わったため比べません`, finishedAt);
  if (typeof record.finalSha256 === 'string' && record.finalSha256 !== sha256(finalText)) return fail('final-changed', `確定稿の sha256 が確定時と違います（確定時 ${short(record.finalSha256)}…、いま ${short(sha256(finalText))}…）。確定後に nat-final.md が書き換わったため測りません`, finishedAt);

  return { ...base, status: 'measured', reason: null, finishedAt, volume: measureText(sourceText, finalText) };
}

// ---- many runs ------------------------------------------------------------------------------------------

const SKIP_DIRS = new Set(['node_modules']);
const MAX_DEPTH = 12;

async function findFinished(dir: string, depth = 0, out: { finished: string[]; runs: string[] } = { finished: [], runs: [] }) {
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries.sort((x, y) => x.name.localeCompare(y.name))) {
    if (e.isFile() && e.name === 'finished.json') out.finished.push(path.join(dir, e.name));
    else if (e.isFile() && e.name === 'editor-targets.json') out.runs.push(dir);
    else if (e.isDirectory() && depth < MAX_DEPTH && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name)) await findFinished(path.join(dir, e.name), depth + 1, out);
  }
  return out;
}

/**
 * A folder that is itself a run is read as one run (every target, finished or not). Any other folder is searched
 * recursively: each finished.json names its run (<run>/05_final/editor/<id>/finished.json), and each folder holding
 * an editor-targets.json is a run too, so a run nobody has confirmed yet shows as 未確定. Every target of every run is listed.
 */
export async function getEditVolume(dir: string): Promise<EditVolumeReport> {
  let root: string;
  try { root = await fs.realpath(dir); } catch { throw new Error(`フォルダが見つかりません: ${dir}`); }
  const warnings: string[] = [];
  const results: TargetResult[] = [];
  if (await fs.access(path.join(root, 'editor-targets.json')).then(() => true, () => false)) {
    results.push(...(await measureRun(root, path.basename(root))));
    return { root, results, warnings, note: EDIT_VOLUME_NOTE };
  }
  const found = await findFinished(root);
  const runs = new Set<string>(found.runs);
  for (const file of found.finished) {
    const editorDir = path.dirname(path.dirname(file));
    const run = path.dirname(path.dirname(editorDir));
    if (path.basename(editorDir) !== 'editor' || path.basename(path.dirname(editorDir)) !== '05_final') warnings.push(`finished.json の置き場所が <run>/05_final/editor/<id>/ ではないので数えません: ${path.relative(root, file)}`);
    else runs.add(run);
  }
  for (const run of [...runs].sort((x, y) => path.relative(root, x).localeCompare(path.relative(root, y)))) {
    const label = path.relative(root, run) || path.basename(root);
    try { results.push(...(await measureRun(run, label))); } catch (e) { warnings.push(`${label}: ${(e as Error).message}`); }
  }
  return { root, results, warnings, note: EDIT_VOLUME_NOTE };
}

// ---- output ---------------------------------------------------------------------------------------------

const STATUS_LABEL: Record<TargetStatus, string> = {
  measured: '確定済み',
  unfinished: '未確定',
  'source-missing': '元稿が見つかりません',
  'source-changed': '元稿が確定後に変わっています',
  'final-missing': '確定稿がありません',
  'final-changed': '確定稿が確定後に変わっています',
  'invalid-record': 'finished.json を読めません',
};

const width = (s: string) => [...s].reduce((n, c) => n + (/[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/u.test(c) ? 2 : 1), 0);
const pad = (s: string, n: number, right = false) => (right ? ' '.repeat(Math.max(0, n - width(s))) + s : s + ' '.repeat(Math.max(0, n - width(s))));

export function renderEditVolume(report: EditVolumeReport): string {
  const lines: string[] = [];
  if (report.results.length === 0) lines.push(`確定済みの run が見つかりません（finished.json が見つかりません）: ${report.root}`);
  else {
    const head = ['run', 'id', '元稿 文/字', '確定稿 文/字', '変えた文', '追加字', '削除字', '状態'];
    const rows = report.results.map((r) => {
      const v = r.volume;
      if (!v) return [r.run, r.id, '-', '-', '-', '-', '-', `${STATUS_LABEL[r.status]}${r.reason ? `: ${r.reason}` : ''}`];
      return [r.run, r.id, `${v.source.sentences}/${v.source.chars}`, `${v.final.sentences}/${v.final.chars}`, String(v.changedSentences), String(v.addedChars), String(v.removedChars), STATUS_LABEL[r.status] + (v.approximate ? '（大きな書き換えのため字数は上限値）' : '')];
    });
    const w = head.map((h, i) => Math.max(width(h), ...rows.map((row) => width(row[i]))));
    const fmt = (row: string[]) => row.map((c, i) => (i >= 2 && i <= 6 ? pad(c, w[i], true) : i === 7 ? c : pad(c, w[i]))).join('  ');
    lines.push(fmt(head), ...rows.map(fmt));
    lines.push('', '変えた文: 元稿から置き換え・削除・追加された文の数（n 文を m 文に置き換えた箇所は max(n, m)）。字数は空白・改行を除き、front matter を除く。');
  }
  for (const w of report.warnings) lines.push(`warning: ${w}`);
  lines.push('', report.note);
  return `${lines.join('\n')}\n`;
}
