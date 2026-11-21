// copy-review reports -> findings (the 修正案 table rows) and questions (Q01…), by fixed rules. No LLM, no network, read-only.
//
// Report shapes seen in the real drafts folder, all handled here:
//   findings  a Markdown table whose header has an ID (or #) column, an 旧 (or 原文) column and, usually, a 区分 column
//             (`auto`, `decision Q01`, `decision（Q01）`, `auto（…Q07）`). A table without 区分 is "unclassified".
//   questions a line that opens with Q01… (heading, bullet, bold or plain), in one of two layouts:
//             inline   **Q01（label）: title。** 箇所: … 根拠: … 選択肢: A（推奨）… B …
//             bullets  Q01（E01・label）: title  /  - 根拠: …  - 決めること: …  - 選択肢: A) … B) …  - 推奨案: A
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { loadDraftsIndex } from './drafts-index.ts';
import { reportStatus } from './scan.ts';

export type FindingClass = 'auto' | 'decision' | 'other' | 'unclassified';
export type Finding = {
  slug: string;
  report: string;
  id: string;
  place: string;
  old: string;
  next: string;
  reason: string;
  klass: FindingClass;
  /** The Q ids named in the 区分 cell, normalised (Q1 -> Q01). */
  questionIds: string[];
};
export type Choice = { key: string; text: string };
export type Question = {
  slug: string;
  report: string;
  id: string;
  /** 1-based line of the line that opens the question. */
  line: number;
  title: string;
  /** The parenthesised label after the id, e.g. 資料不足を含む. */
  label: string;
  /** E01… ids the question names (in its label, its first line or its 箇所). */
  refs: string[];
  basis: string;
  choices: Choice[];
  /** The 選択肢 text as written, kept when the choices cannot be split. */
  choicesRaw: string;
  recommended: string | null;
  /** The text after `回答:` if the report has one. Reports usually do not: the answer is given elsewhere. */
  answer: string | null;
};
export type ParsedReport = { slug: string; report: string; status: string | null; findings: Finding[]; questions: Question[] };

export const normalizeQuestionId = (raw: string) => {
  const m = /^Q(\d+)([a-z]?)$/.exec(raw);
  return m ? `Q${m[1].padStart(2, '0')}${m[2]}` : raw;
};
const normalizeRef = (raw: string) => `${raw[0]}${raw.slice(1).padStart(2, '0')}`;

/** Same rule as the scanner's review-report test: a copy-review report, not its brief, reflection log or ledger. */
export const isCopyReviewReport = (name: string) => /\.md$/i.test(name) && /copy-review/i.test(name) && /(report|報告)/i.test(name) && !/(brief|反映記録|ledger|台帳)/i.test(name);

// --- findings ---------------------------------------------------------------

const splitRow = (line: string) =>
  line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, '|').trim());
const isSeparator = (line: string) => /^\|[\s:|-]+\|?\s*$/.test(line.trim()) && line.includes('-');
const FINDING_ID = /^[A-Z]{1,2}\d{1,3}[a-z]?$/;

function classify(cell: string): FindingClass {
  const c = cell.trim();
  if (/^auto/i.test(c)) return 'auto';
  if (/decision|needs_input|判断/i.test(c)) return 'decision';
  return 'other';
}

