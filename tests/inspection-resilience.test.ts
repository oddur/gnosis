import test from 'node:test';
import assert from 'node:assert/strict';
import { createSharedRead, readError } from '../lib/shared-read';
import { createByteCache, approximateBytes } from '../lib/byte-cache';
import { compactInventory, INVENTORY_PATCH_BYTES, FILE_PATCH_BYTES } from '../lib/inspection-limits';
import { loadInspectionBatch, inspectionFailure } from '../lib/inspection-batch';
import { createInspectionRequests } from '../src/inspection-requests';
import { createGitHubClientPool } from './cache-test-pool';
import { createPrChangesService } from '../src/pr-changes-service';
import type { PrChanges } from '../lib/pr-changes';
import type { PrMetadata } from '../lib/types';
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
void test('one reader leaving does not cancel another; the last reader aborts the transport', async () => {
  const value = deferred<string>();
  const task = createSharedRead(() => value.promise);
  const a = new AbortController(),
    b = new AbortController();
  const first = task.read(a.signal),
    second = task.read(b.signal);
  const rejected = assert.rejects(first, /abort/i);
  a.abort();
  await rejected;
  assert.equal(task.signal.aborted, false);
  value.resolve('ready');
  assert.equal(await second, 'ready');
  const abandoned = createSharedRead<undefined>(
    (signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(readError(signal.reason)), { once: true });
      })
  );
  const controller = new AbortController();
  const pending = assert.rejects(abandoned.read(controller.signal), /abort/i);
  controller.abort();
  await pending;
  assert.equal(abandoned.signal.aborted, true);
});
void test('healthy stack members arrive while an earlier PR is stalled; cancellation stops queued members', async () => {
  const stalled = deferred<number>();
  const received: number[] = [],
    started: number[] = [];
  const controller = new AbortController();
  const running = loadInspectionBatch(
    [1, 2, 3],
    (member) => {
      started.push(member);
      return member === 1 ? stalled.promise : Promise.resolve(member);
    },
    (_member, result) => {
      if ('value' in result) received.push(result.value);
    },
    controller.signal,
    2
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(received, [2, 3]);
  assert.deepEqual(started, [1, 2, 3]);
  stalled.resolve(1);
  await running;
  assert.deepEqual(received, [2, 3, 1]);
  const stopped = new AbortController();
  const cancelled: number[] = [];
  await loadInspectionBatch(
    [1, 2, 3],
    (n) => Promise.resolve(n),
    (_n, result) => {
      if ('value' in result) cancelled.push(result.value);
      stopped.abort();
    },
    stopped.signal,
    1
  );
  assert.deepEqual(cancelled, [1]);
});
void test('byte budgets evict by recency and refuse a single oversized inventory', () => {
  const cache = createByteCache<string, string>(100, 10);
  cache.set('a', 'a'.repeat(15));
  cache.set('b', 'b'.repeat(15));
  assert.equal(cache.get('a'), 'a'.repeat(15));
  cache.set('c', 'c'.repeat(15));
  assert.equal(cache.get('b'), undefined);
  cache.set('large', 'x'.repeat(100));
  assert.equal(cache.get('large'), undefined);
  assert.ok(cache.bytes <= 100);
  cache.clear();
  assert.equal(cache.bytes, 0);
  assert.ok(approximateBytes({ description: 'x'.repeat(1000) }) >= 2000);
});
void test('large patches are deferred within a byte budget without losing paths or change identities', () => {
  const snapshot: PrChanges = {
    version: 1,
    url: 'https://github.com/o/r/pull/1',
    metadata: {} as PrMetadata,
    comparisonBase: 'base',
    fetchedAt: 1,
    files: Array.from({ length: 100 }, (_, i) => ({
      path: `src/长路径/ملف-${i}.ts`,
      changeId: `change-${i}`,
      status: 'modified',
      additions: 1,
      deletions: 1,
      patch: 'x'.repeat(i ? 60_000 : FILE_PATCH_BYTES),
    })),
  };
  const compact = compactInventory(snapshot);
  assert.equal(compact.patchesDeferred, true);
  assert.equal(compact.filesTruncated, undefined, 'All filenames are known even when patches are deferred');
  assert.deepEqual(
    compact.files.map((f) => [f.path, f.changeId]),
    snapshot.files.map((f) => [f.path, f.changeId])
  );
  assert.ok(compact.files.reduce((n, f) => n + (f.patch?.length ?? 0) * 2, 0) <= INVENTORY_PATCH_BYTES);
  assert.equal(compact.files[0].patch, undefined);
  assert.equal(compactInventory(compact), compact);
});
void test('inspection request ownership and timeout cancel only the correct reader', async () => {
  const requests = createInspectionRequests(25);
  const wait = (signal: AbortSignal) =>
    new Promise<void>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(readError(signal.reason)), { once: true });
    });
  const first = assert.rejects(requests.run(1, 'id', wait), /abort/i);
  const second = assert.rejects(requests.run(2, 'id', wait), /too long/);
  requests.cancel(1, 'id');
  await Promise.all([first, second]);
});
void test('a timed-out GitHub GET releases the scheduler and is not treated as a server cooldown', async () => {
  let stalls = true,
    calls = 0;
  const pool = createGitHubClientPool({
    minSpacingMs: 0,
    readTimeoutMs: 25,
    fetch: ((_input: string, init?: RequestInit) => {
      calls++;
      if (!stalls) return Promise.resolve(new Response('{}', { headers: { 'content-type': 'application/json' } }));
      return new Promise<Response>((_resolve, reject) =>
        init?.signal?.addEventListener('abort', () => reject(readError(init.signal?.reason)), { once: true })
      );
    }) as typeof fetch,
  });
  const client = pool.client('one');
  await assert.rejects(client.request('GET /test'), /too long/);
  stalls = false;
  await client.request('GET /test');
  assert.equal(calls, 2, 'Timeouts do not poison the per-endpoint server cooldown');
});
void test('retry deadlines survive Electron error messages and diagnostics become readable recovery text', () => {
  const deadline = '2026-10-29T16:00:00.000Z';
  const value = inspectionFailure(
    'url',
    new Error(
      `Error invoking remote method 'pr-changes': Error: GitHub could not load this data (HTTP 503). Try again after ${deadline}.`
    )
  );
  assert.equal(value.retryAt, Date.parse(deadline));
  assert.equal(value.message, 'GitHub is temporarily unable to load this PR.');
});
void test('coalesced PR inventories keep a background reader alive when the foreground reader leaves', async () => {
  const entered = deferred<undefined>(),
    release = deferred<undefined>();
  let fileSignal: AbortSignal | null | undefined,
    fileReads = 0;
  const json = (value: unknown) =>
    new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
  const pool = createGitHubClientPool({
    minSpacingMs: 0,
    fetch: (async (input: string, init?: RequestInit) => {
      const path = new URL(input).pathname;
      if (path.endsWith('/files')) {
        fileReads++;
        fileSignal = init?.signal;
        entered.resolve(undefined);
        await release.promise;
        return json([
          {
            filename: 'one.ts',
            status: 'added',
            sha: 'blob',
            additions: 1,
            deletions: 0,
            patch: '@@ -0,0 +1 @@\n+one',
          },
        ]);
      }
      if (path.includes('/compare/')) return json({ merge_base_commit: { sha: 'base' } });
      return json({
        title: 'PR',
        body: '',
        user: { login: 'dev' },
        base: { ref: 'main', sha: 'base', repo: { full_name: 'o/r' } },
        head: { ref: 'feature', sha: 'head', repo: { full_name: 'o/r' } },
        changed_files: 1,
        state: 'open',
        labels: [],
      });
    }) as typeof fetch,
  });
  const service = createPrChangesService(),
    client = pool.client('one'),
    controller = new AbortController();
  const first = service.manifest(client, 'https://github.com/o/r/pull/1', false, {}, controller.signal);
  const background = service.manifest(client, 'https://github.com/o/r/pull/1');
  await entered.promise;
  const cancelled = assert.rejects(first, /abort/i);
  controller.abort();
  await cancelled;
  assert.equal(fileSignal?.aborted, false);
  release.resolve(undefined);
  assert.equal((await background).files.length, 1);
  assert.equal(fileReads, 1);
});
