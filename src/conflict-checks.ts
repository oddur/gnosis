import { Worker } from 'node:worker_threads';
import { NOISE_MAX_CHARACTERS } from '../lib/semantic-noise';
import { verifyProposals, verifyWholeFile, type Analyse, type Equivalent, type Verdict } from '../lib/conflict-verify';
import type { ConflictFile } from '../lib/conflict-resolution';
import { SYNTAX_MAX_CHARACTERS, type createSyntaxEngine, type SyntaxLanguage } from '../lib/syntax-scope';

/**
 * The conflict checks (lib/conflict-verify.ts) in the main process (#445 item 3), so a session's buckets do not depend
 * on an open dialog. The checks parse with tree-sitter in a worker thread (src/conflict-check-worker.ts): a parse never
 * blocks the main process.
 *
 * A check that could not run (an error, a timeout, a stopped worker) answers undefined, never a verdict: the service
 * saves nothing for it, so the dialog checks the file itself and the next open checks it again.
 */
/** The draft (`result`) too: a conflict you decided in it is checked as the text you chose. */
export type CheckedFile = Pick<
  ConflictFile,
  'path' | 'base' | 'ours' | 'theirs' | 'original' | 'proposals' | 'wholeFile'
> &
  Partial<Pick<ConflictFile, 'result'>>;
type Engine = Pick<ReturnType<typeof createSyntaxEngine>, 'definitions' | 'equivalent'>;

/**
 * One file's proposals checked as the conflict dialog checks them: a whole-file proposal with verifyWholeFile, else
 * each conflict's proposal with verifyProposals. A language that is off in Settings, or a text over the limits, is not
 * parsed, as in the renderer's syntax worker.
 */
export function conflictChecker(engine: Engine, disabled: readonly SyntaxLanguage[] = []) {
  const analyse: Analyse = async (...args) => {
    const [language, text] = args;
    if (disabled.includes(language)) throw Error('This language is off in Settings');
    if (text.length > SYNTAX_MAX_CHARACTERS) throw Error('This file is too large to parse');
    // Every argument and every field passes through, so the checks read what the renderer's worker answers.
    return engine.definitions(...args);
  };
  const equivalent: Equivalent = (language, before, after) => {
    if (disabled.includes(language)) return Promise.reject(Error('This language is off in Settings'));
    if (Math.max(before.length, after.length) > NOISE_MAX_CHARACTERS)
      return Promise.reject(Error('This file is too large to compare'));
    return engine.equivalent(language, before, after);
  };
  return (file: CheckedFile): Promise<Verdict | undefined> =>
    (file.wholeFile
      ? verifyWholeFile(file, file.wholeFile, analyse)
      : verifyProposals(file, analyse, false, equivalent)
    ).catch((error: unknown) => {
      console.warn(`[conflicts] The checks failed on ${file.path}.`, error);
      return undefined;
    });
}

/** Where the worker finds the tree-sitter runtime and grammars: `src/assets/tree-sitter` in development. */
export interface TreeSitterFiles {
  runtime: string;
  grammars: string;
}
export interface CheckRequest {
  id: number;
  file: CheckedFile;
  disabled: SyntaxLanguage[];
}
export type CheckResponse = { id: number; verdict?: Verdict } | { id: number; error: string };

interface Job {
  request: CheckRequest;
  resolve: (verdict: Verdict | undefined) => void;
  timer?: ReturnType<typeof setTimeout>;
}
/**
 * The worker that runs the checks, started on the first check and stopped after a minute without one, so its grammars
 * leave memory. One file at a time. A file that runs over 30 seconds, counted from when it starts, answers undefined;
 * the worker restarts for the files after it.
 */
export function createConflictCheckWorker(
  script: string,
  files: () => TreeSitterFiles,
  idleMs = 60_000,
  timeoutMs = 30_000
) {
  let worker: Worker | undefined;
  let serial = 0;
  let disposed = false;
  let idle: ReturnType<typeof setTimeout> | undefined;
  const queue: Job[] = [];
  let current: Job | undefined;
  const terminate = () => {
    const previous = worker;
    worker = undefined;
    previous?.removeAllListeners();
    void previous?.terminate();
  };
  /** Answers the running job, then starts the next. `restart`: the worker is stuck or gone, so a new one takes over. */
  const finish = (job: Job, verdict: Verdict | undefined, restart = false) => {
    if (current !== job) return;
    clearTimeout(job.timer);
    current = undefined;
    job.resolve(verdict);
    if (restart) terminate();
    pump();
  };
  const start = () => {
    if (worker) return worker;
    const started = new Worker(script, { workerData: files() });
    started.on('message', (message: CheckResponse) => {
      if (!current || message.id !== current.request.id) return;
      if ('error' in message) console.warn('[conflicts] A check failed.', message.error);
      finish(current, 'verdict' in message ? message.verdict : undefined);
    });
    started.on('error', (error) => {
      console.warn('[conflicts] The check worker failed.', error);
      if (current) finish(current, undefined, true);
      else terminate();
    });
    started.on('exit', () => {
      if (worker !== started) return;
      worker = undefined;
      if (current) finish(current, undefined);
    });
    started.unref();
    worker = started;
    return started;
  };
  function pump() {
    if (current || disposed) return;
    const job = queue.shift();
    if (!job) {
      clearTimeout(idle);
      idle = setTimeout(terminate, idleMs);
      return;
    }
    clearTimeout(idle);
    current = job;
    job.timer = setTimeout(() => {
      console.warn(`[conflicts] The checks ran out of time on ${job.request.file.path}.`);
      finish(job, undefined, true);
    }, timeoutMs);
    try {
      start().postMessage(job.request);
    } catch (error) {
      console.warn('[conflicts] The check worker did not start.', error);
      finish(job, undefined, true);
    }
  }
  return {
    check(file: CheckedFile, disabled: SyntaxLanguage[] = []): Promise<Verdict | undefined> {
      if (disposed) return Promise.resolve(undefined);
      const { path, base, ours, theirs, original, proposals, wholeFile, result } = file;
      return new Promise((resolve) => {
        queue.push({
          request: {
            id: ++serial,
            file: { path, base, ours, theirs, original, proposals, wholeFile, result },
            disabled,
          },
          resolve,
        });
        pump();
      });
    },
    dispose() {
      disposed = true;
      clearTimeout(idle);
      terminate();
      for (const job of [...(current ? [current] : []), ...queue.splice(0)]) {
        clearTimeout(job.timer);
        job.resolve(undefined);
      }
      current = undefined;
    },
  };
}
