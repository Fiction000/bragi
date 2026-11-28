import '@fontsource/noto-serif-jp/400.css';
import '@fontsource/noto-serif-jp/500.css';
import '@fontsource/noto-sans-jp/400.css';
import '@fontsource/noto-sans-jp/500.css';
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import App from './view';
import Dashboard from './dashboard';
import Ledger from './ledger';
import Proposals from './proposals';
import { updateApiBase } from './base';
import './style.css';

// A run opened from the list (/r/<key>/) is the editor. At / the list shows when the server has a drafts folder;
// a server started with only --run (or an old server without /api/mode) has the editor at /, as before.
function Root() {
  const [dashboard, setDashboard] = useState<boolean>();
  const [page, setPage] = useState(location.hash);
  const [pathname, setPathname] = useState(location.pathname);
  const [dashboardOpened, setDashboardOpened] = useState(!location.pathname.startsWith('/r/'));
  useEffect(() => {
    const onHash = () => setPage(location.hash);
    const onPop = () => {
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
    fetch('/api/mode').then(r => (r.ok ? r.json() : { dashboard: false })).catch(() => ({ dashboard: false })).then(m => setDashboard(Boolean(m.dashboard)));
  }, [editorRoute, dashboard]);
  useEffect(() => {
    if (dashboard && !editorRoute) setDashboardOpened(true);
  }, [dashboard, editorRoute]);
  const navigate = (path: string) => {
    history.pushState({}, '', path);
    updateApiBase(path);
    setPathname(location.pathname);
  };
  updateApiBase(pathname);
  if (dashboard === undefined && !editorRoute) return <main />;
  if (dashboard === false) return <App />;
  if (dashboard && !editorRoute && page === '#/ledger') return <Ledger />;
  if (dashboard && !editorRoute && page === '#/proposals') return <Proposals />;
  return <>
    {dashboard && dashboardOpened && <div style={editorRoute ? { display: 'none' } : undefined}><Dashboard onOpen={navigate} /></div>}
    {editorRoute && <App key={pathname} onBack={() => navigate('/')} />}
  </>;
}
createRoot(document.getElementById('root')!).render(<Root />);
