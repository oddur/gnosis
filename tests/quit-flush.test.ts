import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAppDataStore } from '../src/app-data-store';
import { createRendererFlush, saveWorkBeforeQuit, type FlushTarget } from '../src/quit-flush';
import { initializeReviewState, readReviewState, scheduleReviewStateWrite, writeReviewState } from '../lib/renderer-review-state';
import { keepSavedQueue, parseSavedQueue, SAVED_QUEUE_KEY } from '../lib/saved-queue';
import { createWorkbenchStore } from '../lib/workbench-store';
import { groupSubjects, type QueueItem, type ReviewMember, type WorkbenchQueue } from '../lib/workbench';
import { stampQueue } from '../lib/workbench-revision';
import type { ReviewStateWrite, FileProgressPatch } from '../lib/review-state';

const member = (n: number): ReviewMember => ({
  number: n, repo: 'owner/repo', baseRepo: 'owner/repo', headRepo: 'owner/repo', url: `https://github.com/owner/repo/pull/${n}`,
  title: `PR ${n}`, description: '', author: 'alice', role: 'watched', baseBranch: 'main', headBranch: `pr-${n}`, baseSha: 'base', headSha: `head-${n}`,
  merged: false, state: 'open', createdAt: '2026-10-21T12:00:00Z', updatedAt: '2026-10-22T10:00:00Z', labels: [], mergeable: true,
  isDraft: false, commitCount: 1, requestedReviewers: [], requestedTeams: [], mergeableState: 'clean', autoMerge: null, milestone: null,
});
const item = (n: number): QueueItem => ({ subject: groupSubjects([member(n)])[0], attention: 'other' });
const queueOf = (...items: QueueItem[]): WorkbenchQueue => stampQueue({ items, warnings: [], remaining: 0 }, []);

/** A window that answers a flush request after `delay` ms, or never. */
function target(
  rendererFlush: ReturnType<typeof createRendererFlush>,
  { delay = 0, hung = false, destroyed = false, onFlush = () => Promise.resolve() } = {}
): FlushTarget & { requests: number } {
  return {
    requests: 0,
    isDestroyed: () => destroyed,
    isCrashed: () => false,
    send(channel: string, id: unknown) {
      assert.equal(channel, 'flush-review-state');
      this.requests++;
      if (hung) return;
      setTimeout(() => void onFlush().finally(() => rendererFlush.acknowledge(id)), delay);
    },
  };
}

void test('windows flush in parallel; hung windows cost one timeout together and close waits for the rest', async () => {
  const rendererFlush = createRendererFlush({ timeoutMs: 300 });
  const order: string[] = [];
  const saved = (name: string) => () => {
    order.push(name);
    return Promise.resolve();
  };
  const quick = target(rendererFlush, { delay: 20, onFlush: saved('quick saved') });
  const slow = target(rendererFlush, { delay: 120, onFlush: saved('slow saved') });
  const hung = target(rendererFlush, { hung: true });
  const alsoHung = target(rendererFlush, { hung: true });
  const gone = target(rendererFlush, { destroyed: true });
  const warn = console.warn;
  const warnings: string[] = [];
  console.warn = (message: string) => warnings.push(message);
  // Mocked timers, so the timeouts are counted in the test's own time, not the machine's.
  mock.timers.enable({ apis: ['setTimeout'] });
  // setImmediate is not mocked: waiting for it runs every pending promise callback.
  const advance = async (ms: number) => {
    mock.timers.tick(ms);
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
  };
  try {
    let result: { flushed: number; timedOut: number } | undefined;
    let quit = false;
    const quitting = saveWorkBeforeQuit({
      targets: [quick, slow, hung, alsoHung, gone],
      flush: async (targets) => (result = await rendererFlush.flush(targets)),
      close: saved('closed'),
    }).then(() => (quit = true));
    await advance(120);
    assert.deepEqual(order, ['quick saved', 'slow saved'], 'answering windows save at once');
    await advance(179);
    assert.equal(quit, false, 'hung windows get their whole timeout');
    // Both hung windows time out together at 300 ms; one after the other would take 600 ms.
    await advance(1);
    assert.equal(quit, true, 'one timeout, not one per window');
    await quitting;
    assert.deepEqual(order, ['quick saved', 'slow saved', 'closed']);
    assert.deepEqual(result, { flushed: 2, timedOut: 2 });
    assert.equal(gone.requests, 0, 'a destroyed window is not asked');
    assert.match(warnings.join('\n'), /2 windows did not answer in time/);
    // A late answer from the hung window after the timeout is ignored.
    rendererFlush.acknowledge(3);
  } finally {
    mock.timers.reset();
    console.warn = warn;
  }
});

