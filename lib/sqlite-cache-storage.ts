import { Worker } from 'node:worker_threads';
import { SQLITE_CACHE_WORKER } from './sqlite-cache-worker';
export interface CacheWrite {
  id: string;
  payload?: string | null;
  revalidate?: boolean;
  prepared?: boolean;
  onlyPrepared?: boolean;
  deletePrepared?: boolean;
  clearPrepared?: boolean;
}
/** Only the worker opens the database, imports legacy JSON, or waits for disk locks. */
export function createCacheStorage() {
  const worker = new Worker(SQLITE_CACHE_WORKER, { eval: true });
  worker.unref();
  let nextId = 0,
    failure: Error | undefined,
    closed = false;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  const fail = (error: Error) => {
    failure = error;
    for (const request of pending.values()) request.reject(error);
    pending.clear();
    worker.unref();
  };
  worker.on('error', fail);
  worker.on('exit', (code) => {
    if (!closed) fail(new Error(`Cache worker exited (${code})`));
  });
  worker.on('message', (message: { id: number; result?: unknown; error?: string }) => {
    const request = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) request?.reject(new Error(message.error));
    else request?.resolve(message.result);
    if (!pending.size) worker.unref();
  });
  function call(method: string, args?: unknown): Promise<unknown> {
    if (failure || closed) return Promise.reject(failure ?? new Error('Cache storage closed'));
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      worker.ref();
      try {
        worker.postMessage({ id, method, args });
      } catch (error) {
        pending.delete(id);
        reject(error as Error);
        if (!pending.size) worker.unref();
      }
    });
  }
  return {
    open: (args: {
      file: string;
      legacy: string;
      now: number;
      maxBytes: number;
      maxEntryBytes: number;
      maxEntries: number;
      retention: number;
      preparedBytes?: number;
    }) => call('open', args),
    setPreparedLimit: (bytes: number, now: number) => call('prepared-limit', { bytes, now }),
    readPrepared: (id: string, now: number) => call('prepared-read', { id, now }),
    write: (operations: CacheWrite[], now: number) => call('write', { operations, now }),
    async close() {
      try {
        await call('close');
      } finally {
        closed = true;
        await worker.terminate();
      }
    },
  };
}
