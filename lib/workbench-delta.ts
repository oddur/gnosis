import type { QueueItem, WorkbenchQueue, WorkbenchQueueParts } from './workbench';

/**
 * A queue snapshot as the change from one the window already has (#345). A full snapshot is about 2 MB on a large
 * queue; main serialized it for every window on every change, and the window deserialized it, both on their main
 * threads. A delta names unchanged rows by revision and carries only rows and parts whose content changed.
 */
export interface WorkbenchQueueDelta {
  /** The revision of the snapshot this delta applies to. */
  base: string;
  /** Every field except rows and unchanged parts. */
  queue: Omit<WorkbenchQueue, 'items' | 'starredItems'>;
  /** Each row, as the revision of an unchanged row in the base or as the changed row. */
  items: (string | QueueItem)[];
  starredItems?: (string | QueueItem)[];
  /** Parts unchanged from the base, which the receiver copies from its own snapshot. */
  sameParts: (keyof WorkbenchQueueParts)[];
}

const PARTS: (keyof WorkbenchQueueParts)[] = ['stacks', 'readStates', 'mutedPrs', 'starredPrs', 'savedViews', 'filters', 'sync'];

/** The delta from `base` to `next`, or undefined when either lacks the revisions it needs. */
export function queueDelta(base: WorkbenchQueue, next: WorkbenchQueue): WorkbenchQueueDelta | undefined {
  if (!base.revision || !next.revision || !base.parts || !next.parts) return undefined;
  const known = new Set<string>();
  for (const item of [...base.items, ...(base.starredItems ?? [])]) if (item.revision) known.add(item.revision);
  const rows = (items: QueueItem[]) => items.map((item) => (item.revision && known.has(item.revision) ? item.revision : item));
  const sameParts = PARTS.filter((part) => base.parts?.[part] === next.parts?.[part]);
  const same = new Set<string>(sameParts);
  const queue = Object.fromEntries(
    Object.entries(next).filter(([key]) => key !== 'items' && key !== 'starredItems' && !same.has(key))
  ) as Partial<WorkbenchQueue>;
  return {
    base: base.revision,
    queue: queue as WorkbenchQueueDelta['queue'],
    items: rows(next.items),
    ...(next.starredItems ? { starredItems: rows(next.starredItems) } : {}),
    sameParts,
  };
}

/**
 * The snapshot a delta describes, built from the receiver's own copy of the base. Undefined when that copy is not
 * the base or lacks a row the delta names: the receiver then reads a full snapshot.
 */
export function applyQueueDelta(current: WorkbenchQueue, delta: WorkbenchQueueDelta): WorkbenchQueue | undefined {
  if (current.revision !== delta.base) return undefined;
  const byRevision = new Map<string, QueueItem>();
  for (const item of [...current.items, ...(current.starredItems ?? [])]) if (item.revision) byRevision.set(item.revision, item);
  const rows = (entries: (string | QueueItem)[]) => {
    const out: QueueItem[] = [];
    for (const entry of entries) {
      const item = typeof entry === 'string' ? byRevision.get(entry) : entry;
      if (!item) return undefined;
      out.push(item);
    }
    return out;
  };
  const items = rows(delta.items);
  const starredItems = delta.starredItems ? rows(delta.starredItems) : undefined;
  if (!items || (delta.starredItems && !starredItems)) return undefined;
  const queue: WorkbenchQueue = { ...(delta.queue as WorkbenchQueue), items, ...(starredItems ? { starredItems } : {}) };
  for (const part of delta.sameParts) if (part in current) Object.assign(queue, { [part]: current[part] });
  return queue;
}
