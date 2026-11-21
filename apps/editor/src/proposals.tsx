import { useCallback, useEffect, useState } from 'react';
import { Markdown } from './ledger';
import './dashboard.css';

type Meta = { id: string; proposed_by: string; proposed_at: string; status: 'pending' | 'adopted' | 'rejected'; scope: 'draft' | 'medium' | 'global'; medium: string | null; draft: string | null; kind: string; source: string; check: { type: string; pattern?: string }; resolved_at?: string; adopted_as?: string };
type Proposal = { meta: Meta; body: string; file: string };
type Data = { dir: string; proposals: Proposal[]; problems: { file: string; message: string }[] };

const SCOPE = { draft: '記事', medium: '媒体', global: '全体' } as const;
const KIND: Record<string, string> = { fact: '事実', phrasing: '言い回し', structure: '構成', 'fact-policy': '事実の方針', 'tag-policy': 'タグの方針' };

// 候補は台帳の外にある提案。ここで「採る」と台帳に新しい判断が1件入り、候補は adopted で残る。「捨てる」は候補を rejected にするだけ。
export default function ProposalsPage() {
  const [data, setData] = useState<Data>();
  const [error, setError] = useState('');
  const [showResolved, setShowResolved] = useState(false);
  const load = useCallback(() => fetch('/api/proposals').then(async r => { const b = await r.json(); if (!r.ok) throw new Error(b.error); return b; }).then(setData).catch(e => setError(String(e.message ?? e))), []);
  useEffect(() => { load(); }, [load]);

  async function resolve(p: Proposal, action: 'adopt' | 'reject') {
    const first = p.body.split('\n')[0];
    const ask = action === 'adopt'
      ? `この候補を判断として台帳に入れますか？\n\n${first}\n\n範囲：${SCOPE[p.meta.scope]}${p.meta.draft ?? p.meta.medium ?? ''}。以後、この範囲の記事の brief に入ります。`
      : `この候補を捨てますか？\n\n${first}\n\nファイルは残り、状態が「捨てた」になります。台帳には入りません。`;
    if (!window.confirm(ask)) return;
    const r = await fetch(`/api/proposals/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: p.meta.id }) });
    if (!r.ok) { setError((await r.json()).error); load(); return; }
    setError('');
    load();
  }

  if (error && !data) return <main className="dash"><h1>判断の候補</h1><p role="alert" className="dash-error">候補を読めませんでした：{error}</p><p><a href="#/ledger">判断台帳へ</a></p></main>;
  if (!data) return <main className="dash" aria-busy="true" />;
  const pending = data.proposals.filter(p => p.meta.status === 'pending');
  const shown = data.proposals.filter(p => showResolved || p.meta.status === 'pending');
  return <main className="dash ledger proposals">
    <header><h1>判断の候補</h1><p className="dash-meta">未決 {pending.length}件　採った {data.proposals.filter(p => p.meta.status === 'adopted').length}件　捨てた {data.proposals.filter(p => p.meta.status === 'rejected').length}件　<a href="#/ledger">判断台帳</a>　<a href="#/">下書きの一覧へ</a></p></header>
    <p className="dash-meta">エージェントが出した提案です。採るまで台帳には入りません。</p>
    <label className="ledger-toggle"><input type="checkbox" checked={showResolved} onChange={e => setShowResolved(e.target.checked)} /> 採った・捨てたものも表示</label>
    {error && <p role="alert" className="dash-error">{error}</p>}
    <table>
      <thead><tr><th>範囲</th><th>種類</th><th>候補</th><th>提案</th><th>出どころ</th><th><span className="sr-only">操作</span></th></tr></thead>
      <tbody>{shown.map(p => <tr key={p.meta.id} data-id={p.meta.id} data-status={p.meta.status} data-scope={p.meta.scope}>
        <td>{SCOPE[p.meta.scope]}<small>{p.meta.scope === 'medium' ? p.meta.medium : p.meta.scope === 'draft' ? p.meta.draft : ''}</small></td>
        <td>{KIND[p.meta.kind] ?? p.meta.kind}</td>
        <td className="ledger-body"><Markdown text={p.body} />{p.meta.check.type === 'regex' && <small>機械チェック：<code>{p.meta.check.pattern}</code></small>}</td>
        <td className="nowrap">{p.meta.proposed_at}<small>{p.meta.proposed_by}</small></td>
        <td className="ledger-source">{p.meta.source}</td>
        <td className="nowrap">{p.meta.status === 'pending'
          ? <><button className="adopt" onClick={() => resolve(p, 'adopt')}>採る</button> <button className="retire" onClick={() => resolve(p, 'reject')}>捨てる</button></>
          : <span className="tag">{p.meta.status === 'adopted' ? `採った ${p.meta.resolved_at}` : `捨てた ${p.meta.resolved_at}`}</span>}{p.meta.adopted_as && <small>{p.meta.adopted_as}</small>}</td>
      </tr>)}</tbody>
    </table>
    {shown.length === 0 && <p className="dash-empty">未決の候補はありません。</p>}
    {data.problems.length > 0 && <ul className="dash-warnings" role="status">{data.problems.map(p => <li key={p.file}>{p.file}：{p.message}</li>)}</ul>}
    <footer>{data.dir}</footer>
  </main>;
}
