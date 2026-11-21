// Questions in a copy-review report -> candidate decisions. A candidate is only a proposal: nothing here writes the ledger.
// Only a person makes a decision a rule (the UI, or a pasted answer such as 「全部A」); this module lists what could be.
import type { Decision } from './ledger.ts';
import { loadSettings } from './config.ts';
import { normalizeQuestionId, type ParsedReport, type Question } from './reports.ts';

/** in-ledger: a ledger decision already cites this question. answered: the report carries an answer. open: neither. */
export type CandidateState = 'in-ledger' | 'answered' | 'open';
export type Candidate = Question & {
  state: CandidateState;
  decision: { id: string; status: 'active' | 'retired' } | null;
  answerKey: string | null;
  /** The text of the answered option, else of the recommended one. Wording for a person to adopt or change. */
  suggestion: string | null;
  /** The findings (E01…) of the same report whose 区分 cell names this question. */
  findingIds: string[];
  /** What a ledger entry for it would start from. scope is `draft` (the design's default: one article only). */
  proposed: { scope: 'draft'; draft: string; source: string };
};

/** `…/copy-review-report-x.md#Q02` -> the file name and the normalised question id the decision cites. */
export function sourceKey(source: string): { file: string; question: string } | null {
  const m = /([^/#]+)#(Q\d+[a-z]?)\s*$/.exec(source);
  return m ? { file: m[1], question: normalizeQuestionId(m[2]) } : null;
}

export function buildCandidates(reports: ParsedReport[], decisions: Decision[]): Candidate[] {
  const cited = new Map<string, Decision>();
  for (const d of decisions) {
    const k = sourceKey(d.meta.source);
    if (!k) continue;
    const key = `${k.file}#${k.question}`;
    const prev = cited.get(key);
    // an active decision outranks a retired one for the same question
    if (!prev || (prev.meta.status === 'retired' && d.meta.status === 'active')) cited.set(key, d);
  }
  const out: Candidate[] = [];
  for (const r of reports) {
    for (const q of r.questions) {
      const d = cited.get(`${r.report}#${q.id}`) ?? null;
      const answerKey = /^[（(]?([A-D])(?![A-Za-z0-9])/.exec(q.answer ?? '')?.[1] ?? null;
      const pick = (key: string | null) => (key ? (q.choices.find((c) => c.key === key)?.text ?? null) : null);
      out.push({
        ...q,
        state: d ? 'in-ledger' : q.answer ? 'answered' : 'open',
        decision: d ? { id: d.meta.id, status: d.meta.status } : null,
        answerKey,
        suggestion: pick(answerKey) ?? pick(q.recommended),
        findingIds: r.findings.filter((f) => f.questionIds.includes(q.id)).map((f) => f.id),
        proposed: { scope: 'draft', draft: r.slug, source: `drafts/${r.slug}/${r.report}#${q.id}` },
      });
    }
  }
  return out;
}

const ORDER: Record<CandidateState, number> = { answered: 0, open: 1, 'in-ledger': 2 };

export function renderCandidates(slug: string, reports: ParsedReport[], candidates: Candidate[], author: string = loadSettings().author): string {
  const count = (s: CandidateState) => candidates.filter((c) => c.state === s).length;
  const lines = [
    `# 判断の候補：${slug}`,
    '',
    `報告 ${reports.length}本（${reports.map((r) => `${r.report} [${r.status ?? 'status なし'}]`).join('、') || 'なし'}）。質問 ${candidates.length}件：台帳に未登録で回答あり ${count('answered')}・未登録で回答なし ${count('open')}・台帳に登録済み ${count('in-ledger')}。`,
    `台帳には入れていません。採るのは${author}だけ（UI か、回答の取り込み）。`,
  ];
  for (const c of [...candidates].sort((a, b) => ORDER[a.state] - ORDER[b.state] || a.report.localeCompare(b.report) || a.line - b.line)) {
    lines.push('', `## ${c.id}（${c.state === 'in-ledger' ? `台帳に登録済み ${c.decision!.id}${c.decision!.status === 'retired' ? '・取り消し済み' : ''}` : c.state === 'answered' ? '回答あり・未登録' : '未登録・回答なし'}）${c.title}`);
    lines.push(`- 出どころ: ${c.report} L${c.line}${c.label ? `　区分: ${c.label}` : ''}`);
    if (c.refs.length) lines.push(`- 箇所の指摘: ${c.refs.join('・')}`);
    if (c.findingIds.length) lines.push(`- 区分欄でこの質問を指す指摘: ${c.findingIds.join('・')}`);
    if (c.basis) lines.push(`- 根拠: ${c.basis}`);
    if (c.choices.length) lines.push(`- 選択肢: ${c.choices.map((x) => `${x.key}${x.key === c.recommended ? '（推奨）' : ''} ${x.text}`).join(' ／ ')}`);
    else if (c.choicesRaw) lines.push(`- 選択肢（分けられず原文）: ${c.choicesRaw}`);
    if (c.answer) lines.push(`- 回答: ${c.answer}`);
    if (c.state !== 'in-ledger' && c.suggestion) lines.push(`- 台帳に入れるなら（案）: ${c.suggestion}`);
    if (c.state !== 'in-ledger') lines.push(`- 既定: scope ${c.proposed.scope}（${c.proposed.draft} だけ）／ source ${c.proposed.source}`);
  }
  return `${lines.join('\n')}\n`;
}
