import { createNavigationPredictor, type PredictionState, type PredictMember, type PredictorReads } from './navigation-predictor';
import { inspectionData, loadChangePreview, predictedFiles } from './inspection-cache';
import { loadExplanation, peekExplanation } from './explanation-workspace';
import { PrSummary, ReviewPage, WorkflowGraphView } from '../src/lazy-screens';
import type { OpenTarget } from './pr-open-targets';

// The renderer's predictor. Under GNOSIS_PERF_TRACE each navigation prints one `[perf] predict nav …` line.
const clock = () => performance.now();
let lastInput = -Infinity;
// Time to content starts at the input event that caused the navigation, so lazy chunks and data count.
for (const type of ['pointerdown', 'keydown'] as const)
  window.addEventListener(type, (event) => { if (event.isTrusted) lastInput = clock(); }, { capture: true, passive: true });
/** The input that likely started a navigation now. Programmatic navigations (restore, startup) start now. */
export const navigationStart = () => (clock() - lastInput < 5000 ? lastInput : clock());

const targets = (members: PredictMember[], tier: OpenTarget['tier']): OpenTarget[] => members.map((member) => ({ ...member, tier }));
/** Every executor is an existing read path: inspection caches, main's PR open preloader, chunks and saved reviews. */
const reads: PredictorReads = {
  async changes(member, subjectId, files, label) {
    // Patch previews make a file ready without a request, so load the parser first.
    await loadChangePreview().catch(() => {});
    await inspectionData.prepareCommitted(member, { files, label, choose: (snapshot, count) => predictedFiles(snapshot, subjectId, count) });
  },
  changesReady: (member, subjectId, files) =>
    inspectionData.committedReady(member, files, (snapshot, count) => predictedFiles(snapshot, subjectId, count)),
  open: (members, label) => window.electronAPI.prOpenCommitted?.(targets(members, 0), label) ?? Promise.resolve(),
  openIntent(members) {
    if (!members) {
      inspectionData.setIntent([]);
      window.electronAPI.prOpenIntent?.(null);
      return;
    }
    inspectionData.setIntent(members.map((member) => member.url));
    window.electronAPI.prOpenIntent?.(targets(members, 1));
    void PrSummary.preload();
  },
  graph: (member, label) =>
    window.electronAPI.predictWorkflowGraph?.({ url: member.url, headSha: member.headSha }, label) ?? Promise.resolve(),
  chunk(name) {
    if (name === 'workflow-graph') return WorkflowGraphView.preload();
    if (name === 'review-page') return ReviewPage.preload();
    if (name === 'pr-summary') return PrSummary.preload();
    if (name === 'mermaid') return import('./mermaid').then((module) => module.preloadMermaid());
    return import('./d2').then((module) => module.preloadD2());
  },
  review: (id) => loadExplanation(id),
  reviewReady: (id) => !!peekExplanation(id),
};

// Main keeps the budget. Its answer is refreshed when conditions change and at most every 15 s while visible.
let state: PredictionState = { off: false, paused: false, battery: false, hot: false, light: false };
const predictOff = window.electronAPI.predictOff === true;
export const predictor = createNavigationPredictor({
  now: clock,
  report: (line) => window.electronAPI.perfNote?.('predict', line),
  reads,
  conditions: () => ({
    enabled: !predictOff,
    online: navigator.onLine,
    visible: document.visibilityState !== 'hidden',
    focused: document.hasFocus(),
    state,
  }),
});
const apply = (next: PredictionState | undefined) => {
  if (!next || typeof next !== 'object') return;
  state = next;
  if (next.spend !== undefined) predictor.setSpend(next.spend);
  predictor.wake();
};
function refresh() {
  if (document.visibilityState === 'hidden') return;
  void window.electronAPI.predictionState?.().then(apply, () => {});
}
window.electronAPI.onPredictionState?.(apply);
for (const type of ['focus', 'online'] as const) window.addEventListener(type, refresh);
document.addEventListener('visibilitychange', refresh);
// Only while something is predicted: an idle window sends nothing.
setInterval(() => { if (predictor.wanted().length) refresh(); }, 15_000);
refresh();

let account: string | null | undefined;
/** Measurements and predictions belong to one GitHub account. */
export function setPredictionAccount(next: string | null) {
  if (account !== undefined && account !== next) predictor.reset();
  account = next;
}

if (import.meta.env.DEV) (window as unknown as { __gnosisPredict: typeof predictor }).__gnosisPredict = predictor;
window.addEventListener('pagehide', () => {
  if (predictor.records().length) window.electronAPI.perfNote?.('predict-summary', predictor.summary());
});
