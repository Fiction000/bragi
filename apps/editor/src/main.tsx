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
import { apiBase } from './base';
import './style.css';

// A run opened from the list (/r/<key>/) is the editor. At / the list shows when the server has a drafts folder;
// a server started with only --run (or an old server without /api/mode) has the editor at /, as before.
function Root() {
  const [dashboard, setDashboard] = useState<boolean>();
  const [page, setPage] = useState(location.hash);
  useEffect(() => { const on = () => setPage(location.hash); addEventListener('hashchange', on); return () => removeEventListener('hashchange', on); }, []);
  useEffect(() => {
    if (apiBase) { setDashboard(false); return; }
    fetch('/api/mode').then(r => (r.ok ? r.json() : { dashboard: false })).catch(() => ({ dashboard: false })).then(m => setDashboard(Boolean(m.dashboard)));
  }, []);
  if (dashboard === undefined) return <main />;
  if (dashboard && page === '#/ledger') return <Ledger />;
  if (dashboard && page === '#/proposals') return <Proposals />;
  return dashboard ? <Dashboard /> : <App />;
}
createRoot(document.getElementById('root')!).render(<Root />);
