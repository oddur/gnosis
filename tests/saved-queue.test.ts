import test from 'node:test';
import assert from 'node:assert/strict';
import { groupSubjects, type QueueItem, type ReviewMember, type WorkbenchQueue } from '../lib/workbench';
import { stampQueue } from '../lib/workbench-revision';
import { createWorkbenchStore } from '../lib/workbench-store';
import { keepSavedQueue, parseSavedQueue, savedQueueFor, serializeSavedQueue, serializeSavedQueueInSlices, SAVED_QUEUE_KEY, SAVED_QUEUE_MAX_AGE_MS } from '../lib/saved-queue';

const member = (n: number, headSha = `head-${n}`, description = ''): ReviewMember => ({
  number: n, repo: 'owner/repo', baseRepo: 'owner/repo', headRepo: 'owner/repo', url: `https://github.com/owner/repo/pull/${n}`,
  title: `PR ${n}`, description, author: 'alice', role: 'watched', baseBranch: 'main', headBranch: `pr-${n}`, baseSha: 'base', headSha,
  merged: false, state: 'open', createdAt: '2026-10-21T12:00:00Z', updatedAt: '2026-10-22T10:00:00Z', labels: [], mergeable: true,
  isDraft: false, commitCount: 1, requestedReviewers: [], requestedTeams: [], mergeableState: 'clean', autoMerge: null, milestone: null,
});
const item = (n: number, headSha?: string, description?: string): QueueItem =>
  ({ subject: groupSubjects([member(n, headSha, description)])[0], attention: 'other' });
const queueOf = (...items: QueueItem[]): WorkbenchQueue => stampQueue({ items, warnings: [], remaining: 0 }, []);
const sleep = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

/** Main answers when released, with the current head of PR 1. */
function backend(current: WorkbenchQueue) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const calls = { snapshot: [] as (boolean | undefined)[] };
  const api = {
    workbenchSnapshot: async (withSignals?: boolean) => { calls.snapshot.push(withSignals); await gate; return structuredClone(current); },
    workbenchQueue: async () => { await gate; return structuredClone(current); },
    listReviews: () => Promise.resolve([]),
  };
  return { api, calls, release };
}
function storage(initial?: unknown) {
  const values = new Map<string, unknown>(initial === undefined ? [] : [[SAVED_QUEUE_KEY, initial]]);
  const writes: unknown[] = [];
  return {
    values, writes,
    read: (key: string) => values.get(key),
    write: (key: string, value: unknown) => { writes.push(value); values.set(key, structuredClone(value)); return Promise.resolve(); },
  };
}

void test('the saved queue shows before main answers, marked saved until the first snapshot replaces it', async () => {
  const saved = savedQueueFor(queueOf(item(1, 'old-head'), item(2)), 'alice');
  const main = backend(queueOf(item(1, 'new-head'), item(2), item(3)));
  const store = createWorkbenchStore(() => main.api, { delay: 5 });
  const disk = storage(saved);
  const kept = keepSavedQueue(store, disk, { delay: 5 });
  assert.equal(kept.account, 'alice');
  assert.deepEqual(store.getStatus(), { loaded: true, saved: true });
  assert.equal(store.getQueue().items[0].subject.members[0].headSha, 'old-head', 'The saved revision is shown as saved');
  store.reset('alice');
  await sleep();
  assert.deepEqual(main.calls.snapshot, [true], 'The first snapshot still brings saved status for the rows');
  assert.deepEqual(disk.writes, [], 'The saved copy is never saved again as if main had answered');
  main.release();
  await sleep();
  assert.deepEqual(store.getStatus(), { loaded: true });
  assert.equal(store.getQueue().items[0].subject.members[0].headSha, 'new-head');
  assert.equal(store.getQueue().items.length, 3);
  await sleep(30);
  assert.equal(disk.writes.length, 1, 'Main’s queue is saved for the next launch');
  assert.equal(parseSavedQueue(disk.values.get(SAVED_QUEUE_KEY))?.queue.items.length, 3);
  kept.stop();
});

void test('a saved queue from another account is dropped when main names the account', () => {
  const main = backend(queueOf(item(1)));
  const store = createWorkbenchStore(() => main.api, { delay: 5 });
  keepSavedQueue(store, storage(savedQueueFor(queueOf(item(9)), 'bob')), { delay: 5 }).stop();
  assert.equal(store.getStatus().saved, true);
  store.reset('alice');
  assert.deepEqual(store.getStatus(), { loaded: false });
  assert.equal(store.getQueue().items.length, 0);
});

void test('a saved queue never replaces one main already sent', async () => {
  const main = backend(queueOf(item(1)));
  main.release();
  const store = createWorkbenchStore(() => main.api, { delay: 5 });
  const stop = store.subscribe(() => {});
  await sleep();
  assert.equal(store.seed(queueOf(item(9)), 'alice'), false);
  assert.equal(store.getQueue().items[0].subject.members[0].number, 1);
  stop();
});

