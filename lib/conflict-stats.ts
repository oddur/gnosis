import type { ConflictFile, ConflictSession } from './conflict-resolution';
import type { BlockPick, BlockPicks } from './conflict-blocks';
import { blockBuckets, type Verdict } from './conflict-verify';
import { conflictKeys, withProposals } from './conflict-carry';
import { verdictKey } from './conflict-verdict-key';
import type { SyntaxLanguage } from './syntax-scope';

/**
 * Local counts of how Resolve conflicts' buckets fare (#445 item 2): how often you undo a Merged, Check or Decide
 * conflict, choose another option, or start a session over. They decide later whether verified Merged conflicts may
 * skip review by default. Counts only: no file content, paths, names or PRs, and nothing leaves this computer.
 */
export type StatsBucket = 'merged' | 'check' | 'decide';
export const STATS_BUCKETS: readonly StatsBucket[] = ['merged', 'check', 'decide'];
export interface BucketCounts {
  /** Conflicts in this bucket when a fresh preparation was opened. */
  shown: number;
  /** Pushed with Gnosis's proposal unchanged. Decide has no proposal, so it stays 0. */
  accepted: number;
  /** Undo pressed on a conflict of this bucket: for Merged, undoing an automatic merge. Once per conflict and session. */
  undone: number;
  /** Changed to a different option: a Keep over the proposal, or another Keep than before. Once per conflict and session. */
  rechosen: number;
}
export interface SessionCounts {
  /** Fresh preparations with conflicts that you opened. */
  started: number;
  /** Start over with latest code. */
  startedOver: number;
  /** Merge commits pushed. */
  pushed: number;
}
export interface ConflictStats {
  version: 1;
  buckets: Record<StatsBucket, BucketCounts>;
  sessions: SessionCounts;
}
export type ConflictStatsEvent =
  | { kind: 'bucket'; bucket: StatsBucket; count: keyof BucketCounts; by?: number }
  | { kind: 'session'; count: keyof SessionCounts };
/** A choice the renderer reports. Shown, accepted and the session counts come from the main process only. */
export interface ConflictChoiceEvent {
  bucket: StatsBucket;
  count: 'undone' | 'rechosen';
}

/** Every counter stops here: running counts, so the saved state never grows. */
export const STATS_CAP = 1_000_000_000;
const BUCKET_KEYS: readonly (keyof BucketCounts)[] = ['shown', 'accepted', 'undone', 'rechosen'];
const SESSION_KEYS: readonly (keyof SessionCounts)[] = ['started', 'startedOver', 'pushed'];
const count = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.min(Math.floor(value), STATS_CAP) : 0;
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

export function emptyConflictStats(): ConflictStats {
  return normalizeConflictStats(undefined);
}
/** Only the known counters, each a whole number from 0 to STATS_CAP. Anything else in the saved value is dropped. */
export function normalizeConflictStats(value: unknown): ConflictStats {
  const saved = record(value);
  const buckets = record(saved.buckets);
  const sessions = record(saved.sessions);
  return {
    version: 1,
    buckets: Object.fromEntries(
      STATS_BUCKETS.map((bucket) => {
        const counts = record(buckets[bucket]);
        return [bucket, Object.fromEntries(BUCKET_KEYS.map((key) => [key, count(counts[key])]))];
      })
    ) as unknown as Record<StatsBucket, BucketCounts>,
    sessions: Object.fromEntries(SESSION_KEYS.map((key) => [key, count(sessions[key])])) as unknown as SessionCounts,
  };
}
export function applyConflictStats(stats: ConflictStats, events: readonly ConflictStatsEvent[]): ConflictStats {
  const next = normalizeConflictStats(stats);
  for (const event of events) {
    if (event.kind === 'session') {
      if (SESSION_KEYS.includes(event.count)) next.sessions[event.count] = count(next.sessions[event.count] + 1);
    } else if (STATS_BUCKETS.includes(event.bucket) && BUCKET_KEYS.includes(event.count)) {
      const counts = next.buckets[event.bucket];
      counts[event.count] = count(counts[event.count] + count(event.by ?? 1));
    }
  }
  return next;
}
/** Merged conflicts undone per Merged conflict shown, from 0 to 1. Undefined before any Merged conflict was shown. */
export function mergedUndoRate(stats: ConflictStats): number | undefined {
  const { shown, undone } = stats.buckets.merged;
  return shown ? Math.min(1, undone / shown) : undefined;
}
/** The renderer's choice events, checked in the main process. Anything else is dropped. */
export function validChoiceEvents(value: unknown): ConflictChoiceEvent[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 64).flatMap((item) => {
    const event = record(item);
    return STATS_BUCKETS.includes(event.bucket as StatsBucket) && (event.count === 'undone' || event.count === 'rechosen')
      ? [{ bucket: event.bucket as StatsBucket, count: event.count }]
      : [];
  });
}

