import { createPatch } from 'diff';
import type { IndexedHunk } from './diff-parse';
import {
  languageFamily,
  matchMoves,
  type FilePrints,
  type MoveEnd,
  type MoveFile,
  type SymbolMove,
} from './moved-symbols';
import { patchHunks } from './semantic-noise';
import {
  SYNTAX_MAX_CHARACTERS,
  WHOLE_DEFINITION_LINES,
  definitionLines,
  syntaxLanguage,
  type createSyntaxEngine,
  type DefinitionKind,
  type SyntaxDefinition,
  type SyntaxLanguage,
} from './syntax-scope';

/**
 * Focused explanation sections (#565, #561): each large hunk split into slices at definition boundaries, so a section
 * can show only the code it explains, and moved definitions linked across slices. This runs in the explanation's
 * tree-sitter worker (src/conflict-check-worker.ts); everything here but `sliceFile` is pure, so the rules are tested
 * without a worker.
 *
 * The rules:
 * - Only a hunk with more than `SLICE_MIN_CHANGED` changed lines is split.
 * - Each side's lines are cut into units: the smallest definition of at most `WHOLE_DEFINITION_LINES` lines. A larger
 *   definition is split again at its children, or kept whole when it has none. Its own lines outside its children (an
 *   `impl` header, a closing brace) go with its next child, or its last. Top-level code outside every definition
 *   (imports, constants) is a unit of its own for each run of lines. Comments and blank lines outside every definition
 *   go with the next unit.
 * - A removed line takes the old side's unit, an added line the new side's. A line with no unit on its side takes the
 *   other side's unit when that unit encloses the line's place. A definition edited in place, one unit on each side
 *   with the same chain of names, is one slice.
 * - A slice of only comments and blank lines joins the next slice. Neighbouring slices of fewer than
 *   `SLICE_TINY_LINES` changed lines join into one.
 * - Fail safe: a file with no grammar, a language turned off in Code intelligence, a text over the limits, a parse error
 *   in the hunk's lines, a text that doesn't match the hunk, or a worker that doesn't answer keeps the whole hunk. So
 *   does a split that doesn't cover every changed line exactly once.
 */
export const SLICE_MIN_CHANGED = 80;
/** Slices with fewer changed lines than this, next to each other, are one slice. */
export const SLICE_TINY_LINES = 8;

/** Lines from `start` to `end`, inclusive. */
export interface LineRange {
  start: number;
  end: number;
}
/** One unit in a slice: a definition on one side, or a run of top-level code outside every definition. */
export interface SliceSymbol {
  side: 'before' | 'after';
  /** Undefined for top-level code outside every definition, such as imports and constants. */
  kind?: DefinitionKind;
  name: string;
  /** The crumb and its parent chain, outermost first: `fn supersede (impl EntityDrainState)`. */
  label: string;
  /** The unit's lines on its side, from 1, inclusive. */
  start: number;
  end: number;
}
export interface HunkSlice {
  /** `<hunkId>:<content hash>`: the same lines give the same ID on every run. */
  id: string;
  /** The slice's symbols' labels, or the file's name for a whole hunk without them. */
  label: string;
  symbols: SliceSymbol[];
  /** Indexes into the hunk's `expandedContent` lines: its changed lines, and the context lines between them. */
  lines: LineRange[];
  /** The same lines on the old and new side, from 1. */
  oldLines: LineRange[];
  newLines: LineRange[];
  additions: number;
  deletions: number;
  /** A proven move (lib/moved-symbols.ts): the slice the deleted definition reappears in, or came from. */
  movedTo?: string;
  movedFrom?: string;
  /** Whether the moved definition's body is unchanged (comments included), or edited. */
  moveBody?: 'identical' | 'edited';
}
/** Why a hunk is one slice. */
export type WholeReason =
  | 'small'
  | 'no-grammar'
  | 'off'
  | 'too-large'
  | 'parse-error'
  | 'no-definitions'
  /** The texts don't match the hunk, a side's text is missing, or the parse threw. */
  | 'failed'
  /** The worker didn't answer: it ran out of time, failed, or was stopped. */
  | 'timeout'
  | 'coverage';
