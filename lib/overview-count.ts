/**
 * The Overview's actionable count per account, for the workspace tab title (#390): rows in Merge, Answer, Review and
 * Fix, a stack once per lane, as in the count strip. Waiting on others is not work, so it never counts. The Overview
 * publishes it; tab titles read it. Unknown until an Overview has built its lanes in this window.
 */
const counts = new Map<string, number>();
const listeners = new Set<() => void>();
let version = 0;

export function publishOverviewCount(account: string, count: number) {
  if (counts.get(account) === count) return;
  counts.set(account, count);
  version++;
  for (const listener of [...listeners]) listener();
}
export const overviewCount = (account: string): number | undefined => counts.get(account);
export const overviewCountStore = {
  subscribe: (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  version: () => version,
};
