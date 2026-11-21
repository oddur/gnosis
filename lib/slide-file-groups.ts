import type { DiffHunk, DiffSide } from './types';

/** One file block in an Explanation slide: a run of the slide's hunks from one file, in reading order. */
export interface SlideFileGroup {
  filePath: string;
  hunks: DiffHunk[];
  /** Which run of this file it is in the slide: 0 for the first, 1 when the reading order returns to the file. */
  run: number;
  /** Unique in the slide. The first run keys by its path, so state saved before runs existed still applies. */
  key: string;
}

const range = (header: string) => {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(header) as (string | undefined)[] | null;
  if (!match) return undefined;
  return {
    old: Number(match[1]),
    oldCount: Number(match[2] ?? 1),
    new: Number(match[3]),
    newCount: Number(match[4] ?? 1),
  };
};

export const slideFileGroupKey = (filePath: string, run: number) => (run === 0 ? filePath : `${filePath}\u0000${run}`);

/**
 * A slide's hunks keep the planner's reading order, which can move between files (A, B, then A again). Consecutive
 * hunks of one file share a file block; a return to a file starts a new block. So does a hunk listed above the one
 * before it in the same file, because a block always shows its file in line order (reviewGapHunks).
 */
export function groupSlideHunks(hunks: readonly DiffHunk[]): SlideFileGroup[] {
  const groups: SlideFileGroup[] = [];
  const runs = new Map<string, number>();
  let lastStart = -Infinity;
  for (const hunk of hunks) {
    const start = range(hunk.hunkHeader)?.new ?? lastStart;
    const current = groups.at(-1);
    if (current?.filePath === hunk.filePath && start >= lastStart) current.hunks.push(hunk);
    else {
      const run = runs.get(hunk.filePath) ?? 0;
      runs.set(hunk.filePath, run + 1);
      groups.push({ filePath: hunk.filePath, hunks: [hunk], run, key: slideFileGroupKey(hunk.filePath, run) });
    }
    lastStart = start;
  }
  return groups;
}

/** Which run of `filePath` holds `line`, for jumps to a line: the first run whose saved hunks span it, else 0. */
export function slideFileRunOfLine(
  hunks: readonly DiffHunk[],
  filePath: string,
  line: number,
  side?: DiffSide
): number {
  for (const group of groupSlideHunks(hunks)) {
    if (group.filePath !== filePath) continue;
    const spans = group.hunks.some((hunk) => {
      const r = range(hunk.hunkHeader);
      if (!r) return false;
      const inNew = line >= r.new && line < r.new + r.newCount;
      const inOld = line >= r.old && line < r.old + r.oldCount;
      return side === 'LEFT' ? inOld : side === 'RIGHT' ? inNew : inNew || inOld;
    });
    if (spans) return group.run;
  }
  return 0;
}

/** Viewed is per file, so marking a file viewed, or jumping to a line in it, opens or closes all of its blocks. */
export const slideFileKeys = (groups: readonly SlideFileGroup[], filePath: string) =>
  groups.filter((group) => group.filePath === filePath).map((group) => group.key);
