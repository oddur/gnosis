import type { ReviewStateWrite, FileProgressPatch } from '../lib/review-state';
import type { MaintainResult } from './sqlite-maintain';
import type { SearchRequest, LocalSearchResponse, SearchOp } from './command-search-service';
import { Worker } from 'node:worker_threads';
import path from 'node:path';

/**
 * A change to a state saved as a header row plus one row per entry: `pr-read-*`, `muted-prs:*` and
 * `starred-prs:*`. Such a state reads as `{ ...header, entries }`. `header` replaces the header row.
 */
export interface RowPatch {
  header?: Record<string, unknown>;
  put?: Record<string, unknown>;
  remove?: string[];
}
/** An initialized in-memory snapshot, with coalesced durable writes owned by a worker. */
export interface StateStorage {
  /** A private copy of a saved state. */
  read(name: string): unknown;
  /** Hands a saved state to its store without a copy. Later reads and takes of the name return nothing. */
  take(name: string): unknown;
  /** Replaces a whole state. */
  write(name: string, value: unknown): void;
  /** Changes only the listed rows of a row state. */
  patch(name: string, change: RowPatch): void;
  flush(): Promise<void>;
}
interface PendingPatch {
  header?: Record<string, unknown>;
  put: Map<string, unknown>;
  remove: Set<string>;
}
const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
/** Applies a patch to a loaded row state, in place. */
function applyPatch(state: unknown, change: RowPatch): Record<string, unknown> {
  const entries = isRecord(state) && isRecord(state.entries) ? state.entries : {};
  const next = change.header ? { ...change.header, entries } : isRecord(state) ? state : { entries };
  next.entries = entries;
  for (const [id, value] of Object.entries(change.put ?? {})) entries[id] = value;
  for (const id of change.remove ?? []) Reflect.deleteProperty(entries, id);
  return next;
}
/** Adds `change` to a pending patch. The last change to a row wins. */
function mergePatch(target: PendingPatch, change: RowPatch) {
  if (change.header) target.header = change.header;
  for (const [id, value] of Object.entries(change.put ?? {})) {
    target.remove.delete(id);
    target.put.delete(id);
    target.put.set(id, value);
  }
  for (const id of change.remove ?? []) {
    target.put.delete(id);
    target.remove.add(id);
  }
}
/**
 * Storage for tests and for services created without saved data. `saved` holds each state as JSON; pass
 * the same map to another storage to simulate a restart.
 */
