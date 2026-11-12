import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAppDataStore } from '../src/app-data-store';
import { createRendererFlush, saveWorkBeforeQuit, type FlushTarget } from '../src/quit-flush';
import { initializeReviewState, scheduleReviewStateWrite, writeReviewState } from '../lib/renderer-review-state';
import type { ReviewStateWrite, FileProgressPatch } from '../lib/review-state';

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
  const started = performance.now();
  try {
    let result: { flushed: number; timedOut: number } | undefined;
    await saveWorkBeforeQuit({
      targets: [quick, slow, hung, alsoHung, gone],
      flush: async (targets) => (result = await rendererFlush.flush(targets)),
      close: saved('closed'),
    });
    const elapsed = performance.now() - started;
    assert.deepEqual(order, ['quick saved', 'slow saved', 'closed']);
    assert.deepEqual(result, { flushed: 2, timedOut: 2 });
    assert.equal(gone.requests, 0, 'a destroyed window is not asked');
    // Two hung windows one after the other would take 600 ms.
    assert.ok(elapsed >= 290 && elapsed < 550, `one timeout, not one per window (${elapsed} ms)`);
    assert.match(warnings.join('\n'), /2 windows did not answer in time/);
    // A late answer from the hung window after the timeout is ignored.
    rendererFlush.acknowledge(3);
  } finally {
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
  const started = performance.now();
  assert.deepEqual(await rendererFlush.flush([closing]), { flushed: 0, timedOut: 0 });
  assert.ok(performance.now() - started < 100);
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
