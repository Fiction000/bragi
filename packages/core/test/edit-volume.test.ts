import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { countChars, getEditVolume, measureRun, measureText, renderEditVolume, splitSentences, stripFrontMatter } from '../src/edit-volume.ts';

const exec = promisify(execFile);
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

// ---- builders (all names are made up) -------------------------------------------------------------------

type RunOpts = { id?: string; source?: string; final?: string | null; finished?: boolean | Record<string, unknown> | 'garbage'; sourceField?: string; writeSource?: boolean };
/** A run folder: editor-targets.json, the source file, and (optionally) the editor's nat-final.md + finished.json. */
async function makeRun(dir: string, o: RunOpts = {}) {
  const id = o.id ?? 'sample-post', source = o.source ?? '一つ目です。二つ目です。', sourceField = o.sourceField ?? '05_final/sample-post.md';
  await mkdir(path.join(dir, '05_final', 'editor', id), { recursive: true });
  await writeFile(path.join(dir, 'editor-targets.json'), JSON.stringify({ targets: [{ id, title: `Title ${id}`, medium: 'sns', version: 'v1', source: sourceField }] }));
  if (o.writeSource !== false) await writeFile(path.join(dir, '05_final', 'sample-post.md'), source);
  const final = o.final === undefined ? source : o.final;
  const ed = path.join(dir, '05_final', 'editor', id);
  if (final !== null) await writeFile(path.join(ed, 'nat-final.md'), final);
  if (o.finished === 'garbage') await writeFile(path.join(ed, 'finished.json'), '{not json');
  else if (o.finished !== false) await writeFile(path.join(ed, 'finished.json'), JSON.stringify({ id, finishedAt: '2026-01-02T03:04:05.000Z', sourceSha256: sha(source), finalSha256: sha(final ?? ''), changedBlocks: 1, notes: 0, unchanged: false, ...(typeof o.finished === 'object' ? o.finished : {}) }));
}
const tmp = () => mkdtemp(path.join(process.env.TMPDIR ?? os.tmpdir(), 'bragi-ev-'));

async function snapshot(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = path.join(d, e.name), s = await stat(p);
      out.push(`${path.relative(dir, p)}:${s.size}:${s.mtimeMs}`);
      if (e.isDirectory()) await walk(p);
    }
  };
  await walk(dir);
  return out.sort();
}

// ---- sentences and characters ---------------------------------------------------------------------------

test('sentences: 。！？ and newlines split Japanese; blank lines and surrounding spaces do not make sentences', () => {
  assert.deepEqual(splitSentences('今日は晴れ。明日は雨？そうかも！\n\n  次の行'), ['今日は晴れ。', '明日は雨？', 'そうかも！', '次の行']);
  assert.deepEqual(splitSentences('すごい！？本当に。。'), ['すごい！？', '本当に。。']);
});

test('sentences: . ! ? split English only before a space or the end, so 3.5 and v1.2 stay whole', () => {
  assert.deepEqual(splitSentences('It works. It is fast! Is it? yes'), ['It works.', 'It is fast!', 'Is it?', 'yes']);
  assert.deepEqual(splitSentences('Version 3.5 is out. See v1.2 notes.'), ['Version 3.5 is out.', 'See v1.2 notes.']);
});

test('sentences: a terminator inside 「」 or （） does not end the sentence', () => {
  assert.deepEqual(splitSentences('「行こう！」と言った。次です。'), ['「行こう！」と言った。', '次です。']);
  assert.deepEqual(splitSentences('彼は笑った（本当だ。たぶん）。終わり'), ['彼は笑った（本当だ。たぶん）。', '終わり']);
  assert.deepEqual(splitSentences('「開いたまま。\n次です。'), ['「開いたまま。', '次です。'], 'an unclosed bracket ends with its line');
});

test('sentences: Markdown markup stays part of the sentence', () => {
  assert.deepEqual(splitSentences('# 見出し\n\n- 項目です。'), ['# 見出し', '- 項目です。']);
});

test('chars: whitespace is not counted, and an emoji is one character', () => {
  assert.equal(countChars('a b　c\n'), 3);
  assert.equal(countChars('😀a'), 2);
  assert.equal(countChars(''), 0);
});

test('front matter: dropped from both sides before counting', () => {
  assert.equal(stripFrontMatter('---\ntitle: x\n---\n本文です。'), '本文です。');
  assert.equal(stripFrontMatter('本文です。'), '本文です。');
  const v = measureText('---\ntitle: a\n---\n本文です。', '---\ntitle: b\n---\n本文です。');
  assert.deepEqual([v.changedSentences, v.source.sentences, v.source.chars], [0, 1, 5]);
});

