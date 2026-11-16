import { useEffect, useState, type ReactNode } from 'react';
import { WorkerPoolContext } from '@pierre/diffs/react';
import { getOrCreateWorkerPoolSingleton, type WorkerPoolManager } from '@pierre/diffs/worker';
import type { LineDiffTypes } from '@pierre/diffs';
import { DIFF_HIGHLIGHTER } from './diff-highlighter';
import { CODE_THEMES } from './constants';

/** The registered Pierre theme for the reader's code theme. */
export const diffThemeName = (codeTheme: string | undefined) =>
  `gnosis-${CODE_THEMES.some((t) => t.id === codeTheme) ? codeTheme : 'github-dark'}`;

/** Diffs up to this many characters highlight on the main thread: faster than a worker round trip, and they show
 * highlighted at once. Larger ones render as plain text first and highlight in a worker (#346). A 3,000-line file
 * spent about 400 ms of the Changes tab's first paint in the tokenizer on the main thread. */
export const MAIN_THREAD_MAX_CHARACTERS = 16_000;

let pool: WorkerPoolManager | undefined;
let failed = false;
let DiffsWorker: (new () => Worker) | undefined;
// The portable build has no imports, so it inlines as one classic worker that also loads from file:// in the app.
// It is about 1.5 MB, so it loads in its own chunk while the review screen opens; diffs that mount before it
// arrives highlight on the main thread.
void import('@pierre/diffs/worker/worker-portable.js?worker&inline')
  .then((module) => (DiffsWorker = module.default))
  .catch(() => (failed = true));

function diffWorkerPool(theme: string, lineDiffType: LineDiffTypes): WorkerPoolManager | undefined {
  const Factory = DiffsWorker;
  if (failed || !Factory) return pool;
  try {
    pool ??= getOrCreateWorkerPoolSingleton({
      poolOptions: {
        workerFactory: () => new Factory(),
        poolSize: 2,
        mainThreadMaxCharacters: MAIN_THREAD_MAX_CHARACTERS,
        // Pierre falls back to the main thread when its workers fail. Report once, quietly.
        onWorkerError: (event) => {
          event.preventDefault();
          if (!failed) console.warn('Syntax highlighting workers are unavailable; highlighting on the main thread.');
          failed = true;
        },
      },
      highlighterOptions: { theme, lineDiffType, preferredHighlighter: DIFF_HIGHLIGHTER },
    });
  } catch {
    failed = true;
    return undefined;
  }
  return pool;
}

/**
 * Highlights large diffs below it in workers. The pool's render options apply to every diff it serves, so they
 * follow the reader's code theme and inline-change preference.
 */
export function DiffWorkerPool({ theme, lineDiffType, children }: { theme: string; lineDiffType: LineDiffTypes; children: ReactNode }) {
  const [manager] = useState(() => diffWorkerPool(theme, lineDiffType));
  useEffect(() => {
    if (!manager) return;
    const current = manager.getDiffRenderOptions();
    if (current.theme !== theme || current.lineDiffType !== lineDiffType)
      void manager.setRenderOptions({ theme, lineDiffType }).catch(() => {});
  }, [manager, theme, lineDiffType]);
  return <WorkerPoolContext.Provider value={manager}>{children}</WorkerPoolContext.Provider>;
}
