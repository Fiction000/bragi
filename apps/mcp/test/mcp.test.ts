import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createDecision, retireDecision } from '@wle/core';

const server = path.resolve('src/server.ts');
const fixtureDrafts = path.resolve('../../packages/core/test/fixtures/drafts');
const text = (r: any) => r.content[0].text as string;

async function connect(args: string[]) {
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(new StdioClientTransport({ command: 'node', args: [server, ...args], stderr: 'pipe' }));
  return client;
}
async function snapshot(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...await snapshot(p));
    else { const s = await stat(p); out.push(`${p} ${s.size} ${s.mtimeMs}`); }
  }
  return out.sort();
}

test('mcp over stdio: the five reads plus propose_decision (the only write); results come from the files', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wle-mcp-'));
  try {
    await cp(fixtureDrafts, path.join(dir, 'drafts'), { recursive: true });
    const L = path.join(dir, 'ledger');
    const d = (id: string, over: object) => createDecision(L, { id, scope: 'draft', draft: 'deciding-sample', medium: null, kind: 'fact', status: 'active', decided_by: '著者', decided_at: '2026-11-16', source: 's', body: `合成 ${id}`, ...over } as never);
    await d('D-2026-11-16-m-q02', { scope: 'medium', draft: null, medium: '解説記事' });
    await d('D-2026-11-16-d-q01', {});
    await d('D-2026-11-16-x-q01', { draft: 'writing-sample' });
    await d('D-2026-11-16-old', { scope: 'medium', draft: null, medium: '解説記事' });
    await retireDecision(L, 'D-2026-11-16-old', '2026-11-18');
    const before = await snapshot(dir);

    const client = await connect(['--drafts-root', path.join(dir, 'drafts'), '--ledger', L, '--tasknotes', path.join(dir, 'none')]);
    try {
      const tools = (await client.listTools()).tools;
      assert.deepEqual(tools.map(t => t.name).sort(), ['get_candidates', 'get_context', 'get_draft', 'get_recurrence', 'list_drafts', 'propose_decision']);
      assert.ok(tools.filter(t => t.name !== 'propose_decision').every(t => t.annotations?.readOnlyHint === true), 'the five reads stay read-only');
      assert.equal(tools.find(t => t.name === 'propose_decision')!.annotations?.readOnlyHint, false);

      const list = JSON.parse(text(await client.callTool({ name: 'list_drafts', arguments: {} })));
      assert.equal(list.drafts.length, 9);
      assert.equal(list.drafts.find((x: any) => x.slug === 'deciding-sample').stage, 'awaiting-decision');

      const draft = JSON.parse(text(await client.callTool({ name: 'get_draft', arguments: { slug: 'deciding-sample' } })));
      assert.deepEqual([draft.slug, draft.medium, draft.openDecisions], ['deciding-sample', '解説記事', 3]);

      const ctx = text(await client.callTool({ name: 'get_context', arguments: { slug: 'deciding-sample' } }));
      assert.match(ctx, /有効な判断 2件（全体 0・媒体 1・この記事 1）/);
      assert.ok(ctx.includes('D-2026-11-16-m-q02') && ctx.includes('D-2026-11-16-d-q01'));
      assert.ok(!ctx.includes('x-q01') && !ctx.includes('D-2026-11-16-old'));

      const cand = text(await client.callTool({ name: 'get_candidates', arguments: { slug: 'deciding-sample' } }));
      assert.match(cand, /質問 3件：台帳に未登録で回答あり 0・未登録で回答なし 3・台帳に登録済み 0/);
      assert.ok(['Q01', 'Q02', 'Q03'].every((q) => cand.includes(`## ${q}（未登録・回答なし）`)));
      const rec = text(await client.callTool({ name: 'get_recurrence', arguments: {} }));
      assert.match(rec, /^# 再発の数/);
      assert.match(rec, /有効な判断 3件と照合/);
      const recOne = await client.callTool({ name: 'get_recurrence', arguments: { slug: 'nope' } });
      assert.deepEqual([recOne.isError, /unknown draft "nope"/.test(text(recOne))], [true, true]);
      assert.equal(((await client.callTool({ name: 'get_candidates', arguments: { slug: 'nope' } })) as any).isError, true);

      const bad = await client.callTool({ name: 'get_context', arguments: { slug: 'nope' } });
      assert.equal(bad.isError, true);
      assert.match(text(bad), /unknown draft "nope"/);
      assert.equal(((await client.callTool({ name: 'get_draft', arguments: {} })) as any).isError, true);
    } finally { await client.close(); }
    assert.deepEqual(await snapshot(dir), before, 'serving reads changed nothing');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('propose_decision over stdio: writes one candidate in the proposals folder only; the ledger and every read are unchanged; duplicates and bad input write nothing; there is no way to adopt', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wle-mcp-prop-'));
  try {
    await cp(fixtureDrafts, path.join(dir, 'drafts'), { recursive: true });
    const L = path.join(dir, 'ledger');
    const P = path.join(dir, 'proposals');
    await createDecision(L, { id: 'D-2026-11-16-d-q01', scope: 'draft', draft: 'deciding-sample', medium: null, kind: 'fact', status: 'active', decided_by: '著者', decided_at: '2026-11-16', source: 's', body: '既存の判断。' } as never);
    const ledgerBefore = await snapshot(L);
    const args = { slug: 'no-feelings', proposed_by: 'mcp-test-agent', draft: 'deciding-sample', kind: 'fact', source: 'drafts/deciding-sample/copy-review-report-sample.md#Q01', body: '確認表にない心情は書かない。' };
    const client = await connect(['--drafts-root', path.join(dir, 'drafts'), '--ledger', L, '--tasknotes', path.join(dir, 'none')]);
    try {
      const ctxBefore = text(await client.callTool({ name: 'get_context', arguments: { slug: 'deciding-sample' } }));
      const names = (await client.listTools()).tools.map(t => t.name);
      assert.ok(!names.some(n => /adopt|reject|retire|ledger|decide/.test(n.replace('propose_decision', ''))), `no tool adopts, rejects or writes the ledger: ${names}`);

      const r = await client.callTool({ name: 'propose_decision', arguments: args });
      assert.ok(!(r as any).isError, text(r));
      assert.match(text(r), /候補を作りました：P-\d{4}-\d{2}-\d{2}-no-feelings（pending、draft deciding-sample/);
      const written = await readdir(P);
      assert.equal(written.length, 1);
      const file = await readFile(path.join(P, written[0]), 'utf8');
      assert.match(file, /^proposed_by: mcp-test-agent$/m);
      assert.match(file, /^status: pending$/m);
      assert.match(file, /^scope: draft$/m);
      assert.deepEqual(await snapshot(L), ledgerBefore, 'the ledger folder is untouched');
      assert.equal(text(await client.callTool({ name: 'get_context', arguments: { slug: 'deciding-sample' } })), ctxBefore, 'the proposal is not in the brief context');

      // same wording (any slug, agent): the existing proposal comes back, no new file
      const dup = await client.callTool({ name: 'propose_decision', arguments: { ...args, slug: 'again', proposed_by: 'someone-else' } });
      assert.match(text(dup), /同じ内容の候補が既にあります.*P-\d{4}-\d{2}-\d{2}-no-feelings/);
      assert.deepEqual(await readdir(P), written);

      // refused: scope=draft without an article, an unknown article, a medium scope without a medium, an empty text
      for (const bad of [{ draft: undefined }, { draft: 'no-such-article' }, { scope: 'medium', draft: undefined }, { slug: 'empty', body: ' ' }, { slug: 'Bad Slug' }]) {
        const e = await client.callTool({ name: 'propose_decision', arguments: { ...args, slug: 'refused', body: '別の文言。', ...bad } });
        assert.equal((e as any).isError, true, JSON.stringify(bad));
      }
      assert.deepEqual(await readdir(P), written, 'nothing was written by the refused calls');
      assert.deepEqual(await snapshot(L), ledgerBefore);

      // a medium-scope proposal is possible when asked for explicitly
      const m = await client.callTool({ name: 'propose_decision', arguments: { ...args, slug: 'medium-one', scope: 'medium', draft: undefined, medium: '解説記事', body: '媒体への提案。' } });
      assert.ok(!(m as any).isError, text(m));
      assert.equal((await readdir(P)).length, 2);
    } finally { await client.close(); }
    assert.deepEqual(await snapshot(L), ledgerBefore);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
