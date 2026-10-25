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
