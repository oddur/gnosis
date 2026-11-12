import { normalizeGitHubCacheMB, DEFAULT_GITHUB_CACHE_MB } from './github-cache-settings';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { createCacheStorage, type CacheWrite } from './sqlite-cache-storage';
import { deepFreeze } from './deep-freeze';

const MAX_BYTES = 32_000_000;
const MAX_ENTRY_BYTES = 1_000_000;
const MAX_PREPARED_ENTRY_BYTES = 24_000_000;
const PREPARED_RETENTION_MS = 30 * 24 * 60 * 60_000;
const isPreparedKey = (key: string) => /^(?:git-source:v1:|attributes:v1:|workflow-(?:source|parsed|definitions|data|layout):v\d+:|pr-file:v2:|commit-comparison:v1:|pr-review-diff:v1:|pr-changes:v2:|pr-commits:v1:)/.test(key) && !key.endsWith(':latest');
const MAX_ENTRIES = 2000;
const RETENTION_MS = 7 * 24 * 60 * 60_000;
export function isCacheRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
/** A change to a scope. No `value` means removed; id `'*'` means the whole scope was cleared. */
export interface CacheChange {
  scope: string;
  id: string;
  value?: unknown;
}
interface Entry {
  scope: string;
  key: string;
  savedAt: number;
  value: unknown;
  revalidate?: boolean;
  /** The saved record, until its value is first read. Startup builds no object graph for unread entries. */
  raw?: string;
}
/**
 * Synchronous memory reads; incremental persistence belongs to the SQLite worker.
 * Every value that `get`, `values` and `getPrepared` return is deeply frozen and shared. Never change it:
 * call `structuredClone` first.
 */
