// Shapes the scanner produces and reads. Everything that crosses a boundary (the override file, the
// scan result handed to the HTTP layer) is checked with zod.
import { z } from 'zod';
import { DEFAULT_AUTHOR, DEFAULT_STAGE_LABELS } from './config.ts';

export const STAGES = ['writing', 'awaiting-decision', 'awaiting-confirm', 'awaiting-pr', 'pr-unknown', 'gate-ci', 'merge-ready', 'published'] as const;
export const stageSchema = z.enum(STAGES);
export type Stage = z.infer<typeof stageSchema>;

export const WAITING_ON = ['agent', 'author', 'ci', 'none'] as const;
export const waitingOnSchema = z.enum(WAITING_ON);
export type WaitingOn = z.infer<typeof waitingOnSchema>;

/** The stage names with the default author name. The scanner uses the configured ones (loadSettings().stageLabels). */
export const STAGE_LABEL: Record<Stage, string> = Object.fromEntries(Object.entries(DEFAULT_STAGE_LABELS).map(([k, v]) => [k, v.replaceAll('{author}', DEFAULT_AUTHOR)])) as Record<Stage, string>;
export const waitingLabels = (author: string): Record<WaitingOn, string> => ({ agent: 'エージェント', author, ci: 'CI', none: '—' });
/** Who the article waits on, for each stage. */
export const WAITING_FOR_STAGE: Record<Stage, WaitingOn> = {
  writing: 'agent',
  'awaiting-decision': 'author',
  'awaiting-confirm': 'author',
  'awaiting-pr': 'agent',
  'pr-unknown': 'agent',
  'gate-ci': 'ci',
  'merge-ready': 'author',
  published: 'none',
};

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

/** `status.override.json` in an article folder: the only hand-written state. */
export const overrideSchema = z
  .object({
    stage: stageSchema.optional(),
    waiting_on: waitingOnSchema.optional(),
    due: date.nullable().optional(),
    pr: z.url().nullable().optional(),
    note: z.string().optional(),
  })
  .strict();
export type Override = z.infer<typeof overrideSchema>;

export const ciSchema = z.object({ state: z.enum(['success', 'failure', 'pending', 'none']), total: z.number().int(), failing: z.array(z.string()), pending: z.number().int() });
export const gateSchema = z.object({
  verdict: z.enum(['MERGE_OK', 'NEEDS_AUTHOR', 'MANUAL_CHECK', 'BLOCKED']),
  headSha: z.string().nullable(),
  /** The verdict names an older head than the PR has now. */
  stale: z.boolean(),
  at: z.string(),
  url: z.string().nullable(),
});

export const prInfoSchema = z.object({
  url: z.url(),
  number: z.number().int(),
  state: z.enum(['open', 'merged', 'closed', 'unknown']),
  error: z.string().optional(),
  repo: z.string().optional(),
  title: z.string().optional(),
  isDraft: z.boolean().optional(),
  headSha: z.string().optional(),
  /** CI result of the head commit. */
  ci: ciSchema.nullable().optional(),
  /** The `pr_gate <VERDICT>` comment, if any. */
  gate: gateSchema.nullable().optional(),
  /** Review threads not yet resolved. */
  unresolvedReviews: z.number().int().nullable().optional(),
  /** How the PR was linked to the article: recorded (article.yaml, drafts.index.yaml), named in a report, or matched by branch name. Only "record" is not a guess. */
  via: z.enum(['record', 'report', 'branch']).optional(),
  branch: z.string().optional(),
});
export type PrInfo = z.infer<typeof prInfoSchema>;

export const editorRunSchema = z.object({
  /** Opaque, URL-safe id of the run folder, derived from its path under the root. Only scanned runs have one. */
  key: z.string().regex(/^[A-Za-z0-9_-]+$/),
  relPath: z.string(),
  targets: z.array(z.object({ id: z.string(), title: z.string(), medium: z.string().nullable(), finished: z.boolean(), placeholders: z.array(z.string()), agentRevision: z.boolean().optional(), verified: z.boolean().optional(), version: z.string().optional() })),
});
export type EditorRun = z.infer<typeof editorRunSchema>;

export const draftSchema = z.object({
  slug: z.string(),
  title: z.string(),
  medium: z.string().nullable(),
  path: z.string(),
  stage: stageSchema,
  stageLabel: z.string(),
  waitingOn: waitingOnSchema,
  /** Open questions in a needs_input report plus 〔<author>の…〕 placeholders left in the text. null: nothing to count from. */
  openDecisions: z.number().int().nullable(),
  /** The part of openDecisions that is placeholders left in the manuscript, by label. */
  placeholders: z.array(z.string()),
  due: date.nullable(),
  /** Where the due date came from: status.override.json, a TaskNote (its key), or a brief. */
  dueFrom: z.string().nullable(),
  /** folder: found by scanning; manual: registered in drafts.index.yaml. */
  source: z.enum(['folder', 'manual']),
  prs: z.array(prInfoSchema),
  editorRuns: z.array(editorRunSchema),
  overridden: z.boolean(),
  /** One line per step of the derivation, so a wrong stage can be traced. */
  reasons: z.array(z.string()),
  warnings: z.array(z.string()),
});
export type Draft = z.infer<typeof draftSchema>;

export const scanResultSchema = z.object({
  root: z.string(),
  /** What the person who decides is called (BRAGI_AUTHOR), for labels in the UI. */
  author: z.string(),
  scannedAt: z.string(),
  drafts: z.array(draftSchema),
  /** Files directly under the root: not articles, so not listed. */
  skippedFiles: z.array(z.string()),
  /** Problems with the scan itself (an index file or a PR list that could not be read). The list still shows. */
  warnings: z.array(z.string()),
  /** Did this scan read PR state from GitHub? off: GitHub was not asked. failed: it was asked and could not answer. ok: it answered (or there was nothing to look up). */
  github: z.enum(['off', 'ok', 'failed']),
});
export type ScanResult = z.infer<typeof scanResultSchema>;
