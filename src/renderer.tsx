import { preferencesReady } from '../lib/startup-preferences';
import { initializeChecksView } from '../lib/checks-view';
import { initializeReviewState } from '../lib/renderer-review-state';
import { applyCodeFont } from '../lib/code-font';
import { workbenchStore } from '../lib/workbench-store';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { applyTheme } from '../lib/theme';
import './globals.css';

window.electronAPI.perfMark?.('script-start');
// Start the one shared preferences read first.
const preferences = preferencesReady();

// Apply the user's preferred theme as early as possible to avoid a
// flash. We default to system and re-apply once preferences load.
applyTheme('system');
// Read the saved queue while review state loads, so the first queue render has its rows.
workbenchStore.subscribe(() => {});
void preferences.then((prefs) => {
  if (prefs) {
    applyTheme(prefs.theme);
    if (prefs.codeFont) applyCodeFont(prefs.codeFont);
  }
  // Checks load lazily after this runs, so they never flash the other view.
  initializeChecksView(prefs);
});

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
    await initializeReviewState();
    window.electronAPI.perfMark?.('review-state');
    root.render(<App />);
  }
  catch (error) {
    root.render(<main role="alert" className="p-8 max-w-xl"><h1>Could not load saved review progress</h1>
      <p className="my-4">Your existing drafts have been kept. {error instanceof Error ? error.message : String(error)}</p>
      <button className="underline" onClick={() => void start()}>Retry</button></main>);
  }
}
void start();
