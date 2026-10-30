import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contextSelection, emptySelection, runSelectionTasks, selectEntry } from '../lib/entry-selection';
import { selectedTreeFiles } from '../lib/tree-viewed-files';

void test('ranges follow displayed order, shrink around the original anchor, and ignore missing entries', () => {
  const order = ['c', 'a', 'd', 'b'];
  const initial = selectEntry(emptySelection(), order, 'a');
  const range = selectEntry(initial, order, 'b', { shiftKey: true });
  assert.deepEqual(range, { keys: ['a', 'd', 'b'], anchor: 'a' });
  assert.deepEqual(selectEntry(range, order, 'd', { shiftKey: true }).keys, ['a', 'd']);
  assert.deepEqual(selectEntry(range, order, 'c', { shiftKey: true }).keys, ['c', 'a']);
  assert.deepEqual(selectEntry(range, order, 'missing'), range);
});
void test('additive selection and right-click preserve the intended group', () => {
  const order = ['a', 'b', 'c', 'd'];
  const first = selectEntry(emptySelection(), order, 'a');
  const group = selectEntry(first, order, 'c', { metaKey: true });
  assert.deepEqual(group.keys, ['a', 'c']);
  assert.deepEqual(contextSelection(group, 'a'), group);
  assert.deepEqual(contextSelection(group, 'b'), { keys: ['b'], anchor: 'b' });
  assert.deepEqual(selectEntry(group, order, 'c', { ctrlKey: true }).keys, ['a']);
  assert.deepEqual(selectEntry(group, order, 'd', { shiftKey: true, ctrlKey: true }).keys, ['a', 'c', 'd']);
});
void test('virtual rows participate without mounting them, and removed anchors use the focused entry', () => {
  const order = Array.from({ length: 3000 }, (_, index) => String(index));
  assert.equal(selectEntry(emptySelection(), order, '2999', { shiftKey: true }, '0').keys.length, 3000);
  assert.deepEqual(selectEntry({ keys: ['gone'], anchor: 'gone' }, ['a', 'b'], 'b', { shiftKey: true }, 'a').keys, [
    'a',
    'b',
  ]);
});
void test('multiple files and folders keep scope, honor filters, and deduplicate descendants', () => {
  const entries = ['pr1/src/a.ts', 'pr1/src/nested/b.ts', 'pr1/src-other/c.ts', 'pr2/src/a.ts'].map((key) => ({ key }));
  const selected = ['pr1/src/', 'pr1/src/a.ts', 'pr1/src/nested/', 'pr2/src/a.ts'];
  assert.deepEqual(selectedTreeFiles(entries, selected), [entries[0], entries[1], entries[3]]);
  assert.deepEqual(selectedTreeFiles(entries.slice(1), selected, new Set([entries[1].key])), [entries[1]]);
  assert.deepEqual(selectedTreeFiles(entries, selected, new Set()), []);
});
void test('batch requests are bounded and a failure does not discard or repeat successful targets', async () => {
  let active = 0,
    peak = 0;
  const calls: number[] = [];
  const result = await runSelectionTasks([1, 2, 3, 4, 5], async (target) => {
    calls.push(target);
    peak = Math.max(peak, ++active);
    await new Promise((resolve) => setTimeout(resolve, 2));
    active--;
    if (target === 2 || target === 4) throw new Error('GitHub unavailable');
  });
  assert.equal(peak, 2);
  assert.deepEqual(calls.sort(), [1, 2, 3, 4, 5]);
  assert.deepEqual(result.succeeded.sort(), [1, 3, 5]);
  assert.deepEqual(result.failed.map((failure) => failure.target).sort(), [2, 4]);
});
