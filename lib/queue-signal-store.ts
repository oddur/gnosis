import { QUEUE_SIGNALS_TTL, queueSignalKey, type QueueSignalRequest, type QueueSignals } from './queue-signals';

export interface SignalEntry {
  value?: QueueSignals;
  expires: number;
  pending?: Promise<QueueSignals | undefined>;
}
export interface SignalBatchItem {
  request: QueueSignalRequest;
  resolve: (value: QueueSignals | undefined) => void;
  /** Read at visible priority (`QueueSignalOptions.active`): the Overview while it is shown. */
  active?: boolean;
}
export interface SignalAccount {
  entries: Map<string, SignalEntry>;
  batch: Map<string, SignalBatchItem>;
  timer?: ReturnType<typeof setTimeout>;
}

/** PR status per account, keyed by PR URL and head SHA. Shared by every row and the PR page. */
export const accounts = new Map<string, SignalAccount>();
/** Dispatches an event named after the account whenever its entries change, and `ANY_SIGNALS` for every account. */
export const updates = new EventTarget();
/** Not a GitHub login, so it never collides with an account's event. */
export const ANY_SIGNALS = '*';
export function signalsChanged(scope: string) {
  updates.dispatchEvent(new Event(scope));
  updates.dispatchEvent(new Event(ANY_SIGNALS));
}

/** Per PR URL: the newest value any account read, and the head the queue last showed. Lookups stay O(1). */
const newest = new Map<string, QueueSignals>();
const heads = new Map<string, string>();
/** Index a stored value. Every write to an entry's `value` goes through here. */
export function noteSignals(value: QueueSignals) {
  const known = newest.get(value.url);
  if (!known || value.checkedAt >= known.checkedAt) newest.set(value.url, value);
}
/** The PRs' current heads from the queue snapshot, for icons whose copy has no head (a tab, a breadcrumb). */
export function notePrHeads(members: readonly QueueSignalRequest[]) {
  let changed = false;
  for (const { url, headSha } of members)
    if (headSha && heads.get(url) !== headSha) {
      heads.set(url, headSha);
      changed = true;
    }
  if (changed) updates.dispatchEvent(new Event(ANY_SIGNALS));
}

/**
 * The freshest status any account holds for a PR: for `headSha` when given; else for its current head when the queue
 * showed it (none yet: undefined, never an older head's answer); else for its newest-read revision. Mergeability
 * does not depend on who reads it, so the PR state icon can follow it without knowing the account.
 */
export function latestPrSignals(url: string, headSha?: string): QueueSignals | undefined {
  const head = headSha ?? heads.get(url);
  if (head) {
    let latest: QueueSignals | undefined;
    for (const account of accounts.values()) {
      const value = account.entries.get(queueSignalKey({ url, headSha: head }))?.value;
      if (value && (!latest || value.checkedAt > latest.checkedAt)) latest = value;
    }
    return latest;
  }
  return newest.get(url);
}

export function signalAccount(scope: string): SignalAccount {
  let account = accounts.get(scope);
  if (!account) {
    account = { entries: new Map(), batch: new Map() };
    accounts.set(scope, account);
  }
  return account;
}

/** Store status values. A value never replaces a newer one for the same PR revision. */
export function publishQueueSignals(scope: string, values: QueueSignals[]) {
  const account = signalAccount(scope);
  for (const value of values) {
    const key = queueSignalKey(value);
    const entry = account.entries.get(key);
    if (entry?.value && entry.value.checkedAt > value.checkedAt) continue;
    account.entries.set(key, { ...entry, value, expires: value.checkedAt + QUEUE_SIGNALS_TTL });
    noteSignals(value);
  }
  signalsChanged(scope);
}

/** The stored value for one PR revision. */
export const signalValue = (scope: string, request: QueueSignalRequest) =>
  accounts.get(scope)?.entries.get(queueSignalKey(request))?.value;
const value = signalValue;

/** The stored values for these PR revisions, in request order. Missing revisions are skipped. */
export function signalValues(scope: string, requests: readonly QueueSignalRequest[]): QueueSignals[] {
  return requests.flatMap((request) => value(scope, request) ?? []);
}

/**
 * A string that changes when any of these PR revisions gets a new value. It is cheap and primitive,
 * so a row can read it on every store event and render only when its own PRs change.
 */
export function signalStamp(scope: string, requests: readonly QueueSignalRequest[]): string {
  return requests.map((request) => value(scope, request)?.checkedAt).join();
}

/** Calls `listener` whenever the account's saved status changes. Returns a function that stops it. */
export function onQueueSignals(scope: string, listener: () => void) {
  updates.addEventListener(scope, listener);
  return () => updates.removeEventListener(scope, listener);
}