export interface HunkSlices {
  hunkId: string;
  filePath: string;
  /** Set when the hunk is kept whole: one slice holds all of it. */
  whole?: WholeReason;
  slices: HunkSlice[];
}

/** One hunk as the slicer reads it: its expanded header and content (IndexedHunk). */
export interface SliceHunk {
  id: string;
  header: string;
  content: string;
}
/** One file for the worker: both texts (undefined for the missing side of an added or deleted file) and its hunks. */
export interface SliceFile {
  path: string;
  base?: string;
  head?: string;
  hunks: SliceHunk[];
}

// ── Hunk rows ───────────────────────────────────────────────────────────────

interface Row {
  index: number;
  marker: '+' | '-' | ' ' | '\\';
  text: string;
  old?: number;
  new?: number;
}
const HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
/** The hunk's lines with their line numbers on each side; undefined for a header that doesn't parse. */
function hunkRows(hunk: SliceHunk): Row[] | undefined {
  const header = HEADER.exec(hunk.header);
  if (!header) return undefined;
  let old = Number(header[1]) + (header[2] === '0' ? 1 : 0);
  let now = Number(header[3]) + (header[4] === '0' ? 1 : 0);
  const rows: Row[] = [];
  for (const [index, line] of hunk.content.split('\n').entries()) {
    const marker = line[0];
    const text = line.slice(1);
    if (marker === '-') rows.push({ index, marker, text, old: old++ });
    else if (marker === '+') rows.push({ index, marker, text, new: now++ });
    else if (marker === ' ') rows.push({ index, marker, text, old: old++, new: now++ });
    else if (marker === '\\') rows.push({ index, marker, text });
    else return undefined;
  }
  return rows;
}
const isChanged = (row: Row) => row.marker === '+' || row.marker === '-';

/** Comments and blank lines, by their text: they attach to a neighbour and never make a unit or a slice alone. */
function isTrivia(text: string, language: SyntaxLanguage | undefined) {
  const t = text.trim();
  if (!t) return true;
  if (language === 'python' || language === 'yaml') return t.startsWith('#');
  return /^(\/\/|\/\*|\*)/.test(t);
}

const squash = (text: string) => text.replace(/\s+/g, ' ').trim();
const clip = (text: string, max = 60) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

// ── Units ───────────────────────────────────────────────────────────────────

interface Unit {
  id: string;
  /** Pairs a definition edited in place across sides: its chain of crumbs. Undefined for top-level code. */
  key?: string;
  symbol: SliceSymbol;
}
/** One side of a file, read for slicing: each line's unit (index = line, from 1), and its parse errors. */
export interface SideOutline {
  units: (Unit | undefined)[];
  lines: string[];
  errorLines?: readonly (readonly [number, number])[];
}
interface DefinitionNode {
  definition: SyntaxDefinition;
  children: DefinitionNode[];
}
/** Definitions as a tree by their lines. One with the same lines as another is left out; one that overlaps is too. */
function definitionTree(definitions: readonly SyntaxDefinition[], count: number): DefinitionNode[] {
  const sorted = definitions
    .filter((d) => d.start >= 1 && d.end >= d.start && d.end <= count)
    .sort((a, b) => a.start - b.start || b.end - a.end);
  const roots: DefinitionNode[] = [];
  const stack: DefinitionNode[] = [];
  for (const definition of sorted) {
    while (stack.length && stack[stack.length - 1].definition.end < definition.start) stack.pop();
    const parent = stack.at(-1);
    const siblings = parent ? parent.children : roots;
    const last = siblings.at(-1);
    if (parent && parent.definition.start === definition.start && parent.definition.end === definition.end) continue;
    if (parent && definition.end > parent.definition.end) continue;
    if (last && last.definition.end >= definition.start) continue;
    const node = { definition, children: [] };
    siblings.push(node);
    stack.push(node);
  }
  return roots;
}

/**
 * Each line's unit on one side of a file (see the rules above), from the side's definitions and text. Every line has
 * one, unless the side has no definitions and no top-level code at all.
 */
