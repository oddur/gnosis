import { createRoot } from 'react-dom/client';
import { App } from './App';
import './globals.css';

// Apply dark mode at the HTML level so body/scrollbars also get dark variables
document.documentElement.classList.add('dark');

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
