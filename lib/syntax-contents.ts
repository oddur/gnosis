import type { InspectionMode, PrChangeFile, PrChanges } from './pr-changes';
import { syntaxLanguage } from './syntax-scope';
import { imageMimeType } from './review-images';
import { pathFileKinds } from './file-kinds';

/**
 * Loads file contents for hunk scopes (#393). Most files of a large PR have only their patch in the renderer, and
 * scopes need the file around it. Two kinds of reads share one queue:
 *
 * - View reads, for files whose diff is in or near the view. They go first, newest first: the newest is the file the
 *   reader is looking at now. One that leaves the view before it starts is dropped.
 * - Prefetch reads, for every supported file of the open PR in diff order, and the first files of the predicted next
 *   PR after them. They run only when no view read waits, and pause while the reader scrolls or types, while the
 *   window is hidden, and during a rate limit. A view read for a file that waits as a prefetch takes it over.
 *
 * Reads go through the inspection file cache, so each revision is read once, and a read that started finishes and
 * stays cached. A view read goes to GitHub at foreground priority, ahead of queue preparation; a prefetch read goes in
 * the background. A view request for a file whose prefetch is running promotes it. Requests for the same file share
 * one read. A PR's cap counts distinct files, so reading a file again whose contents left the renderer's cache costs
 * nothing against it.
 *
 * A read that fails for a reason that can pass (a timeout, the network, a 5xx) is tried again after 1 s, 4 s and
 * 15 s. A file known to be too large, binary or missing, or whose last try failed, is not read again until its PR
 * leaves the inspection caches, or until the reader asks for it again (`retry`).
 */
export interface SyntaxContentsJob {
  /** One file revision. */
  key: string;
  /** The PR the file belongs to, for the per-PR cap. */
  pr: string;
  /** The least the file can be, in characters: the patch's after lines. Larger files are not read. */
  characters?: number;
  /** True when the contents are already cached: nothing is sent. */
  ready?: () => boolean;
  /**
   * Reads the file at the tier's priority. Called again with `'view'` while a prefetch read runs, when the view asks
   * for the file: the cache sends the higher-priority request, and main joins it to the read in flight.
   */
  run: (tier: SyntaxContentsTier) => Promise<unknown>;
}
/** Why a file has no contents for its scopes. A `retryable` read can be asked for again. */
export interface SyntaxContentsFailure {
  message: string;
  retryable: boolean;
}
/** One read, for the diagnostics export: how long it waited and ran, how many tries it took, and how it ended. */
export interface SyntaxContentsRead {
  key: string;
  tier: SyntaxContentsTier;
  /** From the request to the start of the first try. */
  queuedMs: number;
  /** From the start of the first try to the end of the last, retry waits included. */
  runMs?: number;
  attempts: number;
  outcome: 'running' | 'retrying' | 'done' | 'failed' | 'rate-limited' | 'dropped';
  /** Promoted from prefetch to a view read while it ran. */
  promoted?: boolean;
  error?: string;
}
export type SyntaxContentsTier = 'view' | 'prefetch';

export const SYNTAX_CONTENTS_CONCURRENCY = 2;
/** Distinct files read per PR, for view reads and prefetch together. */
export const SYNTAX_CONTENTS_PER_PR = 400;
/** A PR with more supported files than this is not prefetched; its files load as they come into view. */
export const SYNTAX_PREFETCH_FILES = 300;
/** Files of the predicted next PR warmed after the open PR's. */
export const SYNTAX_PREDICTED_FILES = 4;
/** The main process refuses text files over 1 MB, and the parser refuses more than 1,000,000 characters. */
export const SYNTAX_CONTENTS_MAX_CHARACTERS = 1_000_000;
const RATE_LIMIT_PAUSE_MS = 60_000;
/** Waits before the second, third and fourth tries of a read that failed for a reason that can pass. */
export const SYNTAX_CONTENTS_RETRY_MS: readonly number[] = [1_000, 4_000, 15_000];

