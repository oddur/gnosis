/**
 * Times main-process work when `GNOSIS_PERF_TRACE` is set to any non-empty value, and prints one line
 * such as `[perf] view 11.8ms items=400 muted=649 history=512`. Without it, `fn` runs untimed.
 */
export function timed<T>(label: string, fn: () => T, detail?: (value: T) => string): T {
  if (!(globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.GNOSIS_PERF_TRACE)
    return fn();
  const start = performance.now();
  const value = fn();
  const extra = detail ? ` ${detail(value)}` : '';
  console.log(`[perf] ${label} ${(performance.now() - start).toFixed(1)}ms${extra}`);
  return value;
}
