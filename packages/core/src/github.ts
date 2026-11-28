// GitHub, read only: one `gh api graphql` call for every PR the articles need. It uses the login `gh` already has;
// no token is created or stored here. A failure never stops the scan: the caller shows the PRs as state unknown.
import { execFile } from 'node:child_process';
import { prInfoSchema, type PrInfo } from './schema.ts';

const REPO = /^([\w.-]+)\/([\w.-]+)$/;
const LIST_SIZE = 50;

export type CiState = 'success' | 'failure' | 'pending' | 'none';
export type Ci = { state: CiState; total: number; failing: string[]; pending: number };
export type GateVerdict = 'MERGE_OK' | 'NEEDS_AUTHOR' | 'MANUAL_CHECK' | 'BLOCKED';
export type Gate = { verdict: GateVerdict; headSha: string | null; stale: boolean; at: string; url: string | null };

/** What the GraphQL query returns for one PR, before it is reduced to a PrInfo. */
export type RawPr = {
  number: number;
  title: string;
  url: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  isDraft: boolean;
  headRefName: string;
  headRefOid: string;
  commits?: { nodes: { commit: { oid: string; statusCheckRollup: { state: string; contexts?: { nodes: RawContext[] } } | null } }[] };
  comments?: { nodes: { body: string; createdAt: string; url?: string }[] };
  reviewThreads?: { nodes: { isResolved: boolean }[] };
};
type RawContext = { __typename: 'CheckRun'; name: string; status: string; conclusion: string | null } | { __typename: 'StatusContext'; context: string; state: string };

const PR_FIELDS = `fragment PrF on PullRequest {
  number title url state isDraft headRefName headRefOid
  commits(last:1){ nodes { commit { oid statusCheckRollup { state contexts(first:100){ nodes { __typename ... on CheckRun { name status conclusion } ... on StatusContext { context state } } } } } } }
  comments(last:30){ nodes { body createdAt url } }
  reviewThreads(first:100){ nodes { isResolved } }
}`;

/** repo -> PR numbers wanted in addition to the newest LIST_SIZE PRs (those are listed for branch-name matching). */
export type PrRequest = Record<string, number[]>;

export function buildQuery(request: PrRequest): string {
  const repos = Object.entries(request);
  const parts = repos.map(([repo, numbers], i) => {
    const m = REPO.exec(repo);
    if (!m) throw new Error(`bad repository name: ${repo}`);
    const wanted = [...new Set(numbers)].filter((n) => Number.isInteger(n) && n > 0).sort((a, b) => a - b);
    return `  r${i}: repository(owner: ${JSON.stringify(m[1])}, name: ${JSON.stringify(m[2])}) {
    list: pullRequests(first: ${LIST_SIZE}, orderBy: {field: CREATED_AT, direction: DESC}) { nodes { ...PrF } }
${wanted.map((n) => `    n${n}: pullRequest(number: ${n}) { ...PrF }`).join('\n')}
  }`;
  });
  return `query {\n${parts.join('\n')}\n}\n${PR_FIELDS}\n`;
}

// ---- reducing a raw PR --------------------------------------------------------------------------------

export function ciOf(raw: RawPr): Ci {
  const rollup = raw.commits?.nodes?.[0]?.commit.statusCheckRollup ?? null;
  if (!rollup) return { state: 'none', total: 0, failing: [], pending: 0 };
  const contexts = rollup.contexts?.nodes ?? [];
  const failing: string[] = [];
  let pending = 0;
  for (const c of contexts) {
    if (c.__typename === 'CheckRun') {
      if (c.status !== 'COMPLETED') pending++;
      else if (!['SUCCESS', 'SKIPPED', 'NEUTRAL'].includes(c.conclusion ?? '')) failing.push(c.name);
    } else if (c.state === 'PENDING' || c.state === 'EXPECTED') pending++;
    else if (c.state !== 'SUCCESS') failing.push(c.context);
  }
  const state: CiState = failing.length > 0 || ['FAILURE', 'ERROR'].includes(rollup.state) ? 'failure' : pending > 0 || ['PENDING', 'EXPECTED'].includes(rollup.state) ? 'pending' : 'success';
  return { state, total: contexts.length, failing, pending };
}

