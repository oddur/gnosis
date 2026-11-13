import { createNavigationPredictor, type PredictionState, type PredictMember, type PredictorReads } from './navigation-predictor';
import { inspectionData, loadChangePreview, predictedFiles } from './inspection-cache';
import { loadExplanation, peekExplanation } from './explanation-workspace';
import { PrSummary, ReviewPage, WorkflowGraphView } from '../src/lazy-screens';
import type { OpenTarget } from './pr-open-targets';
import { preloadSettings, type PreloadSettings } from './preload-settings';

// Loaded on every screen, including fixtures and windows whose preload exposes only part of the API (or none).
// Nothing here may throw at import time, or the whole renderer fails to mount.
const api = (): Partial<Window['electronAPI']> | undefined => (window as { electronAPI?: Partial<Window['electronAPI']> }).electronAPI;

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
  open: (members, label) => api()?.prOpenCommitted?.(targets(members, 0), label) ?? Promise.resolve(),
  openIntent(members) {
    if (!members) {
      inspectionData.setIntent([]);
      api()?.prOpenIntent?.(null);
      return;
    }
    inspectionData.setIntent(members.map((member) => member.url));
    api()?.prOpenIntent?.(targets(members, 1));
    void PrSummary.preload();
  },
  graph: (members, label) =>
    api()?.predictWorkflowGraph?.(members.map(({ url, headSha }) => ({ url, headSha })), label) ?? Promise.resolve(),
  chunk(name) {
    if (name === 'workflow-graph') return WorkflowGraphView.preload();
    if (name === 'review-page') return ReviewPage.preload();
    if (name === 'pr-summary') return PrSummary.preload();
    if (name === 'mermaid') return import('./mermaid').then((module) => module.preloadMermaid());
    return import('./d2').then((module) => module.preloadD2());
  },
  // A saved review's document is local. Its diagram engines load with it, as the review would on open.
  review: async (id) => {
    const review = await loadExplanation(id);
    if (review.slides.some((slide) => slide.mermaidDiagram)) void reads.chunk('mermaid').catch(() => {});
    if (review.slides.some((slide) => slide.d2Diagram)) void reads.chunk('d2').catch(() => {});
  },
  reviewReady: (id) => !!peekExplanation(id),
};

// Main keeps the budget. Its answer is refreshed when conditions change and at most every 15 s while visible.
let state: PredictionState = { off: false, paused: false, battery: false, hot: false, light: false };
const predictOff = api()?.predictOff === true;
// Settings › Integrations › Preloading. Main applies the amount (through `state`) and the budget; the renderer
// needs the two switches: intent preloading and queue preparation.
let settings: PreloadSettings = preloadSettings(undefined);
const settingsListeners = new Set<() => void>();
const applySetting = (preferences: unknown) => {
  if (!preferences || typeof preferences !== 'object') return;
  const next = preloadSettings(preferences);
  const changed = JSON.stringify(next) !== JSON.stringify(settings);
  settings = next;
  // Turning intent off drops a hover that is waiting.
  if (!intentsEnabled()) predictor.dropIntents();
  predictor.wake();
  if (changed) settingsListeners.forEach((listener) => listener());
};
/** "Preload likely next pages", unless GNOSIS_PREDICT=off. Off: no prediction and no hover or focus intent. */
export const intentsEnabled = () => !predictOff && settings.predictNavigation;
/** The current Preloading settings. */
export const currentPreloadSettings = () => settings;
/** Called when a Preloading setting changes. Returns an unsubscribe function. */
export function onPreloadSettings(listener: () => void) {
  settingsListeners.add(listener);
  return () => { settingsListeners.delete(listener); };
}
export const predictor = createNavigationPredictor({
  now: clock,
  report: (line) => api()?.perfNote?.('predict', line),
  reads,
  conditions: () => ({
    enabled: intentsEnabled(),
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
  void api()?.predictionState?.().then(apply, () => {});
}
api()?.onPredictionState?.(apply);
void Promise.resolve().then(() => api()?.loadPreferences?.()).then(applySetting, () => {});
api()?.onPreferencesChanged?.(applySetting);
// Settings saved in this window, before main's broadcast arrives.
window.addEventListener('gnosis-preferences-changed', (event) => applySetting((event as CustomEvent<unknown>).detail));
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
  if (predictor.records().length) api()?.perfNote?.('predict-summary', predictor.summary());
});
