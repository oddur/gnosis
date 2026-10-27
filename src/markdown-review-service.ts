import type { ExplanationMarkdownRequest } from '../lib/explanation-markdown';
import { Worker } from 'node:worker_threads';
import type { MarkdownReview, MarkdownReviewRequest } from '../lib/markdown-review';

/** One bounded worker, independent of GitHub IO and SQLite writes. */
export function createMarkdownReviewService(workerPath: string) {
  let worker: Worker | undefined;
  let serial = 0;
  let disposed = false;
  type Job = {
    id: number;
    request: MarkdownReviewRequest | ExplanationMarkdownRequest;
    resolve: (value: MarkdownReview) => void;
    reject: (error: Error) => void;
  };
  const queue: Job[] = [];
  let current: Job | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const fail = (error: Error) => {
    clearTimeout(timer);
    const previous = worker;
    worker = undefined;
    previous?.removeAllListeners();
    if (previous) void previous.terminate();
    current?.reject(error);
    current = undefined;
    for (const job of queue.splice(0)) job.reject(error);
  };
  const pump = () => {
    if (current || !queue.length || disposed) return;
    current = queue.shift();
    try {
      if (!worker) {
        worker = new Worker(workerPath);
        worker.on('message', (message: { id: number; value: MarkdownReview; error?: string }) => {
          if (message.id !== current?.id) return;
          clearTimeout(timer);
          const job = current;
          current = undefined;
          if (message.error) job.reject(new Error(message.error));
          else job.resolve(message.value);
          pump();
        });
        worker.on('error', fail);
        worker.on('exit', () => fail(new Error('Markdown preview stopped. Retry or use Source.')));
      }
      timer = setTimeout(
        () => fail(new Error('Markdown preview took too long. Use Source to review this file.')),
        15_000
      );
      worker.postMessage({ id: current?.id, request: current?.request });
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
    }
  };
  return {
    render(input: unknown): Promise<MarkdownReview> {
      if (!input || typeof input !== 'object')
        return Promise.reject(new Error('The document revision is missing. Reopen the file.'));
      const request = input as MarkdownReviewRequest | ExplanationMarkdownRequest;
      if (disposed) return Promise.reject(new Error('Markdown preview is closing.'));
      // IPC callers can supply malformed values despite the typed bridge.
      const excerpt = 'kind' in request;
      if (
        excerpt &&
        ((input as Record<string, unknown>).kind !== 'explanation' ||
          !Array.isArray(request.hunks) ||
          request.hunks.length > 100 ||
          !request.hunks.every(
            (h: unknown) =>
              !!h &&
              typeof h === 'object' &&
              'content' in h &&
              typeof h.content === 'string' &&
              'hunkHeader' in h &&
              typeof h.hunkHeader === 'string' &&
              h.hunkHeader.length < 1000
          ) ||
          request.hunks.reduce((n, h) => n + h.content.length, 0) > 500_000)
      )
        return Promise.reject(new Error('These saved sections are too large or invalid. Use Source to review them.'));
      if (
        !excerpt &&
        [request.before, request.after].some(
          (value) => value !== null && (typeof value !== 'string' || value.length > 500_000)
        )
      )
        return Promise.reject(
          new Error('This document is too large for rendered comparison. Use Source to review it.')
        );
      const sources: unknown[] = [request.beforeSource, request.afterSource];
      if (
        !sources.every((source) => {
          if (!source || typeof source !== 'object') return false;
          const value = source as Record<string, unknown>;
          return ['repo', 'ref', 'path'].every((key) => typeof value[key] === 'string' && value[key].length < 4096);
        })
      )
        return Promise.reject(new Error('The document revision is missing. Reopen the file.'));
      if (queue.length >= 64) return Promise.reject(new Error('Markdown previews are busy. Retry in a moment.'));
      return new Promise((resolve, reject) => {
        queue.push({ id: ++serial, request, resolve, reject });
        pump();
      });
    },
    dispose() {
      disposed = true;
      fail(new Error('Markdown preview is closing.'));
    },
  };
}
