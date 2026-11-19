import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrFileCache } from '../lib/pr-file-cache';
import type { PrFileContents } from '../lib/pr-changes';
const request = { url: 'https://github.com/a/b/pull/1', path: 'src/file.ts', baseSha: 'base', headSha: 'head' };
const value: PrFileContents = { before: { kind: 'text', content: 'old' }, after: { kind: 'text', content: 'new' } };
void test('returning to a file synchronously reuses contents; concurrent opens coalesce', async () => {
  let reads = 0;
  const cache = createPrFileCache(async () => {
    reads++;
    return value;
  });
  const first = cache.read(request),
    second = cache.read(request);
  assert.equal(first, second);
  await first;
  assert.equal(cache.peek(request), value);
  await cache.read(request);
  assert.equal(reads, 1);
  assert.equal(cache.peek({ ...request, headSha: 'new-head' }), undefined);
  assert.equal(cache.peek({ ...request, url: request.url + '2' }), undefined);
});
void test('failed reads retry and contents are bounded by memory budget', async () => {
  let fail = true;
  const cache = createPrFileCache(async () => {
    if (fail) throw Error('offline');
    return value;
  }, 12);
  await assert.rejects(cache.read(request));
  fail = false;
  await cache.read(request);
  await cache.read({ ...request, path: 'second.ts' });
  assert.equal(cache.peek(request), undefined);
  assert.equal(cache.peek({ ...request, path: 'second.ts' }), value);
});

void test('a foreground click can continue when a speculative read stops at the background budget reserve', async () => {
  const calls: boolean[] = [];
  let rejectPrefetch: (error: Error) => void = () => {};
  const cache = createPrFileCache(async (_request, background) => {
    calls.push(!!background);
    if (background)
      await new Promise<void>((_resolve, reject) => {
        rejectPrefetch = reject;
      });
    return value;
  });
  const speculative = cache.read(request, true);
  const foreground = cache.read(request);
  rejectPrefetch(new Error('Background budget reserve'));
  await assert.rejects(speculative);
  assert.deepEqual(await foreground, value);
  assert.deepEqual(calls, [true, false]);
});

void test('account reset discards an in-flight file and permits a fresh read', async () => {
  const releases: ((value: PrFileContents) => void)[] = [];
  const cache = createPrFileCache(() => new Promise(resolve => releases.push(resolve)));
  const first = cache.read(request);
  cache.clear();
  const second = cache.read(request);
  releases[0](value); await first;
  assert.equal(cache.peek(request), undefined);
  assert.equal(cache.read(request), second, 'The old request must not remove the new in-flight read');
  releases[1](value); await second;
  assert.equal(cache.peek(request), value);
});

void test('background queue preparation cannot evict the selected PR to keep a lower-priority file', async () => {
  const cache = createPrFileCache(() => Promise.resolve(value), 12);
  const other = { ...request, url: request.url + '2' };
  cache.prioritize([request.url, other.url]);
  await cache.read(request); await cache.read(other, true);
  assert.equal(cache.peek(request), value);
  assert.equal(cache.peek(other), undefined);
  cache.prioritize([other.url, request.url]);
  await cache.read(other);
  assert.equal(cache.peek(other), value);
  assert.equal(cache.peek(request), undefined);
});

void test('context gaps read the after side alone, once, or take it from both sides already cached (#299)', async () => {
  let full = 0,
    after = 0;
  const cache = createPrFileCache(
    () => {
      full++;
      return Promise.resolve(value);
    },
    undefined,
    () => {
      after++;
      return Promise.resolve(value.after);
    }
  );
  const first = cache.readAfter(request),
    second = cache.readAfter(request);
  assert.equal(first, second, 'Concurrent reveals share one read');
  assert.deepEqual(await first, value.after);
  assert.deepEqual(cache.peekAfter(request), value.after);
  await cache.readAfter(request);
  assert.deepEqual([full, after], [0, 1]);
  assert.equal(cache.peek(request), undefined, 'An after side alone is not a cached file');
  const other = { ...request, path: 'other.ts' };
  await cache.read(other);
  assert.deepEqual(await cache.readAfter(other), value.after);
  assert.deepEqual([full, after], [1, 1], 'Both sides in the cache answer an after read');
  cache.clear();
  assert.equal(cache.peekAfter(request), undefined);
});
void test('files remember their PR’s last use and leave with their PR (#355)', async () => {
  let now = 1;
  const cache = createPrFileCache(() => Promise.resolve(value), 1_000_000, () => Promise.resolve(value.after), () => now);
  const other = { ...request, url: request.url + '0' };
  await cache.read(request);
  await cache.read(other);
  now = 5;
  await cache.readAfter({ ...other, path: 'src/other.ts' });
  cache.peek(request);
  const uses = new Map<string, number>();
  cache.lastUses(uses);
  assert.deepEqual([...uses].sort(), [[request.url, 5], [other.url, 5]]);
  cache.forget(new Set([other.url]));
  assert.equal(cache.peek(other), undefined);
  assert.equal(cache.peekAfter({ ...other, path: 'src/other.ts' }), undefined);
  assert.equal(cache.peek(request), value);
  assert.equal(cache.stats().entries, 1);
});

