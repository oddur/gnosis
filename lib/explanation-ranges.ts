import type { HiddenChange, HiddenTarget } from './diff-gaps';
import type { OutsideCode } from './explanation-focus';
import type { DiffHunk } from './types';

/**
 * Focused sections (#563): a section's slide entry for a slice keeps its whole hunk, with `lineRanges` (indexes into
 * its content lines) for the lines the slice holds. A section shows only those lines, in Changes' renderer: each run
 * of shown lines becomes a hunk of its own, with the context Changes would show around it, and the changes between
 * runs are hidden in gaps that say where they went (lib/diff-gaps.ts `markHidden`).
 *
 * An entry without `lineRanges`, or whose ranges or content can't be read, shows its whole hunk, as before. Everything
 * here is pure; SlideView calls it per file block.
 */

interface Row {
  marker: ' ' | '+' | '-' | '\\';
  /** The row's old line, or for an added row the old line after it. */
  old: number;
  /** The row's new line, or for a deleted row the new line after it. */
  new: number;
}

const HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/** A hunk's rows with their lines, or undefined when its header or a row's marker can't be read. */
function hunkRows(hunk: Pick<DiffHunk, 'hunkHeader' | 'content'>): { rows: Row[]; lines: string[]; rest: string } | undefined {
  const match = HEADER.exec(hunk.hunkHeader);
  if (!match) return undefined;
  const lines = hunk.content.split('\n');
  if (lines.at(-1) === '') lines.pop();
  // A side with no lines names the line before it.
  let old = Number(match[1]) + (match[2] === '0' ? 1 : 0),
    now = Number(match[3]) + (match[4] === '0' ? 1 : 0);
  const rows: Row[] = [];
  for (const line of lines) {
    const marker = line[0];
    if (marker !== ' ' && marker !== '+' && marker !== '-' && marker !== '\\') return undefined;
    rows.push({ marker, old, new: now });
    if (marker === '+') now++;
    else if (marker === '-') old++;
    else if (marker === ' ') {
      old++;
      now++;
    }
  }
  return { rows, lines, rest: match[5] };
}

const changed = (row: Row) => row.marker === '+' || row.marker === '-';
const hunkKey = (hunk: Pick<DiffHunk, 'filePath' | 'hunkHeader'>) => `${hunk.filePath}\u0000${hunk.hunkHeader}`;

/** The rows `ranges` name, or undefined when a range is out of the hunk. */
function rangeRows(ranges: readonly { start: number; end: number }[], count: number): Set<number> | undefined {
  const out = new Set<number>();
  for (const { start, end } of ranges) {
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end >= count) return undefined;
    for (let i = start; i <= end; i++) out.add(i);
  }
  return out;
}

/** A slice's label as a gap names it: `fn supersede (impl EntityDrainState)` is `fn supersede`. */
export function shortSliceNames(label: string | undefined): string[] {
  if (!label) return [];
  const names = label
    .replace(/ and \d+ more$/, '')
    .replace(/ \((?!part\))[^()]*\)/g, '')
    .split(', ')
    .map((name) => name.trim())
    .filter(Boolean);
  return [...new Set(names)];
}

/** Where each slice of the explanation shows, for a section's gaps (#563). */
export interface SliceOwners {
  /** Per hunk (file and header), the slices sections show: their section (1-based), rows and names. */
  slices: Map<string, { section: number; rows: Set<number>; names: string[] }[]>;
  /**
   * Moved definitions' new copies: their old file and lines, the section that shows them, and where the new copy is
   * (its file, and its first added line), for the jump there.
   */
  moves: {
    filePath: string;
    startLine: number;
    endLine: number;
    section: number;
    names: string[];
    to: { filePath: string; line?: number };
  }[];
}

const ownersCache = new WeakMap<readonly unknown[], SliceOwners>();
/**
 * Slice ownership across an explanation's sections (`Slide.diffHunks` with `sliceId`), kept per slides array: every
 * section reads the same map. A changed row no section shows is code left out (`outside`), which Changes shows.
 */
export function sliceOwners(slides: readonly { diffHunks: readonly DiffHunk[] }[]): SliceOwners {
  const saved = ownersCache.get(slides);
  if (saved) return saved;
  const slices = new Map<string, { section: number; rows: Set<number>; names: string[] }[]>();
  const moves: SliceOwners['moves'] = [];
  slides.forEach((slide, index) => {
    for (const hunk of slide.diffHunks) {
      const names = shortSliceNames(hunk.label);
      const parsed = hunkRows(hunk);
      // An entry without ranges, or whose ranges can't be read, shows its whole hunk: it owns all of its rows.
      const all = parsed && new Set(parsed.rows.map((_, i) => i));
      const rows = parsed && (hunk.lineRanges?.length ? (rangeRows(hunk.lineRanges, parsed.rows.length) ?? all) : all);
      if (hunk.movedFrom) {
        const first = rows && [...rows].sort((a, b) => a - b).find((i) => parsed.rows[i].marker === '+');
        moves.push({
          filePath: hunk.movedFrom.filePath,
          startLine: hunk.movedFrom.startLine,
          endLine: hunk.movedFrom.endLine,
          section: index + 1,
          names,
          to: { filePath: hunk.filePath, ...(first !== undefined && parsed ? { line: parsed.rows[first].new } : {}) },
        });
      }
      if (!rows) continue;
      const key = hunkKey(hunk);
      const list = slices.get(key) ?? [];
      list.push({ section: index + 1, rows, names });
      slices.set(key, list);
    }
  });
  const owners = { slices, moves };
  ownersCache.set(slides, owners);
  return owners;
}