void test('a window that closes while it is asked does not hold up quit', async () => {
  const rendererFlush = createRendererFlush({ timeoutMs: 5_000 });
  const closing: FlushTarget = {
    isDestroyed: () => false,
    isCrashed: () => false,
    send: () => {
      throw new Error('Object has been destroyed');
    },
  };
  // With mocked timers, the flush must settle without its 5 s timeout firing.
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    assert.deepEqual(await rendererFlush.flush([closing]), { flushed: 0, timedOut: 0 });
  } finally {
    mock.timers.reset();
  }
});

void test('a scroll position saved just before quit is restored after relaunch', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gnosis-quit-flush-'));
  let store = createAppDataStore();
  let flushRenderer: (() => Promise<void>) | undefined;
  const sent: string[] = [];
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const oldStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const browser = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      get length() {
        return browser.size;
      },
      key: (i: number) => [...browser.keys()][i] ?? null,
      getItem: (k: string) => browser.get(k) ?? null,
      setItem: (k: string, v: string) => browser.set(k, v),
      removeItem: (k: string) => browser.delete(k),
    },
  });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      electronAPI: {
        reviewStateStorageVersion: 1,
        loadReviewState: (legacy: Record<string, string>) => store.loadReviewState(legacy),
        saveReviewState: (value: ReviewStateWrite) => {
          sent.push(value.key);
          return store.saveReviewState(value);
        },
        saveFileProgress: (value: FileProgressPatch) => store.saveFileProgress(value),
        onFlushReviewState: (callback: () => Promise<void>) => {
          flushRenderer = callback;
        },
      },
    },
  });
  const rendererFlush = createRendererFlush();
  const key = 'gnosis-explanation-position:review-q:reading';
  const tabs = 'gnosis-workspace-tabs:v1:alice';
  try {
    await store.open(directory);
    await initializeReviewState();
    assert.ok(flushRenderer, 'the renderer registers its flush when saved state loads');
    await writeReviewState(tabs, { active: 'one' });
    // The reader scrolls, then quits before the debounce fires (a minute here, so only the flush can
    // run it). A chained save, as the scroll hook and open tabs use, still runs before close.
    let chain = Promise.resolve();
    const cancel = scheduleReviewStateWrite(() => {
      chain = chain.then(() => writeReviewState(key, { top: 4321, left: 0 }));
    }, 60_000);
    const window: FlushTarget = {
      isDestroyed: () => false,
      isCrashed: () => false,
      send: (_channel, id) => void flushRenderer?.().finally(() => rendererFlush.acknowledge(id)),
    };
    await saveWorkBeforeQuit({
      targets: [window],
      flush: (targets) => rendererFlush.flush(targets),
      close: () => store.close(),
    });
    cancel();
    // Closing the window saves open tabs again. The value is unchanged, so nothing is sent or lost.
    const before = sent.length;
    await writeReviewState(tabs, { active: 'one' });
    assert.equal(sent.length, before);
    assert.equal(store.lostWrites(), 0);
    store = createAppDataStore();
    await store.open(directory);
    const restored = await store.loadReviewState({});
    assert.deepEqual(restored[key], { top: 4321, left: 0 });
    assert.deepEqual(restored[tabs], { active: 'one' });
  } finally {
    await store.close();
    fs.rmSync(directory, { recursive: true, force: true });
    if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow);
    else Reflect.deleteProperty(globalThis, 'window');
    if (oldStorage) Object.defineProperty(globalThis, 'localStorage', oldStorage);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});

