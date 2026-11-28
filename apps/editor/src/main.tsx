import '@fontsource/noto-serif-jp/400.css';
import '@fontsource/noto-serif-jp/500.css';
import '@fontsource/noto-sans-jp/400.css';
import '@fontsource/noto-sans-jp/500.css';
import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import App from './view';
import Dashboard from './dashboard';
import Ledger from './ledger';
import Proposals from './proposals';
import { confirmLeave, updateApiBase } from './base';
import './style.css';

// A run opened from the list (/r/<key>/) is the editor. At / the list shows when the server has a drafts folder;
// a server started with only --run (or an old server without /api/mode) has the editor at /, as before.
function Root() {
  const [dashboard, setDashboard] = useState<boolean>();
  const [page, setPage] = useState(location.hash);
  const [pathname, setPathname] = useState(location.pathname);
  const [dashboardOpened, setDashboardOpened] = useState(!location.pathname.startsWith('/r/'));
  // Each history entry this page adds carries its position, so a cancelled back/forward can return exactly where it was.
  const position = () => (typeof history.state?.bragi === 'number' ? history.state.bragi : 0);
  const shown = useRef(position());
  const restoring = useRef(false);
  useEffect(() => {
    const onHash = () => setPage(location.hash);
    const onPop = () => {
      if (restoring.current) { restoring.current = false; return; }
      const to = position();
      if (to !== shown.current && confirmLeave && !confirmLeave()) { restoring.current = true; history.go(shown.current - to); return; }
      shown.current = to;
      updateApiBase(location.pathname);
      setPathname(location.pathname);
      setPage(location.hash);
    };
    addEventListener('hashchange', onHash);
    addEventListener('popstate', onPop);
    return () => { removeEventListener('hashchange', onHash); removeEventListener('popstate', onPop); };
  }, []);
  const editorRoute = pathname.startsWith('/r/');
  useEffect(() => {
    if (editorRoute || dashboard !== undefined) return;
    fetch('/api/mode').then(r => (r.ok ? r.json() : { dashboard: false })).catch(() => { location.reload(); return new Promise<never>(() => {}); }).then(m => setDashboard(Boolean(m.dashboard)));
  }, [editorRoute, dashboard]);
  useEffect(() => {
    if (dashboard && !editorRoute) setDashboardOpened(true);
  }, [dashboard, editorRoute]);
  const navigate = (path: string) => {
    shown.current = position() + 1;
    history.pushState({ bragi: shown.current }, '', path);
    updateApiBase(path);
    setPathname(location.pathname);
  };
  updateApiBase(pathname);
  if (dashboard === undefined && !editorRoute) return <main />;
  if (dashboard === false && !editorRoute) return <App />;
  if (dashboard && !editorRoute && page === '#/ledger') return <Ledger />;
  if (dashboard && !editorRoute && page === '#/proposals') return <Proposals />;
  return <>
    {dashboard && dashboardOpened && <div style={editorRoute ? { display: 'none' } : undefined}><Dashboard onOpen={navigate} /></div>}
    {editorRoute && <App key={pathname} onBack={() => navigate('/')} />}
  </>;
}
createRoot(document.getElementById('root')!).render(<Root />);
