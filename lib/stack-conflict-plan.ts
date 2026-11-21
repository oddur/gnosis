/**
 * What a stack needs before its PRs can merge, from the bottom up: a PR whose parent merged has to move onto the
 * parent's base, and conflicting PRs are resolved lowest first (#445, items 20 and 23). Pure; no Node or Electron.
 */
import { mergeConflictState } from './merge-conflicts';
import type { QueueSignals } from './queue-signals';
import { stackDependencyOrder } from './stack-overview';
import type { ReviewMember, ReviewSubject } from './workbench';

type Signals = (member: ReviewMember) => QueueSignals | undefined;
const isOpen = (member: Pick<ReviewMember, 'state' | 'merged'>) => member.state === 'open' && !member.merged;
/** Signals only for the member's current head. */
const current = (member: ReviewMember, signals: QueueSignals | undefined) =>
  signals && signals.url === member.url && signals.headSha === member.headSha ? signals : undefined;

export interface MergedParent {
  parent: ReviewMember;
  /** The branch the parent merged into, which the PR moves onto. */
  onto: string;
  /** The PR still targets the merged parent's branch. */
  targetsParent: boolean;
  conflicts: boolean;
}

/**
 * The merged parent of an open PR that still has to move: it targets the merged branch, or it conflicts with the
 * branch GitHub moved it to. A PR already moved and clear is not listed, so the row clears once the work is done.
 */
export function mergedParent(
  subject: Pick<ReviewSubject, 'members' | 'edges'>,
  member: ReviewMember,
  signals?: QueueSignals
): MergedParent | undefined {
  if (!isOpen(member)) return undefined;
  const parent = subject.edges
    .filter((edge) => edge.child === member.url)
    .map((edge) => subject.members.find((candidate) => candidate.url === edge.parent))
    .find((candidate) => candidate?.merged);
  if (!parent) return undefined;
  const fresh = current(member, signals);
  const base = fresh?.readiness?.baseBranch || member.baseBranch;
  const targetsParent = base === parent.headBranch && (!parent.headRepo || !member.baseRepo || parent.headRepo === member.baseRepo);
  const conflicts = mergeConflictState(fresh) === 'conflicts';
  if (!targetsParent && !conflicts) return undefined;
  return { parent, onto: parent.baseBranch, targetsParent, conflicts };
}

/** "#101 merged. #102 needs to move onto main." */
export const mergedParentText = (member: Pick<ReviewMember, 'number'>, merged: MergedParent) =>
  `#${merged.parent.number} merged. #${member.number} needs to move onto ${merged.onto}.`;

export type StackPlanStep =
  | { kind: 'move'; member: ReviewMember; merged: MergedParent; text: string }
  | { kind: 'conflicts'; member: ReviewMember; text: string };

/**
 * The stack's next fix, lowest PR first: a move after a merged parent, or a conflict. Once the lowest is resolved and
 * pushed, its fresh status clears it and the plan names the next PR. `undefined` when nothing conflicts or moves.
 */
export function stackConflictPlan(subject: ReviewSubject, signals: Signals): { step: StackPlanStep; conflicting: ReviewMember[] } | undefined {
  const order = stackDependencyOrder(subject).members.filter(isOpen);
  const conflicting = order.filter((member) => mergeConflictState(current(member, signals(member))) === 'conflicts');
  for (const member of order) {
    const merged = mergedParent(subject, member, signals(member));
    if (merged) return { conflicting, step: { kind: 'move', member, merged, text: mergedParentText(member, merged) } };
    if (conflicting.includes(member)) {
      const count = conflicting.length;
      const text = count === 1 ? `#${member.number} has merge conflicts.` : `${count} PRs in this stack conflict. Resolve from the bottom up.`;
      return { conflicting, step: { kind: 'conflicts', member, text } };
    }
  }
  return undefined;
}
