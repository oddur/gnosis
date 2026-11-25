import { focusedApplied } from './explained-markers';
import { sliceOwners } from './explanation-ranges';
import type { DiffHunk, ReviewGuide } from './types';

/**
 * Viewed by parts (#564). With Focused sections, a file can show in several sections, each with its own part of the
 * file. A section's Viewed checkbox marks only its part as seen; the file becomes Viewed (the per-file mark shared with
 * Changes and GitHub) only when every part is seen and no code of the file is left out of the explanation, by Focused
 * sections or as noise. Until then the file stays unviewed (fail closed). Seen parts are kept as unit IDs, per PR and
 * head.
 *
 * A moved definition's old copy is a part of its old file, owned by the section that shows the new copy: seeing that
 * section's part of the new copy's file sees it too (`linked`).
 *
 * Without Focused sections, or for an explanation made before them, there are no parts and Viewed works as before.
 */

/** A section's part of a file: its units, and units of other files it also covers (moved definitions' old copies). */
export interface FilePart {
  section: number;
  units: string[];
  linked?: { filePath: string; unit: string }[];
}

/** A file's parts: each section's units of it (a slice ID, or a whole hunk's key), and whether code is left out. */
export interface FileParts {
  sections: FilePart[];
  outside: boolean;
}

/** A unit's ID: its slice ID, or for a whole hunk, its file and header. */
export const unitId = (entry: Pick<DiffHunk, 'filePath' | 'hunkHeader' | 'sliceId'>) =>
  entry.sliceId ?? `${entry.filePath}\u0000${entry.hunkHeader}`;

/** A moved definition's old copy as a unit of its old file. */
export const movedUnitId = (move: { filePath: string; startLine: number; endLine: number }) =>
  `moved:${move.filePath}\u0000${move.startLine}-${move.endLine}`;

type Explanation = Pick<ReviewGuide, 'slides' | 'focusedSections' | 'noiseReduction'>;
const cache = new WeakMap<readonly unknown[], Map<string, FileParts>>();

