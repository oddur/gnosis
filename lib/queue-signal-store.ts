import { QUEUE_SIGNALS_TTL, queueSignalKey, type QueueSignalRequest, type QueueSignals } from './queue-signals';

export interface SignalEntry {
  value?: QueueSignals;
  expires: number;
  pending?: Promise<QueueSignals | undefined>;
}
export interface SignalBatchItem {
  request: QueueSignalRequest;
  resolve: (value: QueueSignals | undefined) => void;
}
export interface SignalAccount {
  entries: Map<string, SignalEntry>;
  batch: Map<string, SignalBatchItem>;
  timer?: ReturnType<typeof setTimeout>;
}

/** PR status per account, keyed by PR URL and head SHA. Shared by every row and the PR page. */
export const accounts = new Map<string, SignalAccount>();
/** Dispatches an event named after the account whenever its entries change. */
export const updates = new EventTarget();

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
  updates.dispatchEvent(new Event(scope));
}

const value = (scope: string, request: QueueSignalRequest) =>
  accounts.get(scope)?.entries.get(queueSignalKey(request))?.value;

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
