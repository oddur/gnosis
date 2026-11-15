/** The open PR is read again at most this often when the reader switches to its tab or returns to Gnosis. */
export const FOCUS_REFRESH_INTERVAL_MS = 30_000;

/** Per-PR throttle: `take` returns the URLs that may refresh now and starts their wait. */
export function createRefreshThrottle(
  interval = FOCUS_REFRESH_INTERVAL_MS,
  now: () => number = () => Date.now(),
  limit = 200
) {
  const last = new Map<string, number>();
  return {
    take(urls: readonly string[]): string[] {
      const time = now();
      const allowed = [...new Set(urls)].filter(
        (url) => time - (last.get(url) ?? Number.NEGATIVE_INFINITY) >= interval
      );
      for (const url of allowed) {
        last.delete(url);
        last.set(url, time);
      }
      while (last.size > limit) last.delete(last.keys().next().value as string);
      return allowed;
    },
  };
}

/** "Checked just now", "Checked 2m ago": when Gnosis last read this from GitHub. */
export function freshnessLabel(checkedAt: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - checkedAt) / 60_000);
  if (minutes < 1) return 'Checked just now';
  if (minutes < 60) return `Checked ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Checked ${hours}h ago`;
  return `Checked ${Math.floor(hours / 24)}d ago`;
}
