import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createGitHubCache } from '../lib/github-cache';
import { createCacheStorage } from '../lib/sqlite-cache-storage';

const scope = 'a'.repeat(64);
const valid = (v: unknown): v is string => typeof v === 'string';
const hash = (v: string) => createHash('sha256').update(v).digest('hex');
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gnosis-sqlite-'));
  const file = path.join(dir, 'github-cache.json');
  const caches: ReturnType<typeof createGitHubCache>[] = [];
  return {
    dir,
    file,
    async open() {
      const cache = createGitHubCache(() => 1000);
      caches.push(cache);
      await cache.setStorage(file);
      return cache;
    },
    async cleanup() {
      for (const cache of caches) await cache.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
void test('imports legacy entries once; clear and sign-out cannot resurrect legacy data', async () => {
  const f = fixture();
  try {
    fs.writeFileSync(
      f.file,
      JSON.stringify({
        version: 1,
        entries: [
          { scope, key: hash('old'), savedAt: 900, value: 'saved' },
          { scope, key: hash('future'), savedAt: 2000, value: 'invalid' },
          { scope: 'not-a-scope', key: hash('bad'), savedAt: 900, value: 'invalid' },
        ],
      })
    );
    const cache = await f.open();
    assert.equal(cache.scope(scope).get('old', valid)?.value, 'saved');
    assert.equal(cache.scope(scope).get('future', valid), undefined);
    cache.scope(scope).clear();
    await cache.close();
    const restart = await f.open();
    assert.deepEqual(restart.scope(scope).values(valid), []);
  } finally {
    await f.cleanup();
  }
});
void test('batched overwrites, invalidation and deletion survive restart in order', async () => {
  const f = fixture();
  try {
    const cache = await f.open(),
      account = cache.scope(scope);
    account.set('one', 'old');
    account.set('one', 'new');
    account.set('two', 'removed');
    account.delete('two');
    account.revalidate();
    await cache.flush();
    account.set('three', 'persisted');
    await cache.flush();
    account.invalidate((value) => value === 'persisted');
    await cache.close();
    const restart = await f.open(),
      saved = restart.scope(scope);
    assert.deepEqual(saved.get('one', valid), { value: 'new', savedAt: 1000, revalidate: true });
    assert.equal(saved.get('two', valid), undefined);
    assert.equal(saved.get('three', valid)?.revalidate, true);
    assert.equal(restart.scope('b'.repeat(64)).get('one', valid), undefined);
  } finally {
    await f.cleanup();
  }
});
void test('storage failure preserves usable in-memory cache', async () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.dir, 'github-cache.sqlite'), 'not a database');
    const cache = await f.open();
    cache.scope(scope).set('one', 'usable');
    assert.equal(cache.scope(scope).get('one', valid)?.value, 'usable');
    await cache.flush();
  } finally {
    await f.cleanup();
  }
});
void test('SQLite batches roll back atomically on a failed operation', async () => {
  const f = fixture(),
    storage = createCacheStorage();
  try {
    await storage.open({
      file: path.join(f.dir, 'github-cache.sqlite'),
      legacy: f.file,
      now: 1000,
      maxBytes: 32_000_000,
      maxEntryBytes: 1_000_000,
      maxEntries: 2000,
      retention: 10000,
    });
    await assert.rejects(
      storage.write([
        {
          id: `${scope}:${hash('one')}`,
          payload: JSON.stringify({ scope, key: hash('one'), savedAt: 1000, value: 'partial' }),
        },
        { id: 'invalid', payload: undefined },
      ])
    );
    await storage.close();
    const cache = await f.open();
    assert.equal(cache.scope(scope).get('one', valid), undefined);
  } finally {
    await storage.close().catch(() => {});
    await f.cleanup();
  }
});

void test('refreshing 25 PR signals does not serialize or synchronously rewrite a populated cache', async (t) => {
  const { createGitHubClientPool } = await import('../lib/github-client');
  const { createQueueSignalsService } = await import('../src/queue-signals-service');
  const f = fixture();
  const payload = 'x'.repeat(750_000);
  fs.writeFileSync(
    f.file,
    JSON.stringify({
      version: 1,
      entries: Array.from({ length: 40 }, (_, i) => ({
        scope,
        key: hash(String(i)),
        savedAt: Date.now(),
        value: payload,
      })),
    })
  );
  const responses = Object.fromEntries(
    Array.from({ length: 25 }, (_, i) => [
      'p' + i,
      {
        pullRequest: {
          headRefOid: 'abc123',
          state: 'OPEN',
          isDraft: false,
          mergeable: 'MERGEABLE',
          mergeStateStatus: 'CLEAN',
          reviewDecision: null,
          baseRefName: 'main',
          baseRefOid: 'base123',
          baseRef: null,
          mergeQueue: null,
          mergeQueueEntry: null,
          comments: { totalCount: 0 },
          commits: { nodes: [] },
        },
      },
    ])
  );
  const pool = createGitHubClientPool({
    minSpacingMs: 0,
    fetch: (async () =>
      new Response(JSON.stringify({ data: responses }), {
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch,
  });
  try {
    await pool.setStorage(path.join(f.dir, 'github-budget.json'));
    let serializedBytes = 0;
    const stringify = JSON.stringify;
    const serialization = t.mock.method(JSON, 'stringify', (...args: Parameters<typeof JSON.stringify>) => {
      const result = stringify(...args);
      serializedBytes += result?.length ?? 0;
      return result;
    });
    const writes = t.mock.method(fs, 'writeFileSync');
    const result = await createQueueSignalsService()(
      pool.client('test-token'),
      Array.from({ length: 25 }, (_, i) => ({ url: `https://github.com/test/repo/pull/${i + 1}`, headSha: 'abc123' }))
    );
    await pool.flushStorage();
    assert.equal(result.length, 25);
    assert.equal(writes.mock.callCount(), 0, 'cache persistence must not block the host on disk I/O');
    assert.ok(serializedBytes < 1_000_000, `serialized ${serializedBytes} bytes while updating small status records`);
    serialization.mock.restore();
    writes.mock.restore();
  } finally {
    t.mock.restoreAll();
    await pool.closeStorage();
    await f.cleanup();
  }
});
