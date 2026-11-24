// Its own file: review state's quit flag is module state, and quit-flush.test.ts has already quit.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAppDataStore } from '../src/app-data-store';
import { createRendererFlush, saveWorkBeforeQuit, type FlushTarget } from '../src/quit-flush';
import { initializeReviewState, readReviewState, reviewStateQuitting, scheduleReviewStateWrite, writeReviewState } from '../lib/renderer-review-state';
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

void test('a queue save already slicing when quit starts stops pausing on timers and reaches disk', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gnosis-quit-slicing-'));
  let store = createAppDataStore();
  let flushRenderer: (() => Promise<void>) | undefined;
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
      addEventListener: () => {},
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
  // Each row takes longer than a slice, so the save pauses after every row, as a large queue does.
  let clock = 0;
  mock.method(performance, 'now', () => (clock += 10));
  // Slice pauses are zero-delay timers. Count those that start after quit began; a background window throttles them.
  let quitStarted = false;
  let pausesAfterQuit = 0;
  let slicing!: () => void;
  const started = new Promise<void>((resolve) => (slicing = resolve));
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((handler: () => void, delay?: number, ...rest: unknown[]) => {
    if (!delay) {
      if (quitStarted) pausesAfterQuit++;
      else slicing();
    }
    return realSetTimeout(handler, delay, ...rest);
  }) as typeof setTimeout;
  const rendererFlush = createRendererFlush();
  let kept: ReturnType<typeof keepSavedQueue> | undefined;
  try {
    await store.open(directory);
    await initializeReviewState();
    assert.equal(reviewStateQuitting(), false);
    const queue: WorkbenchQueue = stampQueue({ items: Array.from({ length: 30 }, (_, i) => item(i + 1)), warnings: [], remaining: 0 }, []);
    const workbench = createWorkbenchStore(
      () => ({ workbenchSnapshot: () => Promise.resolve(structuredClone(queue)), workbenchQueue: () => Promise.resolve(structuredClone(queue)), listReviews: () => Promise.resolve([]) }),
      { delay: 1 }
    );
    // The app's wiring, with a short debounce so the save is already running when quit starts.
    kept = keepSavedQueue(workbench, { read: readReviewState, write: writeReviewState, schedule: scheduleReviewStateWrite, quitting: reviewStateQuitting }, { delay: 1 });
    workbench.reset('alice');
    await started;
    quitStarted = true;
    const window: FlushTarget = {
      isDestroyed: () => false,
      isCrashed: () => false,
      send: (_channel, id) => void flushRenderer?.().finally(() => rendererFlush.acknowledge(id)),
    };
    await saveWorkBeforeQuit({ targets: [window], flush: (targets) => rendererFlush.flush(targets), close: () => store.close() });
    assert.equal(pausesAfterQuit, 0, 'the running save finishes without waiting on timers');
    assert.equal(store.lostWrites(), 0);
    store = createAppDataStore();
    await store.open(directory);
    const restored = await store.loadReviewState({});
    assert.equal(parseSavedQueue(restored[SAVED_QUEUE_KEY])?.queue.items.length, 30, 'the queue shown at quit opens next launch');
  } finally {
    globalThis.setTimeout = realSetTimeout;
    mock.restoreAll();
    kept?.stop();
    await store.close();
    fs.rmSync(directory, { recursive: true, force: true });
    if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow);
    else Reflect.deleteProperty(globalThis, 'window');
    if (oldStorage) Object.defineProperty(globalThis, 'localStorage', oldStorage);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});
