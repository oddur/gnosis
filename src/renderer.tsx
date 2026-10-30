import { initializeDiffHighlighter } from '../lib/diff-highlighter';
import { initializeReviewState } from '../lib/renderer-review-state';
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

const root = createRoot(container);
async function start() {
  try {
    const [, preferences] = await Promise.all([
      initializeReviewState(),
      // Settings recovery remains available if preferences cannot be read.
      window.electronAPI.loadPreferences().catch(() => undefined),
    ]);
    initializeDiffHighlighter(preferences);
    root.render(<App />);
  }
  catch (error) {
    root.render(<main role="alert" className="p-8 max-w-xl"><h1>Could not load saved review progress</h1>
      <p className="my-4">Your existing drafts have been kept. {error instanceof Error ? error.message : String(error)}</p>
      <button className="underline" onClick={() => void start()}>Retry</button></main>);
  }
}
void start();