// ---- measureText ----------------------------------------------------------------------------------------

test('measure: identical text -> nothing changed, but the totals are still reported', () => {
  const v = measureText('一つ目。二つ目。', '一つ目。二つ目。');
  assert.deepEqual(v, { source: { sentences: 2, chars: 8 }, final: { sentences: 2, chars: 8 }, changedSentences: 0, removedSentences: 0, addedSentences: 0, addedChars: 0, removedChars: 0, approximate: false });
});

test('measure: one sentence reworded -> changed 1; chars count only what differs inside it', () => {
  const v = measureText('今日は晴れです。明日も続く。', '今日は雨です。明日も続く。');
  assert.deepEqual(v, { source: { sentences: 2, chars: 14 }, final: { sentences: 2, chars: 13 }, changedSentences: 1, removedSentences: 1, addedSentences: 1, addedChars: 1, removedChars: 2, approximate: false });
});

test('measure: a deleted sentence and an added sentence each count as one change', () => {
  const del = measureText('甲です。乙です。丙です。', '甲です。丙です。');
  assert.deepEqual([del.changedSentences, del.removedSentences, del.addedSentences, del.removedChars, del.addedChars], [1, 1, 0, 4, 0]);
  const add = measureText('甲です。丙です。', '甲です。乙です。丙です。');
  assert.deepEqual([add.changedSentences, add.removedSentences, add.addedSentences, add.removedChars, add.addedChars], [1, 0, 1, 0, 4]);
});

test('measure: n old sentences replaced by m new ones count as max(n, m) changed', () => {
  const v = measureText('一。二。三。四。', '一。合わせ。四。');
  assert.deepEqual([v.changedSentences, v.removedSentences, v.addedSentences, v.removedChars, v.addedChars], [2, 2, 1, 3, 3]);
  const w = measureText('一。二。三。', '一。あ。い。う。三。');
  assert.deepEqual([w.changedSentences, w.removedSentences, w.addedSentences], [3, 1, 3]);
});

test('measure: English sentences work the same way', () => {
  const v = measureText('It works. It is fast!', 'It runs. It is fast!');
  assert.deepEqual([v.source.sentences, v.changedSentences], [2, 1]);
});

test('measure: only blank lines, trailing spaces or line-break spaces changed -> 0 changed', () => {
  const v = measureText('一行目です。  \n二行目です。\n', '一行目です。\n\n\n二行目です。');
  assert.equal(v.changedSentences, 0);
  assert.equal(v.addedChars + v.removedChars, 0);
});

test('measure: a moved sentence is a removal plus an addition, not hidden', () => {
  const v = measureText('甲です。乙です。丙です。', '乙です。丙です。甲です。');
  assert.ok(v.changedSentences >= 1);
  assert.equal(v.removedSentences, v.addedSentences);
});

test('measure: two long unrelated paragraphs finish quickly (no quadratic blow-up) and still report numbers', () => {
  const a = '甲'.repeat(6000) + '。', b = '乙'.repeat(6000) + '。';
  const t = Date.now();
  const v = measureText(a, b);
  assert.ok(Date.now() - t < 3000);
  assert.deepEqual([v.changedSentences, v.removedChars, v.addedChars], [1, 6000, 6000]);
});

// ---- measureRun -----------------------------------------------------------------------------------------

test('run: a confirmed target is measured and labelled with its run folder', async () => {
  const d = await tmp();
  await makeRun(d, { source: '今日は晴れです。明日も続く。', final: '今日は雨です。明日も続く。' });
  const [r] = await measureRun(d, 'run-a');
  assert.equal(r.status, 'measured');
  assert.equal(r.run, 'run-a');
  assert.equal(r.id, 'sample-post');
  assert.equal(r.title, 'Title sample-post');
  assert.equal(r.finishedAt, '2026-01-02T03:04:05.000Z');
  assert.equal(r.volume?.changedSentences, 1);
  assert.equal(r.reason, null);
});

test('run: front matter in the source and in nat-final.md does not count', async () => {
  const d = await tmp();
  const fm = '---\ntitle: made up\n---\n';
  await makeRun(d, { source: `${fm}一つ目です。`, final: `${fm}一つ目でした。` });
  const [r] = await measureRun(d);
  assert.equal(r.volume?.changedSentences, 1);
  assert.equal(r.volume?.source.chars, 6);
});

