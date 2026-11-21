import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import { Markdown } from '@tiptap/markdown';
import { Extension, type Editor } from '@tiptap/core';
import { changedBlockIndices, randomUUID } from './model';
import { apiBase } from './base';

type Note = { id: string; anchor: { blockIndex: number; text: string }; body: string };
type State = { markdown: string; notes: Note[] };
type Target = { id: string; title: string; medium: string; version: string; finished: boolean };
type Save = 'clean' | 'dirty' | 'saving' | 'saved' | 'failed' | 'conflict' | 'backupFailed';
type Finish = 'idle' | 'finishing' | 'finished' | 'finishFailed';
type Model = { save: Save; finish: Finish };
type Event = { type: 'edit' | 'saving' | 'saved' | 'failed' | 'conflict' | 'backupFailed' | 'finish' | 'finished' | 'finishFailed' | 'reset' };
const reducer = (m: Model, e: Event): Model => {
  if (e.type === 'reset') return { save: 'clean', finish: 'idle' };
  if (e.type === 'edit') return { save: 'dirty', finish: 'idle' };
  if (e.type === 'saving') return { ...m, save: 'saving' };
  if (e.type === 'saved') return { ...m, save: 'saved' };
  if (e.type === 'failed' || e.type === 'conflict' || e.type === 'backupFailed') return { ...m, save: e.type };
  if (e.type === 'finish') return { ...m, finish: 'finishing' };
  return { ...m, finish: e.type };
};
const statuses: Record<Save, string> = { clean: '保存済み', dirty: '', saving: '保存中…', saved: '保存済み', failed: '保存できませんでした', conflict: 'ファイルが別の場所で変更されました', backupFailed: '変更をこのMacに保持できませんでした' };
const norm = (s: string) => s.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').trim();
const blocks = (s: string) => s.split(/\n\s*\n/).map(x => x.replace(/^#{1,6}\s+|^>\s?|^[-*+]\s+|^\d+\.\s+/gm, '').replace(/[*_`\[\]()]/g, '').trim()).filter(Boolean);
const changed = (a: string[], b: string[]) => { const d = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0)); for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) d[i][j] = a[i] === b[j] ? d[i + 1][j + 1] + 1 : Math.max(d[i + 1][j], d[i][j + 1]); return Math.max(a.length, b.length) - d[0][0]; };
const changedMarker = Extension.create({
  name: 'changedMarker',
  addGlobalAttributes() {
    return [{
      types: ['paragraph', 'heading', 'blockquote', 'bulletList', 'orderedList', 'listItem'],
      attributes: {
        changed: {
          default: false,
          parseHTML: element => element.getAttribute('data-changed') === 'true',
          renderHTML: attributes => attributes.changed ? { 'data-changed': 'true' } : {},
        },
      },
    }];
  },
});
const markChanged = (editor: Editor, source: string, current: string) => {
  const changed = changedBlockIndices(blocks(source), blocks(current));
  const transaction = editor.state.tr;
  let index = 0;
  transaction.doc.forEach((node, position) => {
    const shouldMark = changed.has(index++);
    if (node.attrs.changed !== shouldMark) transaction.setNodeMarkup(position, undefined, { ...node.attrs, changed: shouldMark });
  });
  if (transaction.docChanged) editor.view.dispatch(transaction);
};


