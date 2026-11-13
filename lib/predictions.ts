import { createNavigationPredictor } from './navigation-predictor';

// The renderer's predictor. Under GNOSIS_PERF_TRACE each navigation prints one `[perf] predict nav …` line.
const clock = () => performance.now();
let lastInput = -Infinity;
// Time to content starts at the input event that caused the navigation, so lazy chunks and data count.
for (const type of ['pointerdown', 'keydown'] as const)
  window.addEventListener(type, (event) => { if (event.isTrusted) lastInput = clock(); }, { capture: true, passive: true });
/** The input that likely started a navigation now. Programmatic navigations (restore, startup) start now. */
export const navigationStart = () => (clock() - lastInput < 5000 ? lastInput : clock());

export const predictor = createNavigationPredictor({
  now: clock,
  report: (line) => window.electronAPI.perfNote?.('predict', line),
});

if (import.meta.env.DEV) (window as unknown as { __gnosisPredict: typeof predictor }).__gnosisPredict = predictor;
window.addEventListener('pagehide', () => {
  if (predictor.records().length) window.electronAPI.perfNote?.('predict-summary', predictor.summary());
});
