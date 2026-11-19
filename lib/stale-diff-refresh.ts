import type { PrFileRequest } from './pr-changes';
import type { LineEndings } from './diff-gaps';

/**
 * A diff whose loaded contents do not match its patch recovers by itself (useDiffFileModel, for Changes and
 * Explanation topics alike): the PR's changes are refreshed, the file's saved contents dropped, and both read again.
 *
 * - Reports of one PR are batched: the files that go stale within `delayMs` of each other share one refresh.
 * - Each file revision gets one automatic attempt, keyed by the PR, its head and the file's revision key, so a file
 *   that still does not match never refreshes again by itself. The reader's Refresh starts another.
 * - Automatic refreshes are never interactive: they run at the view tier, as structure loading does (#403).
 */
export interface StaleTarget {
  /** Where the file's contents are read from: the PR, path and revision the diff shows. */
  request: PrFileRequest;
  /** The view's revision key for the file (changeFileKey or fileRevisionKey). */
  fileKey: string;
  /** The view had both sides loaded, so both read again; otherwise the after side alone. */
  both: boolean;
  /**
   * The diff's revision cannot move: an Explanation topic shows the revision it was written against. Its contents are
   * read again whatever revision the refresh finds.
   */
  pinned: boolean;
}
export interface Revision {
  baseSha: string;
  headSha: string;
}
/** A file that still did not match its patch after its refresh, for the diagnostics export. */
export interface StaleMismatch {
  at: number;
  url: string;
  path: string;
  headSha: string;
  /** The first new line that differs, or the line after the patch's last when the file has more lines. */
  line?: number;
  /** How the patch and the file end their lines, and whether the two differ in that. */
  patch: LineEndings;
  file: LineEndings;
  lineEndingsDiffer: boolean;
}
/** `refreshing` until the refresh and the read after it finish, then `done`: what still differs is a real mismatch. */
export type StaleAttempt = 'refreshing' | 'done';
export interface StaleRefreshDeps {
  /**
   * Reloads the PR's changes, listing again the files at `revision` whose contents did not match, and resolves to the
   * revision the view now shows. Interactive only for the reader's own Refresh.
   */
  refresh: (url: string, revision: Revision, paths: string[], interactive: boolean) => Promise<Revision | undefined>;
  /** Drops what the renderer holds for the file. */
  drop: (request: PrFileRequest) => void;
  /** Reads the file again, at the view tier (or interactive), so the view finds it in the cache. */
  reread: (request: PrFileRequest, both: boolean, interactive: boolean) => Promise<unknown>;
  delayMs?: number;
  /** The longest a batch waits while reports keep arriving. */
  maxDelayMs?: number;
  schedule?: (run: () => void, ms: number) => () => void;
  now?: () => number;
}
const MISMATCHES = 50;
const ATTEMPTS = 2000;

/**
 * What a diff's gap bars say about its contents: `refreshing` from the moment a refreshable file goes stale until its
 * attempt is done, `mismatch` (with the reader's Refresh) when it is still stale after that, and `stale` for a view
 * that cannot refresh (a local review). Undefined when the contents match.
 */
export function staleStatus(
  stale: boolean,
  refreshable: boolean,
  attempt: StaleAttempt | undefined
): 'refreshing' | 'mismatch' | 'stale' | undefined {
  if (refreshable && attempt === 'refreshing') return 'refreshing';
  if (!stale) return undefined;
  if (!refreshable) return 'stale';
  return attempt === 'done' ? 'mismatch' : 'refreshing';
}
export const staleAttemptKey = (target: Pick<StaleTarget, 'request' | 'fileKey'>) =>
  `${target.request.url}\n${target.request.headSha}\n${target.fileKey}`;
const sameRevision = (a: Revision, b: Revision) => a.baseSha === b.baseSha && a.headSha === b.headSha;

