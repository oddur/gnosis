import { useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore, type RefObject } from 'react';
import {
  createSyntaxContentsScheduler,
  syntaxContentsDiagnostics,
  permanentFailure,
  syntaxContentsPlan,
  syntaxReadMode,
  SYNTAX_PREDICTED_FILES,
  SYNTAX_PREFETCH_FILES,
  type SyntaxContentsJob,
} from './syntax-contents';
import { addDiagnosticsSource } from './diagnostics-sources';
import { inspectionFileRequest, inspectionFiles, onInspectionForget, onInspectionUses } from './inspection-cache';
import { readDefinitions, readNoise, setSyntaxLanguages, warmSyntax } from './syntax-scope-client';
import { NO_NOISE_FILTER, noiseFilterOn, patchHunks, type NoiseFilter } from './semantic-noise';
import type { SyntaxPriority } from './syntax-parse-queue';
import {
  DEFAULT_CODE_INTELLIGENCE,
  codeIntelligenceSettings,
  languageEnabled,
  pathEnabled,
  type CodeIntelligenceSettings,
} from './code-intelligence';
import { preferencesReady, startupPreferences } from './startup-preferences';
import { SYNTAX_LANGUAGES, syntaxLanguage, type SyntaxLanguage } from './syntax-scope';
import { traceStructure } from './structure-trace';
import type { PrChangeFile, PrChanges, PrFileSide } from './pr-changes';
import {
  MOVES_MAX_FILES,
  failMovesKey,
  noteMovesFailure,
  noteMovesText,
  trackMoves,
} from './moved-symbols-store';
import { MOVES_KEY, movesFailureKey } from './moved-symbols-plan';
import { registerSettled } from './test-settled';
/** The moves reads' budgets, one per head: `moves:<head>`. */
const MOVES_BUDGET = 'moves:';

/** A moves read whose tries ran out is queued again this long after. */
const MOVES_RETRY_MS = 5 * 60_000;
/** Reads for moved symbols per PR, apart from the reads scopes may make (`SYNTAX_CONTENTS_PER_PR`). */
const MOVES_READS = MOVES_MAX_FILES;
/**
 * An added or deleted file without a patch with more lines than this is too large to fingerprint (the worker takes at
 * most `SYMBOLS_MAX_CHARACTERS`): it is not read, and its family is not matched.
 */
const MOVES_WHOLE_LINES = 10_000;

/** The page's one queue of contents reads for hunk scopes (#393): view reads first, then prefetch. */
export const syntaxContents = createSyntaxContentsScheduler();
// Caps and failures leave with their PR's inspection data, as the contents and definitions do, and a PR they alone
// still hold is swept when idle.
onInspectionForget((urls) => syntaxContents.forget(urls));
onInspectionUses((into) => syntaxContents.lastUses(into));
// A moves read that ends without the file (its budget spent, its tries run out, the file not readable) leaves the
// file's moved-symbol family unmatched rather than waiting for it forever (#398). Of other reads, only a file that
// cannot be read at all says anything about moves: a scope read refused by the scope cap does not.
syntaxContents.onFailure((key, failure, cause) => {
  const file = movesFailureKey(key, cause);
  if (!file) return;
  failMovesKey(file.key, { reason: failure.message, recoverable: file.recoverable });
  // A moves read whose tries ran out (the network went away) is tried again later, with fresh tries.
  if (file.recoverable)
    setTimeout(() => {
      syntaxContents.retry(key);
      bump();
    }, MOVES_RETRY_MS);
});
// Each read's tier, wait, run time, tries and outcome, so an export shows why breadcrumbs came late.
addDiagnosticsSource('syntaxContents', () => syntaxContentsDiagnostics(syntaxContents.stats()));

// Settings › Appearance › Code intelligence. A language that is off is not read, prefetched or parsed.
let codeSettings: CodeIntelligenceSettings = DEFAULT_CODE_INTELLIGENCE;
const allowed = (path: string) => pathEnabled(codeSettings, path);
/** The setting as last applied, for views without the preferences at hand (Explanation topics). */
export const currentCodeIntelligence = (): CodeIntelligenceSettings => codeSettings;
/**
 * The languages Settings › Code intelligence turns off, as the syntax allow-list has them (`currentCodeIntelligence`):
 * the conflict views key their verdicts with it (lib/conflict-verdict-key.ts), so they agree with what the checks parse.
 * `preferences` only makes a change show at once; the value always comes from the allow-list. The same array while the
 * languages stay the same, so an unrelated preferences save reruns nothing.
 */
