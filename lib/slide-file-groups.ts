import { parseHunkHeader } from './diff-parse';
import type { ElsewhereChange } from './diff-gaps';
import type { DiffHunk, DiffSide } from './types';

/** One file block in an Explanation slide: some of the slide's hunks from one file, in reading order. */
export interface SlideFileGroup {
  filePath: string;
  hunks: DiffHunk[];
  /** Which block of this file it is in the slide: 0 for the first, 1 when the reading order returns to the file. */
  run: number;
  /** Unique in the slide. The first block keys by its path, so state saved before blocks existed still applies. */
  key: string;
}

/** Inclusive line spans; a side with no lines is the point after its start line (`start > end`). */
interface Span {
  start: number;
  end: number;
}
function spans(hunk: DiffHunk): { old: Span; new: Span } | undefined {
  const header = parseHunkHeader(hunk.hunkHeader);
  if (!header) return undefined;
  const span = (start: number, count: number) =>
    count ? { start, end: start + count - 1 } : { start: start + 1, end: start };
  return { old: span(header.baseStart, header.baseCount), new: span(header.headStart, header.headCount) };
}
/** Two spans share a line or touch. */
const meets = (a: Span, b: Span) => a.start <= b.end + 1 && b.start <= a.end + 1;

export const slideFileGroupKey = (filePath: string, run: number) => (run === 0 ? filePath : `${filePath}\u0000${run}`);

/**
 * A slide's hunks keep the planner's reading order, which can move between files (A, B, then A again). Consecutive
 * hunks of one file share a block, and a return to a file starts a new block; so does a hunk listed above the one
 * before it in its file, because a block shows its file in line order (reviewGapHunks). Hunks of one file that overlap
 * or touch always share a block, wherever the order lists them, so no line shows twice. Blocks are ordered by their
 * first hunk.
 */
export function groupSlideHunks(hunks: readonly DiffHunk[]): SlideFileGroup[] {
  const parent = hunks.map((_, i) => i);
  const root = (i: number): number => (parent[i] === i ? i : (parent[i] = root(parent[i])));
  const join = (a: number, b: number) => {
    const [x, y] = [root(a), root(b)];
    if (x !== y) parent[Math.max(x, y)] = Math.min(x, y);
  };
  const lines = hunks.map(spans);
  for (let i = 1; i < hunks.length; i++) {
    const [before, here] = [lines[i - 1], lines[i]];
    if (hunks[i].filePath === hunks[i - 1].filePath && (!before || !here || here.new.start >= before.new.start))
      join(i - 1, i);
  }
  for (let i = 0; i < hunks.length; i++)
    for (let j = i + 1; j < hunks.length; j++) {
      const [a, b] = [lines[i], lines[j]];
      if (hunks[i].filePath === hunks[j].filePath && a && b && (meets(a.new, b.new) || meets(a.old, b.old))) join(i, j);
    }
  const groups: SlideFileGroup[] = [];
  const byRoot = new Map<number, SlideFileGroup>();
  const runs = new Map<string, number>();
  hunks.forEach((hunk, i) => {
    const existing = byRoot.get(root(i));
    if (existing) return void existing.hunks.push(hunk);
    const run = runs.get(hunk.filePath) ?? 0;
    runs.set(hunk.filePath, run + 1);
    const group = { filePath: hunk.filePath, hunks: [hunk], run, key: slideFileGroupKey(hunk.filePath, run) };
    byRoot.set(root(i), group);
    groups.push(group);
  });
  return groups;
}

/** Each file of a slide: its blocks' keys and all of its hunks, for state that is per file (Viewed, threads). */
export function slideFiles(groups: readonly SlideFileGroup[]) {
  const files = new Map<string, { keys: string[]; hunks: DiffHunk[]; blocks: number }>();
  for (const group of groups) {
    const file = files.get(group.filePath) ?? { keys: [], hunks: [], blocks: 0 };
    file.keys.push(group.key);
    file.hunks.push(...group.hunks);
    file.blocks++;
    files.set(group.filePath, file);
  }
  return files;
}

/** Whether `hunks` span `line` on `side`. */
export function hunksHoldLine(hunks: readonly DiffHunk[], line: number, side: DiffSide): boolean {
  return hunks.some((hunk) => {
    const s = spans(hunk)?.[side === 'LEFT' ? 'old' : 'new'];
    return !!s && line >= s.start && line <= s.end;
  });
}

/** The lines a block spans, `start-end` per hunk on each side, for jumps to find the block that holds a line. */
export function blockRanges(hunks: readonly DiffHunk[]) {
  const all = hunks.flatMap((hunk) => spans(hunk) ?? []);
  const text = (side: 'old' | 'new') => all.map((s) => `${s[side].start}-${s[side].end}`).join(',');
  return { old: text('old'), new: text('new') };
}

/**
 * Which of a file's blocks a jump to `line` lands in: the first that shows the line, trying the new side first unless
 * `side` says which; else the first whose saved hunks span it (`blockRanges`; a collapsed block shows no lines); else
 * the first block.
 */
export function resolveBlock<T>(
  blocks: readonly T[],
  { line, side }: { line?: number; side?: DiffSide },
  shows: (block: T, side: DiffSide) => boolean,
  ranges: (block: T, side: DiffSide) => string | undefined
): T | undefined {
  if (line === undefined || blocks.length < 2) return blocks[0];
  const sides: DiffSide[] = side ? [side] : ['RIGHT', 'LEFT'];
  for (const s of sides) {
    const shown = blocks.find((block) => shows(block, s));
    if (shown) return shown;
  }
  const spans = (text: string | undefined) =>
    !!text &&
    text.split(',').some((range) => {
      const [start, end] = range.split('-').map(Number);
      return line >= start && line <= end;
    });
  for (const s of sides) {
    const saved = blocks.find((block) => spans(ranges(block, s)));
    if (saved) return saved;
  }
  return blocks[0];
}

/** Where a hunk's changes sit, in new-side lines: an added line is its line, a deleted one the new line after it. */
function changeSpans(hunk: DiffHunk): Span[] {
  const start = parseHunkHeader(hunk.hunkHeader)?.headStart;
  if (start === undefined) return [];
  const out: Span[] = [];
  let line = start;
  for (const row of hunk.content.split('\n')) {
    const type = row[0];
    if (type === '\\') continue;
    if (type === '+' || type === '-') {
      const last = out.at(-1);
      if (last && line <= last.end + 1) last.end = Math.max(last.end, line);
      else out.push({ start: line, end: line });
    }
    if (type !== '-') line++;
  }
  return out;
}

/**
 * For each block, the changes other blocks of its file show. A gap over one of them must not reveal its lines as
 * unchanged code (lib/diff-gaps.ts `markElsewhere`).
 */
export function elsewhereChanges(groups: readonly SlideFileGroup[]): Map<string, ElsewhereChange[]> {
  const changes = new Map(groups.map((group) => [group.key, group.hunks.flatMap(changeSpans)]));
  const out = new Map<string, ElsewhereChange[]>();
  for (const group of groups) {
    const others = groups.filter((other) => other.filePath === group.filePath && other.key !== group.key);
    if (others.length)
      out.set(
        group.key,
        others.flatMap((other) => (changes.get(other.key) ?? []).map((span) => ({ ...span, run: other.run })))
      );
  }
  return out;
}
