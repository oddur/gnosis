import type { StateStorage } from './app-data-store';
import {
  applyConflictStats,
  normalizeConflictStats,
  resetConflictStats,
  type ConflictStats,
  type ConflictStatsEvent,
} from '../lib/conflict-stats';

/**
 * Settings › Diagnostics › Conflict resolution stats (#445 item 2). One record for the whole app, not per repository or
 * account: the counts judge the resolver, and a key per repository would have to be its name. It lives in the
 * app-data store, whose writes are coalesced in a worker, so a count never waits on the disk.
 */
export const CONFLICT_STATS_NAME = 'conflict-stats';
export const STATS_LOADING = 'Saved data is still loading. Try again in a moment.';
export function createConflictStatsStore(storage: Pick<StateStorage, 'read' | 'write'>) {
  let stats: ConflictStats | undefined;
  /** Throws while saved data is not loaded, so nothing is ever written over counts not read yet. */
  const load = () => {
    if (stats) return stats;
    try {
      return (stats = normalizeConflictStats(storage.read(CONFLICT_STATS_NAME)));
    } catch {
      throw new Error(STATS_LOADING);
    }
  };
  /** Saved first; memory takes the new counts only once the write was accepted. */
  const save = (next: ConflictStats) => {
    storage.write(CONFLICT_STATS_NAME, next);
    stats = next;
    return structuredClone(next);
  };
  return {
    get: (): ConflictStats => structuredClone(load()),
    /** Never throws: a count must not stop the action it counts. */
    record(events: readonly ConflictStatsEvent[]) {
      if (!events.length) return;
      try {
        save(applyConflictStats(load(), events));
      } catch (error) {
        console.warn('[conflicts] Could not count:', error instanceof Error ? error.message : String(error));
      }
    },
    /** The current epoch (`ConflictStats.epoch`): throws while saved data is loading, so nothing counts then. */
    epoch: (): number => load().epoch ?? 0,
    /**
     * Refused while saved data is loading: Reset never writes zeros over counts it has not read. The next epoch starts,
     * so the conflicts drafts counted before count nothing more.
     */
    reset(): ConflictStats {
      return save(resetConflictStats(load()));
    },
  };
}
