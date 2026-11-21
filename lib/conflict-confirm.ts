import {
  applyChoices,
  chosenText,
  inferChoices,
  parseConflicts,
  withPicks,
  type BlockChoice,
  type BlockPicks,
  type ConflictSegment,
} from './conflict-blocks';
import type { ConflictDiffBlock } from './conflict-diff';
import { hasConflictMarkers, type ConflictFile, type ConflictProposal } from './conflict-resolution';
import type { ConflictBucket } from './conflict-verify';

/**
 * How one conflict reached the update (#445 item 12). Yours: a Keep, or a proposal in Check that you reviewed. Merged
 * for you: a proposal the checks Merged that you did not touch.
 */
export type ConfirmHow = BlockChoice | 'proposal' | 'merged';
export interface ConfirmItem {
  index: number;
  how: ConfirmHow;
  /** Who wrote the proposal, for `proposal` and `merged`. */
  source?: ConflictProposal['source'];
}
/** One file's part of one group: the change from `before` to `after`, with each conflict's lines in `after`. */
export interface ConfirmFile {
  path: string;
  before: string;
  after: string;
  /** The group's conflicts in this file, with their lines in `after` (aligned with `blocks`). */
  items: ConfirmItem[];
  blocks: ConflictDiffBlock[];
  /** The file is yours as a whole: you edited it by hand, or used its whole-file proposal. */
  whole?: 'edited' | 'whole-file';
  /** Conflicts this part accounts for. */
  conflicts: number;
}
export interface ConfirmGroups<P> {
  /** Every conflict you resolved: a Keep, an edit, a whole-file proposal you used, a Check proposal you reviewed. */
  decided: ConfirmFile[];
  /** Proposals the checks Merged, in files you did not edit. */
  merged: ConfirmFile[];
  /** The lines main brings into the conflicted files outside their conflicts. */
  main: ConfirmFile[];
  /** The files Git merged on its own: the preview's files that had no conflict. */
  incoming: P[];
  /**
   * Files that still need you. The confirmation shows no counts while any is left and Push stays off; preparation never
   * opens it with one (the service refuses an unreviewed draft too).
   */
  pending: { path: string; conflicts: number }[];
  counts: { decided: number; merged: number; mainFiles: number };
}

/** A text's lines; a final line feed ends the last line rather than starting another. */
const lineCount = (text: string) => (text ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0);

/**
 * Builds a file from its segments, each conflict as `text(segment)`, and records the lines of the conflicts `track`
 * keeps. Anchors follow conflictDiffText: a conflict with no lines sits under the line before it.
 */
function build(
  segments: ConflictSegment[],
  text: (segment: Extract<ConflictSegment, { kind: 'conflict' }>) => string,
  track: (index: number) => boolean
) {
  let out = '';
  let line = 0;
  const blocks: ConflictDiffBlock[] = [];
  for (const segment of segments) {
    const part = segment.kind === 'text' ? segment.text : text(segment);
    const start = line + 1;
    out += part;
    line += lineCount(part);
    if (segment.kind === 'conflict' && track(segment.index)) blocks.push({ index: segment.index, start, end: line });
  }
  for (const block of blocks)
    block.anchor = block.end >= block.start ? block.end : block.start > 1 ? block.start - 1 : line ? 1 : undefined;
  return { text: out, blocks };
}

/**
 * The push confirmation's three groups (#445 item 12): You decided, Merged for you and Arriving from main.
 *
 * Each conflicted file is split into a chain of versions, so the three diffs add up to the whole update:
 * the PR's version, then main's lines outside the conflicts (Arriving from main), then your conflicts (You decided),
 * then the Merged ones (Merged for you), which ends at the draft. When in doubt a conflict is yours, never Merged:
 * a file you edited by hand or whose whole-file proposal you used is yours as a whole, and so is a proposal in Check
 * in a file you marked reviewed. A file not reviewed, with markers left, or that needs a local merge tool is `pending`.
 */
