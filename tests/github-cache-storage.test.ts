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
      ], 1000)
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
      `p${i}`,
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
    fetch: (() => Promise.resolve(
      new Response(JSON.stringify({ data: responses }), {
        headers: { 'content-type': 'application/json' },
      }))) as typeof fetch,
  });
  try {
    await pool.setStorage(path.join(f.dir, 'github-budget.json'));
    let serializedBytes = 0;
    const stringify = JSON.stringify;
    const serialization = t.mock.method(JSON, 'stringify', (...args: Parameters<typeof JSON.stringify>) => {
      const result = stringify(...args);
      serializedBytes += result.length;
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

void test('prepared downloads survive memory eviction and restart, including files over 1 MB', async () => {
  const f = fixture();
  try {
    const cache = await f.open(), account = cache.scope(scope);
    account.set('pr-file:v2:first', 'first');
    // More than the 2,000-entry memory bound; the disk archive retains these.
    for (let i = 0; i < 2010; i++) account.set(`pr-file:v2:${i}`, `file-${i}`);
    const large = 'x'.repeat(1_100_000);
    account.set('pr-file:v2:large', large);
    assert.equal(account.get('pr-file:v2:first', valid), undefined);
    assert.equal(account.get('pr-file:v2:large', valid), undefined);
    assert.equal(await account.getPrepared('pr-file:v2:first', valid), 'first');
    assert.equal(await account.getPrepared('pr-file:v2:large', valid), large);
    await cache.close();
    const next = await f.open();
    assert.equal(await next.scope(scope).getPrepared('pr-file:v2:first', valid), 'first');
    assert.equal(await next.scope(scope).getPrepared('pr-file:v2:large', valid), large);
    assert.equal(await next.scope('b'.repeat(64)).getPrepared('pr-file:v2:large', valid), undefined);
    next.scope(scope).delete('pr-file:v2:large');
    assert.equal(await next.scope(scope).getPrepared('pr-file:v2:large', valid), undefined);
    next.scope(scope).clear();
    assert.equal(await next.scope(scope).getPrepared('pr-file:v2:first', valid), undefined, 'Sign-out clears disk-only records');
  } finally { await f.cleanup(); }
});

void test('commit-pinned attribute files survive memory eviction so classification does not refetch them', async () => {
  const f = fixture();
  try {
    const cache = await f.open(), account = cache.scope(scope);
    const key = `attributes:v1:o/r:${'a'.repeat(40)}:.gitattributes`;
    account.set(key, 'linguist');
    // Saved PR status and discussion snapshots share the 2,000-entry memory bound.
    for (let i = 0; i < 2010; i++) account.set(`pr-status:v1:${i}`, `status-${i}`);
    assert.equal(account.get(key, valid), undefined);
    assert.equal(await account.getPrepared(key, valid), 'linguist');
    await cache.close();
    assert.equal(await (await f.open()).scope(scope).getPrepared(key, valid), 'linguist');
  } finally { await f.cleanup(); }
});

void test('disk cache limits evict oldest prepared content and apply immediately', async () => {
  const f = fixture(), storage = createCacheStorage();
  try {
    await storage.open({ file: path.join(f.dir, 'github-cache.sqlite'), legacy: f.file, now: 1000,
      maxBytes: 32000000, maxEntryBytes: 1000000, maxEntries: 2000, retention: 10000, preparedBytes: 1500 });
    const put = (key: string, time: number) => ({ id: `${scope}:${hash(key)}`, prepared: true, onlyPrepared: true,
      payload: JSON.stringify({ scope, key: hash(key), savedAt: time, value: 'x'.repeat(500) }) });
    await storage.write([put('one', 800), put('two', 900), put('three', 1000)], 1000);
    assert.equal(await storage.readPrepared(`${scope}:${hash('one')}`, 1000), undefined);
    assert.ok(await storage.readPrepared(`${scope}:${hash('two')}`, 1000));
    await storage.setPreparedLimit(750, 1000);
    assert.equal(await storage.readPrepared(`${scope}:${hash('two')}`, 1000), undefined);
    assert.ok(await storage.readPrepared(`${scope}:${hash('three')}`, 1000));
    await storage.setPreparedLimit(1500, 1000);
    await storage.write([put('four', 1000)], 1000);
    assert.ok(await storage.readPrepared(`${scope}:${hash('three')}`, 1000));
    assert.ok(await storage.readPrepared(`${scope}:${hash('four')}`, 1000));
  } finally { await storage.close(); await f.cleanup(); }
});

void test('reading an older hot entry after restart preserves newer disk-only downloads', async () => {
  const f = fixture();
  let now = 1000;
  let cache = createGitHubCache(() => now);
  const large = 'x'.repeat(1_100_000);
  try {
    await cache.setStorage(f.file);
    cache.scope(scope).set('pr-file:v2:older', 'older file');
    await cache.flush();
    now = 2000;
    cache.scope(scope).set('pr-file:v2:newer', large);
    await cache.close();

    now = 3000;
    cache = createGitHubCache(() => now);
    await cache.setStorage(f.file);
    const account = cache.scope(scope);
    assert.equal(account.get('pr-file:v2:newer', valid), undefined, 'large files are disk-only');
    assert.equal(await account.getPrepared('pr-file:v2:newer', valid), large);
    assert.equal(await account.getPrepared('pr-file:v2:older', valid), 'older file');
    await cache.flush();
    assert.equal(await account.getPrepared('pr-file:v2:newer', valid), large);
    assert.equal(account.get('pr-file:v2:older', valid)?.savedAt, 1000, 'restoring does not renew retention');

    await cache.close();
    cache = createGitHubCache(() => now);
    await cache.setStorage(f.file);
    assert.equal(await cache.scope(scope).getPrepared('pr-file:v2:newer', valid), large);
  } finally {
    await cache.close();
    await f.cleanup();
  }
});

void test('cache size defaults to 512 MB and accepts only supported budgets', async () => {
  const { normalizeGitHubCacheMB, GITHUB_CACHE_SIZES_MB } = await import('../lib/github-cache-settings');
  for (const invalid of [undefined, null, '1024', NaN, -1, 0, 32, Infinity]) assert.equal(normalizeGitHubCacheMB(invalid), 512);
  for (const size of GITHUB_CACHE_SIZES_MB) assert.equal(normalizeGitHubCacheMB(size), size);
});

/** Count main-thread parses of saved records that contain `marker`. */
function countParses(marker: string) {
  const parse = JSON.parse;
  let count = 0;
  JSON.parse = ((text: string, reviver?: Parameters<typeof JSON.parse>[1]) => {
    if (typeof text === 'string' && text.includes(marker)) count++;
    return parse(text, reviver) as unknown;
  }) as typeof JSON.parse;
  return { count: () => count, restore: () => { JSON.parse = parse; } };
}

void test('loads payloads lazily and parses on first get', async () => {
  const f = fixture();
  let parses: ReturnType<typeof countParses> | undefined;
  try {
    const cache = await f.open();
    for (const key of ['one', 'two', 'three']) cache.scope(scope).set(key, `lazy-value-${key}`);
    await cache.close();
    parses = countParses('lazy-value-');
    const restart = await f.open();
    assert.equal(parses.count(), 0, 'Startup builds no values');
    assert.equal(restart.scope(scope).get('two', valid)?.value, 'lazy-value-two');
    assert.equal(parses.count(), 1);
    assert.equal(restart.scope(scope).get('two', valid)?.value, 'lazy-value-two');
    assert.equal(parses.count(), 1, 'A value is parsed once');
    assert.deepEqual(restart.scope(scope).values(valid).sort(), ['lazy-value-one', 'lazy-value-three', 'lazy-value-two']);
    assert.equal(parses.count(), 3);
  } finally {
    parses?.restore();
    await f.cleanup();
  }
});

void test('entries written before load win', async () => {
  const f = fixture();
  try {
    const cache = await f.open();
    cache.scope(scope).set('pr', 'saved');
    await cache.close();
    const restart = createGitHubCache(() => 1000);
    restart.scope(scope).set('pr', 'fetched during startup');
    await restart.setStorage(f.file);
    assert.equal(restart.scope(scope).get('pr', valid)?.value, 'fetched during startup');
    await restart.close();
  } finally {
    await f.cleanup();
  }
});

void test('open does not trim prepared; deferred trim does', async () => {
  const f = fixture();
  const file = path.join(f.dir, 'github-cache.sqlite');
  const options = (preparedBytes: number) => ({ file, legacy: f.file, now: 1000, maxBytes: 32000000, maxEntryBytes: 1000000,
    maxEntries: 2000, retention: 10000, preparedBytes });
  const put = (key: string, time: number) => ({ id: `${scope}:${hash(key)}`, prepared: true, onlyPrepared: true,
    payload: JSON.stringify({ scope, key: hash(key), savedAt: time, value: 'x'.repeat(500) }) });
  const indexes = async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(file);
    try {
      return db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='prepared'").all().map((row) => row.name);
    } finally {
      db.close();
    }
  };
  let storage = createCacheStorage();
  try {
    await storage.open(options(1500));
    await storage.write([put('older', 900), put('newer', 1000)], 1000);
    await storage.close();
    storage = createCacheStorage();
    await storage.open(options(800));
    assert.ok(await storage.readPrepared(`${scope}:${hash('older')}`, 1000), 'Opening reads no prepared sizes');
    assert.ok(!(await indexes()).includes('prepared_size'));
    await storage.setPreparedLimit(800, 1000);
    assert.equal(await storage.readPrepared(`${scope}:${hash('older')}`, 1000), undefined);
    assert.ok(await storage.readPrepared(`${scope}:${hash('newer')}`, 1000));
    assert.ok((await indexes()).includes('prepared_size'), 'Later size sums read only the index');
  } finally {
    await storage.close();
    await f.cleanup();
  }
});

void test('invalidate parses only its scope', async () => {
  const f = fixture();
  const other = 'b'.repeat(64);
  let parses: ReturnType<typeof countParses> | undefined;
  try {
    const cache = await f.open();
    cache.scope(scope).set('mine', 'scoped-value-mine');
    for (const key of ['one', 'two']) cache.scope(other).set(key, `scoped-value-${key}`);
    await cache.close();
    parses = countParses('scoped-value-');
    const restart = await f.open();
    restart.scope(scope).invalidate((value) => value === 'scoped-value-mine');
    assert.equal(parses.count(), 1);
    assert.equal(restart.scope(scope).get('mine', valid)?.revalidate, true);
    assert.equal(restart.scope(other).get('one', valid)?.revalidate, false);
  } finally {
    parses?.restore();
    await f.cleanup();
  }
});

void test('new cache files use incremental auto-vacuum', async () => {
  const f = fixture();
  try {
    const cache = await f.open();
    await cache.close();
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path.join(f.dir, 'github-cache.sqlite'));
    assert.equal(db.prepare('PRAGMA auto_vacuum').get()?.auto_vacuum, 2);
    db.close();
  } finally {
    await f.cleanup();
  }
});

void test('maintain waits for idle before converting', async () => {
  const f = fixture();
  const { DatabaseSync } = await import('node:sqlite');
  const file = path.join(f.dir, 'github-cache.sqlite');
  const seed = new DatabaseSync(file);
  seed.exec('CREATE TABLE cache (id TEXT PRIMARY KEY, payload TEXT NOT NULL)');
  seed.close();
  const storage = createCacheStorage();
  try {
    await storage.open({ file, legacy: f.file, now: 1000, maxBytes: 1e6, maxEntryBytes: 1e6, maxEntries: 10, retention: 1e9 });
    const mode = () => {
      const db = new DatabaseSync(file);
      try {
        return db.prepare('PRAGMA auto_vacuum').get()?.auto_vacuum;
      } finally {
        db.close();
      }
    };
    assert.equal((await storage.maintain(5)).vacuumed, undefined);
    assert.equal(mode(), 0, 'an active user keeps the old file');
    assert.equal((await storage.maintain(120)).vacuumed, true);
    assert.equal(mode(), 2);
  } finally {
    await storage.close();
    await f.cleanup();
  }
});

void test('incremental vacuum returns free pages after a prepared trim', async () => {
  const f = fixture();
  const file = path.join(f.dir, 'github-cache.sqlite');
  try {
    const cache = await f.open();
    const big = 'x'.repeat(900_000);
    for (let i = 0; i < 40; i++) cache.scope(scope).set(`pr-file:v2:${i}`, `${big}${i}`);
    await cache.close();
    const storage = createCacheStorage();
    try {
      await storage.open({ file, legacy: f.file, now: 1000, maxBytes: 32e6, maxEntryBytes: 1e6, maxEntries: 2000, retention: 1e9 });
      await storage.setPreparedLimit(0, 1000);
      const before = fs.statSync(file).size + fs.statSync(file + '-wal').size;
      let result = await storage.maintain(0);
      assert.ok(result.more, 'more than 16 MB is free');
      for (let i = 0; result.more && i < 50; i++) result = await storage.maintain(0);
      assert.ok(result.freeBytes <= 4 * 1024 * 1024, `${result.freeBytes} free bytes remain`);
      assert.ok(result.fileBytes < before - 16 * 1024 * 1024, `${result.fileBytes} < ${before}`);
    } finally {
      await storage.close();
    }
  } finally {
    await f.cleanup();
  }
});


const isRecord = (v: unknown): v is { files: { path: string }[] } =>
  !!v && typeof v === 'object' && Array.isArray((v as { files?: unknown }).files);

void test('get returns one frozen value without copying', () => {
  const cache = createGitHubCache(() => 1000).scope(scope);
  cache.set('pr', { files: [{ path: 'a.ts' }] });
  const first = cache.get('pr', isRecord)?.value;
  assert.ok(first);
  assert.equal(cache.get('pr', isRecord)?.value, first, 'Every reader shares one value');
  assert.equal(cache.values(isRecord)[0], first);
  assert.ok(Object.isFrozen(first) && Object.isFrozen(first.files[0]));
  assert.throws(() => {
    first.files[0].path = 'b.ts';
  }, TypeError);
});

void test("set keeps the caller's object mutable", () => {
  const cache = createGitHubCache(() => 1000).scope(scope);
  const value = { files: [{ path: 'a.ts' }] };
  cache.set('pr', value);
  value.files[0].path = 'changed.ts';
  value.files.push({ path: 'added.ts' });
  assert.ok(!Object.isFrozen(value));
  assert.deepEqual(cache.get('pr', isRecord)?.value, { files: [{ path: 'a.ts' }] });
});

void test('owned set freezes in place', () => {
  const cache = createGitHubCache(() => 1000).scope(scope);
  const value = { files: [{ path: 'a.ts' }] };
  cache.set('pr', value, true);
  assert.ok(Object.isFrozen(value) && Object.isFrozen(value.files[0]));
  assert.equal(cache.get('pr', isRecord)?.value, value, 'The owned value is shared, not copied');
});

void test('a loaded raw entry is parsed once', async () => {
  const f = fixture();
  let parses: ReturnType<typeof countParses> | undefined;
  try {
    const cache = await f.open();
    cache.scope(scope).set('one', 'parsed-once-value');
    await cache.close();
    parses = countParses('parsed-once-value');
    const restart = (await f.open()).scope(scope);
    for (let i = 0; i < 3; i++) assert.equal(restart.get('one', valid)?.value, 'parsed-once-value');
    restart.values(valid);
    assert.equal(parses.count(), 1);
    // A value saved in this session is serialized once and parsed on its first read too.
    restart.set('two', 'parsed-once-value-two');
    restart.get('two', valid);
    restart.get('two', valid);
    assert.equal(parses.count(), 2);
  } finally {
    parses?.restore();
    await f.cleanup();
  }
});

void test('getPrepared serves a pending large write without flushing', async () => {
  const f = fixture();
  try {
    const cache = await f.open(),
      account = cache.scope(scope);
    const large = { files: [{ path: 'x'.repeat(1_100_000) }] };
    account.set('pr-changes:v3:large', large);
    assert.equal(account.get('pr-changes:v3:large', isRecord), undefined, 'Too large for the memory cache');
    const flushed = cache.flush().then(() => 'flushed');
    const read = account.getPrepared('pr-changes:v3:large', isRecord);
    assert.equal(await Promise.race([read.then(() => 'read'), flushed]), 'read', 'The read does not wait for the write');
    const value = await read;
    assert.deepEqual(value, large);
    assert.ok(Object.isFrozen(value.files[0]));
    await flushed;
    // Settled writes are read from disk, and are frozen too.
    const saved = await account.getPrepared('pr-changes:v3:large', isRecord);
    assert.deepEqual(saved, large);
    assert.ok(Object.isFrozen(saved.files));
  } finally {
    await f.cleanup();
  }
});

void test('getPrepared honours a pending delete and clear', async () => {
  const f = fixture();
  try {
    const cache = await f.open(),
      account = cache.scope(scope);
    const large = 'y'.repeat(1_100_000);
    account.set('pr-file:v2:one', large);
    account.set('pr-file:v2:two', large);
    await cache.flush();
    account.delete('pr-file:v2:one');
    assert.equal(await account.getPrepared('pr-file:v2:one', valid), undefined, 'A queued delete wins');
    assert.equal(await account.getPrepared('pr-file:v2:two', valid), large);
    account.clear();
    assert.equal(await account.getPrepared('pr-file:v2:two', valid), undefined, 'An unsettled clear wins');
    account.set('pr-file:v2:two', 'z'.repeat(1_100_000));
    assert.equal(await account.getPrepared('pr-file:v2:two', valid), 'z'.repeat(1_100_000), 'A later write wins');
    await cache.flush();
    assert.equal(await account.getPrepared('pr-file:v2:one', valid), undefined);
    assert.equal(await account.getPrepared('pr-file:v2:two', valid), 'z'.repeat(1_100_000));
  } finally {
    await f.cleanup();
  }
});

void test('stale flag is added to a pending raw insert', async () => {
  const f = fixture();
  let parses: ReturnType<typeof countParses> | undefined;
  try {
    const cache = await f.open(),
      account = cache.scope(scope);
    parses = countParses('stale-raw-value');
    account.set('one', 'stale-raw-value');
    account.revalidate();
    assert.equal(parses.count(), 0, 'Marking stale does not parse the value');
    assert.deepEqual(account.get('one', valid), { value: 'stale-raw-value', savedAt: 1000, revalidate: true });
    await cache.close();
    const restart = await f.open();
    assert.deepEqual(restart.scope(scope).get('one', valid), { value: 'stale-raw-value', savedAt: 1000, revalidate: true });
  } finally {
    parses?.restore();
    await f.cleanup();
  }
});
