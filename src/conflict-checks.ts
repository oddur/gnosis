import { Worker } from 'node:worker_threads';
import { NOISE_MAX_CHARACTERS } from '../lib/semantic-noise';
import { verifyProposals, verifyWholeFile, type Analyse, type Equivalent, type Verdict } from '../lib/conflict-verify';
import type { ConflictFile } from '../lib/conflict-resolution';
import type { createSyntaxEngine, SyntaxLanguage } from '../lib/syntax-scope';

/**
 * The conflict checks (lib/conflict-verify.ts) in the main process (#445 item 3), so a session's buckets do not depend
 * on an open dialog. The checks parse with tree-sitter in a worker thread (src/conflict-check-worker.ts): a parse never
 * blocks the main process.
 */
export type CheckedFile = Pick<
  ConflictFile,
  'path' | 'base' | 'ours' | 'theirs' | 'original' | 'proposals' | 'wholeFile'
>;
type Engine = Pick<ReturnType<typeof createSyntaxEngine>, 'definitions' | 'equivalent'>;

/** checkSyntax's limit in lib/syntax-scope-client.ts: a longer text is not parsed, so its proposals stay in Check. */
const SYNTAX_MAX_CHARACTERS = 1_000_000;
const UNCHECKED: Verdict = { merged: false, note: 'Gnosis couldn’t check this result.' };

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
  return (file: CheckedFile): Promise<Verdict> =>
    (file.wholeFile
      ? verifyWholeFile(file, file.wholeFile, analyse)
      : verifyProposals(file, analyse, false, equivalent)
    ).catch(() => UNCHECKED);
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
export type CheckResponse = { id: number; verdict: Verdict } | { id: number; error: string };

/**
 * The worker that runs the checks, started on the first check and stopped after a minute without one, so its grammars
 * leave memory. One file at a time; a file that takes over 30 seconds stops the worker and stays in Check.
 */
export function createConflictCheckWorker(script: string, files: () => TreeSitterFiles, idleMs = 60_000) {
  let worker: Worker | undefined;
  let serial = 0;
  let idle: ReturnType<typeof setTimeout> | undefined;
  const waiting = new Map<number, { resolve: (verdict: Verdict) => void; timer: ReturnType<typeof setTimeout> }>();
  const stop = () => {
    clearTimeout(idle);
    const previous = worker;
    worker = undefined;
    previous?.removeAllListeners();
    void previous?.terminate();
    for (const { resolve, timer } of waiting.values()) {
      clearTimeout(timer);
      resolve(UNCHECKED);
    }
    waiting.clear();
  };
  const start = () => {
    if (worker) return worker;
    const started = new Worker(script, { workerData: files() });
    started.on('message', (message: CheckResponse) => {
      const entry = waiting.get(message.id);
      if (!entry) return;
      waiting.delete(message.id);
      clearTimeout(entry.timer);
      if ('error' in message) console.warn('[conflicts] A check failed.', message.error);
      entry.resolve('verdict' in message ? message.verdict : UNCHECKED);
      if (!waiting.size) idle = setTimeout(stop, idleMs);
    });
    started.on('error', (error) => {
      console.warn('[conflicts] The check worker failed.', error);
      stop();
    });
    started.on('exit', stop);
    started.unref();
    worker = started;
    return started;
  };
  return {
    check(file: CheckedFile, disabled: SyntaxLanguage[] = []): Promise<Verdict> {
      clearTimeout(idle);
      return new Promise<Verdict>((resolve) => {
        const id = ++serial;
        const timer = setTimeout(stop, 30_000);
        waiting.set(id, { resolve, timer });
        try {
          const request: CheckRequest = {
            id,
            file: {
              path: file.path,
              base: file.base,
              ours: file.ours,
              theirs: file.theirs,
              original: file.original,
              proposals: file.proposals,
              wholeFile: file.wholeFile,
            },
            disabled,
          };
          start().postMessage(request);
        } catch (error) {
          console.warn('[conflicts] The check worker did not start.', error);
          stop();
        }
      });
    },
    dispose: stop,
  };
}