export function useDisabledLanguages(preferences?: unknown): readonly SyntaxLanguage[] {
  const [, changed] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const listener = () => changed();
    window.addEventListener('gnosis-preferences-changed', listener);
    const off = (window as { electronAPI?: Partial<Window['electronAPI']> }).electronAPI?.onPreferencesChanged?.(listener);
    return () => {
      window.removeEventListener('gnosis-preferences-changed', listener);
      off?.();
    };
  }, []);
  void preferences;
  // As lib/conflict-verdict-key.ts `disabledLanguages` reads it.
  const value = SYNTAX_LANGUAGES.filter((language) => !languageEnabled(codeSettings, language)).join();
  return useMemo(() => (value ? (value.split(',') as SyntaxLanguage[]) : []), [value]);
}
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
 * so time near the view alone is not enough. Still means no scroll event for this long, as seen from a frame: a slow
 * frame can hold back the scroll events of a scroll that goes on, so the last check waits for the next frame, whose
 * scroll steps deliver them first. A file that came near without a scroll (the PR opened, a file expanded) asks then.
 */
const SETTLE_MS = 150;
let lastScrollAt = 0;
/**
 * Runs `run` once the view has been still for SETTLE_MS; the returned function cancels it. Reads wait for it, and so
 * do the renders that show structure that lands while the reader scrolls: they would add work to the scroll's frames.
 */
export function whenSettled(run: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let frame: number | undefined;
  let cancelled = false;
  const still = () => performance.now() - lastScrollAt >= SETTLE_MS;
  const check = () => {
    const wait = lastScrollAt + SETTLE_MS - performance.now();
    if (wait > 0) {
      timer = setTimeout(check, wait);
      return;
    }
    // A hidden window draws no frames, and has no scroll to wait out.
    if (typeof requestAnimationFrame === 'undefined' || document.visibilityState === 'hidden') {
      if (!cancelled) run();
      return;
    }
    frame = requestAnimationFrame(() => {
      frame = undefined;
      if (cancelled) return;
      if (still()) run();
      else check();
    });
  };
  check();
  return () => {
    cancelled = true;
    clearTimeout(timer);
    if (frame !== undefined) cancelAnimationFrame(frame);
  };
}
/** Near the view: within a viewport above or below it. Rows outside the virtualizer's range are not mounted. */
const NEAR = '100% 0px';
/** The scrollers diffs sit in (components/ChangesDiff.tsx `DIFF_SCROLLER`). */
const DIFF_SCROLLER = '.commit-diff-stream, [data-diff-scroller]';
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

