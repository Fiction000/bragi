// Proposed decisions (step 6). An agent may PROPOSE a decision; only a person adopts it (in the editor's UI).
// A proposal is one Markdown file in its own folder, OUTSIDE the ledger folder, so the ledger scanner, `bragi context`
// and the recurrence count never see it. It carries the same fields a ledger decision would, and is validated with the
// ledger's own schema (decisionMetaSchema) before anything is written.
// What writes where:
//   proposeDecision  -> creates one file in the proposals folder (exclusive create; a duplicate returns the existing one).
//   adoptProposal    -> creates ONE new ledger file and edits ONE proposal file (status line). Called by the editor's HTTP API, never by MCP.
//   rejectProposal   -> edits ONE proposal file (status line).
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parse, stringify } from 'yaml';
import { z } from 'zod';
import { DATE, KINDS, SCOPES, VAULT_KEYS, checkSchema, createDecision, decisionMetaSchema, summarizeError, vaultMetaSchema, type Decision } from './ledger.ts';
import { defaultLedgerDir, loadSettings } from './config.ts';

/** The proposals folder that goes with a ledger folder: its sibling named by the `proposals` setting (default `proposals`), never inside the ledger. */
export const proposalsDirFor = (ledgerDir: string = defaultLedgerDir(), name: string = loadSettings().proposalsName) => path.join(path.dirname(path.resolve(ledgerDir)), name);

export const PROPOSAL_STATUSES = ['pending', 'adopted', 'rejected'] as const;
export const PROPOSAL_ID = /^P-\d{4}-\d{2}-\d{2}-[a-z0-9][a-z0-9-]{0,80}$/;
const PREFIX = /^P-\d{4}-\d{2}-\d{2}-/;
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

const common = {
  scope: z.enum(SCOPES),
  medium: z.string().min(1).nullable().default(null),
  draft: z.string().min(1).nullable().default(null),
  kind: z.enum(KINDS),
  source: z.string().min(1),
  check: checkSchema.default({ type: 'none' }),
};

export const proposalMetaSchema = z
  .object({
    id: z.string().regex(PROPOSAL_ID, 'id is P-YYYY-MM-DD-<slug>'),
    proposed_by: z.string().min(1),
    proposed_at: DATE,
    status: z.enum(PROPOSAL_STATUSES),
    ...common,
    resolved_at: DATE.optional(),
    adopted_as: z.string().optional(),
  })
  .strict()
  .superRefine((p, ctx) => {
    if (p.status !== 'pending' && !p.resolved_at) ctx.addIssue({ code: 'custom', path: ['resolved_at'], message: 'an adopted or rejected proposal needs resolved_at' });
    if (p.status === 'adopted' && !p.adopted_as) ctx.addIssue({ code: 'custom', path: ['adopted_as'], message: 'an adopted proposal needs adopted_as (the decision id)' });
    if (p.status !== 'adopted' && p.adopted_as) ctx.addIssue({ code: 'custom', path: ['adopted_as'], message: 'adopted_as only goes with status=adopted' });
    // The ledger's own rules (scope vs medium/draft, id shape) decide whether this could become a decision.
    const r = decisionMetaSchema.safeParse(toDecisionMeta(p, p.proposed_by, p.proposed_at));
    if (!r.success) for (const i of r.error.issues) if (i.path[0] !== 'id') ctx.addIssue({ code: 'custom', path: i.path, message: i.message });
  });

export type ProposalMeta = z.output<typeof proposalMetaSchema>;
export type Proposal = { meta: ProposalMeta; body: string; file: string };
export type ProposalInput = {
  /** Lower-case words and hyphens: the file is P-<date>-<slug>.md and the decision D-<decided date>-<slug>. */
  slug: string;
  proposed_by: string;
  scope?: (typeof SCOPES)[number];
  medium?: string | null;
  draft?: string | null;
  kind: (typeof KINDS)[number];
  source: string;
  check?: z.input<typeof checkSchema>;
  body: string;
};

const decisionSlug = (id: string) => id.replace(PREFIX, '');