export function sideOutline(
  side: 'before' | 'after',
  definitions: readonly SyntaxDefinition[],
  text: string,
  language: SyntaxLanguage | undefined,
  errorLines?: readonly (readonly [number, number])[]
): SideOutline {
  const lines = text.split('\n');
  const count = lines.length;
  const units: (Unit | undefined)[] = new Array<Unit | undefined>(count + 1).fill(undefined);
  /** `parents`: the definitions around it, outermost first, as definitionChain gives them, from the tree. */
  const definitionUnit = (definition: SyntaxDefinition, parents: readonly SyntaxDefinition[]): Unit => {
    const chain = [...parents, definition];
    return {
      id: `${side}:${definition.start}:${definition.end}`,
      key: chain.map((d) => `${d.kind}\u0001${d.crumb}`).join('\u0000'),
      symbol: {
        side,
        kind: definition.kind,
        name: definition.name,
        label: parents.length ? `${definition.crumb} (${parents.map((p) => p.crumb).join(' › ')})` : definition.crumb,
        start: definition.start,
        end: definition.end,
      },
    };
  };
  /** Lines from `start` to `end` without a unit take the next unit in the range, or the one before them. */
  const attach = (start: number, end: number) => {
    let next: Unit | undefined;
    for (let l = end; l >= start; l--) {
      if (units[l]) next = units[l];
      else units[l] = next;
    }
    let previous: Unit | undefined;
    for (let l = start; l <= end; l++) {
      if (units[l]) previous = units[l];
      else units[l] = previous;
    }
  };
  const place = (nodes: readonly DefinitionNode[], parents: readonly SyntaxDefinition[]) => {
    for (const node of nodes) {
      const { definition } = node;
      if (definitionLines(definition) <= WHOLE_DEFINITION_LINES || !node.children.length) {
        const unit = definitionUnit(definition, parents);
        for (let l = definition.start; l <= definition.end; l++) units[l] = unit;
        continue;
      }
      // Too large: its children are the units, and its own lines go with them.
      place(node.children, [...parents, definition]);
      attach(definition.start, definition.end);
    }
  };
  place(definitionTree(definitions, count), []);
  // Top-level code outside every definition: a unit for each run of lines.
  for (let l = 1; l <= count; l++) {
    if (units[l] || isTrivia(lines[l - 1], language)) continue;
    let end = l;
    while (end < count && !units[end + 1] && !isTrivia(lines[end], language)) end++;
    const unit: Unit = {
      id: `${side}:code:${l}:${end}`,
      symbol: { side, name: clip(squash(lines[l - 1])), label: clip(squash(lines[l - 1])), start: l, end },
    };
    for (let k = l; k <= end; k++) units[k] = unit;
    l = end;
  }
  attach(1, count);
  return { units, lines, ...(errorLines?.length ? { errorLines } : {}) };
}

// ── Slicing ─────────────────────────────────────────────────────────────────

