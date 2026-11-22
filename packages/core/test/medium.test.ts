import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { readArticleYaml, scanDrafts } from '../src/index.ts';

const run = promisify(execFile);

/** A drafts root with one article folder per case. All names are invented. */
async function root(articles: Record<string, Record<string, string>>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wle-medium-'));
  const drafts = path.join(dir, 'drafts');
  for (const [slug, files] of Object.entries(articles)) {
    for (const [name, text] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(drafts, slug, name)), { recursive: true });
      await writeFile(path.join(drafts, slug, name), text);
    }
  }
  return { dir, drafts };
}
const mediumOf = async (drafts: string, slug: string) => (await scanDrafts(drafts, { github: null })).drafts.find((d) => d.slug === slug);
const report = (line: string) => `status: needs_edit\n${line}\n`;
const targets = (medium: string) => JSON.stringify({ targets: [{ id: 'main', title: 't', medium, version: 'v1', source: 'a.md' }] });

test('medium: article.yaml `medium` gives the medium when nothing else does', async () => {
  const { dir, drafts } = await root({ 'sample-a-20260101': { 'article.yaml': 'medium: ニュースレター\n' } });
  try {
    const d = await mediumOf(drafts, 'sample-a-20260101');
    assert.equal(d?.medium, 'ニュースレター');
    assert.deepEqual(d?.warnings, []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('medium: article.yaml with repo/branch/pr and a medium keeps the record', async () => {
  const { dir, drafts } = await root({ 'sample-b-20260101': { 'article.yaml': 'repo: example/site\nbranch: content/sample-b\npr: [7]\nmedium: 解説記事\n' } });
  try {
    const d = await mediumOf(drafts, 'sample-b-20260101');
    assert.equal(d?.medium, '解説記事');
    assert.deepEqual(d?.prs.map((p) => [p.repo, p.number, p.via]), [['example/site', 7, 'record']]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('medium: priority is editor-targets, then article.yaml, then the report line', async () => {
  const { dir, drafts } = await root({
    'all-three-20260101': { 'article.yaml': 'medium: 媒体B\n', 'copy-review-report-x.md': report('媒体: 媒体C'), 'editor-targets.json': targets('媒体A'), 'a.md': 'x\n' },
    'yaml-and-report-20260101': { 'article.yaml': 'medium: 媒体B\n', 'copy-review-report-x.md': report('媒体: 媒体C') },
    'report-only-20260101': { 'copy-review-report-x.md': report('媒体: 媒体C') },
  });
  try {
    assert.equal((await mediumOf(drafts, 'all-three-20260101'))?.medium, '媒体A');
    assert.equal((await mediumOf(drafts, 'yaml-and-report-20260101'))?.medium, '媒体B');
    assert.equal((await mediumOf(drafts, 'report-only-20260101'))?.medium, '媒体C');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('medium: a hand-registered drafts.index.yaml medium is not overridden by an article.yaml in its folder', async () => {
  const { dir, drafts } = await root({ 'indexed-20260101': { 'article.yaml': 'medium: 媒体B\n' } });
  try {
    const indexFile = path.join(dir, 'hand.index.yaml');
    await writeFile(indexFile, 'drafts:\n  - slug: manual-20260101\n    title: 手で登録\n    medium: 媒体M\n    dir: drafts/indexed-20260101\n');
    const result = await scanDrafts(drafts, { github: null, indexFile });
    assert.equal(result.drafts.find((d) => d.slug === 'manual-20260101')?.medium, '媒体M');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('medium: an article.yaml without `medium` reads as before, and the report line still applies', async () => {
  const { dir, drafts } = await root({ 'old-20260101': { 'article.yaml': 'repo: example/site\nbranch: content/old\npr: 3\n', 'copy-review-report-x.md': report('媒体: 媒体C') } });
  try {
    const d = await mediumOf(drafts, 'old-20260101');
    assert.equal(d?.medium, '媒体C');
    assert.deepEqual(d?.prs.map((p) => p.number), [3]);
    assert.doesNotMatch(d?.warnings.join() ?? '', /article\.yaml/);
    const a = await readArticleYaml(path.join(drafts, 'old-20260101', 'article.yaml'));
    assert.deepEqual(a?.problems, []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('medium: an empty or non-string `medium` is reported and the article falls back to the report line', async () => {
  const { dir, drafts } = await root({
    'empty-20260101': { 'article.yaml': 'medium: ""\n', 'copy-review-report-x.md': report('媒体: 媒体C') },
    'number-20260101': { 'article.yaml': 'medium: 5\n' },
  });
  try {
    const e = await mediumOf(drafts, 'empty-20260101');
    assert.equal(e?.medium, '媒体C');
    assert.match(e?.warnings.join() ?? '', /article\.yaml を読めなかった/);
    const n = await mediumOf(drafts, 'number-20260101');
    assert.equal(n?.medium, null);
    assert.match(n?.warnings.join() ?? '', /article\.yaml を読めなかった/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('bragi context: an unknown medium prints one warning on stderr and leaves stdout as it was; a known one prints none', async () => {
  const { dir, drafts } = await root({
    'unknown-20260101': { 'article.yaml': 'repo: example/site\n' },
    'known-20260101': { 'article.yaml': 'medium: ニュースレター\n' },
  });
  try {
    const args = ['--drafts-root', drafts, '--ledger', path.join(dir, 'ledger'), '--tasknotes', path.join(dir, 'none')];
    const unknown = await run('node', ['src/bragi.ts', 'context', 'unknown-20260101', ...args]);
    assert.match(unknown.stdout, /^# 判断台帳：unknown-20260101 に効く判断\n\n媒体: （不明）/);
    assert.equal(unknown.stderr, 'bragi: medium is unknown for unknown-20260101: add `medium:` to article.yaml\n');
    const known = await run('node', ['src/bragi.ts', 'context', 'known-20260101', ...args]);
    assert.match(known.stdout, /媒体: ニュースレター/);
    assert.equal(known.stderr, '');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
