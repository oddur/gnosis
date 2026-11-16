import { useLayoutEffect, useRef } from 'react';

/**
 * Named spans of the app's own heavy work: store updates, queue derivation, filter and viewed changes, tab and view
 * renders. The slow-interaction monitor reports the spans that overlap an input's delay, so an export names the work
 * even when the browser attributes no script to it, as for IPC callbacks or bundled code without a source URL (#345).
 *
 * Spans stay in memory for a few seconds and cost two `performance.now()` calls. Spans under 4 ms are not kept.
 */
export interface PerfSpan {
  name: string;
  start: number;
  end: number;
}

const KEEP_MS = 10_000;
const MIN_MS = 4;
const MAX_SPANS = 300;
let spans: PerfSpan[] = [];

const now = () => (typeof performance === 'undefined' ? Date.now() : performance.now());

export function recordSpan(name: string, start: number, end = now()) {
  if (end - start < MIN_MS) return;
  spans.push({ name, start, end });
  if (spans.length > MAX_SPANS || spans[0].end < end - KEEP_MS) spans = spans.filter((s) => s.end >= end - KEEP_MS).slice(-MAX_SPANS);
}

/** Runs `work` and records how long it took under `name`. */
export function span<T>(name: string, work: () => T): T {
  const start = now();
  try {
    return work();
  } finally {
    recordSpan(name, start);
  }
}

/** Spans that overlap `[start, end]`, longest first. */
export function spansBetween(start: number, end: number): PerfSpan[] {
  return spans.filter((s) => s.start < end && s.end > start).sort((a, b) => b.end - b.start - (a.end - a.start));
}

/**
 * Records a component's render through its commit: from the start of its render to its layout effects, which run
 * after its children have rendered and the DOM is updated. A render React paused and resumed counts the pause too.
 */
export function useRenderSpan(name: string) {
  const start = useRef(0);
  start.current = now();
  useLayoutEffect(() => {
    recordSpan(name, start.current);
  });
}
