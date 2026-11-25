import { hunkRows, outsideLines, rangeRows, shortSliceNames, type Row } from './explanation-ranges';
import type { DiffHunk, ReviewGuide } from './types';

/**
 * Focused sections (#564): where Changes says which section explains each part of a file. Changes still shows every
 * line; a marker is a slim note at the first changed line of a unit (a slice, or a whole hunk):
 * - `section`: "Explained in section N ↗", for code a section shows;
 * - `outside`: "Left out of the explanation", for code no section shows (`focusedSections.outside`);
 * - `moved`: "Moved: explained with X ↗", on a moved definition's old copy, whose new copy a section shows.
 *
 * Only an explanation made with Focused sections applied has markers. Everything here is pure, and computed once per
 * explanation (kept per slides array).
 */
export interface ExplainedMarker {
  kind: 'section' | 'outside' | 'moved';
  /** The unit's first changed line, on its side, in that side's numbers from 1. */
  side: 'before' | 'after';
  start: number;
  /** The section (1-based) and its slide that show the unit, or its moved new copy. */
  section?: number;
  slideId?: string;
  /** The unit's symbol names, such as `fn flush`. */
  names: string[];
  /** Where the section shows it: the explanation's file path and a line there. */
  target?: { filePath: string; line: number; side: 'LEFT' | 'RIGHT' };
}

type Focused = Pick<ReviewGuide, 'slides' | 'focusedSections'>;

/** True when the explanation was made with Focused sections, and slicing ran (not the single-shot path). */
export const focusedApplied = (review: Focused | undefined): boolean =>
  !!review?.focusedSections && review.focusedSections.applied !== false;

const changed = (row: Row) => row.marker === '+' || row.marker === '-';

/** The changed rows an entry shows: its ranges' rows, or the whole hunk's. Undefined when they can't be read. */
function entryRows(entry: DiffHunk): Row[] | undefined {
  const parsed = hunkRows(entry);
  if (!parsed) return undefined;
  if (!entry.lineRanges?.length) return parsed.rows.filter(changed);
  const rows = rangeRows(entry.lineRanges, parsed.rows.length);
  if (!rows) return undefined;
  return [...rows]
    .sort((a, b) => a - b)
    .map((i) => parsed.rows[i])
    .filter(changed);
}

/** A unit's first changed row as a place: a deleted row's old line, an added row's new line. */
const placeOf = (row: Row) =>
  row.marker === '-' ? { side: 'before' as const, start: row.old } : { side: 'after' as const, start: row.new };

/** Where a section's jump lands: the unit's first added line, else its first deleted line. */
function targetOf(filePath: string, rows: Row[]) {
  const added = rows.find((row) => row.marker === '+');
  return added
    ? { filePath, line: added.new, side: 'RIGHT' as const }
    : { filePath, line: rows[0].old, side: 'LEFT' as const };
}

const cache = new WeakMap<readonly unknown[], Map<string, ExplainedMarker[]>>();

/**
 * The markers of an explanation, per file (the explanation's file path), in line order on each side. Undefined when
 * the explanation has no Focused sections, so Changes shows nothing new. One marker per place: a slice, a moved old
 * copy or left-out code wins over a whole hunk that overlaps it (the planner lists each unit once; this keeps an old
 * entry from hiding the focused ones).
 */
export function explainedMarkers(review: Focused | undefined): Map<string, ExplainedMarker[]> | undefined {
  if (!review || !focusedApplied(review)) return undefined;
  const saved = cache.get(review.slides);
  if (saved) return saved;
  const focused = new Map<string, ExplainedMarker[]>();
  const add = (map: Map<string, ExplainedMarker[]>, filePath: string, marker: ExplainedMarker) => {
    const list = map.get(filePath) ?? [];
    if (!list.some((m) => m.side === marker.side && m.start === marker.start)) list.push(marker);
    map.set(filePath, list);
  };
  const wholes: { entry: DiffHunk; rows: Row[]; section: number; slideId: string }[] = [];
  review.slides.forEach((slide, index) => {
    const section = index + 1;
    for (const entry of slide.diffHunks) {
      const rows = entryRows(entry);
      if (!rows?.length) continue;
      const names = shortSliceNames(entry.label);
      const target = targetOf(entry.filePath, rows);
      if (entry.lineRanges?.length || entry.sliceId)
        add(focused, entry.filePath, { kind: 'section', ...placeOf(rows[0]), section, slideId: slide.id, names, target });
      else wholes.push({ entry, rows, section, slideId: slide.id });
      if (entry.movedFrom)
        add(focused, entry.movedFrom.filePath, {
          kind: 'moved',
          side: 'before',
          start: entry.movedFrom.startLine,
          section,
          slideId: slide.id,
          names: names.length ? names : (entry.movedFrom.renamed ? [entry.movedFrom.renamed.to] : []),
          target,
        });
    }
  });
  for (const code of review.focusedSections?.outside ?? []) {
    // A change that deletes lines starts at its first deleted line, which the diff shows above its added ones.
    const old = code.deletions > 0 ? code.oldLines.at(0) : undefined;
    const { side, start } = old ? { side: 'before' as const, start: old.start } : outsideLines(code);
    add(focused, code.filePath, { kind: 'outside', side, start, names: shortSliceNames(code.label) });
  }
  const markers = new Map<string, ExplainedMarker[]>();
  for (const [filePath, list] of focused) markers.set(filePath, [...list]);
  for (const { entry, rows, section, slideId } of wholes) {
    // A whole hunk that overlaps a focused marker of its file is an older listing of the same code: the slices say more.
    const span = (side: 'before' | 'after') => {
      const lines = rows.filter((row) => (side === 'before' ? row.marker === '-' : row.marker === '+'));
      const at = (row: Row) => (side === 'before' ? row.old : row.new);
      return lines.length ? [at(lines[0]), at(lines[lines.length - 1])] : undefined;
    };
    const spans = { before: span('before'), after: span('after') };
    const overlaps = (focused.get(entry.filePath) ?? []).some((m) => {
      const s = spans[m.side];
      return !!s && m.start >= s[0] && m.start <= s[1];
    });
    if (overlaps) continue;
    add(markers, entry.filePath, {
      kind: 'section',
      ...placeOf(rows[0]),
      section,
      slideId,
      names: [],
      target: targetOf(entry.filePath, rows),
    });
  }
  for (const list of markers.values()) list.sort((a, b) => a.start - b.start || a.side.localeCompare(b.side));
  cache.set(review.slides, markers);
  return markers;
}

/** A marker's words: its visible text, and the name a screen reader reads for its button. */
export function markerWords(marker: ExplainedMarker): { text: string; name: string; detail?: string } {
  const what = marker.names.join(', ');
  if (marker.kind === 'outside')
    return { text: 'Left out of the explanation', name: `Left out of the explanation${what ? `: ${what}` : ''}`, detail: what || undefined };
  if (marker.kind === 'moved') {
    const name = what || `section ${marker.section}`;
    return {
      text: `Moved: explained with ${name} ↗`,
      name: `Moved: explained with ${name}, in section ${marker.section}`,
    };
  }
  return {
    text: `Explained in section ${marker.section} ↗`,
    name: `Explained in section ${marker.section}${what ? `: ${what}` : ''}`,
    detail: what || undefined,
  };
}
