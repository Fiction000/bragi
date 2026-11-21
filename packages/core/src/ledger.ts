// The decision ledger: one decision = one Markdown file with YAML frontmatter, in one folder.
// Only a person makes a decision a rule; this module reads and writes the files, it never decides.
// Writes are narrow on purpose: create refuses to overwrite, retire edits the status line and nothing else,
// so the Git diff of either is one file and, for a retirement, two lines.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parse, stringify } from 'yaml';
import { z } from 'zod';

export const SCOPES = ['draft', 'medium', 'global'] as const;
export const KINDS = ['fact', 'phrasing', 'structure', 'fact-policy', 'tag-policy'] as const;
export const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
export const ID = /^D-\d{4}-\d{2}-\d{2}-[a-z0-9][a-z0-9-]{0,80}$/;

export const checkSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }).strict(),
  z.object({ type: z.literal('regex'), pattern: z.string().min(1), message: z.string().optional() }).strict(),
]);

export const decisionMetaSchema = z
  .object({
    id: z.string().regex(ID, 'id is D-YYYY-MM-DD-<slug>'),
    scope: z.enum(SCOPES),
    medium: z.string().min(1).nullable().default(null),
    draft: z.string().min(1).nullable().default(null),
    kind: z.enum(KINDS),
    status: z.enum(['active', 'retired']),
    decided_by: z.string().min(1),
    decided_at: DATE,
    source: z.string().min(1),
    check: checkSchema.default({ type: 'none' }),
    retired_at: DATE.optional(),
  })
  .strict()
  .superRefine((d, ctx) => {
    if (d.scope === 'medium' && !d.medium) ctx.addIssue({ code: 'custom', path: ['medium'], message: 'scope=medium needs medium' });
    if (d.scope === 'draft' && !d.draft) ctx.addIssue({ code: 'custom', path: ['draft'], message: 'scope=draft needs draft (the run slug)' });
    if (d.scope !== 'medium' && d.medium) ctx.addIssue({ code: 'custom', path: ['medium'], message: 'medium only goes with scope=medium' });
    if (d.scope !== 'draft' && d.draft) ctx.addIssue({ code: 'custom', path: ['draft'], message: 'draft only goes with scope=draft' });
    if (d.status === 'retired' && !d.retired_at) ctx.addIssue({ code: 'custom', path: ['retired_at'], message: 'a retired decision needs retired_at' });
  });

/**
 * A note-taking vault may put its own metadata on every note and refuse to let it be removed, so a ledger file carries it too.
 * These keys are accepted and ignored (never written back, never part of a decision). The decision's own keys stay strict:
 * any other unknown key is still an error.
 */
export const VAULT_KEYS = ['tags', 'created', 'updated', 'agent_generated', 'aliases', 'owner', 'sources', 'project'] as const;
const STRINGS = z.union([z.string(), z.array(z.string())]);
export const vaultMetaSchema = z.object({
  tags: STRINGS.nullable().optional(),
  created: z.union([z.string(), z.date()]).optional(),
  updated: z.union([z.string(), z.date()]).optional(),
  agent_generated: z.boolean().optional(),
  aliases: STRINGS.nullable().optional(),
  owner: z.string().optional(),
  sources: STRINGS.nullable().optional(),
  project: z.string().optional(),
});

export const decisionSchema = z.object({ meta: decisionMetaSchema, body: z.string().min(1, 'the decision text is empty') });
export type Decision = z.output<typeof decisionSchema> & { file: string };
export type DecisionInput = z.input<typeof decisionMetaSchema> & { body: string };

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export function parseDecision(text: string, file: string): Decision {
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
  const parsed = decisionSchema.parse({ meta, body: m[2].trim() });
  if (path.basename(file) !== `${parsed.meta.id}.md`) throw new Error(`file name must be ${parsed.meta.id}.md`);
  return { ...parsed, file };
}

