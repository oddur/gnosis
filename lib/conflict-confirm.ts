import {
  applyChoices,
  inferChoices,
  parseConflicts,
  pickText,
  withPicks,
  type BlockChoice,
  type BlockPicks,
  type ConflictSegment,
} from './conflict-blocks';
import {
  resolverBaseline,
  segmentsText,
  writtenFileLines,
  writtenLines,
  type ConflictDiffBlock,
  type WrittenBudget,
} from './conflict-diff';
import { conflictFileStage } from './conflict-markers';
import type { ConflictFile, ConflictProposal } from './conflict-resolution';
import type { ConflictBucket } from './conflict-verify';

/**
 * The one rule for "this file still needs you" (#445 item 12): it needs a local merge tool, has a conflict marker
 * left, or is not marked reviewed with the draft shown. Review and push… opens the confirmation only when no file
 * needs you, the confirmation lists such a file as pending, and the file list's Reviewed is the same test
 * (conflictFileStage, which fileStatus reads as its stage). A reviewed file without markers is decided by you, whatever
 * its buckets say: it is never stuck.
 */
export const needsYou = (
  file: Pick<ConflictFile, 'unsupported' | 'result' | 'resolved' | 'path' | 'original' | 'base' | 'ours' | 'theirs'>,
  draft = file.result
) =>
  conflictFileStage(file, draft) !== 'reviewed';

/**
 * How one conflict reached the update. Yours: a Keep, Use the proposal after another choice (`used`), or a proposal in
 * Check in a file you marked reviewed (`proposal`). Merged for you: a proposal the checks Merged that you never touched.
 */
export type ConfirmHow = BlockChoice | 'used' | 'proposal' | 'merged';
export interface ConfirmItem {
  index: number;
  how: ConfirmHow;
  /** Who wrote the proposal, for `used`, `proposal` and `merged`. */
  source?: ConflictProposal['source'];
}
/**
 * What made a file yours as a whole, when its conflicts can't be told apart: your edit (`manual`), the suggestion you
 * used (`agent`, or `mergiraf` asked for again), a remembered resolution (`rerere`), or its whole-file proposal.
 */
export type ConfirmWhole = ConflictFile['source'] | 'whole-file';
/** One file's part of one group: the change from `before` to `after`, with each conflict's lines in `after`. */
export interface ConfirmFile {
  path: string;
  /** main renamed the file: its path on the PR branch. */
  previousPath?: string;
  before: string;
  after: string;
  /** The group's conflicts in this file, aligned with `blocks`, their lines in `after`. */
  items: ConfirmItem[];
  blocks: ConflictDiffBlock[];
  whole?: ConfirmWhole;
  /** Conflicts this part accounts for. */
  conflicts: number;
  /**
   * Lines of `after` a resolver wrote, which neither side had (#445 item 10), in a proposal's conflict. Empty for your
   * Keeps and your own edits. A whole file's marks need line diffs: they are `marks`, computed when its diff shows.
   */
  written: number[];
  /** A file a resolver wrote whole: what its marks are computed from (confirmWritten), only once its diff mounts. */
  marks?: { ours: string; theirs: string; resolver: string };
}

/**
 * The marked lines of one part of the confirmation (#445 item 10): its conflicts' written lines, or for a file written
 * whole, its lines of the resolver's text that neither side had. Called as each file's diff mounts, so opening the
 * confirmation does no line diff; `budget` bounds the diffs of files that mount together, and past it the cautious rule
 * marks (writtenFileLines).
 */
export function confirmWritten(part: Pick<ConfirmFile, 'after' | 'written' | 'marks'>, budget?: WrittenBudget): number[] {
  if (!part.marks) return part.written;
  return [...writtenFileLines(part.after, part.marks.ours, part.marks.theirs, part.marks.resolver, budget)];
}
export interface ConfirmGroups<P> {
  /** Every conflict you resolved: a Keep, an edit, a proposal you used or reviewed, a whole-file result you used. */
  decided: ConfirmFile[];
  /** Proposals the checks Merged that you never touched, in files you did not edit. */
  merged: ConfirmFile[];
  /** main's lines in the conflicted files outside their conflicts, and its renames of them. */
  main: ConfirmFile[];
  /** The files Git merged on its own: the preview's files that had no conflict. */
  incoming: P[];
  /** Files that still need you (needsYou). While any is left the confirmation shows no counts and Push stays off. */
  pending: { path: string; conflicts: number }[];
  counts: { decided: number; merged: number; mainFiles: number };
}