test('run: no finished.json -> 未確定, not an error, and no numbers', async () => {
  const d = await tmp();
  await makeRun(d, { finished: false, final: null });
  const [r] = await measureRun(d);
  assert.equal(r.status, 'unfinished');
  assert.equal(r.volume, null);
  assert.match(r.reason ?? '', /finished\.json/);
});

test('run: source file gone -> says why, and the numbers are null, never 0', async () => {
  const d = await tmp();
  await makeRun(d, { writeSource: false, final: '今日は雨です。' });
  const [r] = await measureRun(d);
  assert.equal(r.status, 'source-missing');
  assert.equal(r.volume, null);
  assert.match(r.reason ?? '', /sample-post\.md/);
});

test('run: a source path that escapes the run (.. or a symlink out) is refused with a reason', async () => {
  const d = await tmp(), outside = await tmp();
  await writeFile(path.join(outside, 'other.md'), '外です。');
  await makeRun(d, { sourceField: '../escape.md', writeSource: false });
  assert.match((await measureRun(d))[0].reason ?? '', /run の外|unsafe/);
  const d2 = await tmp();
  await makeRun(d2, { writeSource: false });
  await symlink(path.join(outside, 'other.md'), path.join(d2, '05_final', 'sample-post.md'));
  const [r] = await measureRun(d2);
  assert.equal(r.status, 'source-missing');
  assert.equal(r.volume, null);
});

test('run: source edited after the author finished (sha256 differs) -> not compared, reason given', async () => {
  const d = await tmp();
  await makeRun(d, { source: '元です。', final: '直しです。' });
  await writeFile(path.join(d, '05_final', 'sample-post.md'), '後から変えた元です。');
  const [r] = await measureRun(d);
  assert.equal(r.status, 'source-changed');
  assert.equal(r.volume, null);
  assert.match(r.reason ?? '', /sha256/);
});

test('run: nat-final.md missing, or changed after finishing -> not measured, reason given', async () => {
  const d = await tmp();
  await makeRun(d, { final: null });
  const [a] = await measureRun(d);
  assert.deepEqual([a.status, a.volume], ['final-missing', null]);
  const d2 = await tmp();
  await makeRun(d2, { source: '元です。', final: '直しです。' });
  await writeFile(path.join(d2, '05_final', 'editor', 'sample-post', 'nat-final.md'), 'さらに直しました。');
  const [b] = await measureRun(d2);
  assert.deepEqual([b.status, b.volume], ['final-changed', null]);
});

test('run: an unreadable finished.json is reported as such; a record without sha fields is still measured', async () => {
  const d = await tmp();
  await makeRun(d, { finished: 'garbage' });
  const [a] = await measureRun(d);
  assert.deepEqual([a.status, a.volume], ['invalid-record', null]);
  const d2 = await tmp();
  await makeRun(d2, { source: '元です。', final: '直しです。', finished: { sourceSha256: undefined, finalSha256: undefined } });
  const [b] = await measureRun(d2);
  assert.equal(b.status, 'measured');
});

test('run: a folder with no editor-targets.json is an error for the caller', async () => {
  const d = await tmp();
  await assert.rejects(measureRun(d), /editor-targets\.json/);
});

// ---- many runs ------------------------------------------------------------------------------------------

test('tree: finished.json files are found recursively; node_modules and dot folders are skipped; unfinished siblings are listed', async () => {
  const root = await tmp();
  await makeRun(path.join(root, 'alpha', 'run-1'), { source: '甲です。乙です。', final: '甲です。乙でした。' });
  await makeRun(path.join(root, 'beta'), { id: 'beta-post', finished: { id: 'beta-post' } });
  await makeRun(path.join(root, 'node_modules', 'pkg'), {});
  await makeRun(path.join(root, '.hidden'), {});
  // a second, unfinished target in alpha/run-1
  const targets = JSON.parse(await readFile(path.join(root, 'alpha', 'run-1', 'editor-targets.json'), 'utf8'));
  targets.targets.push({ id: 'second-post', title: 'Second', medium: 'sns', version: 'v1', source: '05_final/sample-post.md' });
  await writeFile(path.join(root, 'alpha', 'run-1', 'editor-targets.json'), JSON.stringify(targets));
  const rep = await getEditVolume(root);
  assert.deepEqual(rep.results.map((r) => [r.run, r.id, r.status]), [['alpha/run-1', 'sample-post', 'measured'], ['alpha/run-1', 'second-post', 'unfinished'], ['beta', 'beta-post', 'measured']]);
  assert.match(rep.note, /因果/);
});

