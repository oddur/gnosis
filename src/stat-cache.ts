import fs from 'node:fs';

/**
 * Keeps one parsed file in memory. Each `get` checks the file's size and modification time and reads
 * it again only when either changed, so an external edit is still picked up. `read` receives whether
 * the file exists.
 */
export function createStatCache<T>(file: () => string, read: (exists: boolean) => T) {
  let cached: { path: string; mtimeMs: number; size: number; value: T } | undefined;
  const stamp = (path: string) => {
    const stat = fs.statSync(path, { throwIfNoEntry: false });
    return { exists: !!stat, mtimeMs: stat?.mtimeMs ?? -1, size: stat?.size ?? -1 };
  };
  return {
    get(): T {
      const path = file();
      // The stamp is taken before the read, so a change during the read is read again next time.
      const { exists, mtimeMs, size } = stamp(path);
      if (cached?.path === path && cached.mtimeMs === mtimeMs && cached.size === size) return cached.value;
      const value = read(exists);
      cached = { path, mtimeMs, size, value };
      return value;
    },
    /** Records a value that was just written to the file. */
    set(value: T) {
      const path = file();
      const { mtimeMs, size } = stamp(path);
      cached = { path, mtimeMs, size, value };
    },
    clear() {
      cached = undefined;
    },
  };
}