export default function App() {
  const [targets, setTargets] = useState<Target[]>([]);
  const [target, setTarget] = useState<Target>();
  const [source, setSource] = useState('');
  const [draft, setDraft] = useState<State>({ markdown: '', notes: [] });
  const [model, dispatch] = useReducer(reducer, { save: 'clean', finish: 'idle' });
  const shellRef = useRef<HTMLElement | null>(null);
  const [noteTops, setNoteTops] = useState<Record<string, number>>({});
  const [plusTops, setPlusTops] = useState<{ index: number; top: number }[]>([]);
  const [activeBlock, setActiveBlock] = useState(-1);
  const [readonly, setReadonly] = useState(false);
  const [switcher, setSwitcher] = useState(false);
  const [selected, setSelected] = useState('');
  const base = useRef('source');
  const state = useRef(draft); state.current = draft;
  const currentTarget = useRef(target); currentTarget.current = target;
  const status = useRef(model); status.current = model;
  const readonlyRef = useRef(readonly); readonlyRef.current = readonly;
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const composing = useRef(false);
  const trailingNewlines = useRef('');
  const loading = useRef(false);
  const runId = useRef('run');
  const storageKey = (id: string) => `wle:${runId.current}:${id}`;
  const readEditorMarkdown = () => {
    const markdown = editor?.getMarkdown() ?? '';
    return markdown.replace(/\n*$/, trailingNewlines.current);
  };
  const editor = useEditor({
    extensions: [StarterKit, Link.configure({ openOnClick: false }), Markdown, changedMarker],
    content: '',
    onUpdate: ({ editor: e }) => { if (loading.current || e.view.composing) return; composing.current = false; const markdown = readEditorMarkdown(); markChanged(e, source, markdown); setDraft(s => ({ ...s, markdown })); dispatch({ type: 'edit' }); planSave(); },
    onSelectionUpdate: ({ editor: e }) => setSelected(e.state.doc.textBetween(e.state.selection.from, e.state.selection.to, ' ')),
  });
  const save = useCallback(async () => {
    const t = currentTarget.current;
    if (!t || readonlyRef.current || !['dirty', 'failed', 'conflict'].includes(status.current.save)) return status.current.save === 'saved' || status.current.save === 'clean';
    const snapshot = structuredClone(state.current);
    try { localStorage.setItem(storageKey(t.id), JSON.stringify({ state: snapshot, baseRevision: base.current, savedAt: new Date().toISOString() })); }
    catch { dispatch({ type: 'backupFailed' }); return false; }
    dispatch({ type: 'saving' });
    try {
      const r = await fetch(`${apiBase}/api/drafts/${t.id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ state: snapshot, baseRevision: base.current }) });
      if (r.status === 409) { dispatch({ type: 'conflict' }); return false; }
      if (!r.ok) throw new Error();
      const result = await r.json(); base.current = result.revision;
      if (JSON.stringify(state.current) === JSON.stringify(snapshot)) { localStorage.removeItem(storageKey(t.id)); dispatch({ type: 'reset' }); dispatch({ type: 'saved' }); return true; }
      dispatch({ type: 'edit' }); return false;
    } catch { dispatch({ type: 'failed' }); return false; }
  }, []);
  const planSave = useCallback(() => { clearTimeout(timer.current); timer.current = setTimeout(() => { if (!composing.current && !editor?.view.composing) void save(); }, 800); }, [editor, save]);

  const load = useCallback(async (id: string, preserve = false) => {
    const r = await fetch(`${apiBase}/api/drafts/${id}`); if (!r.ok) return;
    const data = await r.json(); loading.current = true; base.current = data.revision; runId.current = r.headers.get('x-editor-run-id') ?? runId.current;
    trailingNewlines.current = data.state.markdown.match(/\n*$/)?.[0] ?? '';
    setTarget({ ...data.target, finished: data.finished }); setSource(data.sourceMarkdown); setDraft(data.state); dispatch({ type: 'reset' });
    const parsed = editor?.markdown?.parse(data.sourceMarkdown);
    const serialized = parsed ? editor?.markdown?.serialize(parsed) : data.sourceMarkdown;
    const unsupported = norm(serialized ?? data.sourceMarkdown) !== norm(data.sourceMarkdown); setReadonly(unsupported);
    editor?.setEditable(!unsupported); editor?.commands.setContent(data.state.markdown, { contentType: 'markdown' });
    if (editor) markChanged(editor, data.sourceMarkdown, data.state.markdown);
    const k = storageKey(id); const backupKey = preserve ? `${k}:conflict-${Date.now()}` : k;
    try {
      const raw = localStorage.getItem(k);
      if (raw) { const backup = JSON.parse(raw); if (JSON.stringify(backup.state) !== JSON.stringify(data.state)) { if (preserve) localStorage.setItem(backupKey, raw); setDraft(backup.state); base.current = backup.baseRevision; editor?.commands.setContent(backup.state.markdown, { contentType: 'markdown' }); if (editor) markChanged(editor, data.sourceMarkdown, backup.state.markdown); dispatch({ type: 'edit' }); if (!unsupported) setTimeout(() => void save(), 0); } }
    } catch {}
    queueMicrotask(() => { loading.current = false; });
  }, [editor, save]);
  useEffect(() => { fetch(`${apiBase}/api/targets`).then(r => r.json()).then((items: Target[]) => { setTargets(items); if (items[0]) void load(items[0].id); }); }, [load]);
  useEffect(() => { if (!editor) return; const dom = editor.view.dom; const start = () => { composing.current = true; clearTimeout(timer.current); if (!readonlyRef.current) dispatch({ type: 'edit' }); }; const end = () => { composing.current = false; const markdown = readEditorMarkdown(); if (markdown !== state.current.markdown) { setDraft(s => ({ ...s, markdown })); dispatch({ type: 'edit' }); } planSave(); }; dom.addEventListener('compositionstart', start); dom.addEventListener('compositionend', end); return () => { dom.removeEventListener('compositionstart', start); dom.removeEventListener('compositionend', end); }; }, [editor, planSave]);
  useEffect(() => { const fn = (e: BeforeUnloadEvent) => { if (['dirty', 'saving', 'failed', 'conflict', 'backupFailed'].includes(model.save)) { e.preventDefault(); e.returnValue = ''; } }; window.addEventListener('beforeunload', fn); return () => window.removeEventListener('beforeunload', fn); }, [model.save]);
  useEffect(() => { const fn = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'o') { e.preventDefault(); setSwitcher(true); } if (e.key === 'Escape') setSwitcher(false); }; window.addEventListener('keydown', fn); return () => window.removeEventListener('keydown', fn); }, []);

  const updateNote = (id: string, body: string) => { const notes = state.current.notes.map(n => n.id === id ? { ...n, body } : n).filter(n => n.body.trim()); setDraft(s => ({ ...s, notes })); dispatch({ type: 'edit' }); planSave(); };
  const addNote = (index: number) => { const list = blocks(state.current.markdown); const note = { id: randomUUID(), anchor: { blockIndex: index, text: list[index] ?? '' }, body: '' }; setDraft(s => ({ ...s, notes: [...s.notes, note] })); dispatch({ type: 'edit' }); planSave(); setTimeout(() => document.querySelector<HTMLElement>(`[data-note="${note.id}"]`)?.focus(), 0); };
  const switchTo = async (id: string) => { if (['dirty', 'failed', 'conflict', 'backupFailed'].includes(status.current.save) && !await save()) return; setSwitcher(false); await load(id); };
  const finish = async () => { if (['dirty', 'failed'].includes(status.current.save) && !await save()) return; dispatch({ type: 'finish' }); try { const r = await fetch(`${apiBase}/api/drafts/${target!.id}/finish`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ baseRevision: base.current }) }); if (!r.ok) throw new Error(); const result = await r.json(); (state.current as State & { changedBlocks?: number }).changedBlocks = result.changedBlocks; dispatch({ type: 'finished' }); setTargets(xs => xs.map(x => x.id === target!.id ? { ...x, finished: true } : x)); } catch { dispatch({ type: 'finishFailed' }); } };
  const openServerVersion = async (saveBackup: boolean) => { const key = storageKey(target!.id); try { const b = localStorage.getItem(key); if (b && saveBackup) localStorage.setItem(`${key}:conflict-${Date.now()}`, b); localStorage.removeItem(key); } catch {} await load(target!.id); };

  // Align each note to the real top of its anchored block; stack downward so notes never overlap.
  useLayoutEffect(() => {
    const shell = shellRef.current;
    if (!editor || !shell) return;
    const measure = () => {
      const list = blocks(state.current.markdown);
      const children = Array.from(editor.view.dom.children) as HTMLElement[];
      const shellTop = shell.getBoundingClientRect().top;
      const next: Record<string, number> = {};
      let floor = 0;
      for (const note of draft.notes) {
        let idx = list.indexOf(note.anchor.text);
        if (idx < 0) idx = note.anchor.blockIndex;
        const el = children[Math.min(Math.max(idx, 0), children.length - 1)];
        const top = Math.max(el ? el.getBoundingClientRect().top - shellTop : 0, floor);
        next[note.id] = Math.round(top);
        const label = shell.querySelector<HTMLElement>(`[data-note="${note.id}"]`)?.parentElement;
        floor = top + (label?.offsetHeight ?? 44) + 12;
      }
      setNoteTops(prev => JSON.stringify(prev) === JSON.stringify(next) ? prev : next);
      const noted = new Set(draft.notes.map(n => { const i = list.indexOf(n.anchor.text); return i < 0 ? n.anchor.blockIndex : i; }));
      const plus = children.flatMap((el, index) => el.dataset.changed === 'true' && !noted.has(index) ? [{ index, top: Math.round(el.getBoundingClientRect().top - shellTop) }] : []);
      setPlusTops(prev => JSON.stringify(prev) === JSON.stringify(plus) ? prev : plus);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(editor.view.dom);
    return () => ro.disconnect();
  });

  // The ＋ lives in the right margin, outside the paragraph box, so track the row band (column + both margins) rather than CSS :hover.
  useEffect(() => {
    if (!editor) return;
    const rowAt = (y: number) => (Array.from(editor.view.dom.children) as HTMLElement[]).findIndex(el => { const r = el.getBoundingClientRect(); return y >= r.top - 15 && y <= r.bottom + 15; });
    const onMove = (e: MouseEvent) => {
      const shell = shellRef.current; if (!shell) return;
      const r = shell.getBoundingClientRect();
      setActiveBlock(e.clientX >= r.left - 60 && e.clientX <= r.right + 90 ? rowAt(e.clientY) : -1);
    };
    window.addEventListener('mousemove', onMove);
    return () => window.removeEventListener('mousemove', onMove);
  }, [editor]);
  const [, setFocusTick] = useState(0);
  useEffect(() => { if (!editor) return; const f = () => setFocusTick(t => t + 1); editor.on('focus', f); editor.on('blur', f); editor.on('selectionUpdate', f); return () => { editor.off('focus', f); editor.off('blur', f); editor.off('selectionUpdate', f); }; }, [editor]);
  const caretBlock = editor && !editor.isDestroyed && editor.isFocused ? editor.state.selection.$from.index(0) : -1;

  if (targets.length === 0) return <main className="empty"><header>原稿</header><p>直す原稿はありません</p></main>;
  if (!target || !editor) return <main />;
  const original = blocks(source), edited = blocks(draft.markdown), count = changed(original, edited);
  return <main className="app">
    <header className="top"><button className="doc-title" onClick={() => setSwitcher(true)}>{target.title}　／　{target.medium}・{target.version}</button>{apiBase && <a className="to-list" href="/">一覧へ</a>}<span role="status" data-save-state={model.save} className={`save-state ${model.save}`}>{statuses[model.save]}</span></header>
    {readonly && <p className="unsupported">この原稿には、この画面で保てない書式があります。</p>}
    {model.save === 'failed' && <aside className="error"><strong>保存できませんでした</strong><p>変更はこのMacに保持されています。</p><button onClick={() => void save()}>再試行</button></aside>}
    {model.save === 'backupFailed' && <aside className="error"><strong>変更をこのMacに保持できませんでした</strong><p>このページを閉じないでください。</p></aside>}
    {model.save === 'conflict' && <aside className="error"><strong>ファイルが別の場所で変更されました</strong><p>自分の変更はこのMacに保持されています。</p><button onClick={async () => { const r = await fetch(`${apiBase}/api/drafts/${target.id}/fork`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ state: state.current }) }); if (r.ok) await openServerVersion(false); }}>自分の版を別に保存</button><button onClick={() => void openServerVersion(true)}>別の版を開く</button></aside>}
    {model.finish === 'finishFailed' && <aside className="error"><strong>完了を記録できませんでした</strong><button onClick={() => void finish()}>再試行</button></aside>}
    {model.finish === 'finished' ? <section className="completion"><h1>直し終えました</h1><p>編集版を保存しました。</p><p>元の原稿も残っています。</p><p>変更 {(state.current as State & { changedBlocks?: number }).changedBlocks ?? count}か所　理由 {draft.notes.length}件</p>{targets.find(x => !x.finished) && <article className="next"><h2>{targets.find(x => !x.finished)?.title}</h2><p>{targets.find(x => !x.finished)?.medium}・{targets.find(x => !x.finished)?.version}</p><button onClick={() => void switchTo(targets.find(x => !x.finished)!.id)}>次の原稿を開く</button></article>}</section> : <>
      <section className="editor-shell" ref={shellRef}><EditorContent editor={editor} />
      <div className="plus-layer">{!readonly && plusTops.map(p => <button key={p.index} type="button" className={`add-note${p.index === activeBlock || p.index === caretBlock ? ' visible' : ''}`} style={{ top: p.top }} aria-label="理由を書く" onMouseDown={e => e.preventDefault()} onClick={() => addNote(p.index)}>＋</button>)}</div>
      <div className="notes-layer">{draft.notes.map(note => <label className="note" key={note.id} style={{ top: noteTops[note.id] ?? 0 }}><textarea data-note={note.id} aria-label="理由" value={note.body} onChange={e => updateNote(note.id, e.target.value)} onBlur={e => { if (!e.target.value.trim()) updateNote(note.id, ''); }} /></label>)}</div></section>
      <div className="actions"><button disabled={readonly || model.finish === 'finishing'} onClick={() => void finish()}>直し終えた</button></div>
    </>}
    {selected && !readonly && <div className="selection-tools"><button onMouseDown={e => e.preventDefault()} onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}>見出し</button><button onMouseDown={e => e.preventDefault()} onClick={() => editor.chain().focus().toggleBold().run()}>太字</button><button onMouseDown={e => e.preventDefault()} onClick={() => editor.chain().focus().toggleBlockquote().run()}>引用</button><button onMouseDown={e => e.preventDefault()} onClick={() => { const href = prompt('リンク'); if (href) editor.chain().focus().setLink({ href }).run(); }}>リンク</button><button onMouseDown={e => e.preventDefault()} onClick={() => addNote(Math.max(0, editor.state.selection.$from.index(0)))}>理由</button></div>}
    {switcher && <div className="switcher-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) setSwitcher(false); }}><section className="switcher" role="dialog" aria-modal="true" aria-label="原稿を開く　⌘O"><h2>原稿を開く　⌘O</h2>{targets.map((item, i) => <button key={item.id} autoFocus={i === 0} onKeyDown={e => { const all = [...e.currentTarget.parentElement!.querySelectorAll('button')]; if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); all[(i + (e.key === 'ArrowDown' ? 1 : all.length - 1)) % all.length].focus(); } if (e.key === 'Enter') void switchTo(item.id); }} onClick={() => void switchTo(item.id)}><span>{item.title}</span><small>{item.medium}・{item.version}</small></button>)}</section></div>}
  </main>;
}
