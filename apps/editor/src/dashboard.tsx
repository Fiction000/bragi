import { useEffect, useState } from 'react';
import './dashboard.css';

type Ci = { state: 'success' | 'failure' | 'pending' | 'none'; total: number; failing: string[]; pending: number };
type Gate = { verdict: 'MERGE_OK' | 'NEEDS_AUTHOR' | 'MANUAL_CHECK' | 'BLOCKED'; headSha: string | null; stale: boolean; at: string; url: string | null };
type Pr = { url: string; number: number; state: 'open' | 'merged' | 'closed' | 'unknown'; error?: string; via?: 'record' | 'report' | 'branch'; branch?: string; ci?: Ci | null; gate?: Gate | null; unresolvedReviews?: number | null };
type Run = { key: string; relPath: string; targets: { id: string; title: string; finished: boolean }[] };
type Draft = {
  slug: string; title: string; medium: string | null; stage: string; stageLabel: string; waitingOn: 'agent' | 'author' | 'ci' | 'none';
  openDecisions: number | null; placeholders: string[]; due: string | null; dueFrom: string | null; source: 'folder' | 'manual'; prs: Pr[]; editorRuns: Run[]; overridden: boolean; reasons: string[]; warnings: string[];
};
type Scan = { root: string; author: string; scannedAt: string; drafts: Draft[]; skippedFiles: string[]; warnings: string[] };

const waitingLabel = (author: string) => ({ agent: 'エージェント', author, ci: 'CI', none: '—' }) as const;
const CI_LABEL = { success: 'CI ✓', failure: 'CI ✗', pending: 'CI 実行中', none: 'CI なし' } as const;
const gateLabel = (author: string) => ({ MERGE_OK: 'gate: マージ可', NEEDS_AUTHOR: `gate: ${author}確認`, MANUAL_CHECK: 'gate: 手動確認', BLOCKED: 'gate: 止め' }) as const;
const PR_STATE = { open: 'open', merged: 'merged', closed: 'closed', unknown: '状態不明' } as const;
// 著者待ちを上に。待ち先ごとに題名順。
const ORDER = { author: 0, ci: 1, agent: 2, none: 3 } as const;

