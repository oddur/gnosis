/**
 * What a stack needs before its PRs can merge, from the bottom up: a PR whose parent merged has to move onto the
 * parent's base, and conflicting PRs are resolved lowest first (#445, items 20 and 23). Pure; no Node or Electron.
 */
import { mergeConflictState } from './merge-conflicts';
import { isOpenPr } from './pr-lifecycle';
import type { QueueSignals } from './queue-signals';
import { stackDependencyOrder } from './stack-overview';
import type { ReviewMember, ReviewSubject } from './workbench';

/** Signals only for the member's current head. */
const current = (member: ReviewMember, signals: QueueSignals | undefined) =>
  signals?.headSha === member.headSha ? signals : undefined;
/**
 * Branch names that outlive any PR. A merged PR from one of them, such as a release PR, is not a stack parent while the
 * branch is still there. A parent whose head branch was deleted is one, whatever its name.
 */
const LONG_LIVED =
  /^(main|master|develop|dev|trunk|next|stable|canary|beta|alpha|staging|production|prod|qa|uat|(release|releases|support|hotfix)\/.+|release-.+)$/;

export interface MergedParent {
  parent: ReviewMember;
  /** The branch the parent merged into, which the PR moves onto. */
  onto: string;
}

/**
 * The merged parent of an open PR that still targets the parent's head branch, so it has to move onto the branch the
 * parent merged into. Once the base changes the row clears. Ignored: a parent from a long-lived branch that is still
 * there (`LONG_LIVED`). The base is the PR's own (`member.baseBranch`), never a status read's, so the stack plan, the
 * Overview, Next up and the menu bar always agree.
 *
 * Not detected yet: a PR GitHub moved onto main after its parent was squash-merged. It still carries the parent's
 * commits, but telling that needs an ancestry read that no queue read makes yet.
 */
export function mergedParent(
  subject: Pick<ReviewSubject, 'members' | 'edges'>,
  member: ReviewMember
): MergedParent | undefined {
  if (!isOpenPr(member)) return undefined;
  const parent = subject.edges
    .filter((edge) => edge.child === member.url)
    .map((edge) => subject.members.find((candidate) => candidate.url === edge.parent))
    .find((candidate) => candidate?.merged);
  if (!parent || (!parent.headRefDeleted && LONG_LIVED.test(parent.headBranch))) return undefined;
  const targetsParent =
    member.baseBranch === parent.headBranch && (!parent.headRepo || !member.baseRepo || parent.headRepo === member.baseRepo);
  return targetsParent ? { parent, onto: parent.baseBranch } : undefined;
}

/**
 * The one wording for a PR whose parent merged:
 * - `sentence`, the stack plan: "#101 merged. #102 needs to move onto main."
 * - `reason`, Next up and the Overview: "needs to move onto main after #101 merged"
 * - `short`, the menu bar: "Parent #101 merged"
 */
export function mergedParentText(member: Pick<ReviewMember, 'number'>, merged: MergedParent, form: 'sentence' | 'reason' | 'short' = 'sentence') {
  const parent = `#${merged.parent.number}`;
  if (form === 'short') return `Parent ${parent} merged`;
  if (form === 'reason') return `needs to move onto ${merged.onto} after ${parent} merged`;
  return `${parent} merged. #${member.number} needs to move onto ${merged.onto}.`;
}

export type StackPlanStep =
  | { kind: 'move'; member: ReviewMember; merged: MergedParent; text: string }
  | { kind: 'conflicts'; member: ReviewMember; text: string };

/**
 * The stack's next fix, lowest PR first: a move after a merged parent, or a conflict. A PR that has to move moves
 * first, even when it conflicts: it is resolved on its new base. Once the lowest is resolved and pushed, its fresh
 * status clears it and the plan names the next PR. `undefined` when nothing conflicts or moves.
 */
export function stackConflictPlan(
  subject: ReviewSubject,
  signals: (member: ReviewMember) => QueueSignals | undefined
): { step: StackPlanStep; conflicting: ReviewMember[] } | undefined {
  const order = stackDependencyOrder(subject).members.filter(isOpenPr).map((member) => ({ member, fresh: current(member, signals(member)) }));
  const conflicting = order.filter(({ fresh }) => mergeConflictState(fresh) === 'conflicts').map(({ member }) => member);
  for (const { member } of order) {
    const merged = mergedParent(subject, member);
    if (merged) return { conflicting, step: { kind: 'move', member, merged, text: mergedParentText(member, merged) } };
    if (conflicting.includes(member)) {
      const count = conflicting.length;
      const text = count === 1 ? `#${member.number} has merge conflicts.` : `${count} PRs in this stack conflict. Resolve from the bottom up.`;
      return { conflicting, step: { kind: 'conflicts', member, text } };
    }
  }
  return undefined;
}
