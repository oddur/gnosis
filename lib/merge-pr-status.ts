import type { PrStatus } from './types';
import { newerLifecycle } from './pr-lifecycle';
/** A slow summary read must not overwrite a newer pushed snapshot of the same revision. */
export function mergePrStatus(previous: PrStatus | undefined, next: PrStatus): PrStatus {
  if (!previous) return next;
  // A saved copy that arrives late never replaces a status GitHub already confirmed.
  if (next.stale && !previous.stale) return previous;
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
  const lifecycle = newerLifecycle(previous.lifecycle, next.lifecycle);
  // A slower read can return an older PR. Keep the newer full report.
  const metadata =
    previous.metadata && (!next.metadata || Date.parse(previous.metadata.updatedAt) > Date.parse(next.metadata.updatedAt))
      ? previous.metadata
      : next.metadata;
  return {
    ...next,
    ...(lifecycle ? { lifecycle } : {}),
    ...(metadata ? { metadata } : {}),
    signals,
    ciConclusion: signals?.checks.state ?? next.ciConclusion,
    checkSnapshot,
    ciChecks: checkSnapshot?.checks ?? next.ciChecks,
  };
}