void test('a saved queue that changed just before quit reaches disk, and a write after close is refused and counted', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gnosis-quit-queue-'));
  let store = createAppDataStore();
  let flushRenderer: (() => Promise<void>) | undefined;
  const pagehide: (() => void)[] = [];
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const oldStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  // Migration is done, so review state never reads browser storage.
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { length: 0, key: () => null, getItem: () => 'done', setItem: () => {}, removeItem: () => {} },
  });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      addEventListener: (type: string, listener: () => void) => {
        if (type === 'pagehide') pagehide.push(listener);
      },
      removeEventListener: () => {},
      electronAPI: {
        reviewStateStorageVersion: 1,
        loadReviewState: (legacy: Record<string, string>) => store.loadReviewState(legacy),
        saveReviewState: (value: ReviewStateWrite) => store.saveReviewState(value),
        saveFileProgress: (value: FileProgressPatch) => store.saveFileProgress(value),
        onFlushReviewState: (callback: () => Promise<void>) => {
          flushRenderer = callback;
        },
      },
    },
  });
  const warn = console.warn;
  const warnings: string[] = [];
  console.warn = (message: string) => warnings.push(message);
  const rendererFlush = createRendererFlush();
  let kept: ReturnType<typeof keepSavedQueue> | undefined;
  try {
    await store.open(directory);
    await initializeReviewState();
    const queue = queueOf(item(1), item(2), item(3));
    const workbench = createWorkbenchStore(
      () => ({ workbenchSnapshot: () => Promise.resolve(structuredClone(queue)), workbenchQueue: () => Promise.resolve(structuredClone(queue)), listReviews: () => Promise.resolve([]) }),
      { delay: 1 }
    );
    // The app's wiring: the queue saves through review state, a minute after it changes here, so only quit can run it.
    kept = keepSavedQueue(workbench, { read: readReviewState, write: writeReviewState, schedule: scheduleReviewStateWrite }, { delay: 60_000 });
    workbench.reset('alice');
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(workbench.getQueue().items.length, 3, 'main answered, so the queue is due to be saved');
    const window: FlushTarget = {
      isDestroyed: () => false,
      isCrashed: () => false,
      send: (_channel, id) => void flushRenderer?.().finally(() => rendererFlush.acknowledge(id)),
    };
    await saveWorkBeforeQuit({ targets: [window], flush: (targets) => rendererFlush.flush(targets), close: () => store.close() });
    // The window closes after the store: what it saves on the way out is already on disk, so nothing is lost.
    for (const listener of pagehide) listener();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(store.lostWrites(), 0);
    // A write that still arrives after close is refused and counted, never reported as saved.
    await store.saveReviewState({ key: 'gnosis-workspace-tabs:v1:alice', value: { active: 'late' } });
    assert.equal(store.lostWrites(), 1);
    assert.match(warnings.join('\n'), /late review state was not saved/);
    store = createAppDataStore();
    await store.open(directory);
    const restored = await store.loadReviewState({});
    assert.equal(parseSavedQueue(restored[SAVED_QUEUE_KEY])?.queue.items.length, 3, 'the queue shown at quit opens next launch');
    assert.equal(restored['gnosis-workspace-tabs:v1:alice'], undefined, 'the late write never reached disk');
  } finally {
    kept?.stop();
    console.warn = warn;
    await store.close();
    fs.rmSync(directory, { recursive: true, force: true });
    if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow);
    else Reflect.deleteProperty(globalThis, 'window');
    if (oldStorage) Object.defineProperty(globalThis, 'localStorage', oldStorage);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});
