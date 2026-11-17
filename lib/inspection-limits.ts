import type { PrChanges } from './pr-changes';

export const GITHUB_PR_FILE_LIMIT = 3000;
export const INVENTORY_MEMORY_BYTES = 32 * 1024 * 1024;
export const INVENTORY_PATCH_BYTES = 2 * 1024 * 1024;
export const FILE_PATCH_BYTES = 128 * 1024;

/*
 * Renderer cache bounds (#355). Sizes are estimates at two bytes a character, so V8 holds about half of each for ASCII
 * text. Main keeps prepared inventories and file contents, so anything dropped here reloads over IPC, not GitHub.
 * A 2.3-hour session held 21 inventories (26.6 MB) and 128 files (12.3 MB) under the old 32 MB bounds.
 */
/** Inventories (changed files and commits) of the open PR and a few recent ones. */
export const RENDERER_INVENTORY_BYTES = 16 * 1024 * 1024;
export const RENDERER_INVENTORY_ENTRIES = 10;
/** Single-commit comparisons, as the Commits tab and its preparation read them. */
export const RENDERER_COMPARISON_BYTES = 8 * 1024 * 1024;
export const RENDERER_COMPARISON_ENTRIES = 24;
/** File contents (both sides) of opened and predicted files. */
export const RENDERER_FILE_BYTES = 16 * 1024 * 1024;
/** Parsed patch previews. */
export const RENDERER_PREVIEW_BYTES = 8 * 1024 * 1024;
export const RENDERER_PREVIEW_ENTRIES = 64;
/** Stack comparisons. */
export const RENDERER_STACK_BYTES = 8 * 1024 * 1024;
export const RENDERER_STACK_ENTRIES = 12;
/** A PR not read for this long leaves the renderer's caches. */
export const RENDERER_IDLE_MS = 15 * 60 * 1000;

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
