import {
  applyChoices,
  chosenText,
  conflictCount,
  inferChoices,
  parseConflicts,
  type ConflictSegment,
} from './conflict-blocks';
import {
  hasConflictMarkers,
  type ConflictFile,
  type ConflictProposal,
  type ConflictSession,
} from './conflict-resolution';

/** Service errors. The workspace matches them to plain copy in `describeConflictError`. */
export const HEAD_MOVED = 'The PR branch has new commits since you started. Nothing was pushed.';
export const RETARGETED = 'The PR now targets a different base branch. Nothing was pushed.';
export const BASE_KEEPS_MOVING = 'The base branch kept moving while Gnosis merged it again. Nothing was pushed.';
/** How many times publishing merges a moving base branch again before it gives up. */
export const BASE_MOVE_ROUNDS = 3;

/** The revisions a draft was prepared from, and the revisions GitHub reports now. */
type Revisions = Pick<ConflictSession, 'headSha' | 'baseSha' | 'headRepo' | 'headBranch' | 'baseBranch' | 'baseRepo'>;
interface LiveRevisions {
  headSha: string;
  baseSha: string;
  headRepo?: string | null;
  headBranch: string;
  baseBranch: string;
  repository: string;
}

/**
 * What changed since a draft was prepared. Someone pushing to the PR, or retargeting it, blocks publishing until the
 * user loads the new code. New commits on the base branch alone do not: Gnosis merges them again and reuses the
 * user's resolutions, because on a busy base branch this happens every few minutes.
 */
export type RevisionChange = 'none' | 'base-moved' | 'head-moved' | 'retargeted';
export function revisionChange(draft: Revisions, live: LiveRevisions): RevisionChange {
  if (live.headRepo !== draft.headRepo || live.headBranch !== draft.headBranch || live.headSha !== draft.headSha)
    return 'head-moved';
  if (live.baseBranch !== draft.baseBranch || live.repository !== draft.baseRepo) return 'retargeted';
  return live.baseSha === draft.baseSha ? 'none' : 'base-moved';
}

/** Git's marker labels name commits, which change when the base moves. Blocks match on their text alone. */
const blockKey = (segment: Extract<ConflictSegment, { kind: 'conflict' }>) =>
  JSON.stringify([segment.block.ours, segment.block.base ?? null, segment.block.theirs]);

/**
 * The text that replaced each conflict block in `result`, or undefined when the text around the blocks was edited
 * too. An entry is undefined when that block is still open in the result, or when the result can be split in more
 * than one way around it.
 */
export function blockResolutions(segments: ConflictSegment[], result: string): (string | undefined)[] | undefined {
  // Whole-side choices are exact; free text between unchanged lines is the fallback for edits and suggestions.
  const choices = inferChoices(segments, result);
  if (choices)
    return segments.flatMap((s) => {
      if (s.kind !== 'conflict') return [];
      const choice = choices[s.index];
      return [choice && choice !== 'proposal' ? chosenText(s.block, choice) : undefined];
    });
  // Every way the result can be split into the unchanged texts and the blocks between them. A block is known only
  // when every split agrees on where it starts and ends: text between blocks such as a lone "\n" can match in
  // several places, and the earliest match would cut a resolution short.
  const ends = (i: number, at: number): number[] => {
    const segment = segments[i];
    if (segment.kind === 'text') return result.startsWith(segment.text, at) ? [at + segment.text.length] : [];
    const next = segments.at(i + 1);
    if (!next) return [result.length];
    const found: number[] = [];
    if (next.kind === 'text') {
      for (let end = result.indexOf(next.text, at); end >= 0; end = result.indexOf(next.text, end + 1)) found.push(end);
    } else {
      // Two blocks with no text between them can only be split where a whole-side choice ends.
      for (const text of [
        segment.block.raw,
        ...(['ours', 'theirs', 'both'] as const).map((c) => chosenText(segment.block, c)),
      ])
        if (result.startsWith(text, at)) found.push(at + text.length);
    }
    return found;
  };
  const memo = new Map<string, boolean>();
  const completes = (i: number, at: number): boolean => {
    if (i === segments.length) return at === result.length;
    const key = `${i}:${at}`;
    let known = memo.get(key);
    if (known === undefined) {
      known = ends(i, at).some((end) => completes(i + 1, end));
      memo.set(key, known);
    }
    return known;
  };
  if (!completes(0, 0)) return undefined;
  const spans = new Map<number, Set<string>>();
  let positions = new Set([0]);
  for (let i = 0; i < segments.length; i++) {
    const next = new Set<number>();
    const segment = segments[i];
    for (const at of positions)
      for (const end of ends(i, at)) {
        if (!completes(i + 1, end)) continue;
        next.add(end);
        if (segment.kind === 'conflict')
          spans.set(segment.index, (spans.get(segment.index) ?? new Set()).add(`${at}:${end}`));
      }
    positions = next;
  }
  return segments.flatMap((s) => {
    if (s.kind !== 'conflict') return [];
    const only = spans.get(s.index);
    if (only?.size !== 1) return [undefined];
    const [at, end] = [...only][0].split(':').map(Number);
    const text = result.slice(at, end);
    return [text === s.block.raw ? undefined : text];
  });
}

