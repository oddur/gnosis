import type { ReviewStateWrite, FileProgressPatch } from '../lib/review-state';
import type { SearchRequest, LocalSearchResponse } from './command-search-service';
import { Worker } from 'node:worker_threads';
import path from 'node:path';

/** An initialized in-memory snapshot, with coalesced durable writes owned by a worker. */
export interface StateStorage {
  read(name: string): unknown;
  write(name: string, value: unknown): void;
  flush(): Promise<void>;
}
export function createAppDataStore() {
  let worker: Worker | undefined;
  let sequence = 0;
  let failure: Error | undefined;
  let values: Record<string, unknown> | undefined;
  let scheduled = false;
  let writing: Promise<void> | undefined;
  const updates = new Map<string, unknown>();
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
  async function flush(): Promise<void> {
    if (failure) throw failure;
    if (writing) {
      await writing;
      if (updates.size) await flush();
      return;
    }
    if (!updates.size) return;
    const batch = [...updates];
    updates.clear();
    // postMessage clones now, before callers can mutate the in-memory state again.
    writing = call<unknown>('write', batch)
      .then(() => {})
      .catch((error: unknown) => {
        // Keep the latest snapshot for retry after a recoverable disk/lock failure.
        for (const [name, value] of batch) if (!updates.has(name)) updates.set(name, values?.[name] ?? value);
        throw error;
      })
      .finally(() => {
        writing = undefined;
      });
    await writing;
    if (updates.size) await flush();
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
    write(name: string, value: unknown) {
      assertReady()[name] = value;
      updates.set(name, value);
      if (!scheduled) {
        scheduled = true;
        queueMicrotask(() => {
          scheduled = false;
          void flush().catch((error: unknown) => console.error('Saved work could not be persisted:', error));
        });
      }
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
    async clearGitHub() {
      await flush();
      values = await call<Record<string, unknown>>('clear-github');
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
