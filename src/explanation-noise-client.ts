import { Worker } from 'node:worker_threads';
import type { NoiseKind } from '../lib/semantic-noise';
import type { NoiseRequest } from '../lib/explanation-noise';
import type { TreeSitterFiles } from './conflict-checks';

export interface NoiseRequestMessage {
  id: number;
  files: Pick<NoiseRequest, 'language' | 'after' | 'hunks'>[];
}
export interface NoiseResponseMessage {
  id: number;
  kinds: (NoiseKind[] | null)[];
}

/**
 * Classifies the files of one explanation in a worker started for it (src/explanation-noise-worker.ts) and stopped when
 * it answers. Fail closed: an error, a timeout or a cancellation answers null for every file, so no hunk is cut as
 * whitespace, formatting or comments.
 */
export function classifyInWorker(
  script: string,
  files: TreeSitterFiles,
  requests: readonly NoiseRequest[],
  signal?: AbortSignal,
  timeoutMs = 20_000
): Promise<(NoiseKind[] | null)[]> {
  const none = () => requests.map(() => null);
  if (!requests.length || signal?.aborted) return Promise.resolve(none());
  return new Promise((resolve) => {
    let worker: Worker | undefined;
    let done = false;
    const finish = (kinds: (NoiseKind[] | null)[]) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      worker?.removeAllListeners();
      void worker?.terminate();
      resolve(kinds.length === requests.length ? kinds : none());
    };
    const abort = () => finish(none());
    const timer = setTimeout(() => {
      console.warn('[noise] The syntax comparison ran out of time; no hunk is cut as formatting.');
      finish(none());
    }, timeoutMs);
    signal?.addEventListener('abort', abort);
    try {
      worker = new Worker(script, { workerData: files });
      worker.on('message', (message: NoiseResponseMessage) => finish(message.kinds));
      worker.on('error', (error) => {
        console.warn('[noise] The syntax comparison failed.', error);
        finish(none());
      });
      worker.on('exit', () => finish(none()));
      worker.postMessage({
        id: 1,
        files: requests.map(({ language, after, hunks }) => ({ language, after, hunks })),
      } satisfies NoiseRequestMessage);
    } catch (error) {
      console.warn('[noise] The syntax comparison did not start.', error);
      finish(none());
    }
  });
}
