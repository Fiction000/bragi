// What `bragi list` prints. Display only: nothing here reads or writes a file.
//
// A stage that leans on a PR (the PR is assumed open, or none was found because nobody looked) is a guess when GitHub was not
// read, so the row says so instead of showing the guessed stage and who it waits on:
//   GitHub was not asked (no --github) -> GitHub未照合
//   GitHub was asked and failed        -> 照合失敗
// Rows that do not depend on a PR (執筆中, 判断待ち, a hand-set stage in status.override.json, ...) are printed as before.
// With --github that worked, every row is printed as before.
import type { Draft, ScanResult } from './schema.ts';

export const UNVERIFIED_LABEL = 'GitHub未照合';
export const FAILED_LABEL = '照合失敗';

const dependsOnGithub = (d: Draft): boolean => !d.overridden && (d.stage === 'pr-unknown' || d.prs.some((p) => p.state === 'unknown'));

export function renderListLines(scan: Pick<ScanResult, 'drafts' | 'github' | 'warnings'>): { lines: string[]; notes: string[] } {
  const label = scan.github === 'off' ? UNVERIFIED_LABEL : scan.github === 'failed' ? FAILED_LABEL : null;
  const lines = scan.drafts.map((d) => {
    const unverified = label !== null && dependsOnGithub(d);
    return [d.slug, d.medium ?? '-', unverified ? label : d.stageLabel, unverified ? '-' : d.waitingOn, d.due ?? '-'].join('\t');
  });
  return { lines, notes: scan.github === 'failed' ? scan.warnings.filter((w) => w.startsWith('GitHub から')) : [] };
}