/** Where a hidden changed row went: the section that shows it, else the code left out. Never unchanged code. */
function rowTarget(
  hunk: DiffHunk,
  index: number,
  row: Row,
  owners: SliceOwners | undefined,
  section: number
): { key: string; target: HiddenTarget } {
  const shown = owners?.slices.get(hunkKey(hunk))?.find((slice) => slice.section !== section && slice.rows.has(index));
  if (shown) return { key: `s${shown.section}`, target: { kind: 'section', section: shown.section, names: [...shown.names] } };
  if (row.marker === '-') {
    const move = owners?.moves.find(
      (m) => m.section !== section && m.filePath === hunk.filePath && row.old >= m.startLine && row.old <= m.endLine
    );
    if (move)
      return {
        key: `m${move.section}:${move.to.filePath}`,
        target: {
          kind: 'section',
          section: move.section,
          names: [...move.names],
          filePath: move.to.filePath,
          ...(move.to.line !== undefined ? { line: move.to.line } : {}),
        },
      };
  }
  // The code no section shows (`outside`), and anything else no section claims, such as a change left out as noise:
  // it is never shown as unchanged code, and Changes shows it.
  return {
    key: 'outside',
    target: { kind: 'outside', lines: 0, side: row.marker === '+' ? 'after' : 'before', start: 0, end: 0 },
  };
}

/** A file block of a section, its slices cut to their ranges, and the changes it hides between them. */
export interface RangedBlock {
  hunks: DiffHunk[];
  hidden: HiddenChange[];
  /**
   * The hunks' unchanged rows the ranges leave out, by new line: a gap reveals them from the saved text as it would a
   * whole hunk's, up to the nearest hidden change (`markHidden` caps it there), so show scope matches Changes.
   */
  context: Map<number, string>;
}

/**
 * A section's hunks of one file block as it shows them (#563). Entries of one hunk (several slices, listed anywhere in
 * the block) merge: their ranges' rows show, with up to `context` unchanged rows around each run, never past a changed
 * row; each run is a hunk of its own with its own header. An entry without ranges shows its whole hunk. The changed
 * rows left out are `hidden`, each run with where it went: another section (`section`, 1-based, is this one), or the
 * code no section shows. Old explanations, with no ranges, come back as they are.
 */
