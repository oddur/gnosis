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
const frozenHashes = new WeakMap<object, string>();
/** Frozen inputs cannot change, so their hash is computed once per object. */
const hash = (value: unknown) => {
  const frozen = !!value && typeof value === 'object' && Object.isFrozen(value);
  const known = frozen ? frozenHashes.get(value) : undefined;
  if (known !== undefined) return known;
  const result = contentHash(canonical(value));
  if (frozen) frozenHashes.set(value, result);
  return result;
};

/**
 * Content identity for one queue entry. `briefing.updatedAt` is excluded because an uncached
 * briefing reports the current time on every read.
 */
export function itemRevision(item: QueueItem, reuseMembers = false): string {
  return hash({
    ...item,
    subject: item.subject && { ...item.subject, members: item.subject.members.map(m => memberRevision(m, reuseMembers)) },
    revision: undefined,
    briefing: item.briefing && { ...item.briefing, updatedAt: undefined },
  });
}
// Members carry full PR descriptions; re-serializing them on every main-process view dominated
// stamping. The main queue state replaces members rather than editing them, so it may reuse a
// member's hash by identity. Other callers can edit members in place and always rehash.
const memberRevisions = new WeakMap<object, string>();
function memberRevision(member: QueueItem['subject']['members'][number], reuse: boolean): string {
  if (!reuse) return contentHash(canonical(member));
  let revision = memberRevisions.get(member);
  if (revision === undefined) memberRevisions.set(member, (revision = contentHash(canonical(member))));
  return revision;
}

export function historyRevision(history: readonly ReviewHistoryEntry[]): string {
  return hash(history);
}

/**
 * Stamp a snapshot with content revisions. Item revisions are written onto the entries in place,
 * so callers that hold the same entries see current revisions; the queue itself is copied.
 */
export function stampQueue(
  queue: WorkbenchQueue,
  history?: readonly ReviewHistoryEntry[],
  options: { reuseMembers?: boolean } = {}
): WorkbenchQueue {
  const stamped = new Set<QueueItem>();
  const stamp = (item: QueueItem) => {
    if (!stamped.has(item)) {
      item.revision = itemRevision(item, options.reuseMembers);
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