export function createStaleDiffRefresh(deps: StaleRefreshDeps) {
  const delay = deps.delayMs ?? 300,
    maxDelay = deps.maxDelayMs ?? 1000;
  const schedule =
    deps.schedule ??
    ((run: () => void, ms: number) => {
      const timer = setTimeout(run, ms);
      return () => clearTimeout(timer);
    });
  const now = deps.now ?? Date.now;
  const attempts = new Map<string, StaleAttempt>();
  const recorded = new Set<string>();
  const mismatches: StaleMismatch[] = [];
  /** Reports waiting for their PR's refresh, the timer that runs it, and when the first one came. */
  const batches = new Map<string, { targets: Map<string, StaleTarget>; cancel: () => void; since: number }>();
  /** The refresh in flight for each PR: the next batch waits for it. */
  const running = new Map<string, Promise<void>>();
  const refreshers = new Map<string, ((url: string, revision: Revision, paths: string[], interactive: boolean) => Promise<Revision | undefined>)[]>();
  const listeners = new Set<() => void>();
  let refreshes = 0;
  const emit = () => listeners.forEach((listener) => listener());

  function set(key: string, value: StaleAttempt) {
    attempts.delete(key);
    attempts.set(key, value);
    while (attempts.size > ATTEMPTS) {
      const oldest = attempts.keys().next().value;
      if (oldest === undefined) break;
      attempts.delete(oldest);
      recorded.delete(oldest);
    }
  }

  async function run(url: string, targets: StaleTarget[], interactive: boolean) {
    // One refresh per revision; a PR's diffs show one revision, so this is one refresh.
    const revisions = new Map<string, StaleTarget[]>();
    for (const target of targets) {
      const id = `${target.request.baseSha}:${target.request.headSha}`;
      revisions.set(id, [...(revisions.get(id) ?? []), target]);
    }
    for (const group of revisions.values()) {
      const revision = { baseSha: group[0].request.baseSha, headSha: group[0].request.headSha };
      for (const target of group) deps.drop(target.request);
      refreshes++;
      const refresh = refreshers.get(url)?.at(-1) ?? deps.refresh;
      // A file of a commit or stack comparison is not in the PR's own list: its contents read again alone.
      const listed = group.filter((target) => !target.request.comparison && !target.request.stackComparison);
      const shown = listed.length
        ? await refresh(url, revision, [...new Set(listed.map((target) => target.request.path))], interactive).catch(() => undefined)
        : undefined;
      // A view that moved to a newer revision shows other files; the ones it left need no read.
      const reread = group.filter((target) => target.pinned || !shown || sameRevision(shown, revision) || target.request.comparison || target.request.stackComparison);
      await Promise.all(reread.map((target) => deps.reread(target.request, target.both, interactive).catch(() => undefined)));
      for (const target of group) set(staleAttemptKey(target), 'done');
      emit();
    }
  }

  function flush(url: string, interactive = false) {
    const batch = batches.get(url);
    if (!batch) return;
    batches.delete(url);
    batch.cancel();
    const previous = running.get(url) ?? Promise.resolve();
    const next = previous.then(() => run(url, [...batch.targets.values()], interactive));
    running.set(url, next);
    void next.finally(() => {
      if (running.get(url) === next) running.delete(url);
    });
  }

  function enqueue(target: StaleTarget, interactive: boolean) {
    const url = target.request.url;
    const key = staleAttemptKey(target);
    set(key, 'refreshing');
    const batch = batches.get(url);
    if (interactive) {
      batches.delete(url);
      batch?.cancel();
      const targets = new Map(batch?.targets ?? []);
      targets.set(key, target);
      batches.set(url, { targets, cancel: () => {}, since: now() });
      flush(url, true);
      emit();
      return;
    }
    const since = batch?.since ?? now();
    batch?.cancel();
    const targets = batch?.targets ?? new Map<string, StaleTarget>();
    targets.set(key, target);
    // Each report restarts the wait, up to `maxDelayMs` after the first.
    const wait = Math.max(0, Math.min(delay, since + maxDelay - now()));
    batches.set(url, { targets, since, cancel: schedule(() => flush(url), wait) });
    emit();
  }

  return {
    /** A file went stale. Starts its one automatic attempt, or does nothing when it had one. */
    report(target: StaleTarget) {
      if (attempts.has(staleAttemptKey(target))) return;
      enqueue(target, false);
    },
    /** The reader's Refresh, after the automatic attempt: refreshes now, at the interactive tier. */
    retry(target: StaleTarget) {
      recorded.delete(staleAttemptKey(target));
      enqueue(target, true);
    },
    attempt: (key: string): StaleAttempt | undefined => attempts.get(key),
    /** Records a file that still does not match after its refresh, once per attempt. */
    mismatch(key: string, value: Omit<StaleMismatch, 'at'>) {
      if (attempts.get(key) !== 'done' || recorded.has(key)) return;
      recorded.add(key);
      mismatches.push({ at: now(), ...value });
      if (mismatches.length > MISMATCHES) mismatches.shift();
    },
    /** The view that shows this PR's changes refreshes them as its own Update changes does, keeping the reader's place. */
    register(url: string, refresh: (url: string, revision: Revision, paths: string[], interactive: boolean) => Promise<Revision | undefined>) {
      refreshers.set(url, [...(refreshers.get(url) ?? []), refresh]);
      return () => {
        const rest = (refreshers.get(url) ?? []).filter((value) => value !== refresh);
        if (rest.length) refreshers.set(url, rest);
        else refreshers.delete(url);
      };
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /** For the diagnostics export: refreshes started, and the files that still did not match. */
    stats: () => ({ refreshes, attempts: attempts.size, mismatches: [...mismatches] }),
  };
}
export type StaleDiffRefresh = ReturnType<typeof createStaleDiffRefresh>;