void test('A read in flight when its PR is forgotten answers its caller and keeps nothing', async () => {
  const releases: (() => void)[] = [];
  const later = <T,>(result: T) => new Promise<T>((resolve) => releases.push(() => resolve(result)));
  const cache = createPrFileCache(() => later(value), 1_000_000, () => later(value.after));
  const whole = cache.read(request);
  const after = cache.readAfter({ ...request, path: 'src/after.ts' });
  cache.forget(new Set([request.url]));
  // A read that starts after the forget is kept as usual.
  const again = cache.readAfter({ ...request, path: 'src/again.ts' });
  for (const release of releases) release();
  assert.equal(await whole, value);
  assert.deepEqual(await after, value.after);
  await again;
  assert.equal(cache.peek(request), undefined, 'The whole file stays out');
  assert.equal(cache.peekAfter({ ...request, path: 'src/after.ts' }), undefined, 'The after side stays out');
  assert.deepEqual(cache.peekAfter({ ...request, path: 'src/again.ts' }), value.after);
  assert.deepEqual(cache.stats(), { entries: 0, bytes: 0, afters: { entries: 1, bytes: cache.stats().afters.bytes } });
  // With nothing in flight, the PR's next reads are kept.
  const next = cache.read(request);
  for (const release of releases.splice(0)) release();
  await next;
  assert.equal(cache.peek(request), value);
});

void test('A reveal does not wait behind a background after-side read; a background read joins a reveal', async () => {
  const modes: unknown[] = [];
  const cache = createPrFileCache(
    () => Promise.resolve(value),
    32_000_000,
    async (_request, background) => {
      modes.push(background);
      await new Promise((resolve) => setTimeout(resolve, 5));
      return value.after;
    }
  );
  const scope = cache.readAfter(request, true);
  const reveal = cache.readAfter(request);
  assert.notEqual(scope, reveal, 'The reveal sends its own read; main joins the two');
  await Promise.all([scope, reveal]);
  const other = { ...request, path: 'src/other.ts' };
  const first = cache.readAfter(other);
  assert.equal(cache.readAfter(other, true), first, 'A background read joins a pending reveal');
  await first;
  assert.deepEqual(modes, [true, false, false]);
});

void test('a dropped file reads again, and a read in flight before the drop keeps nothing', async () => {
  const stale: PrFileContents = { before: { kind: 'text', content: 'old' }, after: { kind: 'text', content: 'stale' } };
  let next = stale;
  const releases: (() => void)[] = [];
  const reads: string[] = [];
  const cache = createPrFileCache(
    () => {
      reads.push('both');
      return Promise.resolve(next);
    },
    32_000_000,
    async () => {
      reads.push('after');
      const answer = next.after;
      await new Promise<void>((resolve) => releases.push(resolve));
      return answer;
    }
  );
  await cache.read(request);
  assert.equal(cache.peekAfter(request), stale.after);
  cache.drop(request);
  assert.equal(cache.peek(request), undefined);
  assert.equal(cache.peekAfter(request), undefined);
  // A read that started before a second drop answers its caller, and is not saved.
  const pending = cache.readAfter(request, 'view');
  cache.drop(request);
  // A read after the drop does not join it.
  next = { ...stale, after: { kind: 'text', content: 'fresh' } };
  const fresh = cache.readAfter(request, 'view');
  assert.notEqual(fresh, pending);
  // The fresh read lands first; the older one, answering later, must not replace it.
  releases[1]();
  assert.deepEqual(await fresh, { kind: 'text', content: 'fresh' });
  releases[0]();
  assert.deepEqual(await pending, stale.after);
  assert.deepEqual(cache.peekAfter(request), { kind: 'text', content: 'fresh' });
  assert.deepEqual(reads, ['both', 'after', 'after']);
});
