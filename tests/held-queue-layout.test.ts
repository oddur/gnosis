import test from 'node:test';
import assert from 'node:assert/strict';
import { HELD_NEW_GROUP, holdQueueLayout, snapshotQueueLayout } from '../lib/held-queue-layout';
import type { QueueGrouping } from '../lib/queue-groups';
import type { QueueItem } from '../lib/workbench';

const item = (id: string, attention: QueueItem['attention'] = 'updated', starred = false) =>
  ({ subject: { id, kind: 'pr', title: id, members: [], edges: [], warnings: [] }, attention, starred }) as unknown as QueueItem;
const grouping = (groups: [string, QueueItem[]][]): QueueGrouping => ({
  groups: groups.map(([key, items]) => ({ key, label: key, count: items.length, collapsed: false })),
  items: groups.flatMap(([, items]) => items),
  groupOf: new Map(groups.flatMap(([key, items]) => items.map((entry) => [entry.subject.id, key] as const))),
});
const ids = (items: QueueItem[]) => items.map((entry) => entry.subject.id);

void test('a held layout keeps order and sections, puts new entries last and drops gone ones (#549)', () => {
  const [a, b, c] = [item('a'), item('b', 'requested'), item('c')];
  const snapshot = snapshotQueueLayout([a, b, c], undefined, true);
  // Sync: c was updated and sorts first, b is now starred, d is new and a is gone.
  const live = [item('c'), item('b', 'requested', true), item('d')];
  const held = holdQueueLayout(snapshot, live, undefined, true);
  assert.deepEqual(ids(held.items), ['b', 'c', 'd']);
  assert.equal(held.items[0], live[1], 'rows show the live entry');
  assert.ok(held.sections);
  assert.equal(held.sections.get('b'), 'requested', 'b keeps its section until the hold ends');
  assert.equal(held.sections.get('d'), 'updated');
});

void test('a held grouped layout keeps every entry in its group and every heading, with j/k in the same order', () => {
  const [a, b, c] = [item('a'), item('b'), item('c')];
  const snapshot = snapshotQueueLayout([a, b, c], grouping([['fix', [a, b]], ['merge', [c]]]), true);
  // Sync: b's checks pass, so it moves to Merge; Fix keeps a. A new entry d is in a new Review group.
  const live = grouping([['review', [item('d')]], ['fix', [item('a')]], ['merge', [item('b'), item('c')]]]);
  const held = holdQueueLayout(snapshot, live.items, live, true);
  assert.ok(held.grouping);
  assert.deepEqual(held.grouping.groups.map((group) => `${group.key}:${group.count}`), ['fix:2', 'merge:1', `${HELD_NEW_GROUP}:1`]);
  assert.deepEqual(ids(held.items), ['a', 'b', 'c', 'd'], 'the list and j/k walk the same order');
  assert.equal(held.grouping.items, held.items);
  assert.equal(held.grouping.groupOf.get('b'), 'fix');
  assert.equal(held.grouping.groupOf.get('d'), HELD_NEW_GROUP, 'a new entry follows every group, under its own heading');
});

void test('a held group that sync removed keeps its heading and its entries', () => {
  const [a, b] = [item('a'), item('b')];
  const snapshot = snapshotQueueLayout([a, b], grouping([['fix', [a]], ['merge', [b]]]), true);
  const live = grouping([['merge', [item('a'), item('b')]]]);
  const held = holdQueueLayout(snapshot, live.items, live, true);
  assert.ok(held.grouping);
  assert.deepEqual(held.grouping.groups.map((group) => `${group.key}:${group.count}`), ['fix:1', 'merge:1']);
});