export function createGitHubCache(now = Date.now) {
  const entries = new Map<string, Entry>();
  const archived = new WeakSet<Entry>();
  const sizes = new Map<string, number>();
  const versions = new Map<string, number>();
  const writes = new Map<string, CacheWrite>();
  /** Batches handed to the worker and not yet settled, in the order the worker applies them. */
  const inflight = new Set<CacheWrite[]>();
  let storage: ReturnType<typeof createCacheStorage> | undefined;
  let cacheSizeMB = DEFAULT_GITHUB_CACHE_MB;
  let bytes = 0,
    scheduled = false;
  let pending: Promise<unknown> = Promise.resolve();
  const listeners = new Set<(change: CacheChange) => void>();
  /** Fires from `set`, `delete` and `clear` only, never from trimming, eviction or revalidation. */
  function changed(change: CacheChange) {
    for (const listener of listeners)
      try {
        listener(change);
      } catch (error) {
        console.warn('GitHub cache listener failed:', error instanceof Error ? error.message : String(error));
      }
  }
  const id = (scope: string, key: string) => `${scope}:${createHash('sha256').update(key).digest('hex')}`;
  const validTime = (time: number) => Number.isFinite(time) && time <= now() && now() - time < RETENTION_MS;
  function enqueue(key: string, payload: string | null | undefined, revalidate = false, prepared = false) {
    if (!storage) return;
    if (prepared && payload) writes.set(`prepared:${key}`, { id: key, payload, prepared: true, onlyPrepared: true });
    writes.set(key, { id: key, payload: prepared && payload && Buffer.byteLength(payload) > MAX_ENTRY_BYTES ? null : payload, revalidate });
    if (!scheduled) {
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        void flush().catch((error: unknown) =>
          console.warn('Could not persist GitHub cache:', error instanceof Error ? error.message : String(error))
        );
      });
    }
  }
  function flush(): Promise<unknown> {
    if (!storage || !writes.size) return pending;
    const batch = [...writes.values()];
    writes.clear();
    inflight.add(batch);
    const target = storage;
    pending = pending
      .catch(() => {})
      .then(() => target.write(batch, now()))
      .finally(() => inflight.delete(batch));
    return pending;
  }
  // `remove` and `remember` are the only functions that add or drop entries. Keep them small.
  function remove(key: string) {
    bytes -= sizes.get(key) ?? 0;
    sizes.delete(key);
    entries.delete(key);
    enqueue(key, null);
  }
  function trim() {
    for (const [key, entry] of entries) if (!validTime(entry.savedAt)) remove(key);
    while (bytes > MAX_BYTES || entries.size > MAX_ENTRIES) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      remove(oldest);
    }
  }
  /** `payload` is the entry's saved record, serialized once by the caller. */
  function remember(key: string, entry: Entry, payload: string, persist: boolean, prepared = false) {
    // Size only the changed record, never serialize the whole cache on a write.
    const size = Buffer.byteLength(payload);
    bytes -= sizes.get(key) ?? 0;
    sizes.delete(key);
    entries.delete(key);
    if (size > MAX_ENTRY_BYTES) {
      if (persist) enqueue(key, prepared && size <= MAX_PREPARED_ENTRY_BYTES ? payload : null, false, prepared);
      return;
    }
    entries.set(key, entry);
    sizes.set(key, size);
    bytes += size;
    if (persist) {
      enqueue(key, payload, false, prepared);
      if (prepared && storage) archived.add(entry);
    }
  }
  /** Parse a loaded entry's value on first use. An unreadable record is dropped. */
  function parsed(key: string, entry: Entry) {
    if (entry.raw === undefined) return true;
    const raw = entry.raw;
    delete entry.raw;
    try {
      const saved: unknown = JSON.parse(raw);
      if (!isCacheRecord(saved) || !('value' in saved)) throw new Error('Invalid cache entry');
      // Parsed once, then frozen and shared by every reader.
      entry.value = deepFreeze(saved.value);
      return true;
    } catch {
      remove(key);
      return false;
    }
  }
  function markStale(key: string, entry: Entry) {
    if (entry.revalidate) return;
    entry.revalidate = true;
    // A pending insert must carry the flag; existing rows need only a small SQL update.
    if (writes.get(key)?.payload) {
      // An unread record gains the flag as text, without parsing its value.
      if (entry.raw !== undefined) entry.raw = entry.raw.slice(0, -1) + ',"revalidate":true}';
      enqueue(key, entry.raw ?? JSON.stringify(entry));
    } else enqueue(key, undefined, true);
    const extra = Buffer.byteLength(',"revalidate":true');
    sizes.set(key, (sizes.get(key) ?? 0) + extra);
    bytes += extra;
  }
  /** The value of a saved prepared record, when it belongs to this scope and is recent enough. */
  function preparedValue<T>(scope: string, saved: unknown, validate: (value: unknown) => value is T): T | undefined {
    if (
      !isCacheRecord(saved) ||
      saved.scope !== scope ||
      typeof saved.savedAt !== 'number' ||
      saved.savedAt > now() ||
      now() - saved.savedAt >= PREPARED_RETENTION_MS ||
      !validate(saved.value)
    )
      return;
    return deepFreeze(saved.value);
  }
  /**
   * The newest queued or unsettled write to a prepared row, in the order the worker applies them:
   * a payload, `null` for a delete or clear, or `undefined` when nothing pending touches the row.
   */
  function pendingPrepared(scope: string, hash: string): string | null | undefined {
    let found: string | null | undefined;
    for (const operations of [...inflight, [...writes.values()]])
      for (const operation of operations) {
        if (operation.id !== (operation.clearPrepared ? scope : hash)) continue;
        if (operation.clearPrepared || operation.deletePrepared) found = null;
        else if (operation.prepared && operation.payload) found = operation.payload;
      }
    return found;
  }
  return {
    /** Resolves with the worker's open timings, for startup traces. */
    async setStorage(location: string): Promise<Record<string, unknown> | undefined> {
      if (storage) throw new Error('GitHub cache storage is already initialized');
      const next = createCacheStorage();
      let timings: Record<string, unknown> | undefined;
      try {
        const saved = await next.open({
          file: path.join(path.dirname(location), 'github-cache.sqlite'),
          legacy: location,
          now: now(),
          maxBytes: MAX_BYTES,
          maxEntryBytes: MAX_ENTRY_BYTES,
          maxEntries: MAX_ENTRIES,
          retention: RETENTION_MS,
          preparedBytes: cacheSizeMB * 1024 * 1024 - MAX_BYTES,
        });
        const opened = isCacheRecord(saved) ? saved : undefined;
        if (!opened || !Array.isArray(opened.entries)) throw new Error('Invalid cache storage response');
        timings = isCacheRecord(opened.ms) ? opened.ms : undefined;
        for (const row of opened.entries as unknown[]) {
          if (
            !isCacheRecord(row) ||
            typeof row.id !== 'string' ||
            typeof row.scope !== 'string' ||
            typeof row.payload !== 'string' ||
            typeof row.size !== 'number' ||
            typeof row.savedAt !== 'number' ||
            !/^[a-f0-9]{64}:[a-f0-9]{64}$/.test(row.id) ||
            !row.id.startsWith(`${row.scope}:`) ||
            !validTime(row.savedAt)
          )
            continue;
          // Entries written before the cache loaded are newer than saved ones.
          if (!entries.has(row.id)) {
            entries.set(row.id, {
              scope: row.scope,
              key: row.id.slice(row.scope.length + 1),
              savedAt: row.savedAt,
              value: undefined,
              ...(row.revalidate === true ? { revalidate: true } : {}),
              raw: row.payload,
            });
            sizes.set(row.id, row.size);
            bytes += row.size;
          }
        }
        storage = next;
        trim();
      } catch (error) {
        await next.close().catch(() => {});
        console.warn(
          'GitHub cache will use memory for this session:',
          error instanceof Error ? error.message : String(error)
        );
      }
      return timings;
    },
    async setSizeMB(value: unknown) {
      const next = normalizeGitHubCacheMB(value);
      if (next === cacheSizeMB) return;
      await flush();
      await storage?.setPreparedLimit(Math.max(0, next * 1024 * 1024 - MAX_BYTES), now());
      cacheSizeMB = next;
    },
    /** Apply the disk limit, deferred from open because the first trim reads every prepared row. */
    async trimPrepared() {
      if (!storage) return;
      await flush();
      await storage.setPreparedLimit(Math.max(0, cacheSizeMB * 1024 * 1024 - MAX_BYTES), now());
    },
    flush,
    /** One space-reclaim step in the cache worker. */
    maintain: (idleSeconds: number) => storage?.maintain(idleSeconds),
    /** The stored value is passed read-only and uncloned. Listeners must not keep or change it. */
    onChange(listener: (change: CacheChange) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async close() {
      try {
        await flush();
      } finally {
        const target = storage;
        storage = undefined;
        await target?.close();
      }
    },
    scope(scope: string) {
      return {
        version: () => versions.get(scope) ?? 0,
        values<T>(validate: (value: unknown) => value is T): T[] {
          return [...entries]
            .filter(([key, entry]) => entry.scope === scope && validTime(entry.savedAt) && parsed(key, entry) && validate(entry.value))
            .map(([, entry]) => entry.value as T);
        },
        get<T>(
          key: string,
          validate: (value: unknown) => value is T
        ): { value: T; savedAt: number; revalidate: boolean } | undefined {
          const hash = id(scope, key), entry = entries.get(hash);
          if (!entry || !validTime(entry.savedAt) || !parsed(hash, entry) || !validate(entry.value)) return;
          return { value: entry.value, savedAt: entry.savedAt, revalidate: entry.revalidate === true };
        },
        async getPrepared<T>(key: string, validate: (value: unknown) => value is T): Promise<T | undefined> {
          const hash = id(scope, key), entry = entries.get(hash);
          // The saved record, before parsing drops it. Archiving reuses it instead of serializing again.
          const raw = entry?.raw;
          if (entry && validTime(entry.savedAt) && parsed(hash, entry) && validate(entry.value)) {
            // Migrate a previously downloaded revision lazily without a GitHub request.
            if (storage && isPreparedKey(key) && !archived.has(entry)) {
              enqueue(hash, raw ?? JSON.stringify(entry), false, true);
              archived.add(entry);
            }
            return entry.value;
          }
          if (!storage || !isPreparedKey(key)) return;
          // A queued or unsettled write answers without waiting for the worker, including items too
          // large for the memory cache.
          const queued = pendingPrepared(scope, hash);
          if (queued === null) return;
          if (queued !== undefined) {
            try {
              return preparedValue(scope, JSON.parse(queued), validate);
            } catch {
              return;
            }
          }
          const version = versions.get(scope) ?? 0;
          const saved = await storage.readPrepared(hash, now()).catch(() => undefined);
          if (version !== (versions.get(scope) ?? 0)) return;
          return preparedValue(scope, saved, validate);
        },
        /**
         * Saves a copy. The caller keeps its object and may change it: the value is serialized once now
         * and parsed on first read. With `owned`, the caller hands the value over instead: it is frozen in
         * place and shared, so the caller must never change it again.
         */
        set(key: string, value: unknown, owned = false) {
          const hash = id(scope, key),
            savedAt = now(),
            record = { scope, key: hash.split(':')[1], savedAt, value: owned ? deepFreeze(value) : value };
          const payload = JSON.stringify(record);
          remember(hash, owned ? record : { ...record, value: undefined, raw: payload }, payload, true, isPreparedKey(key));
          trim();
          // Listeners read the value synchronously and must not change it.
          if (listeners.size) changed({ scope, id: hash, value: record.value });
        },
        delete(key: string) {
          versions.set(scope, (versions.get(scope) ?? 0) + 1);
          const hash = id(scope, key);
          remove(hash);
          if (storage) writes.set(`prepared:${hash}`, { id: hash, deletePrepared: true });
          if (listeners.size) changed({ scope, id: hash });
        },
        clear() {
          versions.set(scope, (versions.get(scope) ?? 0) + 1);
          for (const [key, entry] of entries) if (entry.scope === scope) remove(key);
          if (storage) {
            writes.set(`clear-prepared:${scope}`, { id: scope, clearPrepared: true });
            void flush().catch(() => {});
          }
          if (listeners.size) changed({ scope, id: '*' });
        },
        revalidate() {
          versions.set(scope, (versions.get(scope) ?? 0) + 1);
          for (const [key, entry] of [...entries]) if (entry.scope === scope) markStale(key, entry);
          trim();
        },
        invalidate(matches: (value: unknown) => boolean) {
          versions.set(scope, (versions.get(scope) ?? 0) + 1);
          for (const [key, entry] of [...entries])
            if (entry.scope === scope && parsed(key, entry) && matches(entry.value)) markStale(key, entry);
          trim();
        },
      };
    },
  };
}
export type GitHubCache = ReturnType<ReturnType<typeof createGitHubCache>['scope']>;
