import { lazyComponent, lazyScreen } from '../lib/lazy-screen';
import { preloadMarkdown } from '../components/LazyMarkdown';

// Screens outside the startup bundle. Each loads once per window, so kept tabs never suspend again.
export const ReviewPage = lazyScreen(() => import('./pages/ReviewPage').then((module) => module.ReviewPage));
export const PrSummary = lazyScreen(() => import('../components/PrSummary').then((module) => module.PrSummary));
export const SettingsDialog = lazyScreen(() =>
  import('../components/SettingsDialog').then((module) => module.SettingsDialog)
);

/** The Checks graph. Loaded on first use, or ahead of time when Checks is a likely next tab. */
export const WorkflowGraphView = lazyComponent(() =>
  import('../components/WorkflowGraph').then((module) => module.WorkflowGraphView)
);

let prefetched = false;
/** Once the queue has painted, load the remaining screens one at a time while the window is idle. */
export function prefetchScreens() {
  if (prefetched) return;
  prefetched = true;
  const idle = (task: () => Promise<unknown>) =>
    new Promise<void>((resolve) => {
      const run = () => void task().finally(resolve);
      if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 2000 });
      else setTimeout(run, 200);
    });
  void (async () => {
    for (const task of [ReviewPage.preload, SettingsDialog.preload, preloadMarkdown]) await idle(task);
  })();
}