// Two shapes: what `pr_gate.py --post` writes (format_comment): "### 自動レビューゲート: <VERDICT>" then "head `<first 10 of sha>` / CI: <state>";
// and the hand-written "pr_gate <VERDICT> ..., head <sha>" the team also leaves.
const GATE = /(?:自動レビューゲート\s*[:：]\s*|\bpr_gate\s+)(MERGE_OK|NEEDS_[A-Z]+|MANUAL_CHECK|BLOCKED)\b/;
/** Any `NEEDS_<WHO>` verdict means a person has to look; it is reported as NEEDS_AUTHOR whatever name the gate script uses. */
const verdictOf = (word: string): GateVerdict => (word.startsWith('NEEDS_') ? 'NEEDS_AUTHOR' : (word as GateVerdict));
const HEAD_SHA = /\bhead\s+`?([0-9a-f]{7,40})\b/i;

/** The newest comment that carries a gate verdict. The head it names may be a prefix (10 characters); stale: it names a head that is not the PR's current one. */
export function gateOf(raw: RawPr): Gate | null {
  const comments = [...(raw.comments?.nodes ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  for (const c of comments) {
    const m = GATE.exec(c.body);
    if (!m) continue;
    const sha = HEAD_SHA.exec(c.body)?.[1]?.toLowerCase() ?? null;
    const head = raw.headRefOid.toLowerCase();
    return { verdict: verdictOf(m[1]), headSha: sha, stale: sha !== null && !head.startsWith(sha) && !sha.startsWith(head), at: c.createdAt, url: c.url ?? null };
  }
  return null;
}

export const unresolvedReviews = (raw: RawPr): number | null => (raw.reviewThreads ? raw.reviewThreads.nodes.filter((t) => !t.isResolved).length : null);

export function prInfoOf(repo: string, raw: RawPr): PrInfo {
  return prInfoSchema.parse({
    url: raw.url,
    number: raw.number,
    state: raw.state.toLowerCase(),
    repo,
    title: raw.title,
    isDraft: raw.isDraft,
    branch: raw.headRefName,
    headSha: raw.headRefOid,
    ci: ciOf(raw),
    gate: gateOf(raw),
    unresolvedReviews: unresolvedReviews(raw),
  });
}

// ---- the client --------------------------------------------------------------------------------------

/** repo -> the PRs found: the newest ones plus every number asked for. */
export type GithubResult = Record<string, PrInfo[]>;
export type GithubClient = (request: PrRequest) => Promise<GithubResult>;

export function parseResponse(request: PrRequest, data: unknown): GithubResult {
  const out: GithubResult = {};
  const root = (data ?? {}) as Record<string, Record<string, unknown> | null>;
  Object.keys(request).forEach((repo, i) => {
    const node = root[`r${i}`];
    if (!node) return;
    const byNumber = new Map<number, PrInfo>();
    const add = (raw: unknown) => {
      if (raw && typeof raw === 'object') {
        try {
          const info = prInfoOf(repo, raw as RawPr);
          byNumber.set(info.number, info);
        } catch { /* a PR that does not parse is left out; the caller marks the number unknown */ }
      }
    };
    for (const raw of (node.list as { nodes?: unknown[] } | undefined)?.nodes ?? []) add(raw);
    for (const [key, raw] of Object.entries(node)) if (/^n\d+$/.test(key)) add(raw);
    out[repo] = [...byNumber.values()];
  });
  return out;
}

export function createStaleWhileRevalidate(fetchGithub: GithubClient, ttlMs: number): GithubClient {
  const cache = new Map<string, { at: number; result: GithubResult }>();
  const inFlight = new Map<string, Promise<GithubResult>>();
  const retryAfter = new Map<string, number>();
  return (request) => {
    const key = buildQuery(request);
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return Promise.resolve(hit.result);

    const refresh = () => {
      const current = inFlight.get(key);
      if (current) return current;
      const pending = fetchGithub(request).then((result) => {
        cache.set(key, { at: Date.now(), result });
        retryAfter.delete(key);
        return result;
      }).finally(() => inFlight.delete(key));
      inFlight.set(key, pending);
      return pending;
    };

    if (hit) {
      if ((retryAfter.get(key) ?? 0) > Date.now()) return Promise.resolve(hit.result);
      void refresh().catch(() => { retryAfter.set(key, Date.now() + 30_000); });
      return Promise.resolve(hit.result);
    }
    return refresh();
  };
}

/** `gh api graphql`, one call for all repositories, cached for ttlMs. Throws on failure with a short message. */
export function createGhGraphql({ ttlMs = 60_000, timeoutMs = 25_000 }: { ttlMs?: number; timeoutMs?: number } = {}): GithubClient {
  const fetchGithub: GithubClient = (request) => new Promise((resolve, reject) => {
    const query = buildQuery(request);
    execFile('gh', ['api', 'graphql', '-f', `query=${query}`], { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      let body: { data?: unknown; errors?: { message: string }[] } | null = null;
      try { body = JSON.parse(stdout); } catch { /* not JSON */ }
      if (!body?.data) return reject(new Error(String(body?.errors?.[0]?.message ?? stderr ?? error?.message ?? 'no data').split('\n')[0].slice(0, 160)));
      resolve(parseResponse(request, body.data));
    });
  });
  return createStaleWhileRevalidate(fetchGithub, ttlMs);
}
