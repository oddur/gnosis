import { performance } from 'node:perf_hooks';

// GNOSIS_PERF_TRACE=1 logs startup marks. GNOSIS_PERF_TRACE=exit also quits once the queue has painted.
const setting = process.env.GNOSIS_PERF_TRACE;
export const startupTracing = !!setting;
export const exitAfterTrace = setting === 'exit';
const marks: Record<string, number> = {};

/** Record a startup mark on main's clock: milliseconds since the main process started. */
export function mark(name: string, at = performance.now()): void {
  if (!startupTracing) return;
  marks[name] ??= Math.round(at * 10) / 10;
  console.log(`[perf] main ${name} ${at.toFixed(1)}`);
}

/** Renderer marks carry wall-clock time, so they convert onto main's clock. */
export function markRenderer(name: string, epochMs: number): void {
  if (!startupTracing || !Number.isFinite(epochMs)) return;
  const at = epochMs - performance.timeOrigin;
  marks[name] ??= Math.round(at * 10) / 10;
  console.log(`[perf] renderer ${name} ${at.toFixed(1)}`);
}

/** Log measurements that are not points in time, such as worker phase durations. */
export function note(name: string, value: unknown): void {
  if (startupTracing) console.log(`[perf] main ${name} ${JSON.stringify(value)}`);
}

/** Renderer measurements: `[perf] predict nav pr-tab:changes hit 38ms`. Strings print as they are. */
export function noteRenderer(name: string, value: unknown): void {
  if (startupTracing) console.log(`[perf] ${name} ${typeof value === 'string' ? value : JSON.stringify(value)}`);
}

export function startupSummary(): Record<string, number> {
  return { ...marks };
}
