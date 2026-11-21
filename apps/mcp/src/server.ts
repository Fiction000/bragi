#!/usr/bin/env node
// MCP server over stdio. Read-only tools: list_drafts, get_draft, get_context, get_candidates, get_recurrence.
// One write tool: propose_decision, which creates a file in the proposals folder (next to the ledger, never in it). Nothing here
// writes the ledger, and there is no tool to adopt or reject a proposal: that is for a person, in the editor's UI.
// stdout belongs to the protocol; anything else goes to stderr.
//   node apps/mcp/src/server.ts [--drafts-root dir] [--ledger dir] [--proposals dir] [--tasknotes dir] [--drafts-index file] [--github]
import { parseArgs } from 'node:util';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createGhGraphql, getCandidates, getContext, getDraft, getRecurrence, listDrafts, proposeDecisionFor, KINDS, SCOPES, summarizeError, loadSettings, type ServiceOptions } from '@wle/core';

const { values } = parseArgs({
  options: { 'drafts-root': { type: 'string' }, ledger: { type: 'string' }, proposals: { type: 'string' }, tasknotes: { type: 'string' }, 'drafts-index': { type: 'string' }, 'pr-repo': { type: 'string', multiple: true }, github: { type: 'boolean', default: false } },
});
const options: ServiceOptions = {
  draftsRoot: values['drafts-root'], ledgerDir: values.ledger, proposalsDir: values.proposals, taskNotesDir: values.tasknotes, draftsIndex: values['drafts-index'],
  prRepos: values['pr-repo'], github: values.github ? createGhGraphql() : null,
};

const text = (value: string) => ({ content: [{ type: 'text' as const, text: value }] });
const failure = (e: unknown) => ({ isError: true, content: [{ type: 'text' as const, text: (e as Error).message }] });
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const server = new McpServer({ name: 'writing-local-editor', version: '0.1.0' });

server.registerTool('list_drafts', {
  description: 'List every article under the drafts folder: slug, title, medium, stage, who is waiting, open decisions, due date, PRs. Read-only.',
  inputSchema: {}, annotations: readOnly,
}, async () => { try { return text(JSON.stringify(await listDrafts(options), null, 2)); } catch (e) { return failure(e); } });

server.registerTool('get_draft', {
  description: 'Everything the scanner knows about one article (stage and why, warnings, PRs with CI and gate, editor runs). Read-only.',
  inputSchema: { slug: z.string().describe('article slug, e.g. my-article-20261113') }, annotations: readOnly,
}, async ({ slug }) => { try { return text(JSON.stringify(await getDraft(options, slug), null, 2)); } catch (e) { return failure(e); } });

server.registerTool('get_context', {
  description: 'The active decisions that apply to one article (global + its medium + this article), as Markdown to paste into a brief. Retired decisions are never included. Read-only.',
  inputSchema: { slug: z.string().describe('article slug, e.g. my-article-20261113') }, annotations: readOnly,
}, async ({ slug }) => { try { return text(await getContext(options, slug)); } catch (e) { return failure(e); } });

server.registerTool('get_candidates', {
  description: 'The questions (Q01…) in one article\'s copy-review reports as candidate decisions: each is in-ledger (a decision already cites it), answered (the report carries an answer) or open, with its basis, options, recommendation and what a ledger entry would start from. Nothing is written to the ledger. Read-only.',
  inputSchema: { slug: z.string().describe('article slug, e.g. my-article-20261113') }, annotations: readOnly,
}, async ({ slug }) => { try { return text((await getCandidates(options, slug)).text); } catch (e) { return failure(e); } });

server.registerTool('get_recurrence', {
  description: 'How many articles each active ledger decision recurs in: findings (auto/decision rows) of the copy-review reports that fall under a decision by fixed rules (decision id, check regex, quoted phrase, topic tag), not counting the article the decision came from. With a slug: only the decisions that article\'s findings fall under. Read-only.',
  inputSchema: { slug: z.string().optional().describe('article slug; omit to count across every report') }, annotations: readOnly,
}, async ({ slug }) => { try { return text((await getRecurrence(options, slug)).text); } catch (e) { return failure(e); } });

server.registerTool('propose_decision', {
  description: 'Propose a decision for the ledger. This only writes a candidate file in the proposals folder; it is NOT a decision and never reaches get_context until the person adopts it in the editor UI. scope defaults to draft (that article only); use medium or global only when the rule really holds beyond it. The same wording for the same scope/target/kind returns the existing proposal instead of a new one. The text is checked against the ledger schema and refused if it does not fit.',
  inputSchema: {
    slug: z.string().describe('lower-case words and hyphens, e.g. my-article-q02-no-feelings; names the file'),
    proposed_by: z.string().min(1).describe('your agent name'),
    body: z.string().min(1).describe('the decision, in the words that should go in a brief'),
    kind: z.enum(KINDS),
    source: z.string().min(1).describe('where it came from, e.g. drafts/<slug>/copy-review-report-x.md#Q02'),
    scope: z.enum(SCOPES).default('draft'),
    draft: z.string().optional().describe('article slug; required for scope=draft'),
    medium: z.string().optional().describe('medium name; required for scope=medium'),
    check: z.object({ type: z.enum(['none', 'regex']), pattern: z.string().optional(), message: z.string().optional() }).optional().describe('machine check, only when a regex can really test it'),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ check, ...input }) => {
  try {
    const checkInput = check === undefined ? undefined : check.type === 'regex' ? { type: 'regex' as const, pattern: check.pattern ?? '', message: check.message } : { type: 'none' as const };
    const { created, proposal } = await proposeDecisionFor(options, { ...input, check: checkInput });
    const m = proposal.meta;
    return text(`${created ? '候補を作りました' : '同じ内容の候補が既にあります（新しいファイルは作っていません）'}：${m.id}（${m.status}、${m.scope}${m.draft ? ` ${m.draft}` : ''}${m.medium ? ` ${m.medium}` : ''}、提案 ${m.proposed_by} ${m.proposed_at}）\n台帳には入っていません。採るのは${loadSettings().author}だけ（エディターの「判断の候補」画面）。\n`);
  } catch (e) { return failure(Array.isArray((e as { issues?: unknown }).issues) ? new Error(`refused, nothing written: ${summarizeError(e)}`) : e); }
});

await server.connect(new StdioServerTransport());
