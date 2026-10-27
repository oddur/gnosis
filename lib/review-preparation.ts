import { setTimeout as delay } from 'node:timers/promises';
import type { DiffSource } from './diffSource';
import type { ChangedFile, FileMetadata } from './types';
import { githubRateLimit } from './github-client';
import { withGitHubPriority } from './github-scheduler';

export interface ContentProgress {
  completed: number;
  total: number;
  waitingUntil?: number;
}

/** Count complete files, not requests: added/deleted files have only one side. */
export async function loadReviewContents(
  source: Pick<DiffSource, 'getFileContent'>,
  files: ChangedFile[],
  parentSignal: AbortSignal,
  onProgress: (progress: ContentProgress) => void,
  timing: { now: () => number; wait: (ms: number, signal: AbortSignal) => Promise<void> } = {
    now: Date.now,
    wait: (ms: number, signal: AbortSignal) => delay(ms, undefined, { signal }),
  }
) {
  const controller = new AbortController();
  const signal = AbortSignal.any([parentSignal, controller.signal]);
  const fileContents: Record<string, string> = {},
    headFileContents: Record<string, string> = {};
  const waiting = new Map<symbol, number>();
  let next = 0,
    completed = 0;
  const report = () => {
    if (signal.aborted) return;
    const deadlines = [...waiting.values()].filter((time) => time > timing.now());
    onProgress({
      completed,
      total: files.length,
      ...(deadlines.length ? { waitingUntil: Math.max(...deadlines) } : {}),
    });
  };
  async function read(path: string, ref: 'base' | 'head') {
    for (;;) {
      signal.throwIfAborted();
      try {
        return await source.getFileContent(path, ref, signal);
      } catch (error) {
        signal.throwIfAborted();
        const limited = githubRateLimit(error, timing.now());
        if (!limited) throw error;
        const id = Symbol();
        // Never busy-loop if a supplied deadline has just elapsed.
        const deadline = Math.max(limited.retryAt, timing.now() + 1000);
        waiting.set(id, deadline);
        report();
        try {
          while (deadline > timing.now()) await timing.wait(Math.min(60_000, deadline - timing.now()), signal);
        } finally {
          waiting.delete(id);
          report();
        }
      }
    }
  }
  report();
  try {
    await withGitHubPriority('foreground', () =>
      Promise.all(
        Array.from({ length: Math.min(5, files.length) }, async () => {
          while (next < files.length) {
            signal.throwIfAborted();
            const file = files[next++];
            const [before, after] = await Promise.all([
              file.status === 'added' ? null : read(file.previous_filename ?? file.filename, 'base'),
              file.status === 'deleted' ? null : read(file.filename, 'head'),
            ]);
            signal.throwIfAborted();
            if (before !== null) fileContents[file.filename] = before;
            if (after !== null) headFileContents[file.filename] = after;
            completed++;
            report();
          }
        })
      )
    );
  } finally {
    controller.abort();
  }
  return { fileContents, headFileContents };
}

/** Optional age/churn never gates the explanation or outlives its consumer. */
export function startReviewFileMetadata(source: Pick<DiffSource, 'getFileMetadata'>, files: ChangedFile[]) {
  const controller = new AbortController();
  let value: FileMetadata[] = files.map((file) => ({
    filename: file.filename,
    previousFilename: file.previous_filename,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
  }));
  void withGitHubPriority('background', () => source.getFileMetadata(files, controller.signal)).then(
    (result) => {
      if (!controller.signal.aborted) value = result;
    },
    () => {
      /* Age and churn are optional; retain the known file inventory. */
    }
  );
  return {
    finish() {
      controller.abort();
      return value;
    },
  };
}
