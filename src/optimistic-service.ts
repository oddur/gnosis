import {
  applyToActionState,
  createOptimisticLayer,
  optimisticKinds,
  type OptimisticChange,
  type OptimisticKind,
  type OptimisticPatch,
  type OptimisticResult,
  type OptimisticViewer,
} from '../lib/optimistic-patches';
import type { PrActionState } from '../lib/pr-actions';
import type { QueueSignals } from '../lib/queue-signals';
import type { GitHubReviewThread, GitHubReviewThreads } from '../lib/review-threads';
import type { PrMetadata, PrStatus } from '../lib/types';

export interface OptimisticServiceDeps {
  /** The signed-in account. Without one, writes run without a patch. */
  viewer: () => OptimisticViewer | undefined;
  /** Local counts before the write. Never a request. */
  before: (url: string) => OptimisticPatch['before'];
  /** The PR's copies changed: push them, with every patch applied, to every window and the menu bar. */
  changed: (url: string, kinds: OptimisticKind[]) => void;
  now?: () => number;
}

/**
 * Main's one optimistic layer over every copy of a PR it hands out: the discussion, the metadata, the queue signals,
 * the PR status and the PR action state. Windows and the menu bar all read through it, so they agree.
 */
export function createOptimisticService(deps: OptimisticServiceDeps) {
  const layer = createOptimisticLayer({ now: deps.now });
  let timer: ReturnType<typeof setInterval> | undefined;
  const changed = (url: string, kinds: OptimisticKind[]) => {
    try {
      deps.changed(url, kinds);
    } catch (error) {
      console.warn('[optimistic] Could not publish a change:', error instanceof Error ? error.message : error);
    }
  };
  /** Confirmed patches expire. Checked only while there are patches. */
  function watchExpiry() {
    if (timer) return;
    timer = setInterval(() => {
      for (const url of layer.expire()) changed(url, ['discussion', 'metadata', 'signals']);
      if (!layer.list().length) {
        clearInterval(timer);
        timer = undefined;
      }
    }, 10_000);
    // Node timers can let the process exit; browser fixtures get a number.
    (timer as { unref?: () => void }).unref?.();
  }
  const service = {
    layer,
    /**
     * Shows `change` at once, runs the write, and then confirms the change with GitHub's objects or rolls it back.
     * Throws the write's error unchanged.
     */
    async run<T>(
      urls: string | string[],
      change: OptimisticChange,
      write: () => Promise<T>,
      result?: (value: T) => OptimisticResult
    ): Promise<T> {
      const viewer = deps.viewer();
      const targets = [...new Set(typeof urls === 'string' ? [urls] : urls)];
      if (!viewer || !targets.length) return write();
      const kinds = optimisticKinds(change);
      const patches = targets.map((url) => layer.begin({ url, change, viewer, before: deps.before(url) }));
      watchExpiry();
      for (const url of targets) changed(url, kinds);
      let value: T;
      try {
        value = await write();
      } catch (error) {
        for (const patch of patches) if (layer.fail(patch.id)) changed(patch.url, kinds);
        throw error;
      }
      let details: OptimisticResult = {};
      try {
        details = result?.(value) ?? {};
      } catch {
        // The write succeeded. Matching by text replaces the optimistic copy instead.
      }
      for (const patch of patches) if (layer.confirm(patch.id, details)) changed(patch.url, kinds);
      return value;
    },
    /** GitHub carried out `change` without a patch of its own (`layer.applied`). */
    applied(url: string, change: OptimisticChange) {
      if (layer.applied(url, change)) changed(url, optimisticKinds(change));
    },
    /** A copy read from GitHub. Patches it shows stop applying to its kind. */
    observe(url: string, kind: OptimisticKind, base: GitHubReviewThreads | PrMetadata | QueueSignals) {
      return layer.observe(url, kind, base);
    },
    discussion: (url: string, base: GitHubReviewThreads) => (layer.has(url) ? layer.discussion(url, base) : base),
    thread: (url: string, thread: GitHubReviewThread) => (layer.has(url) ? layer.thread(url, thread) : thread),
    metadata: <T extends PrMetadata>(base: T): T => (layer.has(base.url) ? layer.metadata(base) : base),
    signals: (base: QueueSignals): QueueSignals => (layer.has(base.url) ? layer.signals(base) : base),
    status(url: string, status: PrStatus | null): PrStatus | null {
      if (!status || !layer.has(url)) return status;
      const metadata = status.metadata && layer.metadata(status.metadata);
      const shown = layer.metadata({
        url,
        isDraft: status.isDraft,
        autoMerge: status.autoMerge,
        requestedReviewers: status.requestedReviewers,
        requestedTeams: status.requestedTeams,
        labels: status.labels,
        milestone: status.milestone,
      } as PrMetadata);
      return {
        ...status,
        isDraft: shown.isDraft,
        autoMerge: shown.autoMerge,
        requestedReviewers: shown.requestedReviewers,
        requestedTeams: shown.requestedTeams,
        labels: shown.labels,
        milestone: shown.milestone,
        ...(metadata ? { metadata } : {}),
        ...(status.signals ? { signals: layer.signals(status.signals) } : {}),
      };
    },
    actionState(state: PrActionState): PrActionState {
      // Draft and auto-merge changes are idempotent: applying one the state already shows changes nothing.
      return layer
        .list(state.url)
        .filter((patch) => !patch.settled.includes('metadata'))
        .reduce((value, patch) => applyToActionState(value, patch.change), state);
    },
    /** Sign-out or another account: nothing carries over. */
    clear() {
      layer.clear();
    },
  };
  return service;
}
export type OptimisticService = ReturnType<typeof createOptimisticService>;