/**
 * How a tier's read is scheduled in main: a view read at foreground priority (`'view'`: ahead of queue preparation,
 * never in the reader's interactive slots), a prefetch read in the background.
 */
export const syntaxReadMode = (tier: SyntaxContentsTier): InspectionMode => (tier === 'view' ? 'view' : true);

/**
 * Failures that trying again cannot fix: the file is too large, binary or not text, GitHub has no such file, or the
 * read is not allowed. Anything else, such as a timeout, a dropped connection or a 5xx, may pass.
 */
export function permanentFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /too large|binary file|no text preview|not UTF-8|not found|\b40[134]\b|\b41[05]\b|\b422\b|not available for this file|Preloading likely next pages is off|file list before opening/i.test(
    message
  );
}

/** When GitHub accepts requests again, for an error that is a rate limit or a paused budget; undefined otherwise. */
export function backoffUntil(error: unknown, now = Date.now()): number | undefined {
  const message = error instanceof Error ? error.message : String(error);
  // Electron keeps an error's message across IPC, not its properties.
  const resume = /GitHub requests can resume after (\S+?)\.?(?:\s|$)/.exec(message);
  if (resume) {
    const at = Date.parse(resume[1]);
    return Number.isFinite(at) && at > now ? at : now + RATE_LIMIT_PAUSE_MS;
  }
  if (/rate.?limit|API (?:allowance|limit)|GitHub allowance/i.test(message)) return now + RATE_LIMIT_PAUSE_MS;
  return undefined;
}

/**
 * What a changed file's scopes need read, from its patch: the after side, or both sides when a hunk only deletes
 * lines (scopes of deleted lines come from the old tree). Undefined for a file whose scopes cannot show or need no
 * read: added or deleted files, files without a patch (the view reads them whole), no grammar, images, generated
 * files, and files the patch alone shows to be too large.
 */
export function syntaxContentsPlan(
  snapshot: Pick<PrChanges, 'fileKinds'>,
  file: PrChangeFile,
  /** Whether a path's language is on in Settings (lib/code-intelligence.ts). */
  allowed: (path: string) => boolean = (path) => !!syntaxLanguage(path)
): { both: boolean; characters: number } | undefined {
  if (file.status === 'added' || file.status === 'deleted' || !file.patch) return;
  if (!syntaxLanguage(file.path) || !allowed(file.path) || imageMimeType(file.path)) return;
  if ((snapshot.fileKinds?.[file.path] ?? pathFileKinds(file.path)).generated.value) return;
  let characters = 0;
  // Per hunk: whether it deletes lines and whether it adds any. A hunk that only deletes needs the old side.
  const hunks: { deletes: boolean; adds: boolean }[] = [];
  for (const line of file.patch.split('\n')) {
    const hunk = hunks.at(-1);
    if (line.startsWith('@@')) hunks.push({ deletes: false, adds: false });
    else if (line.startsWith('-')) {
      if (hunk) hunk.deletes = true;
    } else if (line.startsWith('+')) {
      if (hunk) hunk.adds = true;
      characters += line.length;
    } else if (line.startsWith(' ')) characters += line.length;
  }
  if (characters > SYNTAX_CONTENTS_MAX_CHARACTERS) return;
  const old = file.previousPath ?? file.path;
  const both = hunks.some((hunk) => hunk.deletes && !hunk.adds) && !!syntaxLanguage(old) && allowed(old);
  return { both, characters };
}


interface Entry {
  job: SyntaxContentsJob;
  running: boolean;
  /** View requests waiting for this read, each with what to call if it fails. */
  waiters: Map<() => void, ((failure: SyntaxContentsFailure) => void) | undefined>;
  /** When the newest view request asked. */
  viewSeq: number;
  /** Prefetch owners that want this read, with its place in their order. */
  owners: Map<string, number>;
  /** Tries made so far; the next waits until `retryAt`. */
  attempts: number;
  retryAt: number;
  /** The tier of the running try. */
  tier?: SyntaxContentsTier;
  /** This read's diagnostics record, once its first try started. */
  record?: SyntaxContentsRead;
  queuedAt: number;
  startedAt?: number;
}