export interface CarriedFile {
  file: ConflictFile;
  /** Conflict blocks that reuse the user's earlier result. */
  reused: number;
  /** Conflict blocks the user still has to resolve. */
  open: number;
  /** False when the earlier draft could not be matched block by block. */
  mapped: boolean;
}

/**
 * Moves a draft onto a fresh merge of the same file. A block whose three sides are unchanged keeps the user's result;
 * any other block stays open. The file stays reviewed only when `keepReview` is set and every block was reused.
 */
export function carryFile(old: ConflictFile | undefined, next: ConflictFile, keepReview: boolean): CarriedFile {
  if (next.unsupported || !old || old.unsupported)
    return { file: next, reused: 0, open: next.unsupported ? 0 : conflictCount(next.original), mapped: !old };
  const oldSegments = parseConflicts(old.original);
  const resolutions = blockResolutions(oldSegments, old.result);
  const segments = parseConflicts(next.original);
  if (!resolutions) return { file: next, reused: 0, open: conflictCount(next.original), mapped: false };
  const available = new Map<string, string[]>();
  for (const segment of oldSegments) {
    if (segment.kind !== 'conflict') continue;
    const text = resolutions[segment.index];
    if (text === undefined || hasConflictMarkers(text)) continue;
    const key = blockKey(segment);
    available.set(key, [...(available.get(key) ?? []), text]);
  }
  let reused = 0;
  let open = 0;
  const result = segments
    .map((segment) => {
      if (segment.kind === 'text') return segment.text;
      const text = available.get(blockKey(segment))?.shift();
      if (text === undefined) {
        // Not carried: the fresh merge's proposal for it, if any, as preparation left it. It still needs you.
        open++;
        return next.proposals?.[segment.index]?.text ?? segment.block.raw;
      }
      reused++;
      return text;
    })
    .join('');
  return { file: withResult(old, next, result, keepReview && open === 0 && old.resolved), reused, open, mapped: true };
}

/** The fresh merge with an earlier result. Source and explanation stay when the user's result carried over. */
export function withResult(old: ConflictFile, next: ConflictFile, result: string, resolved: boolean): ConflictFile {
  const carried = result !== next.original;
  return {
    ...next,
    result,
    resolved: resolved && !hasConflictMarkers(result),
    source: carried ? old.source : next.source,
    ...(carried && old.explanation ? { explanation: old.explanation } : {}),
  };
}

/**
 * Rewrites the marker lines of `text` with the labels used in `sample`, so a three-way merge of two conflict files
 * from different base commits sees only real content changes.
 */
export function relabelMarkers(text: string, sample: string) {
  const labels: Record<string, string> = {};
  for (const line of sample.split(/(?<=\n)/)) {
    const char = /^([<|>])\1{6}(?:[ \t]|\r?\n|$)/.exec(line)?.[1];
    if (char && !(char in labels)) labels[char] = line.replace(/\r?\n$/, '');
  }
  return text
    .split(/(?<=\n)/)
    .map((line) => {
      const char = /^([<|>])\1{6}(?:[ \t]|\r?\n|$)/.exec(line)?.[1];
      if (!char || !labels[char]) return line;
      return labels[char] + (/\r\n$/.test(line) ? '\r\n' : line.endsWith('\n') ? '\n' : '');
    })
    .join('');
}

/**
 * A resolver's whole-file output as per-block proposals of Git's conflict. Undefined when the text outside the blocks
 * differs from Git's merge (the resolver touched lines Git had merged) or when no block was resolved. A block the
 * resolver left conflicted has no proposal.
 */
export function blockProposals(original: string, output: string, source: ConflictProposal['source']) {
  const resolutions = blockResolutions(parseConflicts(original), output);
  const proposals = resolutions?.map((text) =>
    text === undefined || hasConflictMarkers(text) ? null : { source, text }
  );
  return proposals?.some(Boolean) ? proposals : undefined;
}

/** Git's conflict with these proposals in place; other blocks keep their markers. */
export function withProposals(original: string, proposals: readonly (ConflictProposal | null)[]) {
  return applyChoices(
    parseConflicts(original),
    proposals.map((p) => (p ? 'proposal' : undefined)),
    proposals
  );
}
