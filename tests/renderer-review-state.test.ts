import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createAppDataStore } from '../src/app-data-store';
import { initializeReviewState } from '../lib/renderer-review-state';
import { readReviewDrafts, updateReviewDrafts, type ChangesReviewDraft } from '../lib/changes-review-drafts';
import { markFileViewed, markFilesViewed, isFileViewed } from '../lib/file-view-progress';
import type { ReviewStateWrite, FileProgressPatch } from '../lib/review-state';
void test('renderer migration uses real SQLite, serializes concurrent drafts and never touches browser storage afterward', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gnosis-renderer-state-'));
  let store = createAppDataStore(),
    failed = false,
    browserForbidden = false;
  const progressWrites: FileProgressPatch[] = [];
  const draft: ChangesReviewDraft = {
    id: 'first',
    body: 'Keep this note',
    filePath: 'one.ts',
    headSha: 'head',
    baseSha: 'base',
    baseBranch: 'main',
    line: 1,
    side: 'RIGHT',
    slideIndex: 0,
    hunkHeader: '',
    codeSnippet: '',
  };
  const url = 'https://github.com/o/r/pull/88',
    key = `gnosis-changes-drafts:alice:${url}`;
  const browser = new Map([
    [key, JSON.stringify([draft])],
    ['gnosis-file-progress:v1', JSON.stringify({ aliases: { revision: 'content' }, marks: { content: true } })],
  ]);
  const check = () => {
    if (browserForbidden) throw new Error('Renderer used browser storage after migration');
  };
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window'),
    oldStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      get length() {
        check();
        return browser.size;
      },
      key: (i: number) => {
        check();
        return [...browser.keys()][i] ?? null;
      },
      getItem: (k: string) => {
        check();
        return browser.get(k) ?? null;
      },
      setItem: (k: string, v: string) => {
        check();
        browser.set(k, v);
      },
      removeItem: (k: string) => {
        check();
        browser.delete(k);
      },
    },
  });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      electronAPI: {
        reviewStateStorageVersion: 1,
        loadReviewState: (legacy: Record<string, string>) => store.loadReviewState(legacy),
        saveReviewState: (value: ReviewStateWrite) =>
          failed ? Promise.reject(new Error('Disk full')) : store.saveReviewState(value),
        saveFileProgress: (value: FileProgressPatch) => { progressWrites.push(value); return store.saveFileProgress(value); },
      },
    },
  });
  try {
    await store.open(directory);
    await initializeReviewState();
    assert.equal(browser.has(key), false);
    browserForbidden = true;
    assert.deepEqual(readReviewDrafts('alice', url), [draft]);
    assert.equal(isFileViewed('revision'), true);
    await Promise.all([
      updateReviewDrafts('alice', url, (items) => [...items, { ...draft, id: 'second' }]),
      updateReviewDrafts('alice', url, (items) => [...items, { ...draft, id: 'third' }]),
    ]);
    assert.deepEqual(
      readReviewDrafts('alice', url).map((d) => d.id),
      ['first', 'second', 'third']
    );
    failed = true;
    await assert.rejects(
      updateReviewDrafts('alice', url, () => []),
      /Disk full/
    );
    assert.equal(readReviewDrafts('alice', url).length, 3);
    assert.deepEqual(readReviewDrafts('bob', url), []);
    failed = false;
    await markFileViewed('revision', false);
    const keys = Array.from({ length: 3000 }, (_, i) => `folder/file-${i}`);
    const writesBefore = progressWrites.length;
    await markFilesViewed([...keys, 'revision', 'revision'], true);
    assert.equal(progressWrites.length, writesBefore + 1, 'one IPC/database patch for a whole folder');
    assert.equal(Object.keys((progressWrites.at(-1) as FileProgressPatch).marks).length, 3001);
    assert.equal((progressWrites.at(-1) as FileProgressPatch).marks.content, true, 'revision aliases remain shared with explanations');
    await markFilesViewed(keys, true);
    assert.equal(progressWrites.length, writesBefore + 1, 'already viewed files do not need another write');
    await markFilesViewed(['revision'], false);
    await store.close();
    store = createAppDataStore();
    await store.open(directory);
    const restored = await store.loadReviewState({});
    assert.equal((restored[key] as unknown[]).length, 3);
    assert.equal((restored['gnosis-file-progress:v1'] as FileProgressPatch).marks.content, false);
    assert.ok(keys.every(key => (restored['gnosis-file-progress:v1'] as FileProgressPatch).marks[key]));
  } finally {
    await store.close();
    fs.rmSync(directory, { recursive: true, force: true });
    if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow);
    else Reflect.deleteProperty(globalThis, 'window');
    if (oldStorage) Object.defineProperty(globalThis, 'localStorage', oldStorage);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});
