import test from 'node:test';
import assert from 'node:assert/strict';
import {
  readDiscussion,
  setDiscussionAccount,
  subscribeDiscussions,
  subscribeDiscussionFailures,
} from '../lib/review-discussion-cache';
import type { GitHubReviewThreads } from '../lib/review-threads';

const thread = {
  id: 'T1',
  path: 'queue.ts',
  line: 1,
  startLine: null,
  diffSide: 'RIGHT' as const,
  isResolved: false,
  isOutdated: false,
  viewerCanResolve: true,
  viewerCanUnresolve: false,
  comments: [{ id: 'C1', body: 'Check cancellation.', createdAt: '', url: '', author: null }],
};
const saved: GitHubReviewThreads = { headSha: 'head', baseSha: 'base', checkedAt: 1, threads: [thread] };
function host(api: {
  cached?: () => Promise<GitHubReviewThreads | undefined>;
  read: (refresh?: boolean, options?: { revalidate?: boolean }) => Promise<GitHubReviewThreads>;
}) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      electronAPI: {
        getCachedReviewThreads: api.cached,
        getReviewThreads: (_url: string, refresh?: boolean, options?: { revalidate?: boolean }) =>
          api.read(refresh, options),
      },
    },
  });
  return () => {
    if (original) Object.defineProperty(globalThis, 'window', original);
    else Reflect.deleteProperty(globalThis, 'window');
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

void test('readDiscussion resolves with the cached copy, then publishes the refreshed one', async () => {
  const url = 'https://github.com/o/r/pull/11';
  const network = deferred<GitHubReviewThreads>();
  const reads: unknown[] = [];
  const restore = host({
    cached: () => Promise.resolve(structuredClone(saved)),
    read: (refresh, options) => {
      reads.push({ refresh, ...options });
      return network.promise;
    },
  });
  const published: GitHubReviewThreads[] = [];
  const stop = subscribeDiscussions((target, data) => {
    if (target === url) published.push(data);
  });
  try {
    setDiscussionAccount('cached-first');
    const shown = await readDiscussion(url);
    assert.equal(shown.stale, true);
    assert.equal(shown.threads.length, 1);
    assert.deepEqual(reads, [{ refresh: false, revalidate: true }], 'The refresh runs behind the saved copy');
    assert.equal(await readDiscussion(url), shown, 'Later readers get the displayed copy without waiting');
    network.resolve({ ...saved, checkedAt: 2, threads: [{ ...thread, isResolved: true }] });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(published.length, 2);
    assert.equal(published[1].stale, undefined);
    assert.equal(published[1].threads[0].isResolved, true);
  } finally {
    stop();
    restore();
  }
});

void test('a failed revalidation keeps the cached copy and reports a failure', async () => {
  const url = 'https://github.com/o/r/pull/12';
  const restore = host({
    cached: () => Promise.resolve(structuredClone(saved)),
    read: () => Promise.reject(new Error('GitHub is rate limited')),
  });
  const failures: string[] = [];
  const stop = subscribeDiscussionFailures((target, error) => {
    if (target === url) failures.push(error instanceof Error ? error.message : String(error));
  });
  try {
    setDiscussionAccount('cached-failure');
    const shown = await readDiscussion(url);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(failures, ['GitHub is rate limited']);
    assert.equal(await readDiscussion(url), shown, 'The saved copy stays displayed');
    assert.equal(shown.stale, true);
  } finally {
    stop();
    restore();
  }
});

void test('an unchanged refresh keeps the threads array identity', async () => {
  const url = 'https://github.com/o/r/pull/13';
  const restore = host({
    cached: () => Promise.resolve(structuredClone(saved)),
    read: () => Promise.resolve({ ...structuredClone(saved), checkedAt: 2 }),
  });
  const published: GitHubReviewThreads[] = [];
  const stop = subscribeDiscussions((target, data) => {
    if (target === url) published.push(data);
  });
  try {
    setDiscussionAccount('cached-identity');
    const shown = await readDiscussion(url);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(published.length, 2);
    assert.equal(published[1].threads, shown.threads, 'Unchanged threads keep their array');
    assert.equal(published[1].stale, undefined);
    assert.equal(published[1].checkedAt, 2);
  } finally {
    stop();
    restore();
  }
});

void test('without a saved copy, readDiscussion waits for GitHub', async () => {
  const url = 'https://github.com/o/r/pull/14';
  const reads: unknown[] = [];
  const restore = host({
    cached: () => Promise.resolve(undefined),
    read: (refresh, options) => {
      reads.push({ refresh, ...options });
      return Promise.resolve(structuredClone(saved));
    },
  });
  try {
    setDiscussionAccount('cached-miss');
    const [a, b] = await Promise.all([readDiscussion(url), readDiscussion(url)]);
    assert.equal(a, b);
    assert.equal(a.stale, undefined);
    assert.deepEqual(reads, [{ refresh: false }], 'Concurrent readers share one blocking read');
  } finally {
    restore();
  }
});
