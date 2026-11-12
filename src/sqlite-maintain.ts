import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

/**
 * Space reclaim for the saved-work database. `lib/sqlite-cache-worker.ts` repeats these steps in
 * its self-contained source; keep the two in step.
 */
export const MAINTAIN_LIMITS = {
  /** Free disk a conversion needs beyond twice the live data: VACUUM writes a copy and a WAL. */
  headroomBytes: 256 * 1024 * 1024,
  /** Pages per `incremental_vacuum` step: 8 MB of 4 KB pages. */
  stepPages: 2000,
  /** Start returning free pages at this much free space, and keep going until this little remains. */
  startFreeBytes: 16 * 1024 * 1024,
  keepFreeBytes: 4 * 1024 * 1024,
  walBytes: 16 * 1024 * 1024,
  /** The cache database converts only after this much user idle time. */
  idleSeconds: 60,
} as const;
/** Set once per session. A failed or refused conversion is not retried until the next launch. */
export interface MaintainState {
  vacuumSkipped?: boolean;
  draining?: boolean;
}
export interface MaintainResult {
  more: boolean;
  fileBytes: number;
  freeBytes: number;
  vacuumed?: boolean;
}
export const availableDiskBytes = (directory: string) => {
  const stats = fs.statfsSync(directory);
  return stats.bavail * stats.bsize;
};
const size = (file: string) => {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
};
const pragma = (db: DatabaseSync, name: string) => Number(Object.values(db.prepare(`PRAGMA ${name}`).get() ?? {})[0] ?? 0);

/**
 * One bounded step. An existing file converts to incremental auto-vacuum with one VACUUM, when
 * the disk has room; after that, each step returns at most 8 MB of free pages to the file system.
 * A crash during VACUUM leaves the original file and mode 0, so the next launch retries.
 */
export function maintainDatabase(
  db: DatabaseSync,
  file: string,
  options: { idleSeconds: number; requireIdle?: boolean; label: string },
  state: MaintainState,
  freeDisk: (directory: string) => number = availableDiskBytes
): MaintainResult {
  let more = false,
    vacuumed = false;
  const pageSize = pragma(db, 'page_size');
  if (pragma(db, 'auto_vacuum') !== 2) {
    if (!state.vacuumSkipped && (!options.requireIdle || options.idleSeconds >= MAINTAIN_LIMITS.idleSeconds)) {
      const live = (pragma(db, 'page_count') - pragma(db, 'freelist_count')) * pageSize;
      try {
        const available = freeDisk(path.dirname(file));
        if (available < 2 * live + MAINTAIN_LIMITS.headroomBytes) {
          state.vacuumSkipped = true;
          console.warn(
            `Not compacting ${options.label}: it needs ${Math.ceil((2 * live + MAINTAIN_LIMITS.headroomBytes) / 1048576)} MB free disk space.`
          );
        } else {
          db.exec('PRAGMA auto_vacuum=INCREMENTAL');
          db.exec('VACUUM');
          db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
          vacuumed = more = true;
        }
      } catch (error) {
        state.vacuumSkipped = true;
        console.warn(`Could not compact ${options.label}:`, error instanceof Error ? error.message : String(error));
      }
    }
  } else {
    const free = pragma(db, 'freelist_count') * pageSize;
    if (free >= MAINTAIN_LIMITS.startFreeBytes || (state.draining && free > MAINTAIN_LIMITS.keepFreeBytes)) {
      db.exec(`PRAGMA incremental_vacuum(${MAINTAIN_LIMITS.stepPages})`);
      state.draining = pragma(db, 'freelist_count') * pageSize > MAINTAIN_LIMITS.keepFreeBytes;
      more = state.draining;
    } else state.draining = false;
  }
  if (size(`${file}-wal`) > MAINTAIN_LIMITS.walBytes) db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  return {
    more,
    fileBytes: size(file) + size(`${file}-wal`),
    freeBytes: pragma(db, 'freelist_count') * pageSize,
    ...(vacuumed ? { vacuumed } : {}),
  };
}
