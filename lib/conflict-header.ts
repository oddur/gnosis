import { conflictFileStage, type ConflictFile, type ConflictTypeCheck } from './conflict-resolution';
import {
  allMerged,
  blockBuckets,
  bucketSummary,
  fileStatus,
  summarySentence,
  typeCheckFor,
  typeErrorOf,
  waitsForReview,
  withTypeError,
  type ConflictBucket,
  type FileStatus,
  type Verdict,
} from './conflict-verify';
import { verdictKey } from './conflict-verdict-key';
import { conflictFileAction } from './conflict-flow';
import type { SyntaxLanguage } from './syntax-scope';

/**
 * The conflict line in the PR header (#445 item 5), before you open Resolve conflicts. It reads the draft that
 * background preparation saved (src/conflict-precompute.ts) with the conflict dialog's own status and summary.
 */
export type ConflictHeader =
  /** Background preparation runs. `files` once Git has merged. */
  | { state: 'checking'; files?: number }
  /**
   * "3 files have conflicts. 7 of 9 conflicts are merged and checked. 2 need you." `merged`: nothing is left to review,
   * so the action reads Review and push….
   */
  | { state: 'ready'; sentence: string; merged: boolean }
  /** You can't push to the PR branch, so nothing was prepared. */
  | { state: 'no-permission' };

/**
 * One file's entry in `bucketSummary`, from its status and buckets: the same for the conflict dialog and the PR header,
 * so both say the same thing.
 */
export function summaryEntry(
  file: Pick<ConflictFile, 'wholeFile'>,
  status: FileStatus,
  buckets: readonly ConflictBucket[],
  verdict: Verdict | undefined,
  showMerged: boolean
) {
  return {
    buckets,
    verdict,
    reviewed: status.kind === 'reviewed',
    whole: !!file.wholeFile,
    marker: status.kind === 'marker',
    unsupported: status.kind === 'unsupported',
    review: waitsForReview(status, buckets, showMerged),
  };
}

/**
 * Stands in for a verdict the header has none for: nothing runs checks for a header, so such a proposal is to check,
 * never "Checking…". A whole-file proposal stays one proposal to check.
 */
const NOT_CHECKED: Verdict = { merged: false, passed: true, note: 'Not checked yet.' };

/**
 * A prepared draft's line: its files as saved, each with the verdict the main process saved for its proposals and the
 * type check's demotions over it, as the conflict dialog applies them (`typeErrorOf`). `typeCheck`: the PR's type check,
 * null when it is off.
 */
export function conflictHeader(
  files: readonly ConflictFile[],
  disabled: readonly SyntaxLanguage[] = [],
  showMerged = true,
  typeCheck?: ConflictTypeCheck | null
): ConflictHeader {
  let review = false;
  const status = typeCheckFor(typeCheck, files);
  const states = files.map((f) => {
    // The same comparison as the conflict dialog's: the checks' version, the file's language, the proposals and draft.
    const saved = withTypeError(
      f.verdict?.key === verdictKey(f, disabled) ? f.verdict.verdict : undefined,
      typeErrorOf(f, status)
    );
    const verdict = saved ?? (f.proposals || f.wholeFile ? NOT_CHECKED : undefined);
    const buckets = blockBuckets(f, f.result, verdict, undefined, f.edits);
    const stage = conflictFileStage(f);
    const merged = allMerged(buckets);
    // The dialog's own next step for the file. Only a reviewed file, or an all-Merged one that "Show me every merged
    // conflict" off reviews for you, leaves nothing to review.
    const action = conflictFileAction({ stage, otherFilesPending: false, unsupported: !!f.unsupported });
    if (action !== 'confirm' && !(action === 'mark-reviewed' && merged && !showMerged)) review = true;
    return summaryEntry(f, fileStatus(f, f.result, stage, buckets), buckets, verdict, showMerged);
  });
  return {
    state: 'ready',
    sentence: summarySentence(bucketSummary(states)),
    merged: states.length > 0 && !review,
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
