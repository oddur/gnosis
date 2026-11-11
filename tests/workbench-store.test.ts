import test from 'node:test';
import assert from 'node:assert/strict';
import { groupSubjects, type QueueItem, type ReviewMember, type WorkbenchQueue } from '../lib/workbench';
import { historyRevision, stampQueue, type WorkbenchRevisions } from '../lib/workbench-revision';
import { createWorkbenchStore } from '../lib/workbench-store';
import type { ReviewHistoryEntry } from '../lib/types';

const member = (n: number): ReviewMember => ({
  number: n,
  repo: 'owner/repo',
  baseRepo: 'owner/repo',
  headRepo: 'owner/repo',
  url: `https://github.com/owner/repo/pull/${n}`,
  title: `PR ${n}`,
  description: '',
  author: 'alice',
  role: 'watched',
  baseBranch: 'main',
  headBranch: `pr-${n}`,
  baseSha: 'base',
  headSha: `head-${n}`,
  merged: false,
  state: 'open',
  createdAt: '2026-10-21T12:00:00Z',
  updatedAt: '2026-10-22T10:00:00Z',
  labels: [],
  mergeable: true,
  isDraft: false,
  commitCount: 1,
  requestedReviewers: [],
  requestedTeams: [],
  mergeableState: 'clean',
  autoMerge: null,
  milestone: null,
});
const item = (n: number): QueueItem => ({ subject: groupSubjects([member(n)])[0], attention: 'other' });
const entry = (id: string): ReviewHistoryEntry => ({
  id, prUrl: member(1).url, prTitle: 'PR 1', author: 'alice', savedAt: '2026-11-01T00:00:00Z', status: 'completed', riskLevel: 'low',
});
const sleep = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

/** A main process stand-in: every read is a fresh, stamped copy, as IPC delivers it. */
function backend() {
  const state = { queue: { items: [item(1), item(2)], sync: { status: 'idle' as const }, warnings: [], remaining: 1 } as WorkbenchQueue, history: [entry('a')] };
  const calls = { snapshot: 0, discover: 0, reviews: 0 };
  let changed: ((revisions?: WorkbenchRevisions) => void) | undefined;
  let gate: Promise<void> | undefined;
  const read = () => stampQueue(structuredClone(state.queue), state.history);
  const api = {
    workbenchSnapshot: async () => { calls.snapshot++; await gate; return read(); },
    workbenchQueue: async () => { calls.discover++; await gate; return read(); },
    listReviews: async () => { calls.reviews++; await gate; return structuredClone(state.history); },
    onWorkbenchChanged: (callback: (revisions?: WorkbenchRevisions) => void) => { changed = callback; return () => { changed = undefined; }; },
  };
  return {
    state, calls, api,
    revisions: (): WorkbenchRevisions => { const q = read(); return { revision: q.revision ?? '', historyRevision: q.historyRevision ?? '' }; },
    push: (revisions?: WorkbenchRevisions) => changed?.(revisions),
    pause: () => { let release!: () => void; gate = new Promise((resolve) => { release = resolve; }); return () => { gate = undefined; release(); }; },
  };
}
async function loaded() {
  const server = backend();
  const store = createWorkbenchStore(() => server.api, { delay: 5 });
  let renders = 0;
  const stop = store.subscribe(() => { renders++; });
  await sleep();
  return { server, store, stop, renders: () => renders, reset: () => { renders = 0; } };
}

void test('unchanged pushes read nothing and notify nobody', async () => {
  const { server, store, stop, renders, reset } = await loaded();
  assert.equal(store.getStatus().loaded, true);
  assert.deepEqual(server.calls, { snapshot: 1, discover: 0, reviews: 1 });
  assert.equal(store.getHistory().length, 1);
  reset();
  const queue = store.getQueue();
  for (let i = 0; i < 5; i++) server.push(server.revisions());
  await sleep();
  assert.deepEqual(server.calls, { snapshot: 1, discover: 0, reviews: 1 }, 'Matching revisions need no read');
  server.push();
  await sleep();
  assert.equal(server.calls.snapshot, 2, 'A push without revisions reads once');
  assert.equal(server.calls.reviews, 1);
  assert.equal(renders(), 0);
  assert.equal(store.getQueue(), queue);
  stop();
});

