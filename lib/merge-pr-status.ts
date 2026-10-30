import type { PrStatus } from './types';
/** A slow summary read must not overwrite a newer pushed snapshot of the same revision. */
export function mergePrStatus(previous: PrStatus | undefined, next: PrStatus): PrStatus {
  if (!previous) return next;
  const signals =
    previous.signals &&
    next.signals &&
    previous.signals.headSha === next.signals.headSha &&
    previous.signals.checkedAt > next.signals.checkedAt
      ? previous.signals
      : next.signals;
  const checkSnapshot =
    previous.checkSnapshot &&
    next.checkSnapshot &&
    previous.checkSnapshot.headSha === next.checkSnapshot.headSha &&
    previous.checkSnapshot.checkedAt > next.checkSnapshot.checkedAt
      ? previous.checkSnapshot
      : next.checkSnapshot;
  return {
    ...next,
    signals,
    ciConclusion: signals?.checks.state ?? next.ciConclusion,
    checkSnapshot,
    ciChecks: checkSnapshot?.checks ?? next.ciChecks,
  };
}
