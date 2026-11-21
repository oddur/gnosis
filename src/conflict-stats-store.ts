import type { StateStorage } from './app-data-store';
import {
  applyConflictStats,
  emptyConflictStats,
  normalizeConflictStats,
  type ConflictStats,
  type ConflictStatsEvent,
} from '../lib/conflict-stats';

/**
 * Settings › Diagnostics › Conflict resolution stats (#445 item 2). One record for the whole app, not per repository or
 * account: the counts judge the resolver, and a key per repository would have to be its name. It lives in the
 * app-data store, whose writes are coalesced in a worker, so a count never waits on the disk.
 */
export const CONFLICT_STATS_NAME = 'conflict-stats';
export function createConflictStatsStore(storage: Pick<StateStorage, 'read' | 'write'>) {
  let stats: ConflictStats | undefined;
  const load = () => (stats ??= normalizeConflictStats(storage.read(CONFLICT_STATS_NAME)));
  return {
    get(): ConflictStats {
      try {
        return structuredClone(load());
      } catch {
        // Saved data is still loading.
        return emptyConflictStats();
      }
    },
    /** Never throws: a count must not stop the action it counts. */
    record(events: readonly ConflictStatsEvent[]) {
      if (!events.length) return;
      try {
        stats = applyConflictStats(load(), events);
        storage.write(CONFLICT_STATS_NAME, stats);
      } catch (error) {
        console.warn('[conflicts] Could not count:', error instanceof Error ? error.message : String(error));
      }
    },
    reset(): ConflictStats {
      stats = emptyConflictStats();
      storage.write(CONFLICT_STATS_NAME, stats);
      return structuredClone(stats);
    },
  };
}
