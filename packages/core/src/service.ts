// The three reads shared by the CLI (bragi) and the MCP server. Read-only.
import { loadLedger } from './ledger.ts';
import { defaultDraftsRoot, defaultLedgerDir, defaultTaskNotesDir, today } from './config.ts';
import { renderContext } from './context.ts';
import { scanDrafts } from './scan.ts';
import { listReportFiles, readReports } from './reports.ts';
import { buildCandidates, renderCandidates } from './candidates.ts';
import { countRecurrence, renderRecurrence } from './recurrence.ts';
import { proposalsDirFor, proposeDecision, type ProposalInput } from './proposals.ts';
import type { GithubClient } from './github.ts';
import type { Draft } from './schema.ts';

export type ServiceOptions = {
  draftsRoot?: string;
  ledgerDir?: string;
  /** Where proposals live. Default: the folder next to the ledger folder (so a test ledger in a temp dir can never reach the real Vault). */
  proposalsDir?: string;
  taskNotesDir?: string | null;
  draftsIndex?: string | null;
  prRepos?: string[];
  /** null: do not ask GitHub (PRs show as state unknown). */
  github?: GithubClient | null;
};

const scan = (o: ServiceOptions) =>
  scanDrafts(o.draftsRoot ?? defaultDraftsRoot(), { github: o.github ?? null, prRepos: o.prRepos ?? [], taskNotesDir: o.taskNotesDir === undefined ? defaultTaskNotesDir() : o.taskNotesDir, indexFile: o.draftsIndex });

export async function listDrafts(o: ServiceOptions = {}) {
  const s = await scan(o);
  return { root: s.root, scannedAt: s.scannedAt, warnings: s.warnings, drafts: s.drafts.map((d) => ({ slug: d.slug, title: d.title, medium: d.medium, stage: d.stage, stageLabel: d.stageLabel, waitingOn: d.waitingOn, openDecisions: d.openDecisions, due: d.due, prs: d.prs.map((p) => ({ number: p.number, state: p.state, url: p.url })) })) };
}

export class UnknownDraft extends Error {
  constructor(slug: string, known: string[]) { super(`unknown draft "${slug}". Known: ${known.join(', ') || '(none)'}`); }
}

async function find(o: ServiceOptions, slug: string): Promise<Draft> {
  const s = await scan(o);
  const hit = s.drafts.find((d) => d.slug === slug);
  if (!hit) throw new UnknownDraft(slug, s.drafts.map((d) => d.slug));
  return hit;
}

export const getDraft = (o: ServiceOptions, slug: string) => find(o, slug);

export async function getContext(o: ServiceOptions, slug: string): Promise<string> {
  return (await getContextWithMedium(o, slug)).text;
}

/** The context Markdown plus the medium it was built for (null: unknown), so a caller can warn without parsing the text. */
export async function getContextWithMedium(o: ServiceOptions, slug: string): Promise<{ text: string; medium: string | null }> {
  const draft = await find(o, slug);
  const { decisions, problems } = await loadLedger(o.ledgerDir ?? defaultLedgerDir());
  const text = renderContext(decisions, { draft: draft.slug, medium: draft.medium });
  return { medium: draft.medium, text: problems.length > 0 ? `${text}\n> 読めなかった台帳ファイル ${problems.length}件\n${problems.map((p) => `> - ${p.file}：${p.message}\n`).join('')}` : text };
}

/** Every copy-review report, parsed, with the ledger's decisions. Read-only. */
async function reportsAndLedger(o: ServiceOptions) {
  const { reports: files, unowned, warnings: w1 } = await listReportFiles(o.draftsRoot ?? defaultDraftsRoot(), o.draftsIndex);
  const { parsed, warnings: w2 } = await readReports(files);
  const { decisions, problems } = await loadLedger(o.ledgerDir ?? defaultLedgerDir());
  return { parsed, decisions, warnings: [...w1, ...w2, ...problems.map((p) => `台帳 ${p.file}：${p.message}`)], unowned };
}

/** The questions of one article's copy-review reports as candidate decisions. Nothing is written to the ledger. */
export async function getCandidates(o: ServiceOptions, slug: string) {
  const { parsed, decisions, warnings } = await reportsAndLedger(o);
  const mine = parsed.filter((r) => r.slug === slug);
  if (mine.length === 0) throw new UnknownDraft(slug, [...new Set(parsed.map((r) => r.slug))].sort());
  const candidates = buildCandidates(mine, decisions);
  return { slug, reports: mine.map((r) => ({ file: r.report, status: r.status, findings: r.findings.length, questions: r.questions.length })), candidates, warnings, text: renderCandidates(slug, mine, candidates) };
}

/** How many articles each active decision recurs in, across every report (or only those the article's findings fall under). */
export async function getRecurrence(o: ServiceOptions, slug?: string) {
  const { parsed, decisions, warnings, unowned } = await reportsAndLedger(o);
  if (slug && !parsed.some((r) => r.slug === slug)) throw new UnknownDraft(slug, [...new Set(parsed.map((r) => r.slug))].sort());
  const rows = countRecurrence(parsed, decisions, slug);
  const notes = [...warnings, ...unowned.map((n) => `フォルダのない報告は数えていない（drafts.index.yaml に登録されていない）: ${n}`)];
  const text = renderRecurrence(rows, parsed, slug) + (notes.length ? `\n${notes.map((n) => `> ${n}`).join('\n')}\n` : '');
  return { slug: slug ?? null, rows, articles: [...new Set(parsed.map((r) => r.slug))].sort(), warnings: notes, text };
}

const TODAY = () => today();

/**
 * The only write an agent has: put one PROPOSED decision in the proposals folder (never the ledger).
 * Scope defaults to draft, and a draft-scope proposal must name an article that exists. `now` is for tests.
 */
export async function proposeDecisionFor(o: ServiceOptions, input: ProposalInput, now: string = TODAY()) {
  const scope = input.scope ?? 'draft';
  if (scope === 'draft' && input.draft) await find(o, input.draft); // unknown article -> UnknownDraft, nothing written
  const ledgerDir = o.ledgerDir ?? defaultLedgerDir();
  return proposeDecision(o.proposalsDir ?? proposalsDirFor(ledgerDir), ledgerDir, { ...input, scope }, now);
}
