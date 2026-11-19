import { useEffect, useState, useSyncExternalStore, type RefObject } from 'react';
import {
  createSyntaxContentsScheduler,
  syntaxContentsDiagnostics,
  syntaxContentsPlan,
  syntaxReadMode,
  SYNTAX_PREDICTED_FILES,
  SYNTAX_PREFETCH_FILES,
  type SyntaxContentsJob,
} from './syntax-contents';
import { addDiagnosticsSource } from './diagnostics-sources';
import { inspectionFileRequest, inspectionFiles, onInspectionForget, onInspectionUses } from './inspection-cache';
import { readDefinitions, setSyntaxLanguages, warmSyntax } from './syntax-scope-client';
import type { SyntaxPriority } from './syntax-parse-queue';
import {
  DEFAULT_CODE_INTELLIGENCE,
  codeIntelligenceSettings,
  languageEnabled,
  pathEnabled,
  type CodeIntelligenceSettings,
} from './code-intelligence';
import { preferencesReady, startupPreferences } from './startup-preferences';
import { syntaxLanguage } from './syntax-scope';
import { traceStructure } from './structure-trace';
import type { PrChangeFile, PrChanges, PrFileSide } from './pr-changes';

/** The page's one queue of contents reads for hunk scopes (#393): view reads first, then prefetch. */
export const syntaxContents = createSyntaxContentsScheduler();
// Caps and failures leave with their PR's inspection data, as the contents and definitions do, and a PR they alone
// still hold is swept when idle.
onInspectionForget((urls) => syntaxContents.forget(urls));
onInspectionUses((into) => syntaxContents.lastUses(into));
// Each read's tier, wait, run time, tries and outcome, so an export shows why breadcrumbs came late.
addDiagnosticsSource('syntaxContents', () => syntaxContentsDiagnostics(syntaxContents.stats()));

// Settings › Appearance › Code intelligence. A language that is off is not read, prefetched or parsed.
let codeSettings: CodeIntelligenceSettings = DEFAULT_CODE_INTELLIGENCE;
const allowed = (path: string) => pathEnabled(codeSettings, path);
/** The setting as last applied, for views without the preferences at hand (Explanation topics). */
export const currentCodeIntelligence = (): CodeIntelligenceSettings => codeSettings;
/** Applies the setting to reads and parses; diffs pass it to their hooks too, so a change shows at once. */
export function applyCodeIntelligence(settings: CodeIntelligenceSettings) {
  codeSettings = settings;
  setSyntaxLanguages((language) => languageEnabled(settings, language));
}
// From the saved preferences too, so warming the predicted next PR respects the setting before any diff shows. Some
// fixtures render diffs without the app's API.
if (typeof window !== 'undefined' && (window as { electronAPI?: unknown }).electronAPI) {
  const fromPreferences = (preferences: unknown) => {
    if (preferences) applyCodeIntelligence(codeIntelligenceSettings(preferences));
  };
  const saved = startupPreferences();
  if (saved) fromPreferences(saved);
  else void preferencesReady().then(fromPreferences, () => {});
  window.addEventListener('gnosis-preferences-changed', (event) => fromPreferences((event as CustomEvent<unknown>).detail));
  // Some windows and fixtures expose only part of the API.
  (window as { electronAPI?: Partial<Window['electronAPI']> }).electronAPI?.onPreferencesChanged?.(fromPreferences);
}

/**
 * How long the view must be still before a file near it queues its read, so files that only flash past are not read.
 * Scrolling restarts the wait: on a slow machine a fast scroll can leave each file near the view for longer than this,
 * so time near the view alone is not enough. A scroll fires every frame, so a scroll that is still going never lets
 * this much time pass; a file that came near without a scroll (the PR opened, a file expanded) asks at once.
 */
const SETTLE_MS = 150;
let lastScrollAt = 0;
/** Runs `run` once the view has been still for SETTLE_MS; the returned function cancels it. */
function whenSettled(run: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelled = false;
  const check = () => {
    const wait = lastScrollAt + SETTLE_MS - Date.now();
    if (wait > 0) timer = setTimeout(check, wait);
    else if (!cancelled) run();
  };
  check();
  return () => {
    cancelled = true;
    clearTimeout(timer);
  };
}
/** Near the view: within a viewport above or below it. Rows outside the virtualizer's range are not mounted. */
const NEAR = '100% 0px';
/** Files read as view reads as soon as a PR's Changes opens, before any of them is near the view. */
export const SYNTAX_OPEN_FILES = 3;
/** Prefetch waits this long after the last scroll or key press. */
const INPUT_PAUSE_MS = 700;
/** A window hidden this long stops prefetching; it starts again when the window shows. */
const HIDDEN_STOP_MS = 60_000;

/** A file of a PR as the diff shows it: `key` is the view's file key (`changeFileKey`). */
export interface SyntaxFile {
  key: string;
  snapshot: PrChanges;
  file: PrChangeFile;
}