/** The decision this proposal would become, as the ledger's schema sees it. */
function toDecisionMeta(p: Pick<ProposalMeta, 'id' | 'scope' | 'medium' | 'draft' | 'kind' | 'source' | 'check'>, decidedBy: string, at: string) {
  return {
    id: `D-${at}-${decisionSlug(p.id)}`, scope: p.scope, medium: p.medium, draft: p.draft, kind: p.kind, status: 'active' as const,
    decided_by: decidedBy, decided_at: at, source: p.source, check: p.check,
  };
}

const bodySchema = z.string().trim().min(1, 'the decision text is empty');

function serialize(meta: ProposalMeta, body: string): string {
  const m = proposalMetaSchema.parse(meta);
  const ordered = {
    id: m.id, proposed_by: m.proposed_by, proposed_at: m.proposed_at, status: m.status,
    scope: m.scope, medium: m.medium, draft: m.draft, kind: m.kind, source: m.source, check: m.check,
    ...(m.resolved_at ? { resolved_at: m.resolved_at } : {}), ...(m.adopted_as ? { adopted_as: m.adopted_as } : {}),
  };
  return `---\n${stringify(ordered, { lineWidth: 0 }).trimEnd()}\n---\n\n${bodySchema.parse(body)}\n`;
}

export function parseProposal(text: string, file: string): Proposal {
  const m = FRONTMATTER.exec(text);
  if (!m) throw new Error('frontmatter (--- ... ---) not found');
  const raw: unknown = parse(m[1]);
  let meta = raw;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const vault: Record<string, unknown> = {};
    const rest: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(raw)) ((VAULT_KEYS as readonly string[]).includes(k) ? vault : rest)[k] = v;
    vaultMetaSchema.parse(vault);
    meta = rest;
  }
  const parsed = z.object({ meta: proposalMetaSchema, body: bodySchema }).parse({ meta, body: m[2].trim() });
  if (path.basename(file) !== `${parsed.meta.id}.md`) throw new Error(`file name must be ${parsed.meta.id}.md`);
  return { ...parsed, file };
}

export type ProposalRead = { proposals: Proposal[]; problems: { file: string; message: string }[] };

/** Every *.md in the proposals folder. A file that does not parse is reported, never fatal. A missing folder is an empty list. */
export async function loadProposals(dir: string): Promise<ProposalRead> {
  let names: string[];
  try {
    names = (await fs.readdir(dir)).filter((n) => n.endsWith('.md') && !n.startsWith('.')).sort();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { proposals: [], problems: [] };
    throw e;
  }
  const proposals: Proposal[] = [];
  const problems: ProposalRead['problems'] = [];
  for (const name of names) {
    try {
      proposals.push(parseProposal(await fs.readFile(path.join(dir, name), 'utf8'), path.join(dir, name)));
    } catch (e) {
      problems.push({ file: name, message: summarizeError(e) });
    }
  }
  proposals.sort((a, b) => a.meta.proposed_at.localeCompare(b.meta.proposed_at) || a.meta.id.localeCompare(b.meta.id));
  return { proposals, problems };
}

/** Two proposals are the same when scope, target, kind and the wording (width, case-folded spaces ignored) agree. */
export function dedupeKey(p: { scope: string; medium: string | null; draft: string | null; kind: string; body: string }): string {
  return JSON.stringify([p.scope, p.medium, p.draft, p.kind, p.body.normalize('NFKC').replace(/\s+/g, ' ').trim()]);
}

const sameDir = (a: string, b: string) => path.resolve(a) === path.resolve(b);
const inside = (parent: string, child: string) => { const r = path.relative(path.resolve(parent), path.resolve(child)); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };

/** The proposals folder must never be the ledger folder or inside it: that is what keeps a proposal out of every ledger read. */
export function assertOutsideLedger(proposalsDir: string, ledgerDir: string): void {
  if (inside(ledgerDir, proposalsDir) || inside(proposalsDir, ledgerDir)) throw new Error('the proposals folder must be outside the ledger folder');
}

export type ProposeResult = { created: boolean; proposal: Proposal };

/**
 * Writes one proposal file, only in the proposals folder. Invalid input is refused before anything is written (the ledger's schema).
 * The same wording for the same scope/target/kind returns the existing proposal (whatever its status) and writes nothing.
 */
