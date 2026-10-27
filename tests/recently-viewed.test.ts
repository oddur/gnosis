import test from 'node:test';
import assert from 'node:assert/strict';
import { createRecentlyViewed, homeVisit } from '../lib/recently-viewed';
import type { HomeLocation } from '../lib/navigation-history';
import { DEFAULT_QUEUE_FILTERS } from '../lib/queue-filters';
const location = (viewId: string, tab: HomeLocation['tab'] = 'summary'): HomeLocation => ({
  account: 'alice',
  filters: DEFAULT_QUEUE_FILTERS,
  savedView: false,
  savedQuery: '',
  viewId,
  viewName: viewId,
  muted: false,
  item: null,
  tab,
  selected: null,
  scroll: 0,
});
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
void test('recent destinations deduplicate visits, preserve the latest tab and survive a new store', async () => {
  const disk = new Map<string, unknown>();
  const create = () =>
    createRecentlyViewed(
      (key) => disk.get(key),
      (key, value) => {
        disk.set(key, structuredClone(value));
        return Promise.resolve();
      }
    );
  const store = create();
  store.scope('alice');
  store.record(homeVisit(location('First')));
  store.record(homeVisit(location('Second')));
  store.record(homeVisit(location('First', 'changes')));
  assert.deepEqual(
    store.snapshot().entries.map((e) => e.title),
    ['First', 'Second']
  );
  await settle();
  const restored = create();
  restored.scope('alice');
  assert.deepEqual(restored.snapshot(), store.snapshot());
  store.scope('bob');
  assert.equal(store.snapshot().entries.length, 0);
  store.scope('alice');
  assert.equal(store.snapshot().entries.length, 2);
  store.clear();
  store.record(homeVisit(location('First', 'changes')));
  // An explicit visit after an account switch can populate an empty list.
  store.clear();
  store.record(homeVisit(location('First', 'changes')));
  assert.equal(store.snapshot().entries.length, 0);
  store.record(homeVisit(location('Third')));
  assert.equal(store.snapshot().entries[0].title, 'Third');
});
void test('account switches preserve pending writes, bounded history and recoverable storage failure', async () => {
  let fail = true;
  const store = createRecentlyViewed(
    () => undefined,
    () => fail ? Promise.reject(Error('disk full')) : Promise.resolve()
  );
  store.scope('alice');
  for (let i = 0; i < 30; i++) store.record(homeVisit(location(String(i))));
  store.scope('bob');
  store.scope('alice');
  assert.equal(store.snapshot().entries.length, 24);
  await settle();
  assert.match(store.snapshot().error, /Could not save/);
  fail = false;
  store.retry();
  await settle();
  assert.equal(store.snapshot().error, '');
});
