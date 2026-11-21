// Finding which PRs belong to an article. The record (article.yaml / drafts.index.yaml) is the source;
// the functions here are the fallback for articles without one, and every result of them is a guess.
import type { PrInfo } from './schema.ts';

const PR_URL = /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/g;
const PR_NUMBER = /\bPR\s*#(\d+)\b/g;
export const MAX_PR_CANDIDATES = 8;

export type PrRef = { repo: string; number: number };

/**
 * PRs named in the texts, plus bare "PR #118" mentions when all URLs point at one repository
 * (an article lives in one repo). Most mentioned first, capped.
 */
export function prCandidates(texts: string[]): PrRef[] {
  const counts = new Map<string, { ref: PrRef; n: number }>();
  const bump = (repo: string, number: number) => {
    const key = `${repo}#${number}`;
    const hit = counts.get(key);
    if (hit) hit.n++;
    else counts.set(key, { ref: { repo, number }, n: 1 });
  };
  const repos = new Set<string>();
  for (const text of texts) for (const m of text.matchAll(PR_URL)) { repos.add(m[1]); bump(m[1], Number(m[2])); }
  if (repos.size === 1) {
    const [repo] = [...repos];
    for (const text of texts) for (const m of text.matchAll(PR_NUMBER)) bump(repo, Number(m[1]));
  }
  return [...counts.values()].sort((a, b) => b.n - a.n || a.ref.repo.localeCompare(b.ref.repo) || a.ref.number - b.ref.number).slice(0, MAX_PR_CANDIDATES).map((c) => c.ref);
}

export const prUrl = (ref: PrRef) => `https://github.com/${ref.repo}/pull/${ref.number}`;
export const repoOf = (url: string) => /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\//.exec(url)?.[1] ?? null;

/** `my-article-20261113` -> `my-article`. The folder name without its trailing date. */
export const slugBase = (slug: string) => slug.toLowerCase().replace(/[-_]?\d{6,8}$/, '');

/**
 * PRs whose head branch equals `branch` (when the article records it), or, as a guess, contains the article's name.
 * A name shorter than 4 characters matches nothing. Each result carries via: "record" or "branch".
 */
export function matchPrsByBranch(slug: string, items: PrInfo[], branch?: string | null): PrInfo[] {
  const base = slugBase(slug);
  if (branch) return items.filter((p) => p.branch === branch).map((p) => ({ ...p, via: 'record' as const }));
  return base.length >= 4 ? items.filter((p) => p.branch?.toLowerCase().includes(base)).map((p) => ({ ...p, via: 'branch' as const })) : [];
}

export function unknownPr(ref: PrRef, error: string): PrInfo {
  return { url: prUrl(ref), number: ref.number, state: 'unknown', repo: ref.repo, error: error.slice(0, 160) };
}