export function confirmGroups<P extends { name: string; prevName?: string }>(
  files: readonly {
    file: Pick<ConflictFile, 'path' | 'ours' | 'original' | 'result' | 'proposals' | 'wholeFile' | 'unsupported'>;
    /** blockBuckets of the saved draft. */
    buckets: readonly ConflictBucket[];
    /** The file is marked reviewed and its saved draft is the one shown. */
    reviewed: boolean;
    picks?: BlockPicks;
  }[],
  preview: readonly P[]
): ConfirmGroups<P> {
  const groups: ConfirmGroups<P> = {
    decided: [],
    merged: [],
    main: [],
    incoming: [],
    pending: [],
    counts: { decided: 0, merged: 0, mainFiles: 0 },
  };
  for (const { file, buckets, reviewed, picks } of files) {
    const segments = parseConflicts(file.original);
    const conflicts = segments.filter((s) => s.kind === 'conflict');
    if (
      file.unsupported ||
      !reviewed ||
      hasConflictMarkers(file.result) ||
      buckets.includes('decide') ||
      buckets.length !== conflicts.length
    ) {
      groups.pending.push({ path: file.path, conflicts: Math.max(1, conflicts.length) });
      continue;
    }
    const whole = (how: 'edited' | 'whole-file', before: string) =>
      groups.decided.push({
        path: file.path,
        before,
        after: file.result,
        items: [],
        blocks: [],
        whole: how,
        conflicts: conflicts.length,
      });
    // A whole-file proposal also changes lines outside the conflicts: main's lines can't be told apart from it.
    if (file.wholeFile && file.result === file.wholeFile.text) {
      whole('whole-file', file.ours);
      continue;
    }
    // main's lines: Git's merge, with every conflict as the PR's side.
    const withMain = build(segments, (s) => s.block.ours, () => false).text;
    if (withMain !== file.ours)
      groups.main.push({ path: file.path, before: file.ours, after: withMain, items: [], blocks: [], conflicts: 0 });
    const inferred = inferChoices(segments, file.result, file.proposals);
    const choices = inferred && withPicks(segments, inferred, file.proposals, picks);
    if (
      !choices ||
      conflicts.some((s) => !choices[s.index]) ||
      applyChoices(segments, choices, file.proposals) !== file.result
    ) {
      // Edited by hand: the conflicts can't be told apart from your edit, so the file is yours, Merged ones included.
      whole('edited', withMain);
      continue;
    }
    const items = new Map<number, ConfirmItem>();
    for (const s of conflicts) {
      const choice = choices[s.index];
      const source = file.proposals?.[s.index]?.source;
      if (choice === 'proposal')
        // Merged only while its checks say so; a Check proposal in a file you marked reviewed is yours.
        items.set(s.index, { index: s.index, how: buckets[s.index] === 'merged' ? 'merged' : 'proposal', source });
      else if (choice) items.set(s.index, { index: s.index, how: choice });
    }
    const textOf = (s: Extract<ConflictSegment, { kind: 'conflict' }>) => {
      const choice = choices[s.index];
      return choice === 'proposal' ? (file.proposals?.[s.index]?.text ?? '') : chosenText(s.block, choice ?? 'ours');
    };
    const isMerged = (index: number) => items.get(index)?.how === 'merged';
    const mine = build(segments, (s) => (isMerged(s.index) ? s.block.ours : textOf(s)), (i) => !isMerged(i));
    const all = build(segments, textOf, isMerged);
    if (all.text !== file.result) {
      whole('edited', withMain);
      continue;
    }
    const part = (before: string, after: string, blocks: ConflictDiffBlock[]): ConfirmFile => ({
      path: file.path,
      before,
      after,
      blocks,
      items: blocks.flatMap((b) => items.get(b.index) ?? []),
      conflicts: blocks.length,
    });
    if (mine.blocks.length) groups.decided.push(part(withMain, mine.text, mine.blocks));
    if (all.blocks.length) groups.merged.push(part(mine.text, all.text, all.blocks));
  }
  const paths = new Set(files.map((f) => f.file.path));
  groups.incoming = preview.filter((f) => !paths.has(f.name) && !(f.prevName && paths.has(f.prevName)));
  groups.counts = {
    decided: groups.decided.reduce((n, f) => n + f.conflicts, 0),
    merged: groups.merged.reduce((n, f) => n + f.conflicts, 0),
    mainFiles: groups.main.length + groups.incoming.length,
  };
  return groups;
}

/** "2 conflicts in 1 file", "1 file", or "none". */
export function confirmCount(conflicts: number, files: number) {
  if (!conflicts && !files) return 'none';
  const f = `${files} ${files === 1 ? 'file' : 'files'}`;
  return conflicts ? `${conflicts} ${conflicts === 1 ? 'conflict' : 'conflicts'} in ${f}` : f;
}
