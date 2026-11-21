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

/**
 * The freshest status any account holds for a PR: for `headSha` when given, else for its newest-read revision.
 * Mergeability does not depend on who reads it, so the PR state icon can follow it without knowing the account.
 */
export function latestPrSignals(url: string, headSha?: string): QueueSignals | undefined {
  let latest: QueueSignals | undefined;
  for (const account of accounts.values()) {
    const values = headSha
      ? [account.entries.get(queueSignalKey({ url, headSha }))?.value]
      : [...account.entries.values()].map((entry) => (entry.value?.url === url ? entry.value : undefined));
    for (const value of values) if (value && (!latest || value.checkedAt > latest.checkedAt)) latest = value;
  }
  return latest;
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