/** A 53-bit hash of a text, in base 36 (cyrb53). */
function contentHash(text: string) {
  let h1 = 0xdeadbeef,
    h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** Sorted numbers as runs of consecutive ones. */
function ranges(numbers: readonly number[]): LineRange[] {
  const sorted = [...numbers].sort((a, b) => a - b);
  const result: LineRange[] = [];
  for (const n of sorted) {
    const last = result.at(-1);
    if (last && n === last.end + 1) last.end = n;
    else if (!last || n > last.end) result.push({ start: n, end: n });
  }
  return result;
}

const fileName = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const joinLabels = (labels: readonly string[], fallback: string) => {
  const unique = [...new Set(labels)];
  if (!unique.length) return fallback;
  return unique.length > 3 ? `${unique.slice(0, 3).join(', ')} and ${unique.length - 3} more` : unique.join(', ');
};

/** A slice from its rows: its line ranges on every side, counts, label and content-hashed ID. */
function buildSlice(
  hunkId: string,
  rows: readonly Row[],
  symbols: readonly SliceSymbol[],
  fallback: string
): HunkSlice {
  const sorted = [...rows].sort((a, b) => a.index - b.index);
  const unique = [...new Map(symbols.map((s) => [`${s.side}:${s.start}:${s.end}:${s.label}`, s])).values()];
  return {
    id: `${hunkId}:${contentHash(sorted.map((r) => r.marker + r.text).join('\n'))}`,
    label: joinLabels(
      unique.map((s) => s.label),
      fallback
    ),
    symbols: unique,
    lines: ranges(sorted.map((r) => r.index)),
    oldLines: ranges(sorted.flatMap((r) => (r.old !== undefined ? [r.old] : []))),
    newLines: ranges(sorted.flatMap((r) => (r.new !== undefined ? [r.new] : []))),
    additions: sorted.filter((r) => r.marker === '+').length,
    deletions: sorted.filter((r) => r.marker === '-').length,
  };
}

/** The whole hunk as one slice: every line of it. */
export function wholeHunk(
  hunk: SliceHunk,
  filePath: string,
  whole: WholeReason,
  symbols: readonly SliceSymbol[] = []
): HunkSlices {
  const rows = hunkRows(hunk) ?? hunk.content.split('\n').map((text, index): Row => ({ index, marker: ' ', text }));
  return { hunkId: hunk.id, filePath, whole, slices: [buildSlice(hunk.id, rows, symbols, fileName(filePath))] };
}

/** Every changed row is in exactly one slice, and every slice holds one. */
export function coversExactly(hunk: SliceHunk, slices: readonly HunkSlice[]): boolean {
  const rows = hunkRows(hunk);
  if (!rows) return false;
  const seen = new Map<number, number>();
  for (const slice of slices) {
    let changed = 0;
    for (const range of slice.lines)
      for (let i = range.start; i <= range.end; i++) {
        const row = rows[i] as Row | undefined;
        if (!row) return false;
        if (!isChanged(row)) continue;
        changed++;
        seen.set(i, (seen.get(i) ?? 0) + 1);
      }
    if (!changed) return false;
  }
  return rows.filter(isChanged).every((row) => seen.get(row.index) === 1) && [...seen.values()].every((n) => n === 1);
}

const touches = (errors: SideOutline['errorLines'], numbers: readonly number[]) => {
  if (!errors?.length || !numbers.length) return false;
  let low = Infinity,
    high = -Infinity;
  for (const n of numbers) {
    low = Math.min(low, n);
    high = Math.max(high, n);
  }
  return errors.some(([start, end]) => start <= high && end >= low);
};

/**
 * One hunk's slices, from its file's outlines (`sideOutline`): undefined for a side the file doesn't have. A hunk
 * whose outlines can't be trusted, or that has `SLICE_MIN_CHANGED` changed lines or fewer, is one slice.
 */
export function sliceHunk(
  hunk: SliceHunk,
  filePath: string,
  language: SyntaxLanguage | undefined,
  before: SideOutline | undefined,
  after: SideOutline | undefined
): HunkSlices {
  const rows = hunkRows(hunk);
  if (!rows) return wholeHunk(hunk, filePath, 'failed');
  const changed = rows.filter(isChanged);
  // The texts must be the ones the hunk was made from: a stale or missing side keeps the whole hunk.
  for (const row of rows) {
    if (row.old !== undefined && (row.marker === '-' || before) && before?.lines[row.old - 1] !== row.text)
      return wholeHunk(hunk, filePath, 'failed');
    if (row.new !== undefined && (row.marker === '+' || after) && after?.lines[row.new - 1] !== row.text)
      return wholeHunk(hunk, filePath, 'failed');
  }
  const oldNumbers = rows.flatMap((r) => (r.old !== undefined ? [r.old] : []));
  const newNumbers = rows.flatMap((r) => (r.new !== undefined ? [r.new] : []));
  if (touches(before?.errorLines, oldNumbers) || touches(after?.errorLines, newNumbers))
    return wholeHunk(hunk, filePath, 'parse-error');

  // Each changed row's unit: its own side's, else the other side's when that unit encloses the row's place.
  const unitOf = new Map<number, Unit>();
  for (const [at, row] of rows.entries()) {
    if (!isChanged(row)) continue;
    const own = row.marker === '-' ? before?.units[row.old ?? 0] : after?.units[row.new ?? 0];
    if (own) {
      unitOf.set(row.index, own);
      continue;
    }
    const other = row.marker === '-' ? after : before;
    const field = row.marker === '-' ? 'new' : 'old';
    let place: number | undefined;
    for (let k = at + 1; k < rows.length && place === undefined; k++) place = rows[k][field];
    if (place === undefined) {
      const previous = rows
        .slice(0, at)
        .reverse()
        .find((r) => r[field] !== undefined)?.[field];
      place = previous === undefined ? undefined : previous + 1;
    }
    const enclosing = place !== undefined && place > 1 ? other?.units[place - 1] : undefined;
    if (enclosing && place !== undefined && other?.units[place] === enclosing) unitOf.set(row.index, enclosing);
  }
  if (!unitOf.size) return wholeHunk(hunk, filePath, 'no-definitions');

  // Groups by unit; a definition edited in place (one unit on each side with the same chain) is one group.
  const groupOf = new Map<string, string>();
  const byKey = new Map<string, { before: Set<string>; after: Set<string> }>();
  for (const unit of unitOf.values()) {
    groupOf.set(unit.id, unit.id);
    if (!unit.key) continue;
    const entry = byKey.get(unit.key) ?? { before: new Set(), after: new Set() };
    entry[unit.symbol.side].add(unit.id);
    byKey.set(unit.key, entry);
  }
  for (const entry of byKey.values())
    if (entry.before.size === 1 && entry.after.size === 1) groupOf.set([...entry.after][0], [...entry.before][0]);

  interface Group {
    rows: Row[];
    symbols: SliceSymbol[];
  }
  const groups = new Map<string, Group>();
  const groupRow = (id: string, row: Row, symbol?: SliceSymbol) => {
    const group = groups.get(id) ?? { rows: [], symbols: [] };
    group.rows.push(row);
    if (symbol) group.symbols.push(symbol);
    groups.set(id, group);
  };
  // Rows without a unit join the next row's group in the hunk, or the one before them.
  const ids = changed.map((row) => {
    const unit = unitOf.get(row.index);
    return unit ? (groupOf.get(unit.id) ?? unit.id) : undefined;
  });
  for (let i = ids.length - 2; i >= 0; i--) ids[i] ??= ids[i + 1];
  for (let i = 1; i < ids.length; i++) ids[i] ??= ids[i - 1];
  changed.forEach((row, i) => groupRow(ids[i] ?? '', row, unitOf.get(row.index)?.symbol));

  let ordered = [...groups.values()].sort((a, b) => a.rows[0].index - b.rows[0].index);
  const merge = (into: Group, from: Group) => {
    into.rows.push(...from.rows);
    into.symbols.push(...from.symbols);
    into.rows.sort((a, b) => a.index - b.index);
  };
  // A group of only comments and blank lines joins the next group, or the one before it.
  for (let i = 0; i < ordered.length && ordered.length > 1; ) {
    if (!ordered[i].rows.every((row) => isTrivia(row.text, language))) {
      i++;
      continue;
    }
    // Its rows only: the definition its comments sat before isn't part of the change.
    merge(ordered[i + 1] ?? ordered[i - 1], { rows: ordered[i].rows, symbols: [] });
    ordered.splice(i, 1);
  }
  // Neighbouring tiny groups join, when neither reaches into the other.
  const joined: Group[] = [];
  for (const group of ordered) {
    const last = joined.at(-1);
    const tiny = (g: Group) => g.rows.length < SLICE_TINY_LINES;
    if (last && tiny(last) && tiny(group) && last.rows[last.rows.length - 1].index < group.rows[0].index)
      merge(last, group);
    else joined.push(group);
  }
  ordered = joined;

  // Each group's rows, with the context rows between two of its own changed rows.
  const owner = new Map<number, Group>();
  for (const group of ordered) for (const row of group.rows) owner.set(row.index, group);
  let previous: Group | undefined;
  const pending: Row[] = [];
  for (const row of rows) {
    const group = owner.get(row.index);
    if (group) {
      if (group === previous) group.rows.push(...pending);
      pending.length = 0;
      previous = group;
    } else if (previous) pending.push(row);
  }

  if (changed.length <= SLICE_MIN_CHANGED)
    return wholeHunk(
      hunk,
      filePath,
      'small',
      ordered.flatMap((group) => group.symbols)
    );
  const slices = ordered.map((group) => buildSlice(hunk.id, group.rows, group.symbols, fileName(filePath)));
  // Two slices with the same lines keep apart.
  const seen = new Map<string, number>();
  for (const slice of slices) {
    const n = (seen.get(slice.id) ?? 0) + 1;
    seen.set(slice.id, n);
    if (n > 1) slice.id = `${slice.id}.${n}`;
  }
  if (!coversExactly(hunk, slices)) return wholeHunk(hunk, filePath, 'coverage');
  return { hunkId: hunk.id, filePath, slices };
}

// ── Moves ───────────────────────────────────────────────────────────────────

/**
 * Links each proven move (lib/moved-symbols.ts `matchMoves`) to its slices: a deleted slice that is the moved
 * definition alone, and an added slice that is its new copy alone. A move whose end is part of a larger slice, or of
 * a slice that also adds or deletes other lines, is not linked: the slices stay ordinary.
 */
export function linkMoves(sliced: readonly HunkSlices[], moves: readonly SymbolMove[]): HunkSlices[] {
  const result = sliced.map((hunk) => ({ ...hunk, slices: hunk.slices.map((slice) => ({ ...slice })) }));
  const endSlice = (end: MoveEnd) => {
    for (const hunk of result) {
      if (hunk.filePath !== end.diffPath) continue;
      for (const slice of hunk.slices) {
        if (slice.symbols.length !== 1) continue;
        const [symbol] = slice.symbols;
        if (symbol.side !== end.side || symbol.start !== end.start || symbol.end !== end.end) continue;
        if (end.side === 'before' ? slice.additions : slice.deletions) continue;
        return slice;
      }
    }
    return undefined;
  };
  for (const move of moves) {
    const from = endSlice(move.from),
      to = endSlice(move.to);
    if (!from || !to || from === to || from.movedTo || to.movedFrom) continue;
    const body = move.exact && !move.commentsChanged ? 'identical' : 'edited';
    from.movedTo = to.id;
    from.moveBody = body;
    to.movedFrom = from.id;
    to.moveBody = body;
  }
  return result;
}

/** One file's moved-symbol candidates for `sliceMoves`; undefined prints when the file couldn't be read. */
export interface SliceMoveFile {
  path: string;
  family: string;
  prints?: FilePrints;
}
/**
 * The PR's proven moves among the files' candidates. A language family is matched only when every file of it was read
 * whole: a file left out could hold a rival, and a wrong move is worse than none.
 */
export function sliceMoves(files: readonly SliceMoveFile[]): SymbolMove[] {
  const refused = new Set(files.filter((f) => !f.prints || f.prints.capped).map((f) => f.family));
  const read: MoveFile[] = files.flatMap((f) =>
    f.prints && !refused.has(f.family)
      ? [{ file: f.path, url: '', headSha: '', path: f.path, family: f.family, prints: f.prints }]
      : []
  );
  return read.length ? matchMoves(read).moves : [];
}

/** The family a file's moves are matched in; undefined for a file Gnosis has no grammar for. */
export const sliceFamily = (path: string) => {
  const language = syntaxLanguage(path);
  return language ? languageFamily(language) : undefined;
};

/**
 * A PR's slices with their moves linked, from a reader of one file's answer (`sliceFile`, in the worker) and a matcher
 * of moves (`sliceMoves`). Fail safe: a file without an answer keeps whole hunks and refuses its family's moves; no
 * answer from the matcher links nothing. `stopped` ends the reading early, with the files left keeping whole hunks.
 */
export async function slicePr(
  files: readonly SliceFile[],
  read: (file: SliceFile) => Promise<SliceAnswer | undefined>,
  match: (files: SliceMoveFile[]) => Promise<SymbolMove[] | undefined>,
  stopped: () => boolean = () => false
): Promise<HunkSlices[]> {
  const sliced: HunkSlices[] = [];
  const candidates: SliceMoveFile[] = [];
  for (const file of files) {
    const answer = stopped() ? undefined : await read(file);
    sliced.push(...(answer?.slices ?? file.hunks.map((hunk) => wholeHunk(hunk, file.path, 'timeout'))));
    // A file of the family without candidates (unread, off, too large) refuses the family's moves.
    const family = sliceFamily(file.path);
    if (family) candidates.push({ path: file.path, family, ...(answer?.prints ? { prints: answer.prints } : {}) });
  }
  if (!candidates.some((file) => file.prints) || stopped()) return sliced;
  const moves = await match(candidates);
  return moves ? linkMoves(sliced, moves) : sliced;
}

// ── The worker's job ────────────────────────────────────────────────────────

/** The worker's answer for one file: its hunks' slices, and its moved-symbol candidates when it could read them. */
export interface SliceAnswer {
  slices: HunkSlices[];
  prints?: FilePrints;
}

/**
 * One file's slices and moved-symbol candidates, in the worker. Both sides are parsed once for all of its hunks. Any
 * failure keeps whole hunks and reads no candidates.
 */
export async function sliceFile(
  engine: Pick<ReturnType<typeof createSyntaxEngine>, 'definitions' | 'symbols'>,
  file: SliceFile,
  disabled: readonly SyntaxLanguage[] = []
): Promise<SliceAnswer> {
  const whole = (reason: WholeReason) => ({ slices: file.hunks.map((h) => wholeHunk(h, file.path, reason)) });
  const language = syntaxLanguage(file.path);
  if (!language) return whole('no-grammar');
  if (disabled.includes(language)) return whole('off');
  if ([file.base, file.head].some((text) => text !== undefined && text.length > SYNTAX_MAX_CHARACTERS))
    return whole('too-large');
  let before: SideOutline | undefined, after: SideOutline | undefined;
  try {
    if (file.base !== undefined) {
      const read = await engine.definitions(language, file.base);
      before = sideOutline('before', read.definitions, file.base, language, read.errorLines);
    }
    if (file.head !== undefined) {
      const read = await engine.definitions(language, file.head);
      after = sideOutline('after', read.definitions, file.head, language, read.errorLines);
    }
  } catch {
    return whole('failed');
  }
  const slices = file.hunks.map((hunk) => sliceHunk(hunk, file.path, language, before, after));
  let prints: FilePrints | undefined;
  try {
    if (file.base !== undefined && file.head !== undefined) {
      const hunks = patchHunks(createPatch(file.path, file.base, file.head, '', '', { context: 3 })) ?? [];
      prints = (await engine.symbols(language, { mode: 'modified', text: file.head, hunks })).prints;
    } else if (file.head !== undefined)
      prints = (await engine.symbols(language, { mode: 'added', text: file.head })).prints;
    else if (file.base !== undefined)
      prints = (await engine.symbols(language, { mode: 'deleted', text: file.base })).prints;
  } catch {
    prints = undefined;
  }
  return { slices, ...(prints ? { prints } : {}) };
}

/** The worker's files for an explanation's hunks: one per file, with the texts its hunks were made from. */
export function sliceRequests(
  hunks: readonly Pick<IndexedHunk, 'id' | 'filePath' | 'expandedHunkHeader' | 'expandedContent'>[],
  before: Record<string, string>,
  after: Record<string, string>
): SliceFile[] {
  const text = (files: Record<string, string>, path: string) => (Object.hasOwn(files, path) ? files[path] : undefined);
  const files = new Map<string, SliceFile>();
  for (const hunk of hunks) {
    let file = files.get(hunk.filePath);
    if (!file) {
      // By the texts there are, not `fileStatus`: a text the hunk wasn't made from fails the slicer's check anyway.
      const base = text(before, hunk.filePath);
      const head = text(after, hunk.filePath);
      file = {
        path: hunk.filePath,
        ...(base !== undefined ? { base } : {}),
        ...(head !== undefined ? { head } : {}),
        hunks: [],
      };
      files.set(hunk.filePath, file);
    }
    file.hunks.push({ id: hunk.id, header: hunk.expandedHunkHeader, content: hunk.expandedContent });
  }
  return [...files.values()];
}
