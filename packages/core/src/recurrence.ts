// Recurrence: how many articles got a finding that falls under a decision already in the ledger.
// Matching is by fixed rules, in this order, and the first that fits is the one recorded. No LLM.
//   id      the finding's text names the decision's id (D-2026-…)
//   check   the decision has a `check: regex` and it matches the finding's 旧 text
//   phrase  a 「…」 phrase of the decision's text (3+ characters) appears in the finding's 旧 or 理由
//   tag     the decision and the finding both fall under the same topic tag (TOPICS below)
// Only auto and decision findings count; unclassified and other rows are ignored. Only active decisions count.
// The article a decision came from is not counted: a recurrence is the same ruling being needed again elsewhere.
import type { Decision } from './ledger.ts';
import type { Finding, ParsedReport } from './reports.ts';

/**
 * Topic tags, written down from the decisions the ledger holds and the reports they came from. A tag fits a decision when
 * `decision` matches its text, and a finding when `finding` matches its 旧／理由. Add one only with a real decision behind it.
 */
export const TOPICS: { tag: string; label: string; decision: RegExp; finding: RegExp; /** also required in the finding: the finding must say there is no basis, not just mention the word */ and?: RegExp }[] = [
  { tag: 'unsourced-feeling-evaluation', label: '資料にない心情・評価・因果', decision: /心情|評価|因果/, finding: /心情|評価|因果|人物評/, and: /(根拠|資料|表|出典)[^。、]{0,8}(ない|なく|ありません|見当たらない|未確認)|根拠のない/ },
  { tag: 'superlative', label: '根拠のない最上級', decision: /最上級/, finding: /最上級/ },
  { tag: 'translator-intent', label: '訳者の意図の断定', decision: /訳者の意図|意図の断定/, finding: /訳者[^。]{0,20}(意図|理由)|意図の断定|意図の推測/ },
  { tag: 'reread-invite', label: '再読の誘い', decision: /再読の誘い/, finding: /再読の誘い/ },
  { tag: 'edition-claim', label: '在庫・現行版・版を重ねる', decision: /在庫|現行版|版を重ね|手に取りやすい/, finding: /在庫|現行版|版を重ね|手に取りやすい/ },
  { tag: 'secondary-source', label: '二次資料だけが根拠', decision: /二次資料|二次情報/, finding: /二次資料|二次情報|二次（/ },
];

export type Rule = 'id' | 'check' | 'phrase' | 'tag';
export type Hit = { slug: string; report: string; finding: string; klass: 'auto' | 'decision'; rule: Rule; via: string };
export type RecurrenceRow = {
  decision: string;
  scope: 'draft' | 'medium' | 'global';
  origin: string | null;
  tags: string[];
  /** Articles other than the origin that have a finding under this decision, and how many. */
  articles: string[];
  count: number;
  hits: Hit[];
};

export const decisionOrigin = (d: Decision): string | null => d.meta.draft ?? /(?:^|\/)drafts\/([^/#]+)\//.exec(d.meta.source)?.[1] ?? null;

export const decisionTags = (d: Decision) => TOPICS.filter((t) => t.decision.test(d.body)).map((t) => t.tag);
export const findingTags = (f: Finding) => TOPICS.filter((t) => { const text = `${f.old}\n${f.reason}`; return t.finding.test(text) && (!t.and || t.and.test(text)); }).map((t) => t.tag);

/** 「…」 phrases of 3+ characters in the decision text. */
export const decisionPhrases = (d: Decision) => [...new Set([...d.body.matchAll(/「([^」\n]{3,40})」/g)].map((m) => m[1]))];

export function matchFinding(d: Decision, f: Finding): { rule: Rule; via: string } | null {
  if ([f.old, f.next, f.reason, f.place].some((t) => t.includes(d.meta.id))) return { rule: 'id', via: d.meta.id };
  if (d.meta.check.type === 'regex') {
    try {
      const m = new RegExp(d.meta.check.pattern).exec(f.old);
      if (m) return { rule: 'check', via: m[0] };
    } catch {
      // a bad pattern is the ledger's problem to report, not a reason to stop counting
    }
  }
  const text = `${f.old}\n${f.reason}`;
  const phrase = decisionPhrases(d).find((p) => text.includes(p));
  if (phrase) return { rule: 'phrase', via: `「${phrase}」` };
  const shared = decisionTags(d).find((t) => findingTags(f).includes(t));
  if (shared) return { rule: 'tag', via: shared };
  return null;
}

/** `only`: keep the decisions that this article's findings fall under (the "new report" view). */
export function countRecurrence(reports: ParsedReport[], decisions: Decision[], only?: string): RecurrenceRow[] {
  const rows: RecurrenceRow[] = [];
  for (const d of decisions) {
    if (d.meta.status !== 'active') continue;
    const origin = decisionOrigin(d);
    const hits: Hit[] = [];
    for (const r of reports) {
      if (r.slug === origin) continue;
      for (const f of r.findings) {
        if (f.klass !== 'auto' && f.klass !== 'decision') continue;
        const m = matchFinding(d, f);
        if (m) hits.push({ slug: r.slug, report: r.report, finding: f.id, klass: f.klass, ...m });
      }
    }
    const articles = [...new Set(hits.map((h) => h.slug))].sort();
    if (only && !articles.includes(only)) continue;
    rows.push({ decision: d.meta.id, scope: d.meta.scope, origin, tags: decisionTags(d), articles, count: articles.length, hits });
  }
  return rows.sort((a, b) => b.count - a.count || a.decision.localeCompare(b.decision));
}

export function renderRecurrence(rows: RecurrenceRow[], reports: ParsedReport[], only?: string): string {
  const articles = new Set(reports.map((r) => r.slug));
  const findings = reports.reduce((n, r) => n + r.findings.filter((f) => f.klass === 'auto' || f.klass === 'decision').length, 0);
  const hit = rows.filter((r) => r.count > 0);
  const lines = [
    `# 再発の数${only ? `：${only} の報告` : ''}`,
    '',
    `報告 ${reports.length}本（記事 ${articles.size}本）、auto／decision の指摘 ${findings}件を、有効な判断 ${rows.length}件${only ? '（この記事の指摘が当たるもの）' : ''}と照合。元の記事は数えない。照合は判断の id・check・「」の語句・テーマのタグ（LLM なし）。`,
  ];
  if (hit.length === 0) lines.push('', '再発はありません。');
  for (const r of hit) {
    lines.push('', `## ${r.decision}：${r.count}本（範囲 ${r.scope}・元 ${r.origin ?? '不明'}）`);
    for (const slug of r.articles) {
      const own = r.hits.filter((h) => h.slug === slug);
      lines.push(`- ${slug}：${own.map((h) => `${h.finding}（${h.klass}・${h.rule}：${h.via}）`).join('、')}`);
    }
  }
  const none = rows.filter((r) => r.count === 0);
  if (none.length) lines.push('', `再発なし：${none.map((r) => r.decision).join('、')}`);
  return `${lines.join('\n')}\n`;
}
