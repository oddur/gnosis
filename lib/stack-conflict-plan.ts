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
/** Branches that outlive any PR. A merged release PR from one of them is not a stack parent. */
const LONG_LIVED = /^(main|master|develop|dev|trunk|staging|production|release\/.*)$/;

export interface MergedParent {
  parent: ReviewMember;
  /** The branch the parent merged into, which the PR moves onto. */
  onto: string;
}

/**
 * The merged parent of an open PR that still targets the parent's head branch, so it has to move onto the branch the
 * parent merged into. Once the base changes the row clears. A PR GitHub already moved after a squash merge is not
 * detected. Ignored: a long-lived parent branch, and a parent that merged before the PR was opened.
 */
export function mergedParent(
  subject: Pick<ReviewSubject, 'members' | 'edges'>,
  member: ReviewMember,
  signals?: QueueSignals
): MergedParent | undefined {
  if (!isOpenPr(member)) return undefined;
  const parent = subject.edges
    .filter((edge) => edge.child === member.url)
    .map((edge) => subject.members.find((candidate) => candidate.url === edge.parent))
    .find((candidate) => candidate?.merged);
  if (!parent || LONG_LIVED.test(parent.headBranch) || Date.parse(parent.updatedAt) < Date.parse(member.createdAt)) return undefined;
  const base = current(member, signals)?.readiness?.baseBranch || member.baseBranch;
  const targetsParent = base === parent.headBranch && (!parent.headRepo || !member.baseRepo || parent.headRepo === member.baseRepo);
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
  for (const { member, fresh } of order) {
    const merged = mergedParent(subject, member, fresh);
    if (merged) return { conflicting, step: { kind: 'move', member, merged, text: mergedParentText(member, merged) } };
    if (conflicting.includes(member)) {
      const count = conflicting.length;
      const text = count === 1 ? `#${member.number} has merge conflicts.` : `${count} PRs in this stack conflict. Resolve from the bottom up.`;
      return { conflicting, step: { kind: 'conflicts', member, text } };
    }
  }
  return undefined;
}