/** Each file's parts across the explanation's sections. Undefined without Focused sections: nothing changes. */
export function explanationFileParts(review: Explanation | undefined): Map<string, FileParts> | undefined {
  if (!review || !focusedApplied(review)) return undefined;
  const saved = cache.get(review.slides);
  if (saved) return saved;
  const files = new Map<string, FileParts>();
  const fileOf = (filePath: string) => {
    const file = files.get(filePath) ?? { sections: [], outside: false };
    files.set(filePath, file);
    return file;
  };
  const partOf = (filePath: string, section: number) => {
    const file = fileOf(filePath);
    let part = file.sections.find((p) => p.section === section);
    if (!part) file.sections.push((part = { section, units: [] }));
    return part;
  };
  const addUnit = (part: FilePart, id: string) => {
    if (!part.units.includes(id)) part.units.push(id);
  };
  review.slides.forEach((slide, index) => {
    for (const entry of slide.diffHunks) addUnit(partOf(entry.filePath, index + 1), unitId(entry));
  });
  // Moved definitions' old copies: a part of the old file, owned by the new copy's section, and seen with it.
  for (const move of sliceOwners(review.slides).moves) {
    const id = movedUnitId(move);
    addUnit(partOf(move.filePath, move.section), id);
    if (move.to.filePath !== move.filePath) {
      const part = partOf(move.to.filePath, move.section);
      if (!part.linked?.some((l) => l.unit === id)) part.linked = [...(part.linked ?? []), { filePath: move.filePath, unit: id }];
    }
  }
  // Code no section shows, and code cut as noise, is finished in Changes.
  for (const code of review.focusedSections?.outside ?? []) fileOf(code.filePath).outside = true;
  for (const hunk of review.noiseReduction?.leftOut ?? []) fileOf(hunk.filePath).outside = true;
  for (const file of files.values()) file.sections.sort((a, b) => a.section - b.section);
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
export const usesParts = (file: FileParts | undefined): boolean => !!file && (file.sections.length > 1 || file.outside);

/** Whether a section's part of a file is seen: the file is Viewed, or (with parts) the section's units are all seen. */
export function sectionPartSeen(file: FileParts | undefined, section: number, seen: ReadonlySet<string>, viewed: boolean) {
  if (viewed) return true;
  const part = file && usesParts(file) ? file.sections.find((p) => p.section === section) : undefined;
  return !!part && partSeen(part, seen);
}

/**
 * What a section's checkbox shows. A Viewed file is checked in every section. Otherwise a section whose part is seen
 * is mixed (`aria-checked="mixed"`), and the label says how many parts are seen: "2 of 4 parts seen". A section that
 * owns no part of the file shows its Viewed mark read-only.
 */
export function partCheckbox(
  file: FileParts | undefined,
  section: number,
  seen: ReadonlySet<string>,
  viewed: boolean
): { checked: boolean; mixed: boolean; label?: string; outside?: boolean; readOnly?: boolean } {
  if (!file || !usesParts(file)) return { checked: viewed, mixed: false };
  const part = file.sections.find((p) => p.section === section);
  if (!part?.units.length) return { checked: viewed, mixed: false, readOnly: true };
  if (viewed) return { checked: true, mixed: false };
  const progress = partsProgress(file, seen);
  const label = `${progress.seen} of ${progress.total} ${progress.total === 1 ? 'part' : 'parts'} seen`;
  return {
    checked: false,
    mixed: partSeen(part, seen),
    label: file.outside ? `${label}, rest in Changes` : label,
    outside: file.outside || undefined,
  };
}

/**
 * A section's checkbox changed: the seen units after it, and the Viewed marks to set (files not in it are unchanged).
 * Checking sees the section's part (and the old copies it moved), and views each file that completes. Unchecking
 * unsees them, and un-views those files. A file without parts views and un-views as before.
 */
export function togglePart(
  files: ReadonlyMap<string, FileParts> | undefined,
  filePath: string,
  section: number,
  next: boolean,
  seen: ReadonlySet<string>,
  viewed: (filePath: string) => boolean
): { seen: Set<string>; viewed: Map<string, boolean> } {
  const out = new Set(seen);
  const marks = new Map<string, boolean>();
  const part = files?.get(filePath)?.sections.find((p) => p.section === section);
  for (const unit of [...(part?.units ?? []), ...(part?.linked ?? []).map((l) => l.unit)]) {
    if (next) out.add(unit);
    else out.delete(unit);
  }
  const settle = (path: string, own: boolean) => {
    const target = files?.get(path);
    const was = viewed(path);
    if (!target || !usesParts(target)) {
      // One whole part: the file's own box views and un-views it, as before; a moved copy's file follows its part.
      const change = own ? next !== was : !!target && (next ? !was && partsProgress(target, out).complete : was);
      if (change) marks.set(path, next);
      return;
    }
    if (!next && was) marks.set(path, false);
    else if (next && !was && partsProgress(target, out).complete) marks.set(path, true);
  };
  settle(filePath, true);
  for (const { filePath: other } of part?.linked ?? []) if (!marks.has(other)) settle(other, false);
  return { seen: out, viewed: marks };
}

/**
 * Files un-viewed elsewhere (in Changes, or on GitHub) lose their seen parts, so their boxes don't read "N of N" as
 * mixed. `unviewed` are the files whose Viewed mark went away without a section's checkbox.
 */
export function clearUnviewed(
  files: ReadonlyMap<string, FileParts> | undefined,
  seen: ReadonlySet<string>,
  unviewed: Iterable<string>
): Set<string> {
  const out = new Set(seen);
  for (const path of unviewed) for (const part of files?.get(path)?.sections ?? []) for (const unit of part.units) out.delete(unit);
  return out;
}

/** The review state key of a PR's seen parts: per subject and head, so a new head starts with none, as Viewed does. */
export const viewedPartsKey = (subject: string, revision: string) => `gnosis-viewed-parts:${subject}:${revision}`;

/** Seen parts as saved: the units seen, and the files that were Viewed when they were saved. */
export interface SavedParts {
  seen: Set<string>;
  viewed: Set<string>;
}

const strings = (value: unknown) =>
  new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);

/** Saved seen parts, kept only when they were saved for this head. */
export function readViewedParts(value: unknown, revision: string): SavedParts {
  const saved = (value ?? {}) as { revision?: unknown; units?: unknown; viewed?: unknown };
  if (saved.revision !== revision || !Array.isArray(saved.units)) return { seen: new Set(), viewed: new Set() };
  return { seen: strings(saved.units), viewed: strings(saved.viewed) };
}

/** The value saved for seen parts; null when none are seen. */
export const viewedPartsValue = (revision: string, parts: SavedParts) =>
  parts.seen.size ? { revision, units: [...parts.seen], viewed: [...parts.viewed] } : null;

/**
 * Seen parts against the files Viewed now. A file that was Viewed when the parts were saved and is not now was
 * un-viewed elsewhere (in Changes, on GitHub, or while the Explanation was closed): it loses its seen parts, so one
 * re-check can't view it again (fail closed). `pending` are this page's own Viewed changes not yet applied, with the
 * value they set: they count as done. The result's `viewed` is the explanation's files Viewed now, to save.
 */
export function reconcileParts(
  files: ReadonlyMap<string, FileParts> | undefined,
  saved: SavedParts,
  viewedNow: ReadonlySet<string>,
  pending: ReadonlyMap<string, boolean> = new Map()
): SavedParts {
  const isViewed = (path: string) => pending.get(path) ?? viewedNow.has(path);
  const unviewed = [...saved.viewed].filter((path) => !isViewed(path));
  const viewed = new Set([...(files?.keys() ?? [])].filter(isViewed));
  return { seen: unviewed.length ? clearUnviewed(files, saved.seen, unviewed) : saved.seen, viewed };
}