/**
 * A short fingerprint of a file's conflict blocks (FNV-1a and length of their text, without Git's marker labels), so
 * saved buckets count only for the same conflicts, also after the base branch moved.
 */
export function conflictFingerprint(original: string) {
  const text = conflictKeys(original);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  return `${(hash >>> 0).toString(36)}:${text.length}`;
}
/** The file's saved bucket for each conflict, while they belong to its current conflict. */
export function savedStatsBuckets(file: Pick<ConflictFile, 'original' | 'statsBuckets'>) {
  const saved = file.statsBuckets;
  return saved && saved.key === conflictFingerprint(file.original) ? saved.buckets : undefined;
}
/** The main process's checks of the file as it is now (src/conflict-resolution-service.ts `check`). A copy: proposalKey
 * remembers its answer per object. */
const savedVerdict = (file: ConflictFile, disabled: readonly SyntaxLanguage[]): Verdict | undefined =>
  file.verdict && file.verdict.key === verdictKey({ ...file }, disabled) ? file.verdict.verdict : undefined;
const savedPicks = (file: ConflictFile): BlockPicks | undefined => file.picks?.map((pick) => pick ?? undefined);
/**
 * Each conflict's bucket as preparation left it: its proposal checked (Merged), its proposal unchecked or a whole-file
 * proposal (Check), or nothing proposed (Decide). Undefined while the checks have not run, or for a file Gnosis
 * cannot write as text.
 */
export function preparedBuckets(file: ConflictFile, disabled: readonly SyntaxLanguage[]): StatsBucket[] | undefined {
  if (file.unsupported) return undefined;
  const verdict = savedVerdict(file, disabled);
  if ((file.proposals || file.wholeFile) && !verdict) return undefined;
  // The draft as prepared: proposals in place, and none of your choices.
  const prepared: ConflictFile = {
    ...file,
    result: file.proposals ? withProposals(file.original, file.proposals) : file.original,
  };
  const buckets = blockBuckets(prepared, prepared.result, verdict);
  return buckets.every((b) => b !== 'decided') ? (buckets as StatsBucket[]) : undefined;
}

/**
 * You opened a session in the workspace. Each file whose conflicts have not been counted gets its prepared buckets
 * saved on it (`statsBuckets`) and counted as shown, so a reopen never counts them again. A fresh preparation counts as
 * a started session. Load latest changes keeps the buckets of conflicts that did not change. Returns whether a file
 * changed.
 */
