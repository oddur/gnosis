import { createElement, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { navigationStart, predictor } from './predictions';
import { destinationKey, type Prediction } from './navigation-predictor';
import { createRowIntent } from './row-intent';

/** Declares a screen's likely next destinations while it is mounted. Hidden Activity trees clear theirs. */
export function usePredictions(owner: string, predictions: Prediction[]): void {
  const signature = JSON.stringify(predictions);
  useEffect(() => {
    predictor.declare(owner, JSON.parse(signature) as Prediction[]);
    return () => predictor.declare(owner, []);
  }, [owner, signature]);
}

/**
 * Hover and keyboard-focus intent for an entry point that opens a PR or a review. It fires once the pointer or focus
 * rests for 150 ms, like a queue row, and clears on leave. The returned handlers are stable, so rows do not re-render.
 */
export function useIntent(owner: string) {
  const state = useRef<{ intent: ReturnType<typeof createRowIntent>; predictions: Map<string, Prediction> } | null>(null);
  if (!state.current) {
    const predictions = new Map<string, Prediction>();
    state.current = {
      predictions,
      intent: createRowIntent({
        fire: (id) => {
          const prediction = predictions.get(id);
          if (prediction) predictor.intent(owner, prediction);
        },
        clear: () => predictor.intent(owner, null),
      }),
    };
  }
  useEffect(() => () => {
    state.current?.intent.leave();
  }, []);
  return useMemo(() => {
    const enter = (prediction: Prediction | null) => {
      const current = state.current;
      if (!current) return;
      if (!prediction) {
        current.intent.leave();
        return;
      }
      const id = destinationKey(prediction.destination);
      current.predictions.clear();
      current.predictions.set(id, prediction);
      current.intent.enter(id);
    };
    const leave = () => state.current?.intent.leave();
    return {
      enter,
      leave,
      /** Pointer and focus handlers for one element. */
      handlers: (prediction: Prediction | null) => ({
        onPointerEnter: () => enter(prediction),
        onPointerLeave: leave,
        onFocus: () => enter(prediction),
        onBlur: leave,
      }),
    };
  }, []);
}

export type ContentState = 'content' | 'loading' | 'blank';
const visible = (element: Element) => (element as HTMLElement).offsetParent !== null;
/** A loading state the reader can see. Files further down a diff stream may load without the reader seeing it. */
function loadingShown(root: Element) {
  return [...root.querySelectorAll('.loading-state, .loading-indicator')].some(
    (element) => visible(element) && !element.closest('.commit-stream-row:not([data-active="true"]), .pr-summary-toolbar, .pr-merge-status')
  );
}
const state = (root: Element, content: boolean): ContentState => (content ? 'content' : loadingShown(root) ? 'loading' : 'blank');
/**
 * What counts as real content on each destination. A navigation that shows a loading state before its content
 * is not a hit; a blank frame while a view lays out is not a loading state.
 */
export const contentMarkers: Record<string, (root: Element) => ContentState> = {
  summary: (root) => state(root, !!root.querySelector('.pr-description, .stack-summary-main')),
  // The file the reader lands on. Files further down the stream may still load.
  changes: (root) => {
    const active = root.querySelector('.commit-stream-row[data-active="true"]');
    return state(root, !!active?.querySelector('.changes-file-header') && !active.querySelector('.changes-loading'));
  },
  commits: (root) => {
    const active = root.querySelector('.commit-stream-row[data-active="true"]');
    return state(root, !!root.querySelector('.commit-detail-title') && !root.querySelector('.commits-loading') &&
      !active?.querySelector('.changes-loading'));
  },
  checks: (root) => {
    const graph = root.querySelector('.workflow-host:not([hidden])');
    if (graph) return state(root, !!graph.querySelector('.workflow-job') && !graph.querySelector('.loading-state'));
    const list = root.querySelector('.checks-list');
    return state(root, !!list?.querySelector('.checks-pr-group') && !list.querySelector('.checks-revision .loading-indicator'));
  },
  feedback: (root) =>
    state(root, !!root.querySelector('.feedback-workspace, .feedback-empty') &&
      ![...root.querySelectorAll('h2')].some((heading) => heading.textContent === 'Loading feedback')),
};

/**
 * Reports when a destination first shows real content. Place it inside the destination; it renders nothing,
 * holds no state and never re-renders its parent. In a kept tab its effects run again each time the tab is
 * shown, so every visit is one navigation. `firstKey` names the first visit, such as opening the PR.
 */
export function ArrivalProbe({ firstKey, revisitKey, marker }: { firstKey: string; revisitKey?: string; marker: keyof typeof contentMarkers }) {
  const span = useRef<HTMLSpanElement>(null);
  const visits = useRef(0);
  useLayoutEffect(() => {
    const key = visits.current++ === 0 ? firstKey : (revisitKey ?? firstKey);
    const kept = visits.current > 1;
    predictor.navigate(key, navigationStart());
    const root = span.current?.closest('[role="tabpanel"]') ?? span.current?.parentElement;
    if (!root) return;
    let loading = false;
    const check = () => {
      const now = contentMarkers[marker](root);
      loading ||= now === 'loading';
      return now === 'content';
    };
    if (check()) {
      predictor.arrived(key, { loading: false, kept });
      return;
    }
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      observer.disconnect();
      clearTimeout(timer);
    };
    const observer = new MutationObserver(() => {
      if (!check()) return;
      finish();
      predictor.arrived(key, { loading, kept });
    });
    observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['hidden', 'class', 'data-active'] });
    const timer = setTimeout(finish, 30_000);
    // Leaving before content appeared is not a navigation that completed.
    return () => {
      if (!done) predictor.abandon(key);
      finish();
    };
  }, [firstKey, revisitKey, marker]);
  return createElement('span', { ref: span, hidden: true, 'data-arrival': marker });
}
