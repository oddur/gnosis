import { conflictFileStage, type ConflictFile } from './conflict-resolution';
import { allMerged, blockBuckets, bucketSummary, fileStatus, summarySentence } from './conflict-verify';
import { verdictKey } from './conflict-verdict-key';
import type { SyntaxLanguage } from './syntax-scope';

/**
 * The conflict line in the PR header (#445 item 5), before you open Resolve conflicts. It reads the draft that
 * background preparation saved (src/conflict-precompute.ts) with the conflict dialog's own status and summary.
 */
export type ConflictHeader =
  /** Background preparation runs. `files` once Git has merged. */
  | { state: 'checking'; files?: number }
  /** "3 files have conflicts. 7 of 9 conflicts are merged and checked. 2 need you." `merged`: every conflict is Merged. */
  | { state: 'ready'; sentence: string; merged: boolean }
  /** You can't push to the PR branch, so nothing was prepared. */
  | { state: 'no-permission' };

/** A prepared draft's line: its files as saved, each with the verdict the main process saved for its proposals. */
export function conflictHeader(
  files: readonly ConflictFile[],
  disabled: readonly SyntaxLanguage[] = []
): ConflictHeader {
  const states = files.map((f) => {
    // The same comparison as the conflict dialog's: the checks' version, the languages off, the proposals and draft.
    const verdict = f.verdict?.key === verdictKey(f, disabled) ? f.verdict.verdict : undefined;
    const stage = conflictFileStage(f);
    const buckets = blockBuckets(f, f.result, verdict);
    const status = fileStatus(f, f.result, stage, buckets);
    return {
      buckets,
      verdict,
      reviewed: status.kind === 'reviewed',
      whole: !!f.wholeFile,
      marker: status.kind === 'marker',
    };
  });
  return {
    state: 'ready',
    sentence: summarySentence(bucketSummary(states)),
    merged: states.length > 0 && states.every((s) => allMerged(s.buckets)),
  };
}

export const NO_PUSH_LINE = 'You can’t push to this branch, so Gnosis can’t resolve its conflicts here.';
/** The header's words: "Checking 3 files…", the summary, or why nothing was prepared. */
export function conflictHeaderLine(header: ConflictHeader): string {
  if (header.state === 'no-permission') return NO_PUSH_LINE;
  if (header.state === 'ready') return header.sentence;
  return header.files === undefined
    ? 'Checking conflicts…'
    : `Checking ${header.files} ${header.files === 1 ? 'file' : 'files'}…`;
}
