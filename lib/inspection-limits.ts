import type { PrChanges } from './pr-changes';

export const GITHUB_PR_FILE_LIMIT = 3000;
export const INVENTORY_MEMORY_BYTES = 32 * 1024 * 1024;
export const INVENTORY_PATCH_BYTES = 2 * 1024 * 1024;
export const FILE_PATCH_BYTES = 128 * 1024;

/** Keep paths and revision identities; large patches load as full files on demand. */
export function compactInventory(snapshot: PrChanges): PrChanges {
  let remaining = INVENTORY_PATCH_BYTES,
    deferred = false;
  const files = snapshot.files.map((file) => {
    if (!file.patch) return file;
    const bytes = file.patch.length * 2;
    if (bytes <= FILE_PATCH_BYTES && bytes <= remaining) {
      remaining -= bytes;
      return file;
    }
    deferred = true;
    return { ...file, patch: undefined };
  });
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- the map callback records omitted patches
  return deferred ? { ...snapshot, files, patchesDeferred: true } : snapshot;
}
