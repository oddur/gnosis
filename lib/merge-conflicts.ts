import { queueSignalKey, type QueueSignalRequest, type QueueSignals } from './queue-signals';

/**
 * Merge conflict state of one PR revision.
 * - `computing`: GitHub answered, but has not finished computing mergeability (`UNKNOWN`).
 * - `unchecked`: no saved status for this head SHA yet, or the read failed.
 */
export type MergeConflictState = 'conflicts' | 'clear' | 'computing' | 'unchecked';
/** States keyed by `url@headSha`, so a force-push never reuses an older revision's answer. */
export type MergeStates = ReadonlyMap<string, MergeConflictState>;

type Readiness = Pick<NonNullable<QueueSignals['readiness']>, 'mergeable' | 'mergeState'>;
/** GitHub reports conflicts through either field. `DIRTY` can arrive while `mergeable` is still `UNKNOWN`. */
export const hasMergeConflicts = (readiness: Readiness) =>
  readiness.mergeable === 'CONFLICTING' || readiness.mergeState === 'DIRTY';

export function mergeConflictState(signals: QueueSignals | undefined): MergeConflictState {
  const readiness = signals?.readiness;
  if (!readiness) return 'unchecked';
  if (hasMergeConflicts(readiness)) return 'conflicts';
  return readiness.mergeable === 'MERGEABLE' ? 'clear' : 'computing';
}

export function memberMergeState(member: QueueSignalRequest, states: MergeStates | undefined): MergeConflictState {
  return states?.get(queueSignalKey(member)) ?? 'unchecked';
}

/** One state per requested revision; values for other revisions are ignored. */
export function mergeStates(requests: readonly QueueSignalRequest[], values: readonly QueueSignals[]): MergeStates {
  const byKey = new Map(values.map((value) => [queueSignalKey(value), value]));
  return new Map(requests.map((request) => [queueSignalKey(request), mergeConflictState(byKey.get(queueSignalKey(request)))]));
}

/** Pending lookups, for the line that explains PRs the filter cannot place yet. */
export function countUnsettled(requests: readonly QueueSignalRequest[], states: MergeStates | undefined) {
  let computing = 0,
    unchecked = 0;
  for (const request of requests) {
    const state = memberMergeState(request, states);
    if (state === 'computing') computing++;
    else if (state === 'unchecked') unchecked++;
  }
  return { computing, unchecked };
}

const STATE_CODES: Record<MergeConflictState, string> = { conflicts: 'c', clear: 'm', computing: 'p', unchecked: 'u' };
const CODE_STATES = Object.fromEntries(Object.entries(STATE_CODES).map(([state, code]) => [code, state])) as Record<
  string,
  MergeConflictState
>;
/** A primitive snapshot: it changes only when a state changes, not on every status refresh. */
export function mergeStateSignature(requests: readonly QueueSignalRequest[], value: (request: QueueSignalRequest) => QueueSignals | undefined) {
  let signature = '';
  for (const request of requests) signature += STATE_CODES[mergeConflictState(value(request))];
  return signature;
}
export function parseMergeStateSignature(requests: readonly QueueSignalRequest[], signature: string): MergeStates {
  return new Map(requests.map((request, i) => [queueSignalKey(request), CODE_STATES[signature[i]] ?? 'unchecked']));
}

/** GitHub usually computes mergeability within seconds of a push or a base-branch change. */
export const MERGE_RECHECK_DELAY = 10_000;
