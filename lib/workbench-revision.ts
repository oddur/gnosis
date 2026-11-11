import type { QueueItem, WorkbenchQueue, WorkbenchQueueParts } from './workbench';
import type { ReviewHistoryEntry } from './types';

/** Revisions that a `workbench-changed` push carries, so renderers can skip unchanged snapshots. */
export interface WorkbenchRevisions {
  revision: string;
  historyRevision: string;
}

/** cyrb53: a fast 53-bit string hash. It identifies content; it is not a security boundary. */
export function contentHash(text: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** JSON with sorted object keys, so equal content hashes equally whatever order its keys were written in. */
function canonical(value: unknown): string {
  // Callers pass objects, arrays or null, which always serialize to text.
  return JSON.stringify(value, (_key, entry: unknown) =>
    entry && typeof entry === 'object' && !Array.isArray(entry)
      ? Object.fromEntries(Object.keys(entry).sort().map((key) => [key, (entry as Record<string, unknown>)[key]]))
      : entry
  );
}
const hash = (value: unknown) => contentHash(canonical(value));

/**
 * Content identity for one queue entry. `briefing.updatedAt` is excluded because an uncached
 * briefing reports the current time on every read.
 */
export function itemRevision(item: QueueItem): string {
  return hash({
    ...item,
    revision: undefined,
    briefing: item.briefing && { ...item.briefing, updatedAt: undefined },
  });
}

export function historyRevision(history: ReviewHistoryEntry[]): string {
  return hash(history);
}

/**
 * Stamp a snapshot with content revisions. Item revisions are written onto the entries in place,
 * so callers that hold the same entries see current revisions; the queue itself is copied.
 */
export function stampQueue(queue: WorkbenchQueue, history?: ReviewHistoryEntry[]): WorkbenchQueue {
  const stamped = new Set<QueueItem>();
  const stamp = (item: QueueItem) => {
    if (!stamped.has(item)) {
      item.revision = itemRevision(item);
      stamped.add(item);
    }
    return item.revision;
  };
  const items = queue.items.map(stamp);
  const starredItems = queue.starredItems?.map(stamp);
  const parts: WorkbenchQueueParts = {
    stacks: hash(queue.stacks ?? null),
    readStates: hash(queue.readStates ?? null),
    mutedPrs: hash(queue.mutedPrs ?? null),
    starredPrs: hash(queue.starredPrs ?? null),
    savedViews: hash(queue.savedViews ?? null),
    filters: hash(queue.filters ?? null),
    sync: hash(queue.sync ?? null),
  };
  const ids = (entries: QueueItem[] | undefined) => entries?.map((item) => item.subject.id) ?? null;
  const revision = hash([
    ids(queue.items),
    items,
    ids(queue.starredItems),
    starredItems ?? null,
    parts,
    queue.warnings,
    queue.remaining,
    queue.briefingBudget ?? null,
  ]);
  return {
    ...queue,
    parts,
    revision,
    historyRevision: history ? historyRevision(history) : queue.historyRevision,
  };
}
