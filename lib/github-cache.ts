import { createHash } from 'node:crypto';
import path from 'node:path';
import { createCacheStorage, type CacheWrite } from './sqlite-cache-storage';

const MAX_BYTES = 32_000_000;
const MAX_ENTRY_BYTES = 1_000_000;
const MAX_ENTRIES = 2000;
const RETENTION_MS = 7 * 24 * 60 * 60_000;
export function isCacheRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
interface Entry {
  scope: string;
  key: string;
  savedAt: number;
  value: unknown;
  revalidate?: boolean;
}
/** Synchronous memory reads; incremental persistence belongs to the SQLite worker. */
export function createGitHubCache(now = Date.now) {
  const entries = new Map<string, Entry>();
  const sizes = new Map<string, number>();
  const versions = new Map<string, number>();
  const writes = new Map<string, CacheWrite>();
  let storage: ReturnType<typeof createCacheStorage> | undefined;
  let bytes = 0,
    scheduled = false;
  let pending: Promise<unknown> = Promise.resolve();
  const id = (scope: string, key: string) => `${scope}:${createHash('sha256').update(key).digest('hex')}`;
  const validTime = (time: number) => Number.isFinite(time) && time <= now() && now() - time < RETENTION_MS;
  function enqueue(key: string, payload: string | null | undefined, revalidate = false) {
    if (!storage) return;
    writes.set(key, { id: key, payload, revalidate });
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
    const target = storage;
    pending = pending.catch(() => {}).then(() => target.write(batch));
    return pending;
  }
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
  function remember(key: string, entry: Entry, persist: boolean) {
    // Size only the changed record, never serialize the whole cache on a write.
    const payload = JSON.stringify(entry),
      size = Buffer.byteLength(payload);
    bytes -= sizes.get(key) ?? 0;
    sizes.delete(key);
    entries.delete(key);
    if (size > MAX_ENTRY_BYTES) {
      if (persist) enqueue(key, null);
      return;
    }
    entries.set(key, entry);
    sizes.set(key, size);
    bytes += size;
    if (persist) enqueue(key, payload);
  }
  function markStale(key: string, entry: Entry) {
    if (entry.revalidate) return;
    entry.revalidate = true;
    // A pending insert must carry the flag; existing rows need only a small SQL update.
    if (writes.get(key)?.payload) enqueue(key, JSON.stringify(entry));
    else enqueue(key, undefined, true);
    const extra = Buffer.byteLength(',"revalidate":true');
    sizes.set(key, (sizes.get(key) ?? 0) + extra);
    bytes += extra;
  }
  return {
    async setStorage(location: string) {
      if (storage) throw new Error('GitHub cache storage is already initialized');
      const next = createCacheStorage();
      try {
        const saved = await next.open({
          file: path.join(path.dirname(location), 'github-cache.sqlite'),
          legacy: location,
          now: now(),
          maxBytes: MAX_BYTES,
          maxEntryBytes: MAX_ENTRY_BYTES,
          maxEntries: MAX_ENTRIES,
          retention: RETENTION_MS,
        });
        if (!Array.isArray(saved)) throw new Error('Invalid cache storage response');
        for (const row of saved as { entry: unknown; size: number }[]) {
          const entry = row.entry;
          if (
            !isCacheRecord(entry) ||
            typeof entry.scope !== 'string' ||
            typeof entry.key !== 'string' ||
            !/^[a-f0-9]{64}$/.test(entry.scope) ||
            !/^[a-f0-9]{64}$/.test(entry.key) ||
            typeof entry.savedAt !== 'number' ||
            !validTime(entry.savedAt) ||
            !('value' in entry)
          )
            continue;
          const key = `${entry.scope}:${entry.key}`;
          if (!entries.has(key)) {
            entries.set(key, entry as unknown as Entry);
            sizes.set(key, row.size);
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
    },
    flush,
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
          return [...entries.values()]
            .filter((entry) => entry.scope === scope && validTime(entry.savedAt) && validate(entry.value))
            .map((entry) => structuredClone(entry.value) as T);
        },
        get<T>(
          key: string,
          validate: (value: unknown) => value is T
        ): { value: T; savedAt: number; revalidate: boolean } | undefined {
          const entry = entries.get(id(scope, key));
          if (!entry || !validTime(entry.savedAt) || !validate(entry.value)) return;
          return { value: structuredClone(entry.value), savedAt: entry.savedAt, revalidate: entry.revalidate === true };
        },
        set(key: string, value: unknown) {
          const hash = id(scope, key);
          remember(hash, { scope, key: hash.split(':')[1], savedAt: now(), value: structuredClone(value) }, true);
          trim();
        },
        delete(key: string) {
          versions.set(scope, (versions.get(scope) ?? 0) + 1);
          remove(id(scope, key));
        },
        clear() {
          versions.set(scope, (versions.get(scope) ?? 0) + 1);
          for (const [key, entry] of entries) if (entry.scope === scope) remove(key);
        },
        revalidate() {
          versions.set(scope, (versions.get(scope) ?? 0) + 1);
          for (const [key, entry] of [...entries]) if (entry.scope === scope) markStale(key, entry);
          trim();
        },
        invalidate(matches: (value: unknown) => boolean) {
          versions.set(scope, (versions.get(scope) ?? 0) + 1);
          for (const [key, entry] of [...entries])
            if (entry.scope === scope && matches(entry.value)) markStale(key, entry);
          trim();
        },
      };
    },
  };
}
export type GitHubCache = ReturnType<ReturnType<typeof createGitHubCache>['scope']>;