/** How long the confirmation's whole files that mount together may spend on line diffs for their marks. */
export const WRITTEN_BUDGET_MS = 300;

/**
 * The push confirmation's three groups (#445 item 12): You decided, Merged for you and Arriving from main.
 *
 * Each conflicted file is split into a chain of versions, so the three diffs add up to the whole update: the PR's
 * version, then main's lines outside the conflicts (Arriving from main), then your conflicts (You decided), then the
 * Merged ones (Merged for you), which ends at the draft. When in doubt a conflict is yours, never Merged: a file whose
 * conflicts can't be told apart from the rest of the draft is yours as a whole.
 */
export function confirmGroups<P extends { name: string; prevName?: string }>(
  files: readonly {
    file: Pick<
      ConflictFile,
      | 'path'
      | 'base'
      | 'ours'
      | 'theirs'
      | 'original'
      | 'result'
      | 'resolved'
      | 'source'
      | 'proposals'
      | 'wholeFile'
      | 'unsupported'
      | 'resolverText'
    >;
    /** blockBuckets of the saved draft. */
    buckets: readonly ConflictBucket[];
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
  for (const { file, buckets, picks } of files) {
    const segments = parseConflicts(file.original);
    const conflicts = segments.filter((s) => s.kind === 'conflict');
    if (needsYou(file)) {
      groups.pending.push({ path: file.path, conflicts: Math.max(1, conflicts.length) });
      continue;
    }
    const previousPath = preview.find((p) => p.name === file.path && p.prevName && p.prevName !== file.path)?.prevName;
    const named = previousPath ? { previousPath } : {};
    const whole = (how: ConfirmWhole, before: string) =>
      groups.decided.push({
        path: file.path,
        ...named,
        before,
        after: file.result,
        items: [],
        blocks: [],
        whole: how,
        conflicts: conflicts.length,
        // The resolver's lines neither side had are marked, also after you kept or edited parts of its draft; lines you
        // typed never are. They are computed as the file's diff mounts (confirmWritten).
        written: [],
        ...((resolver) => (resolver === undefined ? {} : { marks: { ours: file.ours, theirs: file.theirs, resolver } }))(
          resolverBaseline(file, file.result)
        ),
      });
    // A whole-file proposal also changes lines outside the conflicts: main's lines can't be told apart from it.
    if (file.wholeFile && file.result === file.wholeFile.text) {
      whole('whole-file', file.ours);
      if (previousPath) groups.main.push(mainPart(file.path, named, file.ours, file.ours));
      continue;
    }
    // The PR's side of a conflict at the end of a PR file without a final line feed: Git's markers add one, the file
    // has none.
    const last = segments.at(-1);
    const oursText = (s: Extract<ConflictSegment, { kind: 'conflict' }>) =>
      s === last &&
      !file.ours.endsWith('\n') &&
      s.block.ours.endsWith('\n') &&
      file.ours.endsWith(s.block.ours.slice(0, -1))
        ? s.block.ours.slice(0, -1)
        : s.block.ours;
    // main's lines: Git's merge, with every conflict as the PR's side.
    const withMain = segmentsText(segments, oursText, () => false).after;
    if (withMain !== file.ours || previousPath) groups.main.push(mainPart(file.path, named, file.ours, withMain));
    const inferred = inferChoices(segments, file.result, file.proposals);
    const choices = inferred && withPicks(segments, inferred, file.proposals, picks);
    if (
      !choices ||
      conflicts.some((s) => !choices[s.index]) ||
      applyChoices(segments, choices, file.proposals) !== file.result
    ) {
      // Edited: the conflicts can't be told apart from the rest of the draft, so the file is yours, Merged ones included.
      whole(file.source, withMain);
      continue;
    }
    const items = new Map<number, ConfirmItem>();
    for (const s of conflicts) {
      const choice = choices[s.index];
      const source = file.proposals?.[s.index]?.source;
      if (choice === 'proposal') {
        // Merged only while its checks say so and you never chose anything for it.
        const how = picks?.[s.index] === 'proposal' ? 'used' : buckets[s.index] === 'merged' ? 'merged' : 'proposal';
        items.set(s.index, { index: s.index, how, ...(source ? { source } : {}) });
      } else if (choice) items.set(s.index, { index: s.index, how: choice });
    }
    const isMerged = (index: number) => items.get(index)?.how === 'merged';
    const textOf = (s: Extract<ConflictSegment, { kind: 'conflict' }>) => pickText(s, choices[s.index], file.proposals);
    const mine = segmentsText(segments, (s) => (isMerged(s.index) ? oursText(s) : textOf(s)), (i) => !isMerged(i));
    const all = segmentsText(segments, textOf, isMerged);
    const part = (before: string, after: string, blocks: ConflictDiffBlock[]): ConfirmFile => ({
      path: file.path,
      ...named,
      before,
      after,
      blocks,
      items: blocks.flatMap((b) => items.get(b.index) ?? []),
      conflicts: blocks.length,
      written: blocks.flatMap((b) => {
        const how = items.get(b.index)?.how;
        const segment = conflicts.find((s) => s.index === b.index);
        const text = file.proposals?.[b.index]?.text;
        if (!segment || text === undefined || !(how === 'merged' || how === 'proposal' || how === 'used')) return [];
        return writtenLines(text, segment.block.ours, segment.block.theirs).map((i) => b.start + i);
      }),
    });
    if (mine.blocks.length) groups.decided.push(part(withMain, mine.after, mine.blocks));
    if (all.blocks.length) groups.merged.push(part(mine.after, all.after, all.blocks));
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
const mainPart = (path: string, named: { previousPath?: string }, before: string, after: string): ConfirmFile => ({
  path,
  ...named,
  before,
  after,
  items: [],
  blocks: [],
  conflicts: 0,
  written: [],
});

/** "2 conflicts in 1 file", "1 file", or "none". */
export function confirmCount(conflicts: number, files: number) {
  if (!conflicts && !files) return 'none';
  const f = `${files} ${files === 1 ? 'file' : 'files'}`;
  return conflicts ? `${conflicts} ${conflicts === 1 ? 'conflict' : 'conflicts'} in ${f}` : f;
}

/**
 * What a file Git merged on its own changes, when it has no lines to show (or a mode change beside them): "Binary file
 * changed", "Mode 100644 → 100755", "Renamed, contents unchanged". Undefined for a plain text change.
 */
export function patchNote(patch: {
  type: string;
  hunks: readonly unknown[];
  mode?: string;
  prevMode?: string;
  prevObjectId?: string;
  newObjectId?: string;
}) {
  const parts: string[] = [];
  const lines = patch.hunks.length > 0;
  if (!lines && patch.type !== 'rename-pure' && (patch.prevObjectId || patch.newObjectId))
    parts.push(
      patch.type === 'new' ? 'Binary file added' : patch.type === 'deleted' ? 'Binary file deleted' : 'Binary file changed'
    );
  if (patch.prevMode && patch.mode && patch.prevMode !== patch.mode) parts.push(`Mode ${patch.prevMode} → ${patch.mode}`);
  if (!lines && patch.type === 'rename-pure') parts.push('Renamed, contents unchanged');
  if (!lines && !parts.length) parts.push('No line changes');
  return parts.length ? parts.join(' · ') : undefined;
}

/** A whole file's note in the confirmation: what made it yours. */
export function wholeNote(how: ConfirmWhole, conflicts: number, baseBranch: string) {
  const covers = `It covers ${conflicts} ${conflicts === 1 ? 'conflict' : 'conflicts'}`;
  switch (how) {
    case 'manual':
      return `You edited this file, so its ${conflicts} ${conflicts === 1 ? 'conflict is' : 'conflicts are'} yours.`;
    case 'whole-file':
      return `You used structural merge’s result for the whole file. ${covers} and ${baseBranch}’s other lines in it.`;
    case 'mergiraf':
      return `You used the structural merge’s result for this file. ${covers}.`;
    case 'agent':
      return `You used the suggestion for this file. ${covers}.`;
    case 'rerere':
      return `Your earlier resolution of this file was reused, and you reviewed it. ${covers}.`;
  }
}