export function createMemoryStorage(saved = new Map<string, string>()): StateStorage {
  const taken = new Set<string>();
  const load = (name: string): unknown => {
    const text = saved.get(name);
    return text === undefined ? undefined : JSON.parse(text);
  };
  return {
    read: (name) => (taken.has(name) ? undefined : load(name)),
    take(name) {
      if (taken.has(name)) return undefined;
      taken.add(name);
      return load(name);
    },
    write(name, value) {
      taken.delete(name);
      saved.set(name, JSON.stringify(value));
    },
    patch(name, change) {
      saved.set(name, JSON.stringify(applyPatch(load(name), change)));
    },
    flush: () => Promise.resolve(),
  };
}
export function createAppDataStore() {
  let worker: Worker | undefined;
  let sequence = 0;
  let failure: Error | undefined;
  let values: Record<string, unknown> | undefined;
  let scheduled = false;
  let writing: Promise<void> | undefined;
  const updates = new Map<string, unknown>();
  const patches = new Map<string, PendingPatch>();
  /** Names handed to their stores. The stores own them in memory from then on. */
  const taken = new Set<string>();
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  function call<T>(method: string, args?: unknown): Promise<T> {
    if (!worker || failure) return Promise.reject(failure ?? new Error('Storage is not ready'));
    const active = worker;
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      pending.set(id, { resolve: (value) => resolve(value as T), reject });
      active.ref();
      try {
        active.postMessage({ id, method, args });
      } catch (error) {
        pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
        if (!pending.size) active.unref();
      }
    });
  }
  function assertReady() {
    if (failure) throw failure;
    if (!values) throw new Error('Saved work is still loading');
    return values;
  }
  const dirty = () => updates.size > 0 || patches.size > 0;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      void flush().catch((error: unknown) => console.error('Saved work could not be persisted:', error));
    });
  }
  async function flush(): Promise<void> {
    if (failure) throw failure;
    if (writing) {
      await writing;
      if (dirty()) await flush();
      return;
    }
    if (!dirty()) return;
    const states = [...updates];
    const changed = [...patches];
    updates.clear();
    patches.clear();
    // postMessage clones now, before callers can mutate the in-memory state again. One transaction.
    writing = call<unknown>('write', {
      states,
      patches: changed.map(([name, change]) => [
        name,
        { ...(change.header ? { header: change.header } : {}), put: [...change.put], remove: [...change.remove] },
      ]),
    })
      .then(() => {})
      .catch((error: unknown) => {
        // Keep the latest snapshot for retry after a recoverable disk/lock failure.
        for (const [name, value] of states) if (!updates.has(name)) updates.set(name, values?.[name] ?? value);
        // Failed row changes go back underneath any newer change to the same rows.
        for (const [name, change] of changed) {
          if (updates.has(name)) continue;
          const newer = patches.get(name);
          if (newer) {
            mergePatch(change, {
              ...(newer.header ? { header: newer.header } : {}),
              put: Object.fromEntries(newer.put),
              remove: [...newer.remove],
            });
          }
          patches.set(name, change);
        }
        throw error;
      })
      .finally(() => {
        writing = undefined;
      });
    await writing;
    if (dirty()) await flush();
  }
  return {
    async open(directory: string) {
      if (worker) throw new Error('Storage already opened');
      // Forge builds the worker alongside main.js. tsx is only used by source-level tests.
      worker = __filename.endsWith('.ts')
        ? new Worker(`require('tsx/cjs'); require(${JSON.stringify(path.join(__dirname, 'app-data-worker.ts'))})`, {
            eval: true,
          })
        : new Worker(path.join(__dirname, 'app-data-worker.js'));
      const active = worker;
      const failed = (error: Error) => {
        failure = error;
        for (const request of pending.values()) request.reject(error);
        pending.clear();
        active.unref();
      };
      worker.on('error', failed);
      worker.on('exit', (code) => {
        if (worker === active) failed(new Error(`Saved-work worker exited (${code})`));
      });
      worker.on('message', ({ id, result, error }: { id: number; result: unknown; error?: string }) => {
        const request = pending.get(id);
        pending.delete(id);
        if (error) request?.reject(new Error(error));
        else request?.resolve(result);
        if (!pending.size) active.unref();
      });
      values = await call<Record<string, unknown>>('open', { directory });
    },
    read(name: string): unknown {
      return structuredClone(assertReady()[name]);
    },
    take(name: string): unknown {
      const all = assertReady();
      const value = all[name];
      Reflect.deleteProperty(all, name);
      taken.add(name);
      return value;
    },
    write(name: string, value: unknown) {
      assertReady()[name] = value;
      updates.set(name, value);
      // The whole state replaces any row changes queued before it.
      patches.delete(name);
      schedule();
    },
    patch(name: string, change: RowPatch) {
      const all = assertReady();
      // A state nobody has taken stays readable.
      if (name in all) all[name] = applyPatch(all[name], change);
      // A queued whole state already carries the change; otherwise queue the rows. Rows apply after
      // whole states in the same transaction.
      if (updates.has(name) && name in all) updates.set(name, all[name]);
      else {
        const pending = patches.get(name) ?? { put: new Map(), remove: new Set<string>() };
        mergePatch(pending, change);
        patches.set(name, pending);
      }
      schedule();
    },
    flush,
    loadReviewState: (legacy: Record<string, string>) => call<Record<string, unknown>>('review-load', legacy),
    saveReviewState: async (value: ReviewStateWrite) => {
      await call('review-save', value);
    },
    saveFileProgress: async (value: FileProgressPatch) => {
      await call('progress-save', value);
    },
    search: (request: SearchRequest) => call<LocalSearchResponse>('search', request),
    searchFeeds: async (account: string) => (await call<{ feeds: [string, string][] }>('search-feeds', { account })).feeds,
    searchApply: (account: string, ops: SearchOp[]) =>
      call<{ evicted: number; docs: number }>('search-apply', { account, ops }),
    /** One space-reclaim step in the worker. Call again while `more` is true. */
    maintain: (idleSeconds: number) => call<MaintainResult>('maintain', { idleSeconds }),
    async clearGitHub() {
      await flush();
      values = await call<Record<string, unknown>>('clear-github');
      // Mutes, stars and views survive the reset, and their stores already hold them.
      for (const name of taken) Reflect.deleteProperty(values, name);
    },
    async close() {
      if (!worker) return;
      const active = worker;
      await flush();
      await call('close');
      worker = undefined;
      await active.terminate();
    },
  };
}
