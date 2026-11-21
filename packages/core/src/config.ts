// Where things live and what they are called. Nothing in the repository names a person, a vault or a subject:
// everything that differs between installations is read here, from the environment or from one JSON file.
//
// Precedence (highest first): a command-line flag or an option passed in -> environment -> the JSON file -> the default.
//
//   BRAGI_CONFIG       path of a JSON file with the same keys as below (optional)
//   BRAGI_VAULT        the folder everything is under (relative paths below are resolved against it)
//   BRAGI_DRAFTS       articles folder                    default: drafts
//   BRAGI_LEDGER       decision ledger folder             default: ledger
//   BRAGI_PROPOSALS    proposed-decisions folder          default: proposals
//   BRAGI_TASKNOTES    task notes folder (due dates)      default: none
//   BRAGI_TIMEZONE     IANA time zone for the dates written into files (default: the machine's)
//   BRAGI_AUTHOR       what the person who decides is called in labels and in `decided_by`   default: 著者
//   BRAGI_TASK_IDS     task id patterns an article may mention, regex sources separated by "|||"   default: none
// The file may also hold "stageLabels": { "<stage>": "<label>" }; "{author}" in a label is replaced by the author name.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

export const DEFAULT_AUTHOR = '著者';
const DEFAULT_RELATIVE = { drafts: 'drafts', ledger: 'ledger', proposals: 'proposals' } as const;

const STAGE_KEYS = ['writing', 'awaiting-decision', 'awaiting-confirm', 'awaiting-pr', 'pr-unknown', 'gate-ci', 'merge-ready', 'published'] as const;

export const DEFAULT_STAGE_LABELS: Record<(typeof STAGE_KEYS)[number], string> = {
  writing: '執筆中',
  'awaiting-decision': '{author}判断待ち',
  'awaiting-confirm': '{author}確定待ち',
  'awaiting-pr': 'PR待ち',
  'pr-unknown': 'PR不明',
  'gate-ci': 'ゲート/CI',
  'merge-ready': 'マージ待ち',
  published: '公開済み',
};

const fileSchema = z
  .object({
    vault: z.string().min(1),
    drafts: z.string().min(1),
    ledger: z.string().min(1),
    proposals: z.string().min(1),
    taskNotes: z.string().min(1).nullable(),
    author: z.string().min(1),
    taskIds: z.array(z.string().min(1)),
    stageLabels: z.partialRecord(z.enum(STAGE_KEYS), z.string().min(1)),
  })
  .partial()
  .strict();

export class ConfigError extends Error {}

export type Settings = {
  vault: string | null;
  /** Absolute paths, or null when neither an absolute path nor a vault was given. */
  draftsRoot: string | null;
  ledgerDir: string | null;
  proposalsDir: string | null;
  taskNotesDir: string | null;
  /** The folder name proposals live in, used to put them next to an explicitly given ledger folder. */
  proposalsName: string;
  author: string;
  taskIdPatterns: RegExp[];
  stageLabels: Record<(typeof STAGE_KEYS)[number], string>;
};

function readFile(file: string | undefined): z.infer<typeof fileSchema> {
  if (!file) return {};
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (e) {
    throw new ConfigError(`BRAGI_CONFIG ${file} cannot be read: ${(e as Error).message}`);
  }
  const parsed = fileSchema.safeParse((() => { try { return JSON.parse(raw); } catch (e) { throw new ConfigError(`BRAGI_CONFIG ${file} is not JSON: ${(e as Error).message}`); } })());
  if (!parsed.success) throw new ConfigError(`BRAGI_CONFIG ${file}: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'} ${i.message}`).join('; ')}`);
  return parsed.data;
}

const abs = (vault: string | null, p: string): string | null => (path.isAbsolute(p) ? path.normalize(p) : vault ? path.join(vault, p) : null);

export function loadSettings(env: Record<string, string | undefined> = process.env): Settings {
  const file = readFile(env.BRAGI_CONFIG);
  const pick = <K extends keyof typeof file>(envName: string, key: K): (typeof file)[K] | string | undefined => env[envName] || file[key];
  const vaultRaw = (pick('BRAGI_VAULT', 'vault') as string | undefined) ?? null;
  const vault = vaultRaw ? path.resolve(vaultRaw) : null;
  const drafts = (pick('BRAGI_DRAFTS', 'drafts') as string | undefined) ?? DEFAULT_RELATIVE.drafts;
  const ledger = (pick('BRAGI_LEDGER', 'ledger') as string | undefined) ?? DEFAULT_RELATIVE.ledger;
  const proposals = (pick('BRAGI_PROPOSALS', 'proposals') as string | undefined) ?? DEFAULT_RELATIVE.proposals;
  const taskNotes = (env.BRAGI_TASKNOTES || file.taskNotes) ?? null;
  const author = (pick('BRAGI_AUTHOR', 'author') as string | undefined) ?? DEFAULT_AUTHOR;
  const idSources = env.BRAGI_TASK_IDS ? env.BRAGI_TASK_IDS.split('|||').filter(Boolean) : (file.taskIds ?? []);
  let taskIdPatterns: RegExp[];
  try {
    taskIdPatterns = idSources.map((s) => new RegExp(s, 'g'));
  } catch (e) {
    throw new ConfigError(`task id pattern is not a regular expression: ${(e as Error).message}`);
  }
  const stageLabels = Object.fromEntries(STAGE_KEYS.map((k) => [k, (file.stageLabels?.[k] ?? DEFAULT_STAGE_LABELS[k]).replaceAll('{author}', author)])) as Settings['stageLabels'];
  return {
    vault,
    draftsRoot: abs(vault, drafts),
    ledgerDir: abs(vault, ledger),
    proposalsDir: abs(vault, proposals),
    taskNotesDir: taskNotes ? abs(vault, taskNotes) : null,
    proposalsName: path.basename(proposals),
    author,
    taskIdPatterns,
    stageLabels,
  };
}

const need = (value: string | null, what: string, flag: string, envName: string): string => {
  if (value) return value;
  throw new ConfigError(`${what} is not configured. Pass ${flag}, or set ${envName}, or set BRAGI_VAULT (or BRAGI_CONFIG) so the default relative path can be resolved.`);
};

export const defaultDraftsRoot = () => need(loadSettings().draftsRoot, 'the drafts folder', '--drafts-root', 'BRAGI_DRAFTS');
export const defaultLedgerDir = () => need(loadSettings().ledgerDir, 'the ledger folder', '--ledger', 'BRAGI_LEDGER');
export const defaultProposalsDir = () => need(loadSettings().proposalsDir, 'the proposals folder', '--proposals', 'BRAGI_PROPOSALS');
/** null: no task notes folder is configured (due dates then come only from the other sources). */
export const defaultTaskNotesDir = (): string | null => loadSettings().taskNotesDir;

/** Today as YYYY-MM-DD in BRAGI_TIMEZONE (an IANA name), or in the machine's own time zone when it is not set. */
export const today = (env: Record<string, string | undefined> = process.env): string => new Intl.DateTimeFormat('sv-SE', { timeZone: env.BRAGI_TIMEZONE || undefined }).format(new Date());
