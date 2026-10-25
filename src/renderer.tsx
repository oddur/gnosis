import { createRoot } from 'react-dom/client';
import { lazy, Suspense } from 'react';
const App = lazy(() => import('./App').then(({ App }) => ({ default: App })));
import { D2PrototypePage } from './pages/D2PrototypePage';
import { applyTheme } from '../lib/theme';
import './globals.css';

// Apply the user's preferred theme as early as possible to avoid a
// flash. We default to system; App.tsx loads the actual preference
// once the renderer mounts and re-applies if it differs.
applyTheme('system');

// ─── Native UI: disable web-like behaviors ─────────────────────
window.addEventListener('contextmenu', (e) => e.preventDefault());
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => e.preventDefault());

if (!new URLSearchParams(location.search).has('d2-prototype') && window.electronAPI.isPackaged) {
  window.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    if (e.key === 'r' || e.key === 'u' || e.key === 'p') {
      e.preventDefault();
    }
  });
}

const container = document.getElementById('root');
if (!container) throw new Error('No #root element found');

createRoot(container).render(
  new URLSearchParams(location.search).has('d2-prototype') ? (
    <D2PrototypePage />
  ) : (
    <Suspense fallback={null}>
      <App />
    </Suspense>
  )
);
