declare global {
  interface Window {
    __countRenders?: boolean;
    __renderCounts?: Record<string, number>;
  }
}

/** Counts renders by component name for the browser performance checks. Does nothing unless enabled. */
export function countRender(name: string) {
  if (!window.__countRenders) return;
  const counts = (window.__renderCounts ??= {});
  counts[name] = (counts[name] ?? 0) + 1;
}