export function rangeBlockHunks(
  hunks: DiffHunk[],
  { context = 3, owners, section = 0 }: { context?: number; owners?: SliceOwners; section?: number } = {}
): RangedBlock {
  if (!hunks.some((hunk) => hunk.lineRanges?.length)) return { hunks, hidden: [], context: new Map() };
  const buckets = new Map<string, DiffHunk[]>();
  for (const hunk of hunks) {
    const key = `${hunkKey(hunk)}\u0000${hunk.content}`;
    buckets.set(key, [...(buckets.get(key) ?? []), hunk]);
  }
  const out: DiffHunk[] = [];
  const hidden: HiddenChange[] = [];
  const unshown = new Map<number, string>();
  for (const entries of buckets.values()) {
    const parsed = entries.every((entry) => entry.lineRanges?.length) ? hunkRows(entries[0]) : undefined;
    const sets = parsed && entries.map((entry) => rangeRows(entry.lineRanges ?? [], parsed.rows.length));
    if (!parsed || !sets || sets.some((set) => !set)) {
      out.push(...entries);
      continue;
    }
    const { rows, lines, rest } = parsed;
    const shown = new Set(sets.flatMap((set) => [...(set ?? [])]));
    // Context around each shown run, as Changes shows it: unchanged rows only, never across another slice's change.
    const show = rows.map((_, i) => shown.has(i));
    for (const i of shown) {
      for (let j = i - 1, n = 0; j >= 0 && n < context && !changed(rows[j]) && !shown.has(j); j--, n++) show[j] = true;
      for (let j = i + 1, n = 0; j < rows.length && n < context && !changed(rows[j]) && !shown.has(j); j++, n++) show[j] = true;
    }
    // A note row ("\ No newline at end of file") follows the row above it.
    rows.forEach((row, i) => {
      if (row.marker === '\\') show[i] = i > 0 && show[i - 1];
    });
    const base = entries[0];
    let i = 0;
    while (i < rows.length) {
      if (show[i]) {
        let j = i;
        while (j + 1 < rows.length && show[j + 1]) j++;
        const body = rows.slice(i, j + 1);
        const olds = body.filter((row) => row.marker === ' ' || row.marker === '-').length,
          news = body.filter((row) => row.marker === ' ' || row.marker === '+').length;
        // A side with no lines names the line before it, as GitHub's headers do.
        const header = `@@ -${olds ? rows[i].old : rows[i].old - 1},${olds} +${news ? rows[i].new : rows[i].new - 1},${news} @@${rest}`;
        // The slices' own fields stay on the entries; each cut hunk is plain.
        out.push({
          filePath: base.filePath,
          language: base.language,
          renderedHtml: base.renderedHtml,
          hunkHeader: header,
          content: lines.slice(i, j + 1).join('\n'),
        });
        i = j + 1;
        continue;
      }
      // A run of hidden rows: each change in it, grouped by where it went.
      let current: { key: string; target: HiddenTarget; change: HiddenChange } | undefined;
      const flush = () => {
        if (current) hidden.push({ ...current.change, target: current.target });
        current = undefined;
      };
      while (i < rows.length && !show[i]) {
        const row = rows[i];
        if (row.marker === ' ') unshown.set(row.new, lines[i].slice(1));
        if (changed(row)) {
          const { key, target } = rowTarget(base, i, row, owners, section);
          if (current?.key === key && current.target.kind === 'section' && target.kind === 'section') {
            // Neighbouring slices of one section: one target naming them all.
            for (const name of target.names) if (!current.target.names.includes(name)) current.target.names.push(name);
          }
          if (current?.key !== key) {
            flush();
            current = {
              key,
              target,
              change: { oldStart: row.old, oldEnd: row.old - 1, newStart: row.new, newEnd: row.new - 1, target },
            };
          }
          const change = current.change;
          if (row.marker === '-') change.oldEnd = row.old;
          else change.newEnd = row.new;
          const t = current.target;
          if (t.kind === 'section' && row.marker === '+' && !t.filePath) t.line ??= row.new;
          if (t.kind === 'outside') {
            t.lines++;
            const line = row.marker === '+' ? row.new : row.old;
            const side = row.marker === '+' ? 'after' : 'before';
            // The new side wins: a change that adds lines opens there.
            if (t.lines === 1 || (side === 'after' && t.side === 'before')) Object.assign(t, { side, start: line, end: line });
            else if (side === t.side) t.end = line;
          }
        }
        i++;
      }
      flush();
    }
  }
  return { hunks: out, hidden, context: unshown };
}

/** The code no section shows, per file in path order, for "Code outside the explanation" (#563). */
export function outsideByFile(outside: readonly OutsideCode[] | undefined): { filePath: string; code: OutsideCode[] }[] {
  const files = new Map<string, OutsideCode[]>();
  for (const code of outside ?? []) files.set(code.filePath, [...(files.get(code.filePath) ?? []), code]);
  return [...files.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([filePath, code]) => ({ filePath, code }));
}

/** Where a left-out unit is: its new lines, or its old lines when it only deletes. `L120–148`, `old L9–11`. */
export function outsideLines(code: Pick<OutsideCode, 'oldLines' | 'newLines' | 'additions'>): {
  side: 'before' | 'after';
  start: number;
  end: number;
  label: string;
} {
  const after = code.additions > 0 && code.newLines.length > 0;
  const lines = after ? code.newLines : code.oldLines.length ? code.oldLines : code.newLines;
  const start = lines.at(0)?.start ?? 1,
    end = lines.at(-1)?.end ?? start;
  const span = end > start ? `L${start}–${end}` : `L${start}`;
  return { side: after ? 'after' : 'before', start, end, label: after ? span : `old ${span}` };
}

/**
 * A moved slice's new body (#563): the new side of its ranges' rows, from its first new line, for the move diff against
 * the old body. Undefined when its rows can't be read.
 */
export function movedBody(entry: DiffHunk): { text: string; start: number } | undefined {
  const parsed = hunkRows(entry);
  // A whole hunk that moved is all of it.
  const rows =
    parsed &&
    (entry.lineRanges?.length
      ? rangeRows(entry.lineRanges, parsed.rows.length)
      : new Set(parsed.rows.map((_, i) => i)));
  if (!parsed || !rows?.size) return undefined;
  const indexes = [...rows].sort((a, b) => a - b).filter((i) => parsed.rows[i].marker === ' ' || parsed.rows[i].marker === '+');
  if (!indexes.length) return undefined;
  return {
    text: `${indexes.map((i) => parsed.lines[i].slice(1)).join('\n')}\n`,
    start: parsed.rows[indexes[0]].new,
  };
}