export function createSyntaxContentsScheduler({
  concurrency = SYNTAX_CONTENTS_CONCURRENCY,
  perPr = SYNTAX_CONTENTS_PER_PR,
  maxCharacters = SYNTAX_CONTENTS_MAX_CHARACTERS,
  retryMs = SYNTAX_CONTENTS_RETRY_MS,
  now = Date.now,
  setTimer = (run: () => void, ms: number) => setTimeout(run, ms),
}: {
  concurrency?: number;
  perPr?: number;
  maxCharacters?: number;
  retryMs?: readonly number[];
  now?: () => number;
  setTimer?: (run: () => void, ms: number) => unknown;
} = {}) {
  const entries = new Map<string, Entry>();
  const owners = new Map<string, Set<string>>();
  const started = new Map<string, Set<string>>();
  const failed = new Map<string, { pr: string } & SyntaxContentsFailure>();
  let pausedUntil = 0,
    prefetchPausedUntil = 0,
    hidden = false,
    timerAt = Infinity,
    seq = 0,
    reads = 0,
    retries = 0,
    promotions = 0,
    peak = 0;
  const log: SyntaxContentsRead[] = [];
  let running = 0;

  const wanted = (entry: Entry) => entry.waiters.size > 0 || entry.owners.size > 0;
  const capped = (job: SyntaxContentsJob) => {
    const keys = started.get(job.pr);
    return !keys?.has(job.key) && (keys?.size ?? 0) >= perPr;
  };
  const tooLarge = (job: SyntaxContentsJob) => job.characters !== undefined && job.characters > maxCharacters;
  /** Why a job is not read, or undefined when it may be. */
  const refusal = (job: SyntaxContentsJob): SyntaxContentsFailure | undefined => {
    const known = failed.get(job.key);
    if (known) return { message: known.message, retryable: known.retryable };
    if (tooLarge(job)) return { message: 'This file is too large to show its structure.', retryable: false };
    if (capped(job)) return { message: 'This PR read as many files for structure as it may.', retryable: false };
  };
  function drop(key: string, entry: Entry) {
    if (entries.get(key) !== entry) return;
    entries.delete(key);
    for (const owner of entry.owners.keys()) owners.get(owner)?.delete(key);
    if (entry.record?.outcome === 'retrying') entry.record.outcome = 'dropped';
  }
  /** Stops an owner's prefetch: its reads that have not started and nothing else wants are dropped. */
  function release(owner: string) {
    for (const key of owners.get(owner) ?? []) {
      const entry = entries.get(key);
      if (!entry) continue;
      entry.owners.delete(owner);
      if (!entry.running && !wanted(entry)) drop(key, entry);
    }
    owners.delete(owner);
  }
  function wake(at: number) {
    if (at >= timerAt) return;
    timerAt = at;
    setTimer(() => {
      timerAt = Infinity;
      pump();
    }, Math.max(0, at - now()));
  }
  /**
   * The next read: the newest view request, else the first prefetch in order when prefetch may run. A read waiting
   * to be tried again is left until its time.
   */
  function next(): [string, Entry] | undefined {
    let view: [string, Entry] | undefined, prefetch: [string, Entry] | undefined, order = Infinity;
    const at = now();
    let retryAt = Infinity;
    for (const item of entries) {
      const entry = item[1];
      if (entry.running) continue;
      if (entry.retryAt > at) {
        retryAt = Math.min(retryAt, entry.retryAt);
        continue;
      }
      if (entry.waiters.size) {
        if (!view || entry.viewSeq > view[1].viewSeq) view = item;
      } else
        for (const place of entry.owners.values())
          if (place < order) {
            order = place;
            prefetch = item;
          }
    }
    if (retryAt < Infinity) wake(retryAt);
    if (view) return view;
    if (!prefetch || hidden) return;
    if (at < prefetchPausedUntil) {
      wake(prefetchPausedUntil);
      return;
    }
    return prefetch;
  }
  function fail(key: string, entry: Entry, failure: SyntaxContentsFailure) {
    failed.set(key, { pr: entry.job.pr, ...failure });
    for (const onFail of entry.waiters.values()) onFail?.(failure);
  }
  function pump() {
    if (now() < pausedUntil) {
      wake(pausedUntil);
      return;
    }
    while (running < concurrency) {
      const item = next();
      if (!item) return;
      const [key, entry] = item;
      const { job } = entry;
      const refused = refusal(job);
      if (refused) {
        drop(key, entry);
        for (const onFail of entry.waiters.values()) onFail?.(refused);
        continue;
      }
      if (job.ready?.()) {
        drop(key, entry);
        for (const waiter of entry.waiters.keys()) waiter();
        continue;
      }
      let keys = started.get(job.pr);
      if (!keys) started.set(job.pr, (keys = new Set()));
      keys.add(key);
      const tier: SyntaxContentsTier = entry.waiters.size ? 'view' : 'prefetch';
      entry.running = true;
      entry.tier = tier;
      entry.attempts++;
      running++;
      reads++;
      peak = Math.max(peak, running);
      const at = now();
      entry.startedAt ??= at;
      if (entry.record) {
        entry.record.attempts = entry.attempts;
        entry.record.outcome = 'running';
        if (tier === 'view') entry.record.tier = 'view';
      } else {
        entry.record = { key, tier, queuedMs: at - entry.queuedAt, attempts: entry.attempts, outcome: 'running' };
        log.push(entry.record);
        if (log.length > 1000) log.shift();
      }
      const record = entry.record;
      let done = false;
      void job
        .run(tier)
        .then(
          () => {
            done = true;
            record.outcome = 'done';
          },
          (error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            record.error = message.slice(0, 200);
            const until = backoffUntil(error, now());
            if (until !== undefined) {
              // After a rate limit the file waits with the rest of the queue, and the try does not count.
              pausedUntil = Math.max(pausedUntil, until);
              entry.attempts--;
              record.outcome = 'rate-limited';
            } else if (permanentFailure(error)) {
              record.outcome = 'failed';
              fail(key, entry, { message, retryable: false });
            } else if (entry.attempts <= retryMs.length) {
              entry.retryAt = now() + retryMs[entry.attempts - 1];
              retries++;
              record.outcome = 'retrying';
            } else {
              record.outcome = 'failed';
              fail(key, entry, { message, retryable: true });
            }
          }
        )
        .finally(() => {
          running--;
          entry.running = false;
          entry.tier = undefined;
          record.runMs = now() - (entry.startedAt ?? now());
          if (done || failed.has(key) || !wanted(entry)) drop(key, entry);
          if (done) for (const waiter of entry.waiters.keys()) waiter();
          pump();
        });
    }
  }
  function entryFor(job: SyntaxContentsJob): Entry | SyntaxContentsFailure {
    const existing = entries.get(job.key);
    if (existing) return existing;
    const refused = refusal(job);
    if (refused) {
      if (tooLarge(job)) failed.set(job.key, { pr: job.pr, ...refused });
      return refused;
    }
    const entry: Entry = {
      job,
      running: false,
      waiters: new Map(),
      viewSeq: 0,
      owners: new Map(),
      attempts: 0,
      retryAt: 0,
      queuedAt: now(),
    };
    entries.set(job.key, entry);
    return entry;
  }
  const isEntry = (value: Entry | SyntaxContentsFailure): value is Entry => 'job' in value;

  return {
    /**
     * A view read. `onDone` runs when the read succeeds, and `onFail` when the file cannot be read: at once for a
     * file known to fail, too large, or past its PR's cap. The returned function withdraws the request, which drops a
     * read that has not started once nothing else wants it.
     */
    request(job: SyntaxContentsJob, onDone: () => void, onFail?: (failure: SyntaxContentsFailure) => void): () => void {
      const entry = entryFor(job);
      if (!isEntry(entry)) {
        onFail?.(entry);
        return () => {};
      }
      entry.waiters.set(onDone, onFail);
      entry.viewSeq = ++seq;
      // A prefetch read in flight is promoted: the cache sends the view's request, and main raises the read.
      if (entry.running && entry.tier === 'prefetch') {
        entry.tier = 'view';
        promotions++;
        if (entry.record) {
          entry.record.tier = 'view';
          entry.record.promoted = true;
        }
        void entry.job.run('view').catch(() => {});
      }
      // A read waiting to be tried again goes now: the reader is looking at it.
      if (!entry.running && entry.retryAt > now()) entry.retryAt = now();
      pump();
      return () => {
        entry.waiters.delete(onDone);
        if (!entry.running && !wanted(entry)) drop(job.key, entry);
      };
    },
    /**
     * Prefetch reads for `owner`, in order; `rank` orders owners (the open PR is 0). Replaces the owner's earlier
     * list. The returned function stops them: reads not started are dropped.
     */
    prefetch(owner: string, jobs: SyntaxContentsJob[], rank = 0): () => void {
      release(owner);
      const keys = new Set<string>();
      owners.set(owner, keys);
      jobs.forEach((job, index) => {
        const entry = entryFor(job);
        if (!isEntry(entry) || keys.has(job.key)) return;
        entry.owners.set(owner, rank * 1_000_000 + index);
        keys.add(job.key);
      });
      pump();
      return () => {
        if (owners.get(owner) === keys) release(owner);
      };
    },
    /** Why a file has no contents: its read failed, or it is too large. Undefined otherwise. */
    failure(key: string): SyntaxContentsFailure | undefined {
      const known = failed.get(key);
      return known && { message: known.message, retryable: known.retryable };
    },
    /** Forgets that a file's read failed, so the next request reads it again with a fresh set of tries. */
    retry(key: string) {
      if (failed.get(key)?.retryable) failed.delete(key);
    },
    /** Prefetch waits until `until`: the reader is scrolling or typing. */
    pausePrefetch(until: number) {
      prefetchPausedUntil = Math.max(prefetchPausedUntil, until);
    },
    /** Prefetch waits while the window is hidden. */
    setHidden(value: boolean) {
      hidden = value;
      if (!value) pump();
    },
    /** Drops every prefetch that has not started. */
    stopPrefetch() {
      for (const owner of [...owners.keys()]) release(owner);
    },
    /** Forgets these PRs' caps and failures, with the rest of their inspection data; every PR's without `prs`. */
    forget(prs?: ReadonlySet<string>) {
      for (const pr of [...started.keys()]) if (!prs || prs.has(pr)) started.delete(pr);
      for (const [key, failure] of failed) if (!prs || prs.has(failure.pr)) failed.delete(key);
    },
    /** For the diagnostics export and the browser checks. */
    stats: () => ({
      running,
      queued: [...entries.values()].filter((entry) => !entry.running).length,
      reads,
      retries,
      promotions,
      failed: failed.size,
      peak,
      pausedUntil,
      log: log.map((item) => ({ ...item })),
      started: Object.fromEntries([...started].map(([pr, keys]) => [pr, keys.size])),
    }),
  };
}

/** Reads that took this long from request to result are listed on their own in the diagnostics export. */
export const SLOW_SYNTAX_READ_MS = 2_000;
/** The queue for the diagnostics export: totals, slow reads, reads that failed or needed tries, and the latest. */
export function syntaxContentsDiagnostics(
  stats: ReturnType<ReturnType<typeof createSyntaxContentsScheduler>['stats']>
) {
  const { log, ...totals } = stats;
  return {
    ...totals,
    slow: log.filter((read) => read.queuedMs + (read.runMs ?? 0) >= SLOW_SYNTAX_READ_MS).slice(-30),
    troubled: log.filter((read) => read.outcome === 'failed' || read.attempts > 1).slice(-30),
    recent: log.slice(-50),
  };
}