// Quiet changes (#396): while the reader hides some, every file whose after side is read for its scopes is compared
// too, below its parses, so the file tree and the PR's stats know which files are only noise before they are shown.
let noiseFilter: NoiseFilter = NO_NOISE_FILTER;
/** What the open Changes view hides as noise (Diff appearance). */
export function applyNoiseFilter(filter: NoiseFilter) {
  noiseFilter = filter;
}
function compare({ key, snapshot, file }: SyntaxFile, side: PrFileSide, priority: SyntaxPriority) {
  if (!noiseFilterOn(noiseFilter) || side.kind !== 'text' || file.status === 'added' || file.status === 'deleted') return;
  const language = syntaxLanguage(file.path);
  const hunks = patchHunks(file.patch);
  if (!language || !hunks || !allowed(file.path)) return;
  const imports = file.status === 'modified' ? { path: file.path, patch: hunks } : undefined;
  void readNoise({ fileKey: key, url: snapshot.url, language, text: side.content, hunks, priority, whole: true, imports }).catch(() => {});
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
    ready: () => {
      const both = inspectionFiles.peek(request);
      const after = both?.after ?? inspectionFiles.peekAfter(request);
      const ready = plan.both ? !!both : !!after;
      // Contents another read brought in (a topic, a gap) skip this read: moved symbols take them from here.
      if (ready) noteMovesText(snapshot, file, after, both?.before);
      return ready;
    },
    run: async (tier) => {
      const mode = syntaxReadMode(tier);
      const priority: SyntaxPriority = tier === 'view' ? 'near' : 'prefetch';
      traceStructure(key, { readStart: performance.now() });
      if (plan.both) {
        const contents = await inspectionFiles.read(request, mode);
        traceStructure(key, { readEnd: performance.now() });
        parse(`${key}:after`, snapshot.url, file.path, contents.after, priority);
        parse(`${key}:before`, snapshot.url, file.previousPath ?? file.path, contents.before, priority);
        compare({ key, snapshot, file }, contents.after, priority);
        noteMovesText(snapshot, file, contents.after, contents.before);
        syntaxContents.retry(key + MOVES_KEY);
      } else {
        const after = await inspectionFiles.readAfter(request, mode);
        traceStructure(key, { readEnd: performance.now() });
        parse(`${key}:after`, snapshot.url, file.path, after, priority);
        compare({ key, snapshot, file }, after, priority);
        noteMovesText(snapshot, file, after);
        // The file read: a moves read that ran out of tries for it starts afresh.
        syntaxContents.retry(key + MOVES_KEY);
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
      lastScrollAt = performance.now();
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
  settings: CodeIntelligenceSettings,
  noise: NoiseFilter = NO_NOISE_FILTER
) {
  const setting = JSON.stringify([settings, noise]);
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
    applyNoiseFilter(noise);
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
    // Files read before the reader hid any noise are compared from the cache: their reads will not run again.
    if (noiseFilterOn(noise))
      for (const { file } of planned) {
        if (viewed(file)) continue;
        const after = inspectionFiles.peekAfter(inspectionFileRequest(file.snapshot, file.file));
        if (after) compare(file, after, 'prefetch');
      }
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

/**
 * Moved and renamed symbols (#398) for every file of the open PRs, the ones a filter hides too: a hidden file can hold a
 * symbol's other end, or a rival. Files whose text is here are fingerprinted at once (lib/moved-symbols-store.ts); the
 * rest are read after the view's prefetch (rank 1, below the open PR's scope reads), in diff order, and fingerprinted as
 * they land. Viewed files are read too: the main prefetch leaves them to their view reads, but a move into them is
 * still a move. These reads count against a budget of their own (`MOVES_READS`), never the reads scopes need; they
 * pause and stop with the prefetch, and start again with it (`epoch`). A PR with more files to read than the prefetch
 * limit is left unmatched, as scopes leave it to view reads.
 */
export function useMovesPrefetch(owner: string, files: readonly SyntaxFile[], settings: CodeIntelligenceSettings) {
  const signature = files.map((file) => file.key).join('\n');
  const setting = JSON.stringify(settings);
  // Prefetch stops while the window is hidden; it starts again here as it does for scopes.
  const restart = useSyncExternalStore(
    (listener) => {
      epochListeners.add(listener);
      return () => epochListeners.delete(listener);
    },
    () => epoch
  );
  useEffect(() => {
    if (!settings.enabled || !files.length) return;
    const enabled = (path: string) => pathEnabled(settings, path);
    const byKey = new Map(files.map((file) => [`${file.snapshot.url}\u0000${file.file.path}`, file]));
    // The view holds its PRs while it shows them: they never leave the store meanwhile (lib/moved-symbols-core.ts).
    const { waiting, release } = trackMoves(files, enabled, (snapshot, file) => {
      const request = inspectionFileRequest(snapshot, file);
      const both = inspectionFiles.peek(request);
      return both ?? { after: inspectionFiles.peekAfter(request) };
    }, setting);
    if (!waiting.length || waiting.length > SYNTAX_PREFETCH_FILES) return release;
    // Files the store still wants get fresh tries: a moves read that ran out of them is queued again.
    for (const { snapshot, file } of waiting) {
      const entry = byKey.get(`${snapshot.url}\u0000${file.path}`);
      if (entry) syntaxContents.retry(entry.key + MOVES_KEY);
    }
    const jobs = waiting.flatMap(({ snapshot, file }): SyntaxContentsJob[] => {
      const entry = byKey.get(`${snapshot.url}\u0000${file.path}`);
      if (!entry) return [];
      // A budget per head: a force-push starts afresh.
      const budget = { name: `${MOVES_BUDGET}${snapshot.metadata.headSha}`, limit: MOVES_READS };
      const plan = syntaxContentsPlan(snapshot, file, enabled);
      // Only the text moves need: a modified file's new side (its old side is rebuilt from the patch), a deleted
      // file's old one. No breadcrumbs are parsed and no comparison made that no view asked for.
      if (plan) return [movesReadJob(entry, budget, file.status === 'deleted', plan.characters)];
      // An added or deleted file without a patch has no scope read: it is read whole, through the same queue.
      if (!movesWholeReadable(file)) {
        noteMovesFailure(snapshot, file, file.patch ? 'Not read' : 'Too large');
        return [];
      }
      return [movesReadJob(entry, budget, true)];
    });
    const stop = jobs.length ? syntaxContents.prefetch(`${owner}:moves`, jobs, 1) : undefined;
    return () => {
      stop?.();
      release();
    };
  }, [owner, signature, setting, restart]);
}

/** An added or deleted file without a patch that is not obviously too large to fingerprint. */
const movesWholeReadable = (file: PrChangeFile) =>
  !file.patch && (file.status === 'added' || file.status === 'deleted') && file.additions + file.deletions <= MOVES_WHOLE_LINES;

/**
 * A file's read for its moved symbols alone: the new side, or both sides when `both` (a deleted file's old side, an
 * added or deleted file without a patch). The text goes to the moves store and nowhere else.
 */
function movesReadJob(
  { key, snapshot, file }: SyntaxFile,
  budget: SyntaxContentsJob['budget'],
  both: boolean,
  characters?: number
): SyntaxContentsJob {
  const request = inspectionFileRequest(snapshot, file);
  return {
    key: key + MOVES_KEY,
    pr: snapshot.url,
    budget,
    characters,
    ready: () => {
      const contents = inspectionFiles.peek(request);
      const after = contents?.after ?? (both ? undefined : inspectionFiles.peekAfter(request));
      if (contents || after) noteMovesText(snapshot, file, after, contents?.before);
      return both ? !!contents : !!after;
    },
    run: async (tier) => {
      try {
        if (both) {
          const contents = await inspectionFiles.read(request, syntaxReadMode(tier));
          noteMovesText(snapshot, file, contents.after, contents.before);
        } else noteMovesText(snapshot, file, await inspectionFiles.readAfter(request, syntaxReadMode(tier)));
      } catch (error) {
        if (permanentFailure(error)) noteMovesFailure(snapshot, file, error instanceof Error ? error.message : String(error));
        throw error;
      }
    },
  };
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
 * The place is kept in `tier` and `onChange` hears of each change, so a file crossing the view while the reader
 * scrolls renders nothing: only a parse that still waits is told to move. Watched only while `enabled`, which a file
 * whose structure is parsed is not; it is `near` again while not watched.
 */
export function useViewTier(
  element: RefObject<HTMLElement | null>,
  enabled: boolean,
  tier: { current: SyntaxPriority },
  onChange: (tier: SyntaxPriority) => void
) {
  const changed = useRef(onChange);
  changed.current = onChange;
  useEffect(() => {
    const target = element.current;
    if (!enabled || !target || typeof IntersectionObserver === 'undefined') return;
    const root = target.closest(DIFF_SCROLLER);
    let onScreen = false,
      near = true;
    const update = () => {
      const next: SyntaxPriority = onScreen ? 'view' : near ? 'near' : 'prefetch';
      if (next === tier.current) return;
      tier.current = next;
      changed.current(next);
    };
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
      tier.current = 'near';
    };
  }, [enabled]);
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
  // For the browser checks (lib/test-settled.ts): whether the observer last said the file is near, and the file whose
  // read was asked for since it came near.
  const seenNear = useRef(false);
  const asked = useRef<string>(undefined);
  const wanted = useRef(want);
  wanted.current = want;
  useEffect(
    () =>
      registerSettled('structure-reads', () => {
        const target = element.current;
        const file = wanted.current;
        if (!file || !target?.isConnected || !syntaxContentsPlan(file.snapshot, file.file, allowed)) return true;
        const root = target.closest(DIFF_SCROLLER);
        if (!root) return true;
        // NEAR, from the layout as it is now: a viewport above and below the scroller.
        const box = root.getBoundingClientRect();
        const own = target.getBoundingClientRect();
        const near = own.bottom >= box.top - box.height && own.top <= box.bottom + box.height;
        if (near !== seenNear.current) return `${file.file.path} has not heard that it is ${near ? 'near' : 'away from'} the view`;
        if (near && asked.current !== file.key) return `${file.file.path} waits for a still view to ask for its read`;
        return true;
      }),
    []
  );
  // Contents another read brought in (the PR's opening reads, prefetch, another view) show as soon as they land.
  useEffect(() => {
    if (!want) return;
    const { key } = want;
    let show = () => {};
    const stop = syntaxContents.watch(key, () => {
      show();
      show = whenSettled(() => setResult({ key, state: 'done' }));
    });
    return () => {
      stop();
      show();
    };
  }, [want?.key]);
  useEffect(() => {
    const target = element.current;
    if (!active || !target || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        seenNear.current = entries[entries.length - 1].isIntersecting;
        setNear(seenNear.current);
      },
      { root: target.closest(DIFF_SCROLLER), rootMargin: NEAR }
    );
    observer.observe(target);
    return () => {
      observer.disconnect();
      seenNear.current = false;
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
      asked.current = key;
      traceStructure(key, { viewRequest: performance.now() });
      cancel = syntaxContents.request(
        syntaxContentsJob(want, plan),
        () => setResult({ key, state: 'done' }),
        (failure) => setResult({ key, state: failure.retryable ? 'failed' : 'refused' })
      );
    });
    return () => {
      asked.current = undefined;
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
