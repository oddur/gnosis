import type { IndexedHunk } from './diff-parse';
import type { DiffHunk } from './types';

/**
 * Which section shows each hunk (#560): the first section, in reading order, that lists it. Ownership is fixed before
 * the writers start, so it never depends on which writer finishes first. Hunks the diff doesn't have, and hunks left
 * out as noise, belong to no section. Values are section indexes (0-based).
 */
export function hunkOwners(
  sections: readonly (readonly string[] | undefined)[],
  known: ReadonlyMap<string, unknown>,
  excluded: ReadonlySet<string> | ReadonlyMap<string, unknown> = new Set()
): Map<string, number> {
  const owners = new Map<string, number>();
  sections.forEach((ids, index) => {
    for (const id of ids ?? []) if (known.has(id) && !excluded.has(id) && !owners.has(id)) owners.set(id, index);
  });
  return owners;
}

/** The hunks a section shows: those it lists and owns, once each, in its listed order. */
export function ownedHunkIds(ids: readonly string[], owners: ReadonlyMap<string, number>, index: number): string[] {
  return [...new Set(ids)].filter((id) => owners.get(id) === index);
}

/** Hunks a section lists that an earlier section shows, with that section's number (1-based), for its writer to read only. */
export function shownElsewhere(
  ids: readonly string[],
  owners: ReadonlyMap<string, number>,
  index: number
): Map<string, number> {
  const out = new Map<string, number>();
  for (const id of ids) {
    const owner = owners.get(id);
    if (owner !== undefined && owner !== index) out.set(id, owner + 1);
  }
  return out;
}

/** The sections (1-based, in order) that show hunks a section lists but doesn't own; empty when it owns them all. */
export function ownerSections(ids: readonly string[], owners: ReadonlyMap<string, number>, index: number): number[] {
  return [...new Set(shownElsewhere(ids, owners, index).values())].sort((a, b) => a - b);
}

/** Hunk IDs to the diff hunks a slide shows. */
export function resolveDiffHunks(ids: readonly string[], hunkMap: ReadonlyMap<string, IndexedHunk>): DiffHunk[] {
  return ids.flatMap((id) => {
    const h = hunkMap.get(id);
    return h
      ? [
          {
            filePath: h.filePath,
            hunkHeader: h.expandedHunkHeader,
            content: h.expandedContent,
            language: h.language,
            renderedHtml: '',
          },
        ]
      : [];
  });
}
