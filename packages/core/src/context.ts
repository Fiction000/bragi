// What the ledger says about one article, as Markdown a brief can paste. Pure: no I/O.
// Rule: active decisions only; global + the article's medium + the article's own (scope=draft, this slug).
import type { Decision } from './ledger.ts';

export type ContextTarget = { draft: string; medium: string | null };

export function decisionsFor(decisions: Decision[], target: ContextTarget): { global: Decision[]; medium: Decision[]; draft: Decision[] } {
  const active = decisions.filter((d) => d.meta.status === 'active');
  return {
    global: active.filter((d) => d.meta.scope === 'global'),
    medium: active.filter((d) => d.meta.scope === 'medium' && target.medium !== null && d.meta.medium === target.medium),
    draft: active.filter((d) => d.meta.scope === 'draft' && d.meta.draft === target.draft),
  };
}

const entry = (d: Decision) => {
  const check = d.meta.check.type === 'regex' ? `\n機械チェック: \`${d.meta.check.pattern}\`${d.meta.check.message ? `（${d.meta.check.message}）` : ''}` : '';
  return `### ${d.meta.id}（${d.meta.kind}）\n\n${d.body}\n\n決めた人・日: ${d.meta.decided_by}、${d.meta.decided_at}　出どころ: ${d.meta.source}${check}\n`;
};

export function renderContext(decisions: Decision[], target: ContextTarget): string {
  const g = decisionsFor(decisions, target);
  const total = g.global.length + g.medium.length + g.draft.length;
  const lines = [`# 判断台帳：${target.draft} に効く判断`, '', `媒体: ${target.medium ?? '（不明）'}　／　有効な判断 ${total}件（全体 ${g.global.length}・媒体 ${g.medium.length}・この記事 ${g.draft.length}）`, ''];
  if (total === 0) return `${lines.join('\n')}この記事に効く判断はありません。\n`;
  const section = (title: string, list: Decision[]) => list.length > 0 && lines.push(`## ${title}`, '', ...list.map(entry));
  section('全体', g.global);
  section(`媒体：${target.medium}`, g.medium);
  section(`この記事（${target.draft}）`, g.draft);
  return `${lines.join('\n').trimEnd()}\n`;
}