test('tree: a run nobody has confirmed (editor-targets.json, no finished.json) is listed as 未確定, not skipped', async () => {
  const root = await tmp();
  await makeRun(path.join(root, 'never-confirmed'), { finished: false, final: null });
  const rep = await getEditVolume(root);
  assert.deepEqual(rep.results.map((r) => [r.run, r.status, r.volume]), [['never-confirmed', 'unfinished', null]]);
});

test('tree: a folder that is itself a run is read as one run (unfinished targets included)', async () => {
  const d = await tmp();
  await makeRun(d, { finished: false, final: null });
  const rep = await getEditVolume(d);
  assert.deepEqual(rep.results.map((r) => r.status), ['unfinished']);
});

test('tree: a finished.json that is not under <run>/05_final/editor/<id>/ is a warning, not a result or a crash', async () => {
  const root = await tmp();
  await mkdir(path.join(root, 'stray'), { recursive: true });
  await writeFile(path.join(root, 'stray', 'finished.json'), '{}');
  const rep = await getEditVolume(root);
  assert.deepEqual(rep.results, []);
  assert.match(rep.warnings.join('\n'), /stray/);
});

test('tree: nothing is created, changed or removed', async () => {
  const root = await tmp();
  await makeRun(path.join(root, 'a'), { source: '甲です。', final: '乙です。' });
  await makeRun(path.join(root, 'b'), { finished: false, final: null });
  const before = await snapshot(root);
  await getEditVolume(root);
  await getEditVolume(path.join(root, 'a'));
  assert.deepEqual(await snapshot(root), before);
});

test('tree: a missing folder rejects', async () => {
  await assert.rejects(getEditVolume(path.join(await tmp(), 'nope')), /ENOENT|not found|見つかりません/);
});

// ---- output ---------------------------------------------------------------------------------------------

test('render: a table of numbers, the no-causation line, and no zero for a run that could not be measured', async () => {
  const root = await tmp();
  await makeRun(path.join(root, 'ok'), { source: '今日は晴れです。', final: '今日は雨です。' });
  await makeRun(path.join(root, 'gone'), { id: 'gone-post', writeSource: false });
  await makeRun(path.join(root, 'open'), { id: 'open-post', finished: false, final: null });
  const rep = await getEditVolume(root);
  const text = renderEditVolume(rep);
  const lines = text.split('\n');
  assert.ok(lines.some((l) => /ok\b/.test(l) && /sample-post/.test(l)), 'the measured row');
  const gone = lines.find((l) => l.includes('gone-post')) ?? '';
  assert.match(gone, /元稿が見つかりません/);
  assert.doesNotMatch(gone, /\d+ 字|\b0\b/);
  const open = lines.find((l) => l.includes('open-post')) ?? '';
  assert.match(open, /未確定/);
  assert.match(text, /因果は言わない|因果は示しません/);
});

test('render: no runs found is said in words, not as a table of zeros', async () => {
  const text = renderEditVolume(await getEditVolume(await tmp()));
  assert.match(text, /finished\.json が見つかりません|対象がありません/);
  assert.match(text, /因果/);
});

// ---- the command ----------------------------------------------------------------------------------------

const cli = (...args: string[]) => exec(process.execPath, [path.resolve('src/bragi.ts'), ...args], { env: { ...process.env, BRAGI_DRAFTS_ROOT: '', BRAGI_LEDGER: '' } }).then((r) => ({ code: 0, ...r }), (e) => ({ code: e.code as number, stdout: e.stdout as string, stderr: e.stderr as string }));

test('cli: bragi edit-volume <dir> prints the table; --json prints the same results plus the note', async () => {
  const root = await tmp();
  await makeRun(path.join(root, 'x'), { source: '今日は晴れです。', final: '今日は雨です。' });
  const t = await cli('edit-volume', root);
  assert.equal(t.code, 0);
  assert.match(t.stdout, /sample-post/);
  assert.match(t.stdout, /因果/);
  const j = await cli('edit-volume', root, '--json');
  assert.equal(j.code, 0);
  const parsed = JSON.parse(j.stdout);
  assert.equal(parsed.results[0].volume.changedSentences, 1);
  assert.match(parsed.note, /因果/);
});

test('cli: an unfinished run exits 0 with 未確定; a folder that does not exist exits 1 with a message', async () => {
  const d = await tmp();
  await makeRun(d, { finished: false, final: null });
  const u = await cli('edit-volume', d);
  assert.equal(u.code, 0);
  assert.match(u.stdout, /未確定/);
  const bad = await cli('edit-volume', path.join(d, 'nope'));
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /bragi:/);
  const none = await cli('edit-volume');
  assert.equal(none.code, 2);
});
