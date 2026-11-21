import { useCallback, useEffect, useState } from 'react';
import './dashboard.css';

type Meta = { id: string; scope: 'draft' | 'medium' | 'global'; medium: string | null; draft: string | null; kind: string; status: 'active' | 'retired'; decided_by: string; decided_at: string; source: string; check: { type: string }; retired_at?: string };
type Decision = { meta: Meta; body: string; file: string };
type Ledger = { dir: string; decisions: Decision[]; problems: { file: string; message: string }[] };

const SCOPE = { draft: '記事', medium: '媒体', global: '全体' } as const;
const KIND: Record<string, string> = { fact: '事実', phrasing: '言い回し', structure: '構成', 'fact-policy': '事実の方針', 'tag-policy': 'タグの方針' };

// The decision text is Markdown, but only the little that decisions use: paragraphs, line breaks, **bold**, `code`.
// It is built as React elements from plain text, so nothing in a file can become HTML.
function inline(text: string, key: string) {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/).filter(Boolean).map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) return <strong key={`${key}${i}`}>{part.slice(2, -2)}</strong>;
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) return <code key={`${key}${i}`}>{part.slice(1, -1)}</code>;
    return part;
  });
}
export function Markdown({ text }: { text: string }) {
  return <>{text.trim().split(/\n\s*\n/).map((para, i) => <p key={i}>{para.split('\n').flatMap((line, j) => [j > 0 ? <br key={`b${j}`} /> : null, ...inline(line, `${i}-${j}-`)])}</p>)}</>;
}

export default function LedgerPage() {
  const [ledger, setLedger] = useState<Ledger>();
  const [error, setError] = useState('');
  const [showRetired, setShowRetired] = useState(false);
  const load = useCallback(() => fetch('/api/ledger').then(async r => { const b = await r.json(); if (!r.ok) throw new Error(b.error); return b; }).then(setLedger).catch(e => setError(String(e.message ?? e))), []);
  useEffect(() => { load(); }, [load]);

  async function retire(d: Decision) {
    if (!window.confirm(`この判断を取り消しますか？\n\n${d.body.split('\n')[0]}\n\nファイルは残り、状態が「取り消し済み」になります。`)) return;
    const r = await fetch('/api/ledger/retire', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: d.meta.id }) });
    if (!r.ok) { setError((await r.json()).error); return; }
    setError('');
    load();
  }

  if (error && !ledger) return <main className="dash"><h1>判断台帳</h1><p role="alert" className="dash-error">台帳を読めませんでした：{error}</p><p><a href="#/">一覧へ</a></p></main>;
  if (!ledger) return <main className="dash" aria-busy="true" />;
  const shown = ledger.decisions.filter(d => showRetired || d.meta.status === 'active');
  const retired = ledger.decisions.length - ledger.decisions.filter(d => d.meta.status === 'active').length;
  return <main className="dash ledger">
    <header><h1>判断台帳</h1><p className="dash-meta">有効 {ledger.decisions.length - retired}件　取り消し済み {retired}件　<a href="#/proposals">判断の候補</a>　<a href="#/">下書きの一覧へ</a></p></header>
    <label className="ledger-toggle"><input type="checkbox" checked={showRetired} onChange={e => setShowRetired(e.target.checked)} /> 取り消し済みも表示</label>
    {error && <p role="alert" className="dash-error">{error}</p>}
    <table>
      <thead><tr><th>範囲</th><th>種類</th><th>判断</th><th>決めた日</th><th>出どころ</th><th><span className="sr-only">操作</span></th></tr></thead>
      <tbody>{shown.map(d => <tr key={d.meta.id} data-id={d.meta.id} data-status={d.meta.status} data-scope={d.meta.scope}>
        <td>{SCOPE[d.meta.scope]}<small>{d.meta.scope === 'medium' ? d.meta.medium : d.meta.scope === 'draft' ? d.meta.draft : ''}</small></td>
        <td>{KIND[d.meta.kind] ?? d.meta.kind}</td>
        <td className="ledger-body"><Markdown text={d.body} /></td>
        <td className="nowrap">{d.meta.decided_at}<small>{d.meta.decided_by}</small></td>
        <td className="ledger-source">{d.meta.source}</td>
        <td>{d.meta.status === 'active' ? <button className="retire" onClick={() => retire(d)}>取り消す</button> : <span className="tag">取り消し済み {d.meta.retired_at}</span>}</td>
      </tr>)}</tbody>
    </table>
    {shown.length === 0 && <p className="dash-empty">表示する判断がありません。</p>}
    {ledger.problems.length > 0 && <ul className="dash-warnings" role="status">{ledger.problems.map(p => <li key={p.file}>{p.file}：{p.message}</li>)}</ul>}
    <footer>{ledger.dir}</footer>
  </main>;
}