void test('a changed entry gets a new identity and its neighbours keep theirs', async () => {
  const { server, store, stop, renders, reset } = await loaded();
  const before = store.getQueue();
  const history = store.getHistory();
  reset();
  server.state.queue.items[1].subject.title = 'Renamed';
  server.push(server.revisions());
  server.push(server.revisions());
  await sleep();
  const after = store.getQueue();
  assert.equal(server.calls.snapshot, 2);
  assert.equal(server.calls.reviews, 1, 'Saved reviews are unchanged');
  assert.equal(renders(), 1);
  assert.notEqual(after.items, before.items);
  assert.equal(after.items[0], before.items[0]);
  assert.notEqual(after.items[1], before.items[1]);
  assert.equal(after.sync, before.sync, 'Unchanged fields keep their identity');
  assert.equal(store.getHistory(), history);
  stop();
});

void test('saved reviews load once per revision and keep unchanged entries', async () => {
  const { server, store, stop } = await loaded();
  const first = store.getHistory()[0];
  server.state.history = [entry('b'), entry('a')];
  const revisions = server.revisions();
  assert.equal(revisions.historyRevision, historyRevision(server.state.history));
  for (let i = 0; i < 3; i++) { server.push(revisions); await sleep(8); }
  await sleep();
  assert.equal(server.calls.snapshot, 1, 'Only saved reviews changed');
  assert.equal(server.calls.reviews, 2);
  assert.equal(store.getHistory()[1], first);
  await Promise.all([store.refresh({ history: true }), store.refresh({ history: true })]);
  await sleep();
  const reviews = () => server.calls.reviews;
  assert.equal(reviews(), 4, 'Concurrent forced reads share one request and one follow-up');
  stop();
});

void test('a hold discards reads that started before its release, then reads once', async () => {
  const { server, store, stop } = await loaded();
  const release = server.pause();
  server.state.queue.items[0].subject.title = 'Changed elsewhere';
  server.push(server.revisions());
  await sleep();
  const unhold = store.hold();
  // A write result applies at once, even while held.
  const written = structuredClone(server.state.queue);
  written.items[0].subject.title = 'Written';
  store.apply(stampQueue(written));
  assert.equal(store.getQueue().items[0].subject.title, 'Written');
  release();
  await sleep();
  assert.equal(store.getQueue().items[0].subject.title, 'Written', 'A read that started before the write is discarded');
  server.state.queue.items[0].subject.title = 'Written';
  const reads = server.calls.snapshot;
  unhold();
  await sleep();
  assert.equal(server.calls.snapshot, reads + 1, 'Release reads once');
  assert.equal(store.getQueue().items[0].subject.title, 'Written');
  stop();
});

void test('an optimistic patch is replaced by the next push', async () => {
  const { server, store, stop } = await loaded();
  const revisions = server.revisions();
  store.patch((queue) => ({ ...queue, items: queue.items.map((entry, index) => (index ? entry : { ...entry, unreadUrls: ['x'] })) }));
  assert.deepEqual(store.getQueue().items[0].unreadUrls, ['x']);
  assert.equal(store.getQueue().revision, undefined);
  server.push(revisions);
  await sleep();
  assert.equal(server.calls.snapshot, 2, 'A patched queue has no revision, so any push reads');
  assert.equal(store.getQueue().items[0].unreadUrls, undefined);
  assert.equal(store.getQueue().revision, revisions.revision);
  stop();
});

void test('discovery shares one request per kind, and an account change forgets the queue', async () => {
  const { server, store, stop } = await loaded();
  await Promise.all([store.refresh({ discover: true }), store.refresh({ discover: true })]);
  assert.equal(server.calls.discover, 1);
  store.reset('first');
  assert.equal(store.getQueue().items.length, 2, 'The first account keeps what it loaded');
  store.reset('second');
  assert.equal(store.getQueue().items.length, 0);
  assert.equal(store.getStatus().loaded, false);
  await sleep();
  assert.equal(store.getQueue().items.length, 2);
  stop();
  server.push();
  await sleep();
  assert.equal(server.calls.snapshot, 2, 'Without subscribers the store stops listening');
});
