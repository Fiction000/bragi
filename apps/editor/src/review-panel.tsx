import { useEffect, useRef, useState } from 'react';

type Section = { index: number; heading: string; section_id: string; section_sha: string };
type Finding = { finding_id: string; section_id: string; base_revision: string; anchor: { quote: string; occurrence: number }; category: 'auto' | 'decision'; rationale: string; proposal: string; decision_required: boolean; source_refs: string[] };
type Session = { id: string; runId: string; status: string; section_id: string; section_sha: string; result: null | { state: string; findings?: Finding[]; reason?: string }; decisions: { findingId: string; action: string }[]; turns: { message: string; runId: string; status: string }[] };
type ReviewAnchor = { quote: string; sectionIndex: number; heading: string; hasPreface: boolean; number: number };

export default function ReviewPanel({ apiBase, targetId, revision, markdown, save, onApplied, onAnchors }: { apiBase: string; targetId: string; revision: string; markdown: string; save: () => Promise<boolean>; onApplied: (markdown: string, revision: string) => void; onAnchors: (anchors: ReviewAnchor[]) => void }) {
  const [sections, setSections] = useState<Section[]>([]);
  const [sectionId, setSectionId] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [stale, setStale] = useState(false);
  const identity = useRef({ targetId, sectionId });
  const latestMarkdown = useRef(markdown);
  identity.current = { targetId, sectionId };
  latestMarkdown.current = markdown;
  const section = sections.find(item => item.section_id === sectionId) ?? sections[0];
  const endpoint = `${apiBase}/api/reviews`;
  const url = (route: string) => `${endpoint}${route}${route.includes('?') ? '&' : '?'}target=${encodeURIComponent(targetId)}`;
  const request = async (route: string, body?: unknown) => {
    const response = await fetch(url(route), body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error(data.error || 'レビューに接続できません'), { status: response.status, code: data.code });
    return data;
  };
  useEffect(() => { let live = true; setSections([]); setSectionId(''); setSession(null); setStale(false); setAnswers({}); setMessage(''); fetch(url('/enabled')).then(response => response.json()).then(data => { if (live) setEnabled(data.enabled); }).catch(() => { if (live) setEnabled(false); }); return () => { live = false; }; }, [apiBase, targetId]);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    fetch(url('/sections')).then(async response => {
      if (!response.ok) throw new Error('節を読み込めません');
      const data = await response.json();
      if (!Array.isArray(data.sections) || typeof data.revision !== 'string') throw new Error('節の応答が不正です');
      if (live) setSections(data.sections);
    }).catch(() => { if (live) setSections([]); });
    return () => { live = false; };
  }, [enabled, apiBase, targetId, revision]);
  useEffect(() => { if (sections.length && !sections.some(item => item.section_id === sectionId)) setSectionId(sections[0].section_id); }, [sections, sectionId]);
  useEffect(() => { setAnswers({}); }, [targetId, sectionId]);
  useEffect(() => { setSession(null); setStale(false); }, [targetId]);
  useEffect(() => {
    if (!enabled || !section) return;
    let live = true;
    setSession(null);
    const target = targetId, selected = section.section_id;
    request('/session?sectionId=' + encodeURIComponent(selected)).then(data => { if (live && identity.current.targetId === target && identity.current.sectionId === selected) { setSession(data); setStale(Boolean(data?.stale)); } }).catch(() => {});
    return () => { live = false; };
  }, [enabled, section?.section_id, section?.section_sha, targetId]);
  useEffect(() => {
    if (!session || stale || session.result?.state !== 'valid' || session.section_id !== section?.section_id || session.section_sha !== section?.section_sha) { onAnchors([]); return; }
    onAnchors(session.result.findings?.map((finding, number) => ({ quote: finding.anchor.quote, sectionIndex: section.index, heading: section.heading, hasPreface: sections[0]?.heading === '本文', number: number + 1 })) ?? []);
  }, [session?.result, session?.section_id, session?.section_sha, stale, section?.section_id, section?.section_sha, section?.index, section?.heading, sections, onAnchors]);
  useEffect(() => {
    if (!session || !['queued', 'running', 'in_progress'].includes(session.status)) return;
    let live = true;
    const target = targetId, selected = sectionId, sessionId = session.id;
    const receive = (data: Session) => { if (live && identity.current.targetId === target && identity.current.sectionId === selected && data.id === sessionId) setSession(data); };
    const timer = window.setInterval(() => { request(`/${sessionId}`).then(receive).catch(error => { if (live) setError(error.message); }); }, 1200);
    const stream = new EventSource(url(`/${sessionId}/events`));
    stream.onmessage = () => { request(`/${sessionId}`).then(receive).catch(() => {}); };
    return () => { live = false; clearInterval(timer); stream.close(); };
  }, [session?.id, session?.status, targetId, sectionId]);
  if (!enabled || !section) return null;
  const start = async () => {
    const target = targetId, selected = section;
    setError(''); setStale(false); setBusy(true);
    try {
      if (!await save()) throw new Error('本文を保存してからレビューを始めてください');
      if (identity.current.targetId !== target || identity.current.sectionId !== selected.section_id) return;
      const draftResponse = await fetch(`${apiBase}/api/drafts/${target}`);
      if (!draftResponse.ok) throw new Error('保存済みの本文を読み込めません');
      const saved = await draftResponse.json();
      const sectionResponse = await request('/sections');
      const savedSections = sectionResponse.sections as Section[];
      if (identity.current.targetId !== target || identity.current.sectionId !== selected.section_id) return;
      if (sectionResponse.revision !== saved.revision || !savedSections.some(item => item.section_id === selected.section_id)) throw new Error('節の構成が変わりました。最新版から選び直してください');
      const started = await request('/start', { sectionId: selected.section_id, baseRevision: saved.revision });
      if (identity.current.targetId === target && identity.current.sectionId === selected.section_id) setSession(started);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const apply = async (finding: Finding) => {
    const target = targetId, selected = sectionId, source = latestMarkdown.current;
    if (busy) return;
    setError(''); setBusy(true);
    try {
      if (!await save()) throw new Error('本文を保存してから採用してください');
      if (identity.current.targetId !== target || identity.current.sectionId !== selected) return;
      const result = await request(`/${session!.id}/apply`, { findingId: finding.finding_id });
      if (identity.current.targetId !== target || identity.current.sectionId !== selected || latestMarkdown.current !== source) return;
      onApplied(result.markdown, result.revision);
      setSession(await request(`/${session!.id}`));
    } catch (e) { const err = e as Error & { code?: string }; if (err.code === 'stale') setStale(true); setError(err.message); }
    finally { setBusy(false); }
  };
  const discard = async (finding: Finding) => { const target = targetId, selected = sectionId, sessionId = session!.id; try { const data = await request(`/${sessionId}/discard`, { findingId: finding.finding_id }); if (identity.current.targetId === target && identity.current.sectionId === selected) setSession(data); } catch (e) { if (identity.current.targetId === target && identity.current.sectionId === selected) setError((e as Error).message); } };
  const talk = async () => { if (!message.trim()) return; const target = targetId, selected = sectionId, sessionId = session!.id, text = message; setBusy(true); setError(''); try { const data = await request(`/${sessionId}/talk`, { message: text }); if (identity.current.targetId === target && identity.current.sectionId === selected) { setSession(data); setMessage(''); } } catch (e) { if (identity.current.targetId === target && identity.current.sectionId === selected) setError((e as Error).message); } finally { setBusy(false); } };
  const propose = async (finding: Finding) => { const answer = answers[finding.finding_id] ?? ''; const target = targetId, selected = sectionId, sessionId = session!.id; setBusy(true); setError(''); try { await request(`/${sessionId}/propose`, { findingId: finding.finding_id, answer }); if (identity.current.targetId === target && identity.current.sectionId === selected) { setAnswers(current => ({ ...current, [finding.finding_id]: '' })); setSession(await request(`/${sessionId}`)); } } catch (e) { if (identity.current.targetId === target && identity.current.sectionId === selected) setError((e as Error).message); } finally { setBusy(false); } };
  const openTalk = () => document.getElementById('review-message')?.focus();
  const done = (finding: Finding) => session?.decisions.some(item => item.findingId === finding.finding_id);
  return <aside className="review-panel" aria-label="エージェントレビュー">
    <header><span>節レビュー</span><label>対象の節<select aria-label="レビューする節" value={section.section_id} disabled={busy} onChange={event => setSectionId(event.target.value)}>{sections.map((item, index) => <option key={item.section_id} value={item.section_id}>{index + 1}. {item.heading}</option>)}</select></label></header>
    {!session && <button type="button" className="review-start" disabled={busy} onClick={() => void start()}>この節をレビュー</button>}
    {session && <><div className="review-meta">基準版 {session.id.slice(0, 8)} · {session.status}</div>
      {(['failed', 'cancelled', 'interrupted', 'discarded'].includes(session.status) || session.result?.state === 'invalid') && <button type="button" className="review-start" disabled={busy} onClick={() => void start()}>最新版で再レビュー</button>}
      {['queued', 'running', 'in_progress'].includes(session.status) && <p className="review-progress" role="status">レビューを生成中<br />指摘を受け取っています…</p>}
      {session.result?.state === 'invalid' && <p role="alert">形式が合わないため、提案を採用できません。</p>}
      {session.result?.state === 'failed' && <p role="alert">レビューに失敗しました。もう一度開始してください。</p>}
      {stale && <div className="review-stale"><strong>節が更新されています</strong><p>この案は適用できません。</p><button onClick={() => void start()}>最新版で再レビュー</button><button onClick={async () => { try { await request(`/${session.id}/discard`, { discardAll: true }); setSession(null); setStale(false); } catch (e) { setError((e as Error).message); } }}>この案を捨てる</button></div>}
      {!stale && session.result?.state === 'valid' && session.result.findings?.map((finding, index) => <article className="review-finding" key={finding.finding_id}>
        <h3>{['①','②','③','④','⑤','⑥','⑦','⑧','⑨','⑩'][index] ?? `#${index + 1}`} {finding.category === 'decision' ? '判断が必要' : '修正案'}</h3><p>{finding.rationale}</p><p className="review-current">現在: {finding.anchor.quote}</p><p className="review-proposal">案: {finding.proposal}</p>
        {done(finding) ? <p className="review-decision">{session.decisions.find(item => item.findingId === finding.finding_id)?.action === 'applied' ? '採用しました' : session.decisions.find(item => item.findingId === finding.finding_id)?.action === 'proposed' ? '判断の候補を作成しました' : 'この案を処理しました'}</p> : <div className="review-actions"><button disabled={busy} onClick={() => void apply(finding)}>採る</button><button disabled={busy} onClick={() => void discard(finding)}>捨てる</button><button disabled={busy} onClick={openTalk}>話す</button></div>}
        {finding.decision_required && session.turns.some(turn => turn.runId === session.runId && ['completed', 'succeeded'].includes(turn.status)) && !done(finding) && <div className="review-answer"><label htmlFor={`review-answer-${index}`}>回答から判断の候補を作る</label><textarea id={`review-answer-${index}`} value={answers[finding.finding_id] ?? ''} onChange={event => setAnswers(current => ({ ...current, [finding.finding_id]: event.target.value }))} /><button disabled={busy || !(answers[finding.finding_id] ?? '').trim()} onClick={() => void propose(finding)}>候補を作る</button></div>}
      </article>)}
      {session.turns?.map((turn, index) => <p className="review-turn" key={index}>あなた: {turn.message}</p>)}
      {session.result?.state === 'valid' && <div className="review-chat"><label htmlFor="review-message">話す</label><textarea id="review-message" value={message} onChange={event => setMessage(event.target.value)} /><button disabled={busy || !message.trim()} onClick={() => void talk()}>送る</button></div>}
    </>}
    {error && <p className="review-error" role="alert">{error}</p>}
  </aside>;
}
