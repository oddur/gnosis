import { createRoot } from 'react-dom/client';
import { App } from './App';
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

if (window.electronAPI.isPackaged) {
  window.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    if (e.key === 'r' || e.key === 'u' || e.key === 'p') {
      e.preventDefault();
    }
  });
}

const container = document.getElementById('root');
if (!container) throw new Error('No #root element found');

createRoot(container).render(<App />);
