// Read-only scan of the drafts folder. Every folder directly under the root is one article; articles with no
// folder are registered in drafts.index.yaml. It only reads: no file or folder is created, changed or removed.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { loadDraftsIndex, type IndexEntry } from './drafts-index.ts';
import { hasRecord, readArticleYaml, resolveRecord, type ArticleRecord } from './article.ts';
import type { GithubClient, GithubResult, PrRequest } from './github.ts';
import { matchPrsByBranch, prCandidates, unknownPr, type PrRef } from './pr.ts';
import { deriveStage, findPlaceholders, type ReportFact } from './stage.ts';
import { loadSettings } from './config.ts';
import { draftSchema, overrideSchema, scanResultSchema, type Draft, type EditorRun, type Override, type PrInfo, type ScanResult } from './schema.ts';
import { dueFromNotes, loadTaskNotes, mentionedIds, type TaskNote } from './tasknotes.ts';

export const INDEX_FILE_NAME = 'drafts.index.yaml';
const MAX_TEXT_BYTES = 512 * 1024;
const MAX_MD_PER_ARTICLE = 80;
const MAX_EDITOR_DEPTH = 2;
const SKIP = new Set(['node_modules', '05_final', 'out', 'evidence']);

const targetsFileSchema = z.object({
  targets: z.array(z.object({ id: z.string(), title: z.string(), medium: z.string().optional(), source: z.string().optional() }).passthrough()),
});

export const encodeRunKey = (relPath: string) => Buffer.from(relPath, 'utf8').toString('base64url');
export const decodeRunKey = (key: string) => Buffer.from(key, 'base64url').toString('utf8');

async function readText(file: string): Promise<{ text: string; mtimeMs: number } | null> {
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > MAX_TEXT_BYTES) return null;
    return { text: await fs.readFile(file, 'utf8'), mtimeMs: stat.mtimeMs };
  } catch {
    return null;
  }
}

const exists = async (file: string) => fs.access(file).then(() => true, () => false);
const inside = (parent: string, child: string) => child === parent || child.startsWith(parent + path.sep);

const isReviewReport = (name: string) => /copy-review/i.test(name) && /(report|報告)/i.test(name) && !/(brief|反映記録)/i.test(name);
const isReportLike = (name: string) => /\.md$/i.test(name) && /(report|報告|ledger|台帳)/i.test(name);