export function parseFindings(text: string, slug: string, report: string): Finding[] {
  const lines = text.split(/\r?\n/);
  const out: Finding[] = [];
  for (let i = 0; i + 1 < lines.length; i++) {
    if (!lines[i].trimStart().startsWith('|') || !isSeparator(lines[i + 1])) continue;
    const head = splitRow(lines[i]);
    const col = (re: RegExp) => head.findIndex((h) => re.test(h));
    const c = { id: col(/^(ID|#)$/i), place: col(/^(箇所|行|場所)/), old: col(/^(旧|原文)/), next: col(/^(新|修正案)/), reason: col(/^理由/), klass: col(/区分/) };
    let j = i + 2;
    for (; j < lines.length && lines[j].trimStart().startsWith('|'); j++) {
      if (c.id < 0 || c.old < 0) continue; // not a findings table (e.g. a list of open points)
      const cells = splitRow(lines[j]);
      const id = cells[c.id] ?? '';
      if (!FINDING_ID.test(id)) continue;
      const klassCell = c.klass >= 0 ? (cells[c.klass] ?? '') : '';
      out.push({
        slug, report, id,
        place: cells[c.place] ?? '', old: cells[c.old] ?? '', next: cells[c.next] ?? '', reason: cells[c.reason] ?? '',
        klass: c.klass >= 0 ? classify(klassCell) : 'unclassified',
        questionIds: [...new Set([...klassCell.matchAll(/Q\d+[a-z]?/g)].map((m) => normalizeQuestionId(m[0])))],
      });
    }
    i = j - 1;
  }
  return out;
}

// --- questions --------------------------------------------------------------

const Q_START = /^[ \t]*(?:[-*][ \t]+|\d+[.)][ \t]+)?(?:#{1,6}[ \t]*)?\*{0,2}(Q\d{1,2}[a-z]?)(?=[\s（(:：*。.、]|$)/;
const LABELS = /(?:^|[\s。*])(箇所|根拠|決めること|選択肢|推奨案|推奨)[:：]/g;
const tidy = (s: string) => s.replace(/\*\*/g, '').replace(/\s*\n\s*(?:[-*]\s+)?/g, ' ').replace(/^[-*]\s+/, '').trim();

function sections(block: string): Record<string, string> {
  const hits = [...block.matchAll(LABELS)];
  const out: Record<string, string> = {};
  hits.forEach((m, k) => {
    const label = m[1] === '推奨案' ? '推奨' : m[1];
    const from = m.index! + m[0].length;
    const to = k + 1 < hits.length ? hits[k + 1].index! : block.length;
    out[label] ??= tidy(block.slice(from, to)).replace(/\s+[-*]$/, '');
  });
  return out;
}

/** A, B, C… in ascending order, each opening an option: `A（推奨）…`, `A) …`, `(B) …`. Stray capitals are not options. */
function splitChoices(text: string): { choices: Choice[]; marked: string | null } {
  const found: { key: string; at: number; end: number }[] = [];
  let expected = 'A';
  for (const m of text.matchAll(/(?:^|(?<=[\s。；;、]))[(（]?([A-D])[)）]?(?=[\s（(])/g)) {
    if (m[1] !== expected) continue;
    found.push({ key: m[1], at: m.index!, end: m.index! + m[0].length });
    expected = String.fromCharCode(expected.charCodeAt(0) + 1);
  }
  let marked: string | null = null;
  const choices = found.map((f, k) => {
    let body = text.slice(f.end, k + 1 < found.length ? found[k + 1].at : text.length).trim();
    if (/^[（(]推奨[）)]/.test(body)) { marked = f.key; body = body.replace(/^[（(]推奨[）)]\s*/, ''); }
    return { key: f.key, text: body.replace(/[\s。]+$/, '') };
  });
  return { choices, marked };
}

export function parseQuestions(text: string, slug: string, report: string): Question[] {
  const lines = text.split(/\r?\n/);
  const starts: number[] = [];
  lines.forEach((l, i) => { if (Q_START.test(l)) starts.push(i); });
  const byId = new Map<string, { q: Question; length: number }>();
  starts.forEach((s, k) => {
    const first = lines[s];
    const id = normalizeQuestionId(Q_START.exec(first)![1]);
    let end = lines.length;
    for (let i = s + 1; i < lines.length; i++) {
      if ((k + 1 < starts.length && i === starts[k + 1]) || /^#{1,6}\s/.test(lines[i]) || /^---\s*$/.test(lines[i])) { end = i; break; }
    }
    const block = lines.slice(s, end).join('\n');
    const afterId = first.replace(Q_START, '');
    const labelMatch = /^[ \t]*[（(]([^）)]*)[）)]/.exec(afterId);
    const label = labelMatch?.[1] ?? '';
    const sec = sections(block);
    let title = afterId.slice(labelMatch ? labelMatch[0].length : 0).replace(/^[\s:：]+/, '');
    title = tidy(title.includes('**') ? title.slice(0, title.indexOf('**')) : title.replace(/\s*(?:箇所|根拠|決めること|選択肢|推奨案?)[:：].*$/, ''));
    if (!title) title = sec['決めること'] ?? label;
    const refs = [...new Set([...(label + ' ' + (sec['箇所'] ?? '')).matchAll(/(?<![A-Za-z0-9])[ER]\d{1,3}(?![A-Za-z0-9])/g)].map((m) => normalizeRef(m[0])))];
    const { choices, marked } = splitChoices(sec['選択肢'] ?? '');
    const recommended = /^[（(]?([A-D])(?![A-Za-z0-9])/.exec(sec['推奨'] ?? '')?.[1] ?? marked;
    const answer = /回答[:：][ \t]*([^\n]+)/.exec(block)?.[1]?.trim() ?? null;
    const q: Question = { slug, report, id, line: s + 1, title, label, refs, basis: sec['根拠'] ?? '', choices, choicesRaw: sec['選択肢'] ?? '', recommended, answer };
    // The same id can open more than one line (an index line, then the real block): keep the fuller block.
    const prev = byId.get(id);
    if (!prev || block.length > prev.length) byId.set(id, { q, length: block.length });
  });
  return [...byId.values()].map((v) => v.q).sort((a, b) => a.line - b.line);
}

export function parseReport(text: string, slug: string, report: string): ParsedReport {
  return { slug, report, status: reportStatus(text), findings: parseFindings(text, slug, report), questions: parseQuestions(text, slug, report) };
}

// --- finding the reports ----------------------------------------------------

export type ReportFile = { slug: string; file: string; name: string };
const MAX_REPORT_BYTES = 2_000_000;

/**
 * Every copy-review report of every article: top-level files of each folder under the drafts root, and the files a
 * drafts.index.yaml registers. Loose files that no folder or index entry owns are listed in `unowned`, not guessed.
 */
export async function listReportFiles(root: string, indexFile?: string | null): Promise<{ reports: ReportFile[]; unowned: string[]; warnings: string[] }> {
  const reports: ReportFile[] = [];
  const warnings: string[] = [];
  const owned = new Set<string>();
  for (const entry of (await fs.readdir(root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const dir = path.join(root, entry.name);
    for (const f of (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (f.isFile() && isCopyReviewReport(f.name)) reports.push({ slug: entry.name, file: path.join(dir, f.name), name: f.name });
    }
  }
  const indexPath = indexFile === undefined ? path.join(root, 'drafts.index.yaml') : indexFile;
  if (indexPath) {
    try {
      for (const e of await loadDraftsIndex(indexPath)) {
        for (const name of e.files) {
          const file = path.join(e.dirAbs, name);
          if (!isCopyReviewReport(path.basename(name))) continue;
          if (reports.some((r) => r.slug === e.slug && r.file === file)) continue;
          reports.push({ slug: e.slug, file, name: path.basename(name) });
          owned.add(file);
        }
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') warnings.push(`drafts.index.yaml を読めなかった（無視）: ${String((e as Error).message).split('\n')[0].slice(0, 120)}`);
    }
  }
  const unowned: string[] = [];
  for (const f of await fs.readdir(root, { withFileTypes: true })) {
    if (f.isFile() && isCopyReviewReport(f.name) && !owned.has(path.join(root, f.name))) unowned.push(f.name);
  }
  return { reports, unowned: unowned.sort(), warnings };
}

export async function readReports(files: ReportFile[]): Promise<{ parsed: ParsedReport[]; warnings: string[] }> {
  const parsed: ParsedReport[] = [];
  const warnings: string[] = [];
  for (const r of files) {
    try {
      const st = await fs.stat(r.file);
      if (st.size > MAX_REPORT_BYTES) { warnings.push(`${r.slug}/${r.name}: 大きすぎるので読まなかった`); continue; }
      parsed.push(parseReport(await fs.readFile(r.file, 'utf8'), r.slug, r.name));
    } catch (e) {
      warnings.push(`${r.slug}/${r.name}: 読めなかった（${(e as Error).message.split('\n')[0].slice(0, 100)}）`);
    }
  }
  return { parsed, warnings };
}
