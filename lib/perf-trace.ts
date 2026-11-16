/** Receives every `timed` call's start and end (epoch ms). Main sets it to name event-loop blocking (#345). */
let sink: ((label: string, start: number, end: number) => void) | undefined;
export function setTimedSink(next: typeof sink) {
  sink = next;
}

/** Reports work that already ran, from `start` (performance.now()) to now, to the sink. Cheap when none is set. */
export function noteWork(label: string, start: number) {
  if (!sink) return;
  const end = performance.now();
  sink(label, performance.timeOrigin + start, performance.timeOrigin + end);
}

/**
 * Times main-process work when `GNOSIS_PERF_TRACE` is set to any non-empty value, and prints one line
 * such as `[perf] view 11.8ms items=400 muted=649 history=512`. With a sink set it is always timed and reported to
 * the sink; otherwise `fn` runs untimed.
 */
export function timed<T>(label: string, fn: () => T, detail?: (value: T) => string): T {
  const trace = !!(globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.GNOSIS_PERF_TRACE;
  if (!trace && !sink) return fn();
  const start = performance.now();
  const value = fn();
  const end = performance.now();
  sink?.(label, performance.timeOrigin + start, performance.timeOrigin + end);
  if (trace) console.log(`[perf] ${label} ${(end - start).toFixed(1)}ms${detail ? ` ${detail(value)}` : ''}`);
  return value;
}