void test('only complete, recent copies are shown, and large queues keep fewer rows', () => {
  const now = Date.now();
  const saved = savedQueueFor(queueOf(item(1)), 'alice', now);
  assert.ok(parseSavedQueue(saved, now));
  assert.equal(parseSavedQueue({ ...saved, savedAt: now - SAVED_QUEUE_MAX_AGE_MS - 1 }, now), undefined);
  assert.equal(parseSavedQueue({ ...saved, account: '' }, now), undefined);
  assert.equal(parseSavedQueue({ ...saved, queue: { items: [{ subject: { id: 'x' } }] } }, now), undefined);
  assert.equal(parseSavedQueue('not saved', now), undefined);
  const large = queueOf(...Array.from({ length: 300 }, (_, n) => item(n + 1, undefined, 'x'.repeat(20_000))));
  const bounded = savedQueueFor({ ...large, savedSignals: { account: 'alice', values: [] } }, 'alice', now);
  assert.ok(bounded.queue.items.length < 150 && bounded.queue.items.length >= 10);
  assert.ok(JSON.stringify(bounded).length <= 1_500_000);
  assert.equal(bounded.queue.savedSignals, undefined, 'Saved status is never part of the copy');
});

void test('the copy is serialized in slices, as one JSON string, and not saved again for the same content', async () => {
  const large = queueOf(...Array.from({ length: 150 }, (_, n) => item(n + 1, undefined, 'x'.repeat(8_000))));
  // Slices yield only when one runs long; the text must not depend on where.
  const json = await serializeSavedQueueInSlices(large, 'alice', Date.now(), () => Promise.resolve());
  const savedAt = (JSON.parse(json) as { savedAt: number }).savedAt;
  assert.equal(json, serializeSavedQueue(large, 'alice', savedAt), 'Slices produce the same text');
  assert.equal(parseSavedQueue(json)?.queue.items.length, 150);

  const main = backend(large);
  main.release();
  const store = createWorkbenchStore(() => main.api, { delay: 5 });
  const disk = storage();
  const kept = keepSavedQueue(store, disk, { delay: 5 });
  store.reset('alice');
  const stop = store.subscribe(() => {});
  await sleep(80);
  assert.equal(disk.writes.length, 1);
  assert.equal(typeof disk.writes[0], 'string', 'The copy crosses IPC as one string');
  await store.refresh();
  await sleep(80);
  assert.equal(disk.writes.length, 1, 'A queue with the same content revision is not saved again');
  stop();
  kept.stop();
});

void test('status that arrives after the queue is saved with it', async () => {
  let checkedAt = 1;
  let listener: (() => void) | undefined;
  const signals = {
    read: (_account: string, requests: { url: string; headSha: string }[]) => requests.map((r) => ({ ...r, checkedAt, comments: 0,
      checks: { state: 'success' as const, passed: 1, skipped: 0, total: 1 } })),
    publish: () => {},
    stamp: () => String(checkedAt),
    subscribe: (_account: string, next: () => void) => { listener = next; return () => { listener = undefined; }; },
  };
  const main = backend(queueOf(item(1)));
  main.release();
  const store = createWorkbenchStore(() => main.api, { delay: 5 });
  const disk = storage();
  const kept = keepSavedQueue(store, disk, { delay: 5, signals });
  store.reset('alice');
  await sleep(60);
  assert.equal(disk.writes.length, 1);
  checkedAt = 2;
  listener?.();
  await sleep(60);
  assert.equal(disk.writes.length, 2, 'New status for a saved row saves the copy again');
  assert.equal(parseSavedQueue(disk.values.get(SAVED_QUEUE_KEY))?.signals?.[0].checkedAt, 2);
  kept.stop();
});

void test('saved rows keep their saved status, and the store names their account before the window does', async () => {
  const status = (url: string, headSha: string) => ({ url, headSha, checkedAt: 1_000, comments: 0,
    checks: { state: 'success' as const, passed: 3, skipped: 0, total: 3 } });
  const published: { account: string; urls: string[] }[] = [];
  const signals = {
    read: (_account: string, requests: { url: string; headSha: string }[]) => requests.map((r) => status(r.url, r.headSha)),
    publish: (account: string, values: { url: string }[]) => void published.push({ account, urls: values.map((v) => v.url) }),
  };
  const text = serializeSavedQueue(queueOf(item(1), item(2)), 'alice', Date.now(), signals.read);
  assert.deepEqual(parseSavedQueue(text)?.signals?.map((s) => s.headSha), ['head-1', 'head-2']);
  const main = backend(queueOf(item(1)));
  const store = createWorkbenchStore(() => main.api, { delay: 5 });
  const kept = keepSavedQueue(store, storage(text), { delay: 5, signals });
  assert.deepEqual(published, [{ account: 'alice', urls: [item(1).subject.members[0].url, item(2).subject.members[0].url] }]);
  assert.equal(store.getShownAccount(), 'alice');
  kept.stop();
  // Without a saved copy, main's first snapshot names the account with its saved status.
  const fresh = backend(queueOf(item(1)));
  fresh.api.workbenchSnapshot = () => Promise.resolve({ ...queueOf(item(1)), savedSignals: { account: 'carol', values: [] } });
  const other = createWorkbenchStore(() => fresh.api, { delay: 5 });
  const stop = other.subscribe(() => {});
  await sleep();
  assert.equal(other.getShownAccount(), 'carol');
  stop();
});
