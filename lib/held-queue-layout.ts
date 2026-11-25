import { useLayoutEffect, useMemo, useRef } from 'react';
import { useEntryMenusOpen } from './entry-menu-state';
import type { QueueGroup, QueueGrouping } from './queue-groups';
import type { QueueItem } from './workbench';

/**
 * The queue's layout while it is held (#549): the order of its entries, each entry's group and section, and the group
 * headings. One snapshot drives both the rows the list draws and the order j/k walks, so the two always agree.
 */
export interface QueueLayoutSnapshot {
  ids: readonly string[];
  /** Each shown entry's group key, when the queue is grouped. */
  groupOf: ReadonlyMap<string, string>;
  groups: readonly QueueGroup[] | null;
  /** Each entry's section when the queue is not grouped: 'starred' or its attention. */
  sections: ReadonlyMap<string, QueueSection>;
}

export interface QueueLayout {
  items: QueueItem[];
  grouping?: QueueGrouping;
  /** Held sections by entry id. Undefined when the layout is live. */
  sections?: ReadonlyMap<string, QueueSection>;
}

/** The heading of entries that arrive, or lose their group, while the layout is held. */
export const HELD_NEW_GROUP = 'held:new';

export type QueueSection = QueueItem['attention'] | 'starred';
export const queueSection = (item: QueueItem, starredFirst: boolean): QueueSection => (item.starred && starredFirst ? 'starred' : item.attention);

export function snapshotQueueLayout(items: readonly QueueItem[], grouping: QueueGrouping | undefined, starredFirst: boolean): QueueLayoutSnapshot {
  const shown = grouping ? grouping.items : items;
  return {
    ids: shown.map((item) => item.subject.id),
    groupOf: grouping?.groupOf ?? new Map(),
    groups: grouping?.groups ?? null,
    sections: new Map(shown.map((item) => [item.subject.id, queueSection(item, starredFirst)])),
  };
}

/**
 * The live entries laid out as the snapshot has them. Entries keep their place, group and section, and every held
 * group keeps its heading, even when it is now empty. Entries the snapshot does not have go to the end, after every
 * group, under a "New" heading when grouped; entries that are gone are left out. Row content is always the live one.
 */
export function holdQueueLayout(
  snapshot: QueueLayoutSnapshot,
  items: readonly QueueItem[],
  grouping: QueueGrouping | undefined,
  starredFirst: boolean
): QueueLayout {
  const live = grouping ? grouping.items : items;
  const positions = new Map(snapshot.ids.map((id, index) => [id, index]));
  const known = live.filter((item) => positions.has(item.subject.id))
    .sort((a, b) => (positions.get(a.subject.id) ?? 0) - (positions.get(b.subject.id) ?? 0));
  const fresh = live.filter((item) => !positions.has(item.subject.id));
  const sections = new Map(snapshot.sections);
  for (const item of fresh) sections.set(item.subject.id, queueSection(item, starredFirst));
  if (!grouping || !snapshot.groups) return { items: [...known, ...fresh], sections };
  const byGroup = new Map<string, QueueItem[]>();
  const loose: QueueItem[] = [];
  for (const item of known) {
    const key = snapshot.groupOf.get(item.subject.id);
    const list = key === undefined ? undefined : byGroup.get(key);
    if (key === undefined) loose.push(item);
    else if (list) list.push(item);
    else byGroup.set(key, [item]);
  }
  const ordered: QueueItem[] = [];
  const groupOf = new Map<string, string>();
  const liveCounts = new Map(grouping.groups.map((group) => [group.key, group.count]));
  const groups = snapshot.groups.map((group) => {
    const members = byGroup.get(group.key) ?? [];
    for (const item of members) {
      ordered.push(item);
      groupOf.set(item.subject.id, group.key);
    }
    return { ...group, count: group.collapsed ? liveCounts.get(group.key) ?? group.count : members.length };
  });
  // Entries whose held group is gone, and new ones, follow every group under their own heading, so they never read
  // as part of the last held group.
  const added = [...loose, ...fresh];
  if (added.length) {
    groups.push({ key: HELD_NEW_GROUP, label: 'New', count: added.length, collapsed: false });
    for (const item of added) {
      ordered.push(item);
      groupOf.set(item.subject.id, HELD_NEW_GROUP);
    }
  }
  return { items: ordered, grouping: { groups, items: ordered, groupOf }, sections };
}

/**
 * Keeps the queue's layout while menus are open or `hold` is set, such as while the pointer rests on the list (#549):
 * a row that sync moved, or a group sync filled or emptied, would otherwise slide under a click aimed at another row.
 * A change of `scope`, such as the reader choosing another sort or starring a PR, applies at once: `hold` only keeps
 * changes the reader did not make. The result is the same object for as long as its inputs are.
 */
export function useHeldQueueLayout(
  items: QueueItem[],
  grouping: QueueGrouping | undefined,
  starredFirst: boolean,
  hold: boolean,
  scope: string
): QueueLayout {
  const snapshot = useRef<QueueLayoutSnapshot | null>(null);
  const snapshotScope = useRef(scope);
  const held = (useEntryMenusOpen() || (hold && snapshotScope.current === scope)) && !!snapshot.current?.ids.length;
  const heldSnapshot = held ? snapshot.current : null;
  const inputs = useRef<unknown[]>([]);
  useLayoutEffect(() => {
    if (held) return;
    snapshotScope.current = scope;
    // Only when the live layout changed: this runs after every render, such as each key press.
    const next = [items, grouping, starredFirst];
    if (snapshot.current && next.every((value, index) => value === inputs.current[index])) return;
    inputs.current = next;
    snapshot.current = snapshotQueueLayout(items, grouping, starredFirst);
  });
  return useMemo(
    () => (heldSnapshot ? holdQueueLayout(heldSnapshot, items, grouping, starredFirst) : { items: grouping ? grouping.items : items, grouping }),
    [heldSnapshot, items, grouping, starredFirst]
  );
}