/** Field order is fixed so a new file reads the same as the ones in the design note. */
export function serializeDecision(input: DecisionInput): string {
  const { body: _body, ...fields } = input;
  const meta = decisionMetaSchema.parse(fields);
  const ordered = {
    id: meta.id, scope: meta.scope, medium: meta.medium, draft: meta.draft, kind: meta.kind, status: meta.status,
    decided_by: meta.decided_by, decided_at: meta.decided_at, source: meta.source, check: meta.check,
    ...(meta.retired_at ? { retired_at: meta.retired_at } : {}),
  };
  const body = z.string().trim().min(1, 'the decision text is empty').parse(input.body);
  return `---\n${stringify(ordered, { lineWidth: 0 }).trimEnd()}\n---\n\n${body}\n`;
}

/** One line that says why a file was refused: for a zod error, `key: reason` per issue (unknown keys are named). */
export function summarizeError(e: unknown): string {
  const issues = (e as { issues?: { path: PropertyKey[]; message: string; code: string; keys?: string[] }[] }).issues;
  const text = Array.isArray(issues) && issues.length > 0
    ? [...issues].sort((a, b) => Number(b.code === 'unrecognized_keys') - Number(a.code === 'unrecognized_keys')).map((i) => {
        const where = i.path.filter((k) => k !== 'meta').map(String).join('.');
        let what = i.message;
        if (i.code === 'unrecognized_keys' && i.keys) what = `unknown key ${i.keys.join(', ')}`;
        else if (i.code === 'invalid_value') what = 'invalid value';
        else if (/received undefined/.test(what)) what = 'required';
        return where ? `${where}: ${what}` : what;
      }).join('; ')
    : String((e as Error).message);
  return text.split('\n')[0].slice(0, 200);
}

export type LedgerRead = { decisions: Decision[]; problems: { file: string; message: string }[] };

/** Every *.md in the folder. A file that does not parse is reported, never fatal. A missing folder is an empty ledger. */
export async function loadLedger(dir: string): Promise<LedgerRead> {
  let names: string[];
  try {
    names = (await fs.readdir(dir)).filter((n) => n.endsWith('.md') && !n.startsWith('.')).sort();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { decisions: [], problems: [] };
    throw e;
  }
  const decisions: Decision[] = [];
  const problems: LedgerRead['problems'] = [];
  for (const name of names) {
    try {
      decisions.push(parseDecision(await fs.readFile(path.join(dir, name), 'utf8'), path.join(dir, name)));
    } catch (e) {
      problems.push({ file: name, message: summarizeError(e) });
    }
  }
  decisions.sort((a, b) => a.meta.decided_at.localeCompare(b.meta.decided_at) || a.meta.id.localeCompare(b.meta.id));
  return { decisions, problems };
}

/** Writes <id>.md. Never overwrites: an id that exists is an error. The folder is created if needed. */
export async function createDecision(dir: string, input: DecisionInput): Promise<Decision> {
  const text = serializeDecision(input);
  const file = path.join(dir, `${decisionMetaSchema.shape.id.parse(input.id)}.md`);
  const decision = parseDecision(text, file);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(file, text, { flag: 'wx' });
  return decision;
}

const STATUS_LINE = /^status: active[ \t]*$/m;

/** Retire = `status: active` -> `status: retired` plus a `retired_at` line under it. The body and every other line stay byte for byte. */
export async function retireDecision(dir: string, id: string, at: string): Promise<Decision> {
  if (!ID.test(id)) throw Object.assign(new Error('bad decision id'), { status: 400 });
  DATE.parse(at);
  const file = path.join(dir, `${id}.md`);
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch {
    throw Object.assign(new Error('decision not found'), { status: 404 });
  }
  const current = parseDecision(text, file);
  if (current.meta.status === 'retired') throw Object.assign(new Error('already retired'), { status: 409 });
  const fm = FRONTMATTER.exec(text)!;
  if (!STATUS_LINE.test(fm[1])) throw new Error('status line is not in the plain "status: active" form; edit the file by hand');
  const frontmatter = fm[1].replace(STATUS_LINE, `status: retired\nretired_at: ${at}`);
  const next = text.replace(fm[1], () => frontmatter);
  parseDecision(next, file); // what is written must read back
  const tmp = `${file}.tmp-${process.pid}`;
  await fs.writeFile(tmp, next, { flag: 'wx' });
  await fs.rename(tmp, file);
  return parseDecision(next, file);
}