function parse(key: string, url: string, path: string, side: PrFileSide, priority: SyntaxPriority) {
  const language = syntaxLanguage(path);
  if (language && side.kind === 'text') void readDefinitions({ key, url, language, text: side.content, priority }).catch(() => {});
}
/**
 * The read for a file's scopes: the after side through the same cache and IPC as a gap reveal, or both sides for a
 * file with hunks that only delete. Each side goes to the worker as it arrives, under the keys the view asks for
 * (lib/use-syntax-definitions.ts), so a file prefetched before the reader reaches it shows its scopes at once. A view
 * read's file is near the view, and parses ahead of prefetched files, which parse only when nothing nearer waits; a
 * file on screen asks again, and goes first (lib/syntax-parse-queue.ts). View reads go at foreground priority
 * (`'view'`), prefetch in the background.
 */
export function syntaxContentsJob(
  { key, snapshot, file }: SyntaxFile,
  plan: { both: boolean; characters: number }
): SyntaxContentsJob {
  const request = inspectionFileRequest(snapshot, file);
  return {
    key,
    pr: snapshot.url,
    characters: plan.characters,
    ready: () => (plan.both ? !!inspectionFiles.peek(request) : !!inspectionFiles.peekAfter(request)),
    run: async (tier) => {
      const mode = syntaxReadMode(tier);
      const priority: SyntaxPriority = tier === 'view' ? 'near' : 'prefetch';
      traceStructure(key, { readStart: performance.now() });
      if (plan.both) {
        const contents = await inspectionFiles.read(request, mode);
        traceStructure(key, { readEnd: performance.now() });
        parse(`${key}:after`, snapshot.url, file.path, contents.after, priority);
        parse(`${key}:before`, snapshot.url, file.previousPath ?? file.path, contents.before, priority);
      } else {
        const after = await inspectionFiles.readAfter(request, mode);
        traceStructure(key, { readEnd: performance.now() });
        parse(`${key}:after`, snapshot.url, file.path, after, priority);
      }
    },
  };
}

// Prefetch stops while the reader scrolls or types, and while the window is hidden.
let epoch = 0;
const epochListeners = new Set<() => void>();
const bump = () => {
  epoch++;
  for (const listener of epochListeners) listener();
};
if (typeof window !== 'undefined') {
  const pause = () => syntaxContents.pausePrefetch(Date.now() + INPUT_PAUSE_MS);
  for (const type of ['wheel', 'keydown', 'input', 'touchmove'] as const)
    window.addEventListener(type, pause, { capture: true, passive: true });
  document.addEventListener('scroll', pause, { capture: true, passive: true });
  document.addEventListener(
    'scroll',
    () => {
      lastScrollAt = Date.now();
    },
    { capture: true, passive: true }
  );
  let hiddenTimer: ReturnType<typeof setTimeout> | undefined,
    stopped = false;
  const visibility = () => {
    const hidden = document.visibilityState === 'hidden';
    syntaxContents.setHidden(hidden);
    clearTimeout(hiddenTimer);
    if (hidden)
      hiddenTimer = setTimeout(() => {
        stopped = true;
        syntaxContents.stopPrefetch();
      }, HIDDEN_STOP_MS);
    else if (stopped) {
      stopped = false;
      bump();
    }
  };
  document.addEventListener('visibilitychange', visibility);
  visibility();
}

/**
 * Prefetches the scopes of every supported file in `files`, in their order, while the view is open. Viewed files,
 * which show collapsed, are left for their view reads. A PR with more supported files than the prefetch limit is
 * left to view reads alone.
 */
export function useSyntaxPrefetch(
  owner: string,
  files: readonly SyntaxFile[],
  viewed: (file: SyntaxFile) => boolean,
  settings: CodeIntelligenceSettings
) {
  const setting = JSON.stringify(settings);
  const restart = useSyncExternalStore(
    (listener) => {
      epochListeners.add(listener);
      return () => epochListeners.delete(listener);
    },
    () => epoch
  );
  const signature = files.map((file) => `${file.key}\u0000${viewed(file) ? 1 : 0}`).join('\n');
  useEffect(() => {
    applyCodeIntelligence(settings);
    const planned = files.flatMap((file) => {
      const plan = syntaxContentsPlan(file.snapshot, file.file, allowed);
      return plan ? [{ file, plan }] : [];
    });
    // The PR's grammars load in the worker while the first reads run, so no parse waits for one. Added files count,
    // though they read nothing: their patch is parsed.
    warmSyntax(
      files.flatMap(({ file }) =>
        [file.path, ...(file.previousPath ? [file.previousPath] : [])].flatMap((path) => (allowed(path) && syntaxLanguage(path)) || [])
      )
    );
    const jobs = planned.filter(({ file }) => !viewed(file)).map(({ file, plan }) => syntaxContentsJob(file, plan));
    // The first files show first: they are read at once, as view reads, before the view has measured anything. The
    // file the view opens on asks again when it is near, which makes it the newest request.
    const opening = jobs.slice(0, SYNTAX_OPEN_FILES).map((job) => syntaxContents.request(job, () => {}));
    const stop =
      planned.length && planned.length <= SYNTAX_PREFETCH_FILES ? syntaxContents.prefetch(owner, jobs) : undefined;
    return () => {
      for (const cancel of opening) cancel();
      stop?.();
    };
  }, [owner, signature, restart, setting]);
}

