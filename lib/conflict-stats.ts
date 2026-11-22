import type { ConflictFile, ConflictSession } from './conflict-resolution';
import { parseConflicts, type BlockPick } from './conflict-blocks';
import { blockBuckets, type Verdict } from './conflict-verify';
import { blockResolutions, withProposals } from './conflict-carry';
import { verdictKey } from './conflict-verdict-key';
import type { SyntaxLanguage } from './syntax-scope';

/**
 * Local counts of how Resolve conflicts' buckets fare (#445 item 2): how often you undo a Merged or Check proposal,
 * choose another option, or start a session over. They decide later whether verified Merged conflicts may skip review
 * by default. Counts only: no file content, paths, names or PRs, and nothing leaves this computer.
 */
export type StatsBucket = 'merged' | 'check' | 'decide';
export const STATS_BUCKETS: readonly StatsBucket[] = ['merged', 'check', 'decide'];
export interface BucketCounts {
  /** Conflicts in this bucket when a fresh preparation was opened. */
  shown: number;
  /** Pushed with Gnosis's proposal unchanged. Decide has no proposal, so it stays 0. */
  accepted: number;
  /** Undo that removed Gnosis's untouched proposal: for Merged, undoing an automatic merge. Once per conflict. */
  undone: number;
  /** Changed to a different option: a Keep over the proposal, or another Keep than before. Once per conflict. */
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
/**
 * A choice the renderer reports: which conflict of which draft, by its block fingerprint. The main process looks up the
 * conflict's saved bucket and counts it once (`markChoice`). Nothing of it is saved in the stats.
 */
export interface ConflictChoice {
  id: string;
  path: string;
  key: string;
  count: 'undone' | 'rechosen';
}
/** One conflict block's bucket as it was first shown, and whether it was counted as undone or re-chosen since. */
export interface StatsBlock {
  /** `blockFingerprints`: the block's three sides. */
  key: string;
  bucket: StatsBucket;
  undone?: true;
  rechosen?: true;
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
/** The renderer's choice, checked in the main process. Anything else is dropped. */
export function validChoice(value: unknown): ConflictChoice | undefined {
  const r = record(value);
  return typeof r.id === 'string' &&
    /^[a-f0-9]{64}$/.test(r.id) &&
    typeof r.path === 'string' &&
    r.path.length > 0 &&
    r.path.length <= 4096 &&
    typeof r.key === 'string' &&
    /^[a-z0-9]{1,8}:\d{1,9}$/.test(r.key) &&
    (r.count === 'undone' || r.count === 'rechosen')
    ? { id: r.id, path: r.path, key: r.key, count: r.count }
    : undefined;
}

const fnv = (text: string) => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  return `${(hash >>> 0).toString(36)}:${text.length}`;
};
/** Fingerprints by file version: computed once per `original`, never on each click. */
const fingerprints = new Map<string, readonly string[]>();
/**
 * A short fingerprint of each conflict block of a file (FNV-1a and length of its three sides, without Git's marker
 * labels), so a saved bucket counts only for the same conflict, also after the base branch moved or Load latest.
 */
export function blockFingerprints(original: string): readonly string[] {
  let keys = fingerprints.get(original);
  if (!keys) {
    keys = parseConflicts(original).flatMap((s) =>
      s.kind === 'conflict' ? [fnv(JSON.stringify([s.block.ours, s.block.base ?? null, s.block.theirs]))] : []
    );
    if (fingerprints.size >= 32) fingerprints.delete(fingerprints.keys().next().value as string);
    fingerprints.set(original, keys);
  }
  return keys;
}
/** The file's saved block, by index, while it belongs to the same conflict. */
export function savedStatsBlock(file: Pick<ConflictFile, 'original' | 'statsBlocks'>, index: number) {
  const block = file.statsBlocks?.[index];
  return block && block.key === blockFingerprints(file.original)[index] ? block : undefined;
}
/**
 * The main process's checks of the file as it is now (src/conflict-resolution-service.ts `check`). A copy: proposalKey
 * remembers its answer per object.
 */
const savedVerdict = (file: ConflictFile, disabled: readonly SyntaxLanguage[]): Verdict | undefined =>
  file.verdict && file.verdict.key === verdictKey({ ...file }, disabled) ? file.verdict.verdict : undefined;
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
 * You opened a session in the workspace. Each conflict block not counted yet gets its prepared bucket saved on its file
 * (`statsBlocks`) and counts as shown, so a reopen never counts it again. Load latest changes (`keep`) reuses the saved
 * block of each conflict that did not change, flags included, and counts only the changed ones. A fresh open counts as a
 * started session; Load latest never does. `before` is the draft before the open, needed only for keep and restart.
 */
export function countOpened(
  before: ConflictSession | undefined,
  session: ConflictSession,
  request: { restart: boolean; keep: boolean },
  disabled: readonly SyntaxLanguage[]
): { events: ConflictStatsEvent[]; changed: boolean } {
  const events: ConflictStatsEvent[] = [];
  if (session.status !== 'editing' || session.stale) return { events, changed: false };
  const earlier = new Map(request.keep ? (before?.files ?? []).map((f) => [f.path, f]) : []);
  const shown = new Map<StatsBucket, number>();
  let changed = false;
  // Set inside the map below: any conflict counted now, or counted before.
  const seen = { fresh: false, counted: false };
  for (const file of session.files) {
    const keys = blockFingerprints(file.original);
    if (!keys.length || file.unsupported) continue;
    // Saved blocks of this file and, with keep, of its earlier version, by fingerprint.
    const reusable = new Map<string, StatsBlock[]>();
    const old = earlier.get(file.path);
    for (const source of [file, ...(old ? [old] : [])])
      (source.statsBlocks ?? []).forEach((block, index) => {
        if (block && block.key === blockFingerprints(source.original)[index])
          reusable.set(block.key, [...(reusable.get(block.key) ?? []), block]);
      });
    let prepared: StatsBucket[] | null | undefined = null;
    const blocks = keys.map((key, index): StatsBlock | null => {
      const own = file.statsBlocks?.[index];
      if (own && own.key === key) {
        seen.counted = true;
        return own;
      }
      const reused = reusable.get(key)?.shift();
      if (reused) {
        seen.counted = true;
        return reused;
      }
      if (prepared === null) prepared = preparedBuckets(file, disabled);
      // Nothing proposed for it: Decide, whatever the checks of the file's other proposals say.
      const bucket = prepared?.[index] ?? (!file.wholeFile && !file.proposals?.[index] ? 'decide' : undefined);
      if (!bucket) return null;
      seen.fresh = true;
      shown.set(bucket, (shown.get(bucket) ?? 0) + 1);
      return { key, bucket };
    });
    if (JSON.stringify(blocks) !== JSON.stringify(file.statsBlocks ?? [])) {
      file.statsBlocks = blocks;
      changed = true;
    }
  }
  for (const bucket of STATS_BUCKETS) {
    const by = shown.get(bucket);
    if (by) events.push({ kind: 'bucket', bucket, count: 'shown', by });
  }
  if (seen.fresh && !seen.counted && !request.keep) events.push({ kind: 'session', count: 'started' });
  if (request.restart && !request.keep && before?.files.length) events.push({ kind: 'session', count: 'startedOver' });
  return { events, changed };
}
/**
 * A pushed merge commit: the session, and each conflict pushed with its proposal provably unchanged: its block splits
 * cleanly out of the result, its text is the proposal's, and you did not pick a Keep for it. A file whose result
 * cannot be split counts nothing, except a whole-file proposal pushed exactly as proposed, whose conflicts count as
 * accepted in Check.
 */
export function countPushed(session: ConflictSession): ConflictStatsEvent[] {
  let counted = false;
  const accepted = new Map<StatsBucket, number>();
  const add = (bucket: StatsBucket) => accepted.set(bucket, (accepted.get(bucket) ?? 0) + 1);
  for (const file of session.files) {
    const keys = blockFingerprints(file.original);
    const blocks = keys.map((_, index) => savedStatsBlock(file, index));
    if (!blocks.some(Boolean)) continue;
    counted = true;
    if (file.wholeFile && file.result === file.wholeFile.text) {
      for (const block of blocks) if (block) add('check');
      continue;
    }
    const texts = blockResolutions(parseConflicts(file.original), file.result);
    if (!texts) continue;
    blocks.forEach((block, index) => {
      const proposal = file.proposals?.[index];
      if (block && block.bucket !== 'decide' && proposal && texts[index] === proposal.text && !file.picks?.[index])
        add(block.bucket);
    });
  }
  if (!counted) return [];
  return [
    { kind: 'session', count: 'pushed' },
    ...[...accepted].map(([bucket, by]): ConflictStatsEvent => ({ kind: 'bucket', bucket, count: 'accepted', by })),
  ];
}

/**
 * What a choice in the workspace counts as. Undone: Undo removed Gnosis's untouched proposal. Re-chosen: a different
 * option than the one in place, a Keep or the proposal. Undoing your own Keep counts nothing.
 */
export function choiceEvent(
  before: BlockPick | undefined,
  after: BlockPick | undefined
): ConflictChoice['count'] | undefined {
  if (before === undefined) return undefined;
  if (after === undefined) return before === 'proposal' ? 'undone' : undefined;
  return after === before ? undefined : 'rechosen';
}
/**
 * Marks the choice on its saved block and returns the event to count, once per conflict: a block already counted as
 * undone (or re-chosen), or one that was never counted as shown, counts nothing. Changes `session` in place.
 */
export function markChoice(
  session: ConflictSession,
  choice: Omit<ConflictChoice, 'id'>
): ConflictStatsEvent | undefined {
  const file = session.files.find((f) => f.path === choice.path);
  if (!file) return undefined;
  const index = blockFingerprints(file.original).indexOf(choice.key);
  const block = index < 0 ? undefined : savedStatsBlock(file, index);
  if (!block || block[choice.count]) return undefined;
  block[choice.count] = true;
  return { kind: 'bucket', bucket: block.bucket, count: choice.count };
}
