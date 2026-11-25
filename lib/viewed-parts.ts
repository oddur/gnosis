import { focusedApplied } from './explained-markers';
import type { DiffHunk, ReviewGuide } from './types';

/**
 * Viewed by parts (#564). With Focused sections, a file can show in several sections, each with its own part of the
 * file. A section's Viewed checkbox marks only its part as seen; the file becomes Viewed (the per-file mark shared with
 * Changes and GitHub) only when every part is seen and no code of the file is left out of the explanation. Until then
 * the file stays unviewed (fail closed). Seen parts are kept as unit IDs, per PR and head.
 *
 * Without Focused sections, or for an explanation made before them, there are no parts and Viewed works as before.
 */

/** A file's parts: each section's units of it (a slice ID, or a whole hunk's key), and whether code is left out. */
export interface FileParts {
  sections: { section: number; units: string[] }[];
  outside: boolean;
}

/** A unit's ID: its slice ID, or for a whole hunk, its file and header. */
export const unitId = (entry: Pick<DiffHunk, 'filePath' | 'hunkHeader' | 'sliceId'>) =>
  entry.sliceId ?? `${entry.filePath}\u0000${entry.hunkHeader}`;

const cache = new WeakMap<readonly unknown[], Map<string, FileParts>>();

/** Each file's parts across the explanation's sections. Undefined without Focused sections: nothing changes. */
export function explanationFileParts(
  review: Pick<ReviewGuide, 'slides' | 'focusedSections'> | undefined
): Map<string, FileParts> | undefined {
  if (!review || !focusedApplied(review)) return undefined;
  const saved = cache.get(review.slides);
  if (saved) return saved;
  const files = new Map<string, FileParts>();
  review.slides.forEach((slide, index) => {
    for (const entry of slide.diffHunks) {
      const file = files.get(entry.filePath) ?? { sections: [], outside: false };
      files.set(entry.filePath, file);
      let part = file.sections.find((p) => p.section === index + 1);
      if (!part) file.sections.push((part = { section: index + 1, units: [] }));
      const id = unitId(entry);
      if (!part.units.includes(id)) part.units.push(id);
    }
  });
  for (const code of review.focusedSections?.outside ?? []) {
    const file = files.get(code.filePath);
    if (file) file.outside = true;
    else files.set(code.filePath, { sections: [], outside: true });
  }
  cache.set(review.slides, files);
  return files;
}

const partSeen = (part: { units: string[] }, seen: ReadonlySet<string>) =>
  part.units.length > 0 && part.units.every((unit) => seen.has(unit));

/** How many of a file's parts are seen, and whether that makes the file Viewed. */
export function partsProgress(file: FileParts, seen: ReadonlySet<string>) {
  const count = file.sections.filter((part) => partSeen(part, seen)).length;
  const total = file.sections.length;
  return { seen: count, total, complete: total > 0 && count === total && !file.outside };
}

/** Whether a file needs the parts checkbox: more than one part, or code left out. One whole part works as before. */
export const usesParts = (file: FileParts | undefined): file is FileParts =>
  !!file && (file.sections.length > 1 || file.outside);

/**
 * What a section's checkbox shows. A Viewed file is checked in every section. Otherwise a section whose part is seen
 * is mixed (`aria-checked="mixed"`), and the label says how many parts are seen: "2 of 4 parts seen".
 */
export function partCheckbox(
  file: FileParts | undefined,
  section: number,
  seen: ReadonlySet<string>,
  viewed: boolean
): { checked: boolean; mixed: boolean; label?: string; outside?: boolean } {
  if (viewed || !usesParts(file)) return { checked: viewed, mixed: false };
  const part = file.sections.find((p) => p.section === section);
  const progress = partsProgress(file, seen);
  const label = `${progress.seen} of ${progress.total} ${progress.total === 1 ? 'part' : 'parts'} seen`;
  return {
    checked: false,
    mixed: !!part && partSeen(part, seen),
    label: file.outside ? `${label}, rest in Changes` : label,
    outside: file.outside || undefined,
  };
}

/**
 * A section's checkbox changed: the seen units after it, and the file's Viewed mark to set (`undefined` leaves it).
 * Checking sees the section's part, and views the file when that completes it. Unchecking unsees the part, and
 * un-views the file. A file without parts views and un-views as before.
 */
export function togglePart(
  file: FileParts | undefined,
  section: number,
  next: boolean,
  seen: ReadonlySet<string>,
  viewed: boolean
): { seen: Set<string>; viewed?: boolean } {
  const out = new Set(seen);
  const part = file?.sections.find((p) => p.section === section);
  for (const unit of part?.units ?? []) {
    if (next) out.add(unit);
    else out.delete(unit);
  }
  if (!usesParts(file)) return { seen: out, viewed: next === viewed ? undefined : next };
  if (!next) return { seen: out, viewed: viewed ? false : undefined };
  return { seen: out, viewed: !viewed && partsProgress(file, out).complete ? true : undefined };
}

/** The review state key of a PR's seen parts: per subject and head, so a new head starts with none, as Viewed does. */
export const viewedPartsKey = (subject: string, revision: string) => `gnosis-viewed-parts:${subject}:${revision}`;

/** Saved seen parts, kept only when they were saved for this head. */
export function readViewedParts(value: unknown, revision: string): Set<string> {
  const saved = (value ?? {}) as { revision?: unknown; units?: unknown };
  if (saved.revision !== revision || !Array.isArray(saved.units)) return new Set();
  return new Set(saved.units.filter((unit): unit is string => typeof unit === 'string'));
}