export default function Dashboard({ onOpen }: { onOpen?: (path: string) => void }) {
  const [scan, setScan] = useState<Scan>();
  const [error, setError] = useState('');
  const [showPublished, setShowPublished] = useState(false);
  useEffect(() => {
    fetch('/api/dashboard').then(async r => { const body = await r.json(); if (!r.ok) throw new Error(body.error); return body; }).then(setScan).catch(e => setError(String(e.message ?? e)));
  }, []);
  if (error) return <main className="dash"><h1>下書きの一覧</h1><p role="alert" className="dash-error">一覧を読めませんでした：{error}</p></main>;
  if (!scan) return <main className="dash" aria-busy="true" />;
  const drafts = [...scan.drafts].sort((a, b) => ORDER[a.waitingOn] - ORDER[b.waitingOn] || a.title.localeCompare(b.title, 'ja'));
  const visibleDrafts = showPublished ? drafts : drafts.filter(d => d.stage !== 'published');
  const waitingCount = visibleDrafts.filter(d => d.waitingOn === 'author').length;
  const waitLabel = waitingLabel(scan.author), gates = gateLabel(scan.author);
  return <main className="dash">
    <header><h1>下書きの一覧</h1><p className="dash-meta">{visibleDrafts.length}本　{scan.author}待ち {waitingCount}本　読み取り専用　<a href="#/ledger">判断台帳</a></p></header>
    <label className="ledger-toggle"><input type="checkbox" checked={showPublished} onChange={e => setShowPublished(e.target.checked)} /> 公開済みも表示</label>
    <table>
      <thead><tr><th>題名</th><th>媒体</th><th>段階</th><th>待ち先</th><th className="num">未決</th><th>期限</th><th>PR</th><th><span className="sr-only">開く</span></th></tr></thead>
      <tbody>{visibleDrafts.map(d => {
        const open = d.editorRuns.find(r => r.targets.some(t => !t.finished)) ?? d.editorRuns[0];
        return <tr key={d.slug} data-slug={d.slug} data-waiting={d.waitingOn} data-stage={d.stage}>
          <td className="title">{d.title}<small>{d.slug}</small>{d.warnings.length > 0 && <span className="warn" title={d.warnings.join('\n')}>要確認</span>}{d.source === 'manual' && <span className="tag" title="drafts.index.yaml に手で登録">手で登録</span>}</td>
          <td>{d.medium ?? '—'}</td>
          <td title={d.reasons.join('\n')}>{d.stageLabel}{d.overridden && <span className="tag">手動</span>}</td>
          <td className={`waiting-${d.waitingOn}`}>{waitLabel[d.waitingOn]}</td>
          <td className="num" title={d.placeholders.length ? `本文の未記入: ${d.placeholders.join(' / ')}` : undefined}>{d.openDecisions ?? '—'}</td>
          <td title={d.dueFrom ? `期限の出どころ: ${d.dueFrom}` : undefined}>{d.due ?? '—'}</td>
          <td>{d.prs.length === 0 ? '—' : d.prs.map(p => <div key={p.url} className={`pr pr-${p.state}`}>
            <a href={p.url} target="_blank" rel="noreferrer" title={[p.error, p.via && p.via !== 'record' ? (p.via === 'branch' ? `ブランチ名 ${p.branch} での突き合わせ（推測）` : '報告の記載から拾った（推測）') : ''].filter(Boolean).join('\n') || undefined}>#{p.number} {PR_STATE[p.state]}</a>
            {p.via && p.via !== 'record' && <span className="guess">推測</span>}
            {p.state === 'open' && p.ci && <span className={`badge ci-${p.ci.state}`} title={p.ci.failing.length ? `失敗: ${p.ci.failing.join(', ')}` : undefined}>{CI_LABEL[p.ci.state]}</span>}
            {p.state === 'open' && (p.gate ? <a className={`badge gate-${p.gate.verdict}${p.gate.stale ? ' stale' : ''}`} href={p.gate.url ?? undefined} target="_blank" rel="noreferrer" title={p.gate.stale ? '古い head への判定' : undefined}>{gates[p.gate.verdict]}{p.gate.stale && '（古い）'}</a> : p.ci && <span className="badge gate-none">gate 未判定</span>)}
            {p.state === 'open' && !!p.unresolvedReviews && <span className="badge review">未解決 {p.unresolvedReviews}</span>}
          </div>)}</td>
          <td>{open ? <a className="open" href={`/r/${open.key}/`} onClick={e => { if (onOpen && !newTab(e)) { e.preventDefault(); onOpen(`/r/${open.key}/`); } }}>開く</a> : <span className="none">—</span>}</td>
        </tr>;
      })}</tbody>
    </table>
    {scan.warnings.length > 0 && <ul className="dash-warnings" role="status">{scan.warnings.map(w => <li key={w}>{w}</li>)}</ul>}
    {scan.drafts.length === 0 && <p className="dash-empty">{scan.root} に記事のフォルダがありません。</p>}
    {scan.drafts.length > 0 && visibleDrafts.length === 0 && <p className="dash-empty">未公開の下書きはありません。</p>}
    <footer>{scan.root}　／　{new Date(scan.scannedAt).toLocaleString('ja-JP')} に読み込み{scan.skippedFiles.length > 0 && `　／　フォルダでない単独ファイル ${scan.skippedFiles.length} 件は対象外`}</footer>
  </main>;
}

// Cmd/Ctrl/Shift/Alt or a non-primary click keeps the browser's own link behavior (new tab, new window).
const newTab = (e: { button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }) => e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey;