/** `status: needs_input` on a line of its own, in frontmatter or body. */
export const reportStatus = (text: string) => /^status:[ \t]*([a-z_]+)/m.exec(text)?.[1] ?? null;
/** Q01, Q02… that open a heading or a bullet: the questions a report asks. */
export const reportQuestionIds = (text: string) => [...new Set([...text.matchAll(/^(?:#{1,6}[ \t]*|[-*][ \t]+\*{0,2})(Q\d{2})\b/gm)].map((m) => m[1]))];

/** The text of a target as it stands: the editor's current version if there is one, else the source file. */
async function targetText(runDir: string, id: string, source: string | undefined): Promise<string> {
  const current = await readText(path.join(runDir, '05_final', 'editor', id, 'nat-final.md'));
  if (current) return current.text;
  if (!source || path.isAbsolute(source) || source.split(/[\\/]/).includes('..')) return '';
  try {
    const real = await fs.realpath(path.join(runDir, source));
    return inside(await fs.realpath(runDir), real) ? ((await readText(real))?.text ?? '') : '';
  } catch {
    return '';
  }
}

async function findEditorRuns(root: string, articleDir: string, depth = 0): Promise<EditorRun[]> {
  const runs: EditorRun[] = [];
  const listing = await readText(path.join(articleDir, 'editor-targets.json'));
  if (listing) {
    let parsed;
    try {
      parsed = targetsFileSchema.safeParse(JSON.parse(listing.text));
    } catch {
      parsed = null;
    }
    if (parsed?.success) {
      const relPath = path.relative(root, articleDir);
      const targets = [];
      for (const t of parsed.data.targets) {
        targets.push({
          id: t.id,
          title: t.title,
          medium: t.medium ?? null,
          finished: await exists(path.join(articleDir, '05_final', 'editor', t.id, 'finished.json')),
          placeholders: findPlaceholders(await targetText(articleDir, t.id, t.source), loadSettings().author),
        });
      }
      runs.push({ key: encodeRunKey(relPath), relPath, targets });
    }
    return runs;
  }
  if (depth >= MAX_EDITOR_DEPTH) return runs;
  let entries;
  try {
    entries = await fs.readdir(articleDir, { withFileTypes: true });
  } catch {
    return runs;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory() && !entry.name.startsWith('.') && !SKIP.has(entry.name)) runs.push(...(await findEditorRuns(root, path.join(articleDir, entry.name), depth + 1)));
  }
  return runs;
}

/** Every editor run under the root, with its key. The HTTP layer opens a run only if it is in this list. */
export async function listEditorRuns(root: string): Promise<(EditorRun & { dir: string })[]> {
  const realRoot = await fs.realpath(root);
  const out: (EditorRun & { dir: string })[] = [];
  for (const entry of await fs.readdir(realRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    for (const run of await findEditorRuns(realRoot, path.join(realRoot, entry.name))) out.push({ ...run, dir: path.join(realRoot, run.relPath) });
  }
  return out;
}

/** What is known about one article before PRs and notes are looked up. */
type Material = {
  slug: string;
  dir: string;
  source: 'folder' | 'manual';
  title: string | null;
  medium: string | null;
  /** The `medium` in article.yaml. Ranks below a hand-registered or editor-targets medium, above a report's 媒体 line. */
  articleMedium: string | null;
  files: string[]; // absolute paths
  editorRuns: EditorRun[];
  override: Override | null;
  /** The record of repo, branch and PR numbers (article.yaml, or the same fields in drafts.index.yaml). */
  record: ArticleRecord;
  dueFromIndex: string | null;
  warnings: string[];
};

type Evidence = { reports: ReportFact[]; prTexts: string[]; mentions: string[]; medium: string | null; briefDue: string | null };

async function readEvidence(files: string[]): Promise<Evidence> {
  const ev: Evidence = { reports: [], prTexts: [], mentions: [], medium: null, briefDue: null };
  for (const file of files) {
    const name = path.basename(file);
    if (!/\.md$/i.test(name)) continue;
    const isReview = isReviewReport(name);
    const isBrief = /brief/i.test(name);
    const read = await readText(file);
    if (!read) continue;
    ev.mentions.push(...mentionedIds(read.text));
    if (isReview) {
      ev.reports.push({ file: name, status: reportStatus(read.text), mtimeMs: read.mtimeMs, questionIds: reportQuestionIds(read.text) });
      ev.medium ??= /^媒体[:：][ \t]*([^（(\s\n]+)/m.exec(read.text)?.[1] ?? null;
    }
    if (isReportLike(name)) ev.prTexts.push(read.text);
    if (isBrief) ev.briefDue ??= /^(?:due|期限)[:：][ \t]*(\d{4}-\d{2}-\d{2})/m.exec(read.text)?.[1] ?? null;
  }
  return ev;
}

async function folderMaterial(root: string, slug: string): Promise<Material> {
  const dir = path.join(root, slug);
  const warnings: string[] = [];
  const names = (await fs.readdir(dir)).filter((n) => /\.md$/i.test(n)).sort().slice(0, MAX_MD_PER_ARTICLE);
  let override: Override | null = null;
  const overrideFile = await readText(path.join(dir, 'status.override.json'));
  if (overrideFile) {
    try {
      override = overrideSchema.parse(JSON.parse(overrideFile.text));
    } catch (e) {
      warnings.push(`status.override.json を読めなかった（無視）: ${String((e as Error).message).split('\n')[0].slice(0, 120)}`);
    }
  }
  const article = await readArticleYaml(path.join(dir, 'article.yaml'));
  let record: ArticleRecord = article?.record ?? { repo: null, branch: null, prs: [] };
  warnings.push(...(article?.problems ?? []));
  if (override?.pr) {
    const fromOverride = resolveRecord({ repo: record.repo ?? undefined, branch: record.branch ?? undefined, pr: [override.pr] }).record;
    record = { ...record, prs: [...record.prs, ...fromOverride.prs] };
  }
  return { slug, dir, source: 'folder', title: null, medium: null, articleMedium: article?.medium ?? null, files: names.map((n) => path.join(dir, n)), editorRuns: await findEditorRuns(root, dir), override, record, dueFromIndex: null, warnings };
}

async function manualMaterial(entry: IndexEntry): Promise<Material> {
  const warnings: string[] = [];
  const files: string[] = [];
  for (const name of entry.files) {
    const file = path.join(entry.dirAbs, name);
    if (await exists(file)) files.push(file);
    else warnings.push(`drafts.index.yaml に登録されたファイルが見つからない: ${name}`);
  }
  const { record, problems } = resolveRecord({ repo: entry.repo, branch: entry.branch, pr: entry.pr });
  warnings.push(...problems);
  return { slug: entry.slug, dir: entry.dirAbs, source: 'manual', title: entry.title, medium: entry.medium ?? null, articleMedium: null, files, editorRuns: [], override: null, record, dueFromIndex: entry.due ?? null, warnings };
}

export type ScanOptions = {
  /** One GraphQL call for every PR the articles need (state, head SHA, CI, pr_gate comment, review threads). null: do not ask GitHub (PRs show as state unknown). */
  github?: GithubClient | null;
  /** Repositories to search for branch names in, in addition to those the articles name. */
  prRepos?: string[];
  /** TaskNotes folder (due dates by KRE key or kanban id). null/undefined: none. */
  taskNotesDir?: string | null;
  /** drafts.index.yaml. undefined: <root>/drafts.index.yaml when it exists. null: none. */
  indexFile?: string | null;
  now?: Date;
};

export async function scanDrafts(rootInput: string, options: ScanOptions = {}): Promise<ScanResult> {
  const { github = null, prRepos = [], taskNotesDir = null, now = new Date() } = options;
  const { stageLabels: labels, author } = loadSettings();
  const root = await fs.realpath(rootInput);
  const scanWarnings: string[] = [];
  const entries = await fs.readdir(root, { withFileTypes: true });
  const slugs = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name).sort();
  const skippedFiles = entries.filter((e) => !e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name).sort();

  const materials: Material[] = await Promise.all(slugs.map((slug) => folderMaterial(root, slug)));

  const indexFile = options.indexFile === undefined ? path.join(root, INDEX_FILE_NAME) : options.indexFile;
  if (indexFile && (options.indexFile !== undefined || (await exists(indexFile)))) {
    try {
      for (const entry of await loadDraftsIndex(indexFile)) {
        if (slugs.includes(entry.slug)) scanWarnings.push(`${path.basename(indexFile)} の ${entry.slug} は同名のフォルダがあるため無視した`);
        else materials.push(await manualMaterial(entry));
      }
    } catch (e) {
      scanWarnings.push(`${path.basename(indexFile)} を読めなかった（手で登録した記事は出ない）: ${String((e as Error).message).split('\n')[0].slice(0, 160)}`);
    }
  }

  let notes: TaskNote[] = [];
  if (taskNotesDir) {
    try {
      notes = await loadTaskNotes(taskNotesDir);
    } catch (e) {
      scanWarnings.push(`TaskNotes を読めなかった（期限は出ない）: ${String((e as Error).message).split('\n')[0].slice(0, 120)}`);
    }
  }

  const evidence = await Promise.all(materials.map((m) => readEvidence(m.files)));
  // Which PRs each article is about. A record wins; without one the reports are mined (a guess).
  const refs: { ref: PrRef; via: 'record' | 'report' }[][] = materials.map((m, i) =>
    hasRecord(m.record) ? m.record.prs.map((ref) => ({ ref, via: 'record' as const })) : prCandidates(evidence[i].prTexts).map((ref) => ({ ref, via: 'report' as const })));

  // One request for every repository and every PR number wanted.
  const request: PrRequest = {};
  for (const r of prRepos) request[r] ??= [];
  for (const m of materials) if (m.record.repo) request[m.record.repo] ??= [];
  for (const list of refs) for (const { ref } of list) (request[ref.repo] ??= []).push(ref.number);
  let found: GithubResult = {};
  let githubError: string | null = null;
  if (github && Object.keys(request).length > 0) {
    try {
      found = await github(request);
    } catch (e) {
      githubError = String((e as Error).message).slice(0, 140);
      scanWarnings.push(`GitHub から PR の情報を取れなかった（PR は状態不明として出す）: ${githubError}`);
    }
  } else if (!github) githubError = 'GitHub を使わない設定';
  const githubStatus: ScanResult['github'] = !github ? 'off' : githubError ? 'failed' : 'ok';

  const drafts: Draft[] = [];
  for (const [i, m] of materials.entries()) {
    const ev = evidence[i];
    const warnings = [...m.warnings];
    const prs: PrInfo[] = [];
    for (const { ref, via } of refs[i]) {
      const hit = (found[ref.repo] ?? []).find((p) => p.number === ref.number);
      prs.push(hit ? { ...hit, via } : { ...unknownPr(ref, githubError ?? 'GitHub に見つからない'), via });
    }
    for (const p of prs) if (p.state === 'unknown' && p.error) warnings.push(`PR #${p.number}: ${p.error}`);
    // The recorded branch is matched exactly; without any record the folder name is looked for in branch names (a guess).
    const searchRepos = m.record.repo ? [m.record.repo] : hasRecord(m.record) ? [] : Object.keys(found);
    for (const repo of searchRepos) {
      for (const hit of matchPrsByBranch(m.slug, found[repo] ?? [], m.record.branch)) if (!prs.some((p) => p.url === hit.url)) prs.push(hit);
    }
    const guessed = prs.filter((p) => p.via !== 'record');
    if (guessed.length > 0 && !hasRecord(m.record)) warnings.push(`PR ${guessed.map((p) => `#${p.number}`).join('・')} は記録（article.yaml）がなく、${guessed.some((p) => p.via === 'branch') ? '報告の記載かブランチ名' : '報告の記載'}から推測した`);

    const placeholders = m.editorRuns.flatMap((r) => r.targets.flatMap((t) => t.placeholders));
    const result = deriveStage({ reports: ev.reports, editorRuns: m.editorRuns, prs, override: m.override, placeholders, labels });

    let due: string | null = null;
    let dueFrom: string | null = null;
    const fromNotes = dueFromNotes(ev.mentions, notes);
    if (m.override?.due !== undefined) {
      due = m.override.due;
      dueFrom = due ? 'status.override.json' : null;
    } else if (m.dueFromIndex) {
      due = m.dueFromIndex;
      dueFrom = INDEX_FILE_NAME;
    } else if (fromNotes) {
      due = fromNotes.due;
      dueFrom = fromNotes.from;
    } else if (ev.briefDue) {
      due = ev.briefDue;
      dueFrom = 'brief';
    }

    const first = m.editorRuns[0]?.targets[0];
    drafts.push(draftSchema.parse({
      slug: m.slug,
      title: m.title ?? first?.title ?? m.slug,
      medium: m.medium ?? first?.medium ?? m.articleMedium ?? ev.medium,
      path: m.dir,
      stage: result.stage,
      stageLabel: labels[result.stage],
      waitingOn: result.waitingOn,
      openDecisions: result.openDecisions,
      placeholders,
      due,
      dueFrom,
      source: m.source,
      prs,
      editorRuns: m.editorRuns,
      overridden: m.override?.stage !== undefined || m.override?.waiting_on !== undefined,
      reasons: result.reasons,
      warnings: [...warnings, ...result.warnings],
    }));
  }
  return scanResultSchema.parse({ root, author, scannedAt: now.toISOString(), drafts, skippedFiles, warnings: scanWarnings, github: githubStatus });
}
