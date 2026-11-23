import { noteWork } from '../lib/perf-trace';
import type { ReviewStateWrite, FileProgressPatch } from '../lib/review-state';
import type { MaintainResult } from './sqlite-maintain';
import type { SearchRequest, LocalSearchResponse, SearchOp } from './command-search-service';
import { Worker } from 'node:worker_threads';
import path from 'node:path';

/**
 * A change to a state saved as a header row plus one row per entry: `pr-read-*`, `pr-notify-*`, `muted-prs:*` and
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
  /** Replaces a whole state. `null` or `undefined` removes it. */
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
/**
 * The rule for a whole state, in every storage: an object (`renderer:` states excepted), or `null`/`undefined` to
 * remove it. Refused at write time, so a value the worker would refuse is never queued.
 */
export function assertSavedState(name: string, value: unknown) {
  if (value !== null && value !== undefined && !name.startsWith('renderer:') && !isRecord(value))
    throw new Error(`Saved state ${name.split(':')[0]} must be an object.`);
}
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
      assertSavedState(name, value);
      taken.delete(name);
      if (value === null || value === undefined) saved.delete(name);
      else saved.set(name, JSON.stringify(value));
    },
    patch(name, change) {
      saved.set(name, JSON.stringify(applyPatch(load(name), change)));
    },
    flush: () => Promise.resolve(),
  };
}
/** What a request to saved data says once the store can't reach the disk: its worker died, or it was closed. */
export const SAVED_WORK_UNAVAILABLE = 'Saved work isn’t available. Restart Gnosis.';
export function createAppDataStore() {
  let worker: Worker | undefined;
  /** Where `open` read from, for `reopen`. */
  let opened: string | undefined;
  let sequence = 0;
  let failure: Error | undefined;
  let values: Record<string, unknown> | undefined;
  let scheduled = false;
  let writing: Promise<void> | undefined;
  /** Set once the worker is told to close. No write can reach the database after that. */
  let closed = false;
  let lost = 0;
  const updates = new Map<string, unknown>();
  const patches = new Map<string, PendingPatch>();
  /** Names handed to their stores. The stores own them in memory from then on. */
  const taken = new Set<string>();
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  function call<T>(method: string, args?: unknown): Promise<T> {
    if (failure) return Promise.reject(failure);
    if (!worker) return Promise.reject(new Error(values ? SAVED_WORK_UNAVAILABLE : 'Saved work is still loading'));
    const active = worker;
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      pending.set(id, { resolve: (value) => resolve(value as T), reject });
      active.ref();
      const started = performance.now();
      try {
        // Cloning a large state for the worker runs on main.
        active.postMessage({ id, method, args });
      } catch (error) {
        pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
        if (!pending.size) active.unref();
      } finally {
        noteWork(`saved data ${method}`, started);
      }
    });
  }
  function assertReady() {
    if (failure) throw failure;
    if (!values) throw new Error('Saved work is still loading');
    return values;
  }
  const dirty = () => updates.size > 0 || patches.size > 0;
  /** A write after close cannot be saved. Count it instead of failing the caller during quit. */
  function lose(what: string) {
    lost++;
    console.warn(`Saved work is closed, so a late ${what} was not saved (${lost} lost).`);
  }
  /** Waits before retrying a failed flush: from 500 ms, doubling to 30 s. Reset by a flush that reaches the disk. */
  let retryDelay = 0;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      void flush().catch((error: unknown) => {
        console.error('Saved work could not be persisted:', error);
        if (failure || closed) return;
        retryDelay = Math.min(retryDelay ? retryDelay * 2 : 500, 30_000);
        setTimeout(() => {
          if (dirty()) schedule();
        }, retryDelay).unref();
      });
    });
  }
  /** Names only the kind of state in a log: never an account or a hash. */
  const kind = (name: string) => name.split(':')[0].replace(/-[a-f0-9]{64}.*$/, '');
  /** Puts failed items back for retry, under any newer change to the same rows. */
  function requeue(states: [string, unknown][], changed: [string, PendingPatch][]) {
    for (const [name, value] of states) if (!updates.has(name)) updates.set(name, values && name in values ? values[name] : value);
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
  }
  const clonable = (value: unknown) => {
    try {
      structuredClone(value);
      return true;
    } catch {
      return false;
    }
  };
  async function flush(): Promise<void> {
    if (failure) throw failure;
    if (writing) {
      await writing;
      if (dirty()) await flush();
      return;
    }
    if (!dirty()) return;
    // Closed: writes since are counted as lost (`lose`), and a final save that failed stays queued for `reopen`. A
    // flush never fails a caller for it: the quit already reported the failed save, and the app kept running.
    if (!worker) return;
    const states = [...updates];
    const changed = [...patches];
    updates.clear();
    patches.clear();
    const rows = (change: PendingPatch) => ({
      ...(change.header ? { header: change.header } : {}),
      put: [...change.put],
      remove: [...change.remove],
    });
    // postMessage clones now, before callers can mutate the in-memory state again. One transaction; the worker refuses
    // a bad state or patch alone and names it, and the others are saved.
    writing = call<{ refused?: [string, string][] } | undefined>('write', {
      states,
      patches: changed.map(([name, change]) => [name, rows(change)]),
    })
      .then((result) => {
        retryDelay = 0;
        // A refused item is never retried: it would be refused again, and hold back nothing else.
        for (const [name, message] of result?.refused ?? [])
          console.warn(`Saved work refused a ${kind(name)} state and dropped it: ${message.split(name).join(kind(name))}`);
      })
      .catch((error: unknown) => {
        // A value that can't be sent to the worker: each item is cloned alone to find it, and only it is dropped.
        if (error instanceof Error && error.name === 'DataCloneError') {
          let dropped = 0;
          const keep = (name: string, value: unknown) => {
            if (clonable(value)) return true;
            dropped++;
            console.warn(`Saved work dropped a ${kind(name)} state that can't be saved.`);
            return false;
          };
          requeue(
            states.filter(([name, value]) => keep(name, value)),
            changed.filter(([name, change]) => keep(name, rows(change)))
          );
          if (dropped) return;
          throw error;
        }
        // A disk or lock failure: keep the latest snapshot and retry.
        requeue(states, changed);
        throw error;
      })
      .finally(() => {
        writing = undefined;
      });
    await writing;
    if (dirty()) await flush();
  }
  const store = {
    async open(directory: string) {
      if (worker) throw new Error('Storage already opened');
      opened = directory;
      closed = false;
      // Forge builds the worker alongside main.js. tsx is only used by source-level tests.
      worker = __filename.endsWith('.ts')
        ? new Worker(`require('tsx/cjs'); require(${JSON.stringify(path.join(__dirname, 'app-data-worker.ts'))})`, {
            eval: true,
          })
        : new Worker(path.join(__dirname, 'app-data-worker.js'));
      const active = worker;
      const failed = (error: Error) => {
        // The cause goes to the log; callers get what to do.
        console.error('Saved work stopped:', error);
        const unavailable = new Error(SAVED_WORK_UNAVAILABLE);
        failure = unavailable;
        for (const request of pending.values()) request.reject(unavailable);
        pending.clear();
        active.unref();
      };
      worker.on('error', failed);
      worker.on('exit', (code) => {
        if (worker !== active) return;
        const error = new Error(`Saved-work worker exited (${code})`);
        // The worker exits by itself once it answers close, and that exit can arrive before close()
        // resumes. It is not a crash: fail any request still waiting, but keep the store usable so
        // late writes are counted instead of thrown.
        if (!closed) {
          failed(error);
          return;
        }
        for (const request of pending.values()) request.reject(error);
        pending.clear();
        active.unref();
      });
      worker.on('message', ({ id, result, error }: { id: number; result: unknown; error?: string }) => {
        const request = pending.get(id);
        pending.delete(id);
        if (error) request?.reject(new Error(error));
        else request?.resolve(result);
        if (!pending.size) active.unref();
      });
      const loaded = await call<Record<string, unknown>>('open', { directory });
      // Reopened after a close: the copy in memory is newer than the disk, and the stores own what they took.
      values ??= loaded;
      if (dirty()) schedule();
    },
    /**
     * Opens saved data again after `close`, when the app keeps running: a quit that could not save, and you kept
     * Gnosis open. Saves queued when the close failed go to disk now.
     */
    async reopen() {
      if (worker || !opened || failure) return;
      await store.open(opened);
    },
    read(name: string): unknown {
      const started = performance.now();
      try {
        return structuredClone(assertReady()[name]);
      } finally {
        noteWork(`saved data read ${name.split(':')[0]}`, started);
      }
    },
    /** Names of the saved states that are loaded and not taken. */
    names(): string[] {
      return Object.keys(assertReady());
    },
    take(name: string): unknown {
      const all = assertReady();
      const value = all[name];
      Reflect.deleteProperty(all, name);
      taken.add(name);
      return value;
    },
    write(name: string, value: unknown) {
      const all = assertReady();
      // A whole state is an object (`renderer:` states excepted). Refused here, before it is queued: a value the worker
      // refuses would fail every later flush, and with it every save in the app.
      assertSavedState(name, value);
      const removed = value === null || value === undefined;
      if (removed) Reflect.deleteProperty(all, name);
      else all[name] = value;
      if (closed) return lose(name);
      updates.set(name, removed ? null : value);
      // The whole state replaces any row changes queued before it.
      patches.delete(name);
      schedule();
    },
    patch(name: string, change: RowPatch) {
      const all = assertReady();
      // After a queued removal, the patch's rows alone are the state, in memory and on disk: queued as rows, they
      // would land on top of the old rows the removal had not yet deleted.
      if (updates.has(name) && updates.get(name) === null) {
        const next = applyPatch(undefined, change);
        if (!taken.has(name)) all[name] = next;
        if (closed) return lose(name);
        updates.set(name, next);
        schedule();
        return;
      }
      // A state nobody has taken stays readable.
      if (name in all) all[name] = applyPatch(all[name], change);
      if (closed) return lose(name);
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
    // Review state goes straight to the worker, so a save sent before close is ordered ahead of it.
    saveReviewState: async (value: ReviewStateWrite) => {
      if (closed) return lose('review state');
      await call('review-save', value);
    },
    saveFileProgress: async (value: FileProgressPatch) => {
      if (closed) return lose('file progress');
      await call('progress-save', value);
    },
    /** Writes that arrived after close, for tests and diagnostics. */
    lostWrites: () => lost,
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
      // A failed final save must still release the database: report it, but always stop the worker.
      let failure: unknown;
      // Writes that arrive while the final flush runs join it. The check and `closed` are synchronous,
      // so nothing can slip in between the last flush and the close request.
      do {
        try {
          await flush();
        } catch (error) {
          failure = error;
        }
      } while (!failure && dirty());
      closed = true;
      try {
        await call('close');
      } catch (error) {
        failure ??= error;
      } finally {
        worker = undefined;
        await active.terminate();
      }
      if (failure) throw failure;
    },
  };
  return store;
}
