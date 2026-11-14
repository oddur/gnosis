/**
 * The two reads notifications add: the own-PR status sweep and watch mode. Pure, so cadence and gating are
 * tested without timers. Both reads are automatic background work: charged to the 20 % automatic share.
 */
import type { QueueSignalRequest, QueueSignals } from './queue-signals';
import { mergeConflictState } from './merge-conflicts';

export const SWEEP_BATCH = 25;
/** Checks are running or GitHub is still computing mergeability. */
export const SWEEP_ACTIVE_MS = 120_000;
export const SWEEP_SETTLED_MS = 5 * 60_000;

/** One sweep interval per PR. A measured `rateLimit.cost` above 1 widens it by the same factor. */
export function sweepInterval(signals: QueueSignals | undefined, cost = 1): number {
  const active = !signals || signals.checks.state === 'pending' || mergeConflictState(signals) === 'computing';
  return (active ? SWEEP_ACTIVE_MS : SWEEP_SETTLED_MS) * Math.max(1, cost);
}
/** The PRs due for a status read, in batches of at most 25. A fresh visible-row read counts as a sweep. */
export function planSweep(input: {
  members: readonly QueueSignalRequest[];
  signals: (member: QueueSignalRequest) => QueueSignals | undefined;
  sweptAt: ReadonlyMap<string, number>;
  now: number;
  cost?: number;
}): QueueSignalRequest[][] {
  const due = input.members.filter((member) => {
    const signals = input.signals(member);
    const current = signals?.headSha === member.headSha ? signals : undefined;
    const last = Math.max(input.sweptAt.get(member.url) ?? 0, current?.checkedAt ?? 0);
    return input.now - last >= sweepInterval(current, input.cost);
  });
  const batches: QueueSignalRequest[][] = [];
  for (let i = 0; i < due.length; i += SWEEP_BATCH) batches.push(due.slice(i, i + SWEEP_BATCH).map(({ url, headSha }) => ({ url, headSha })));
  return batches;
}

/**
 * `sync`: a window is visible, the normal loop runs. `watch`: no window is visible, but desktop notifications are
 * on: personal searches and the own-PR sweep only. `off`: nothing runs.
 */
export type SyncMode = 'sync' | 'watch' | 'off';
export function syncMode(input: { signedIn: boolean; suspended: boolean; online: boolean; windowVisible: boolean; desktopNotifications: boolean }): SyncMode {
  if (!input.signedIn || input.suspended || !input.online) return 'off';
  if (input.windowVisible) return 'sync';
  return input.desktopNotifications ? 'watch' : 'off';
}
export const WATCH_INTERVAL_MS = 5 * 60_000;
export const WATCH_BATTERY_INTERVAL_MS = 10 * 60_000;
export const watchInterval = (onBattery: boolean) => (onBattery ? WATCH_BATTERY_INTERVAL_MS : WATCH_INTERVAL_MS);
