// article.yaml: the record of where an article lives on GitHub. The step that makes the PR writes it; the list
// trusts it over any guess. Also the shape of the same fields in drafts.index.yaml.
//
//   repo: example-org/example-repo
//   branch: content/my-article-20261113
//   pr: [115, 116]            # numbers (with repo) or full PR URLs
//   medium: newsletter        # optional: the medium; used when no hand-registered entry or editor target names one
import { promises as fs } from 'node:fs';
import { parse } from 'yaml';
import { z } from 'zod';
import { prUrl, type PrRef } from './pr.ts';

export const repoSchema = z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'repo is owner/name');
export const prRefSchema = z.union([z.number().int().positive(), z.url()]);

export const articleFieldsSchema = z.object({
  repo: repoSchema.optional(),
  branch: z.string().min(1).optional(),
  pr: z.union([prRefSchema, z.array(prRefSchema)]).optional().transform((v) => (v === undefined ? [] : Array.isArray(v) ? v : [v])),
});
// `medium` lives only here: drafts.index.yaml has its own `medium` and spreads articleFieldsSchema into its entries.
export const articleYamlSchema = articleFieldsSchema.extend({ medium: z.string().trim().min(1).optional() }).strict();
export type ArticleRecord = { repo: string | null; branch: string | null; prs: PrRef[] };

/** Resolve numbers against repo, URLs against themselves. Anything that cannot be resolved is reported, not guessed. */
export function resolveRecord(fields: z.output<typeof articleFieldsSchema>): { record: ArticleRecord; problems: string[] } {
  const problems: string[] = [];
  const prs: PrRef[] = [];
  for (const ref of fields.pr) {
    if (typeof ref === 'number') {
      if (fields.repo) prs.push({ repo: fields.repo, number: ref });
      else problems.push(`PR #${ref} に repo がない`);
    } else {
      const m = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)\/?$/.exec(ref);
      if (m) prs.push({ repo: m[1], number: Number(m[2]) });
      else problems.push(`PR の URL を読めない: ${ref}`);
    }
  }
  return { record: { repo: fields.repo ?? null, branch: fields.branch ?? null, prs }, problems };
}

export const hasRecord = (r: ArticleRecord) => r.prs.length > 0 || r.branch !== null;

export async function readArticleYaml(file: string): Promise<{ record: ArticleRecord; medium: string | null; problems: string[] } | null> {
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch {
    return null;
  }
  try {
    const fields = articleYamlSchema.parse(parse(text) ?? {});
    return { ...resolveRecord(fields), medium: fields.medium ?? null };
  } catch (e) {
    return { record: { repo: null, branch: null, prs: [] }, medium: null, problems: [`article.yaml を読めなかった（無視して推測に戻る）: ${String((e as Error).message).split('\n')[0].slice(0, 140)}`] };
  }
}

export { prUrl };