export function countOpened(
  before: ConflictSession | undefined,
  session: ConflictSession,
  request: { restart: boolean; keep: boolean },
  disabled: readonly SyntaxLanguage[]
): { events: ConflictStatsEvent[]; changed: boolean } {
  const events: ConflictStatsEvent[] = [];
  if (session.status !== 'editing' || session.stale) return { events, changed: false };
  const earlier = new Map((before?.files ?? []).map((f) => [f.path, f]));
  let changed = false;
  let counted = false;
  let fresh = false;
  for (const file of session.files) {
    if (savedStatsBuckets(file)) {
      counted = true;
      continue;
    }
    const old = request.keep ? earlier.get(file.path) : undefined;
    const kept = old ? savedStatsBuckets(old) : undefined;
    if (old?.statsBuckets && kept && old.statsBuckets.key === conflictFingerprint(file.original)) {
      file.statsBuckets = { key: old.statsBuckets.key, buckets: kept };
      changed = counted = true;
      continue;
    }
    const buckets = preparedBuckets(file, disabled);
    if (!buckets?.length) continue;
    file.statsBuckets = { key: conflictFingerprint(file.original), buckets };
    changed = fresh = true;
    for (const bucket of STATS_BUCKETS) {
      const by = buckets.filter((b) => b === bucket).length;
      if (by) events.push({ kind: 'bucket', bucket, count: 'shown', by });
    }
  }
  // A session counts as started once: when the first of its files is counted.
  if (fresh && !counted) events.push({ kind: 'session', count: 'started' });
  if (request.restart && !request.keep && before?.files.length) events.push({ kind: 'session', count: 'startedOver' });
  return { events, changed };
}
/** A pushed merge commit: the session, and each conflict pushed with its proposal unchanged. */
export function countPushed(session: ConflictSession, disabled: readonly SyntaxLanguage[]): ConflictStatsEvent[] {
  let counted = false;
  const accepted = new Map<StatsBucket, number>();
  for (const file of session.files) {
    const prepared = savedStatsBuckets(file);
    if (!prepared) continue;
    counted = true;
    const final = blockBuckets(file, file.result, savedVerdict(file, disabled), savedPicks(file));
    prepared.forEach((bucket, index) => {
      // Merged or Check at the push: the proposal is still in place, unchanged.
      if (bucket !== 'decide' && (final[index] === 'merged' || final[index] === 'check'))
        accepted.set(bucket, (accepted.get(bucket) ?? 0) + 1);
    });
  }
  if (!counted) return [];
  return [
    { kind: 'session', count: 'pushed' },
    ...[...accepted].map(([bucket, by]): ConflictStatsEvent => ({ kind: 'bucket', bucket, count: 'accepted', by })),
  ];
}

/** What a choice in the workspace counts as: Undo of a choice or a proposal, or a different option than before. */
export function choiceEvent(
  before: BlockPick | undefined,
  after: BlockPick | undefined
): ConflictChoiceEvent['count'] | undefined {
  if (before === undefined) return undefined;
  if (after === undefined) return 'undone';
  return after === before ? undefined : 'rechosen';
}
/**
 * Counts the workspace's choices for one window: each conflict's bucket is the one it had when you first chose in it
 * (the saved one when the main process counted it as shown), and each conflict counts as undone or re-chosen at most
 * once per session. What it remembers stays in memory; only a bucket and a counter name are sent.
 */
export function createChoiceCounter(send: (events: ConflictChoiceEvent[]) => void) {
  const seen = new Map<string, { bucket: StatsBucket; counted: Set<ConflictChoiceEvent['count']> }>();
  return {
    choice(
      file: Pick<ConflictFile, 'path' | 'original' | 'statsBuckets'>,
      index: number,
      before: BlockPick | undefined,
      after: BlockPick | undefined,
      live: StatsBucket
    ) {
      const key = JSON.stringify([file.path, conflictFingerprint(file.original), index]);
      let entry = seen.get(key);
      if (!entry) seen.set(key, (entry = { bucket: savedStatsBuckets(file)?.[index] ?? live, counted: new Set() }));
      const count = choiceEvent(before, after);
      if (!count || entry.counted.has(count)) return;
      entry.counted.add(count);
      try {
        send([{ bucket: entry.bucket, count }]);
      } catch {
        // A count never stops the choice.
      }
    },
    /** Start over: a fresh merge, so its conflicts count again. */
    clear() {
      seen.clear();
    },
  };
}
