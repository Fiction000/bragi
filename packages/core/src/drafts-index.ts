// drafts.index.yaml: articles that have no folder under the drafts root (their files sit elsewhere), registered by hand.
//
//   drafts:
//     - slug: sample-note-20261106
//       title: 週次ニュースレター改稿
//       medium: ニュースレター
//       dir: ..                      # where the files are, relative to this file (default: its folder)
//       files:                       # relative to dir; the reports in them decide the stage
//         - copy-review-report-sample-note-20261106.md
//       repo: owner/repo             # the same record as article.yaml: repo, branch, pr (numbers or URLs)
//       branch: content/sample-note-intro-20261106
//       pr: [114]
//       due: 2026-11-30              # optional
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { articleFieldsSchema } from './article.ts';

const safeRelative = (p: string) => p.length > 0 && !path.isAbsolute(p) && !p.split(/[\\/]/).includes('..');

export const indexEntrySchema = z
  .object({
    slug: z.string().regex(/^[A-Za-z0-9][\w.-]{0,80}$/, 'slug is letters, digits, - _ .'),
    title: z.string().min(1),
    medium: z.string().min(1).optional(),
    dir: z.string().min(1).default('.'),
    files: z.array(z.string().refine(safeRelative, 'files are relative to dir, without ..')).default([]),
    due: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  })
  .extend(articleFieldsSchema.shape)
  .strict();
export type IndexEntry = z.infer<typeof indexEntrySchema> & { dirAbs: string };

export const indexFileSchema = z.object({ drafts: z.array(indexEntrySchema) }).strict();

export async function loadDraftsIndex(file: string): Promise<IndexEntry[]> {
  const parsed = indexFileSchema.parse(parse(await fs.readFile(file, 'utf8')));
  const seen = new Set<string>();
  return parsed.drafts.map((e) => {
    if (seen.has(e.slug)) throw new Error(`duplicate slug in ${path.basename(file)}: ${e.slug}`);
    seen.add(e.slug);
    return { ...e, dirAbs: path.resolve(path.dirname(file), e.dir) };
  });
}