export async function proposeDecision(proposalsDir: string, ledgerDir: string, input: ProposalInput, now: string): Promise<ProposeResult> {
  assertOutsideLedger(proposalsDir, ledgerDir);
  const date = DATE.parse(now);
  const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,80}$/, 'slug is lower-case letters, digits and hyphens').parse(input.slug);
  const meta = proposalMetaSchema.parse({
    id: `P-${date}-${slug}`, proposed_by: input.proposed_by, proposed_at: date, status: 'pending',
    scope: input.scope ?? 'draft', medium: input.medium ?? null, draft: input.draft ?? null, kind: input.kind, source: input.source, check: input.check ?? { type: 'none' },
  });
  const text = serialize(meta, input.body);
  const file = path.join(proposalsDir, `${meta.id}.md`);
  const proposal = parseProposal(text, file);
  const key = dedupeKey({ ...proposal.meta, body: proposal.body });
  const existing = (await loadProposals(proposalsDir)).proposals.find((p) => dedupeKey({ ...p.meta, body: p.body }) === key);
  if (existing) return { created: false, proposal: existing };
  await fs.mkdir(proposalsDir, { recursive: true });
  try {
    await fs.writeFile(file, text, { flag: 'wx' });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw Object.assign(new Error(`a different proposal already has the id ${meta.id}; use another slug`), { status: 409 });
    throw e;
  }
  return { created: true, proposal };
}

const STATUS_LINE = /^status: pending[ \t]*$/m;

async function readPending(dir: string, id: string): Promise<{ file: string; text: string; proposal: Proposal }> {
  if (!PROPOSAL_ID.test(id)) throw Object.assign(new Error('bad proposal id'), { status: 400 });
  const file = path.join(dir, `${id}.md`);
  let text: string;
  try { text = await fs.readFile(file, 'utf8'); } catch { throw Object.assign(new Error('proposal not found'), { status: 404 }); }
  const proposal = parseProposal(text, file);
  if (proposal.meta.status !== 'pending') throw Object.assign(new Error(`already ${proposal.meta.status}`), { status: 409 });
  if (!STATUS_LINE.test(FRONTMATTER.exec(text)![1])) throw new Error('status line is not in the plain "status: pending" form; edit the file by hand');
  return { file, text, proposal };
}

/** `status: pending` -> `status: <next>` plus the lines after it; the body and every other line stay byte for byte. */
function resolvedText(text: string, file: string, status: 'adopted' | 'rejected', at: string, adoptedAs?: string): string {
  const fm = FRONTMATTER.exec(text)!;
  const extra = `resolved_at: ${at}${adoptedAs ? `\nadopted_as: ${adoptedAs}` : ''}`;
  const next = text.replace(fm[1], () => fm[1].replace(STATUS_LINE, `status: ${status}\n${extra}`));
  parseProposal(next, file); // what is written must read back
  return next;
}

async function replaceFile(file: string, next: string) {
  const tmp = `${file}.tmp-${process.pid}`;
  await fs.writeFile(tmp, next, { flag: 'wx' });
  await fs.rename(tmp, file);
}

/** Reject: the status line only. */
export async function rejectProposal(proposalsDir: string, id: string, at: string): Promise<Proposal> {
  DATE.parse(at);
  const { file, text } = await readPending(proposalsDir, id);
  const next = resolvedText(text, file, 'rejected', at);
  await replaceFile(file, next);
  return parseProposal(next, file);
}

/**
 * Adopt: one new ledger file (a new decision, exclusive create, decided by the person) and the proposal marked adopted.
 * Nothing else is touched. The proposal stays, with adopted_as pointing at the decision.
 */
export async function adoptProposal(proposalsDir: string, ledgerDir: string, id: string, at: string, decidedBy: string): Promise<{ proposal: Proposal; decision: Decision }> {
  assertOutsideLedger(proposalsDir, ledgerDir);
  DATE.parse(at);
  const { file, text, proposal } = await readPending(proposalsDir, id);
  const meta = decisionMetaSchema.parse(toDecisionMeta(proposal.meta, decidedBy, at));
  const next = resolvedText(text, file, 'adopted', at, meta.id); // checked before the ledger is touched
  let decision: Decision;
  try {
    decision = await createDecision(ledgerDir, { ...meta, body: proposal.body });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw Object.assign(new Error(`the ledger already has ${meta.id}`), { status: 409 });
    throw e;
  }
  await replaceFile(file, next);
  return { proposal: parseProposal(next, file), decision };
}