/** Warms the first supported files of the predicted next PR, after the open PR's prefetch. */
export function warmPredictedSyntax(files: readonly SyntaxFile[]) {
  const jobs = files
    .flatMap((file) => {
      const plan = syntaxContentsPlan(file.snapshot, file.file, allowed);
      return plan ? [syntaxContentsJob(file, plan)] : [];
    })
    .slice(0, SYNTAX_PREDICTED_FILES);
  syntaxContents.prefetch('predicted', jobs, 1);
}

/**
 * Where a file's diff is, for the order of parses (lib/syntax-parse-queue.ts): on screen (`view`), within a viewport
 * of it (`near`), or further (`prefetch`). Until the first observation it is `near`: it was just mounted, so close.
 */
export function useViewTier(element: RefObject<HTMLElement | null>, enabled: boolean): SyntaxPriority {
  const [tier, setTier] = useState<SyntaxPriority>('near');
  useEffect(() => {
    const target = element.current;
    if (!enabled || !target || typeof IntersectionObserver === 'undefined') return;
    const root = target.closest('.commit-diff-stream, [data-diff-scroller]');
    let onScreen = false,
      near = true;
    const update = () => setTier(onScreen ? 'view' : near ? 'near' : 'prefetch');
    const screen = new IntersectionObserver(
      (entries) => {
        onScreen = entries[entries.length - 1].isIntersecting;
        update();
      },
      { root }
    );
    const around = new IntersectionObserver(
      (entries) => {
        near = entries[entries.length - 1].isIntersecting;
        update();
      },
      { root, rootMargin: NEAR }
    );
    screen.observe(target);
    around.observe(target);
    return () => {
      screen.disconnect();
      around.disconnect();
    };
  }, [enabled]);
  return tier;
}

/** Where a file's scope contents are: being read, read, or not readable; `retry` asks again after a failure. */
export interface SyntaxContentsStatus {
  state: 'idle' | 'loading' | 'failed';
  retry: () => void;
}
/**
 * Reads a file's scope contents once its diff is near the view (a view read, ahead of prefetch). `want` is undefined
 * when nothing needs reading. The caller renders again when the read ends and finds the contents in the cache.
 * `loading` lasts until then; `failed` means the tries ran out, and `retry` starts over. A file that cannot be read
 * (too large, binary, missing) is `idle`: there is nothing to wait for.
 */
export function useSyntaxContents(
  element: RefObject<HTMLElement | null>,
  want: SyntaxFile | undefined
): SyntaxContentsStatus {
  const [near, setNear] = useState(false);
  const [result, setResult] = useState<{ key: string; state: 'done' | 'failed' | 'refused' }>();
  const [attempt, setAttempt] = useState(0);
  const active = !!want;
  // Contents another read brought in (the PR's opening reads, prefetch, another view) show as soon as they land.
  useEffect(() => {
    if (!want) return;
    const { key } = want;
    return syntaxContents.watch(key, () => setResult({ key, state: 'done' }));
  }, [want?.key]);
  useEffect(() => {
    const target = element.current;
    if (!active || !target || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) => setNear(entries[entries.length - 1].isIntersecting), {
      root: target.closest('.commit-diff-stream, [data-diff-scroller]'),
      rootMargin: NEAR,
    });
    observer.observe(target);
    return () => {
      observer.disconnect();
      setNear(false);
    };
  }, [active]);
  useEffect(() => {
    if (!want || !near) return;
    const plan = syntaxContentsPlan(want.snapshot, want.file, allowed);
    if (!plan) return;
    const { key } = want;
    let cancel = () => {};
    traceStructure(key, { near: performance.now() });
    const stopWaiting = whenSettled(() => {
      traceStructure(key, { viewRequest: performance.now() });
      cancel = syntaxContents.request(
        syntaxContentsJob(want, plan),
        () => setResult({ key, state: 'done' }),
        (failure) => setResult({ key, state: failure.retryable ? 'failed' : 'refused' })
      );
    });
    return () => {
      stopWaiting();
      cancel();
    };
  }, [want?.key, near, attempt]);
  const current = want && result?.key === want.key ? result.state : undefined;
  // A file whose tries ran out before it came into view shows so at once.
  const known = want && !current ? syntaxContents.failure(want.key) : undefined;
  const state = !want
    ? 'idle'
    : current === 'failed' || known?.retryable
      ? 'failed'
      : current === 'refused' || known
        ? 'idle'
        : 'loading';
  return {
    state,
    retry: () => {
      if (!want) return;
      syntaxContents.retry(want.key);
      setResult(undefined);
      setAttempt((n) => n + 1);
    },
  };
}
