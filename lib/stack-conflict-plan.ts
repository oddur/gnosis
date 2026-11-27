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
 * Branch names that outlive any PR, exactly. A merged PR from one of them, such as a release PR, is not a stack parent
 * while the branch is still there. A parent whose head branch was deleted is one, whatever its name.
 */
const LONG_LIVED = /^(main|master|develop|dev|trunk|next|stable|staging|production|release)$/;

export interface MergedParent {
  parent: ReviewMember;
  /** The branch the parent merged into, which the PR moves onto. */
  onto: string;
}

/** The merged stack parent of an open PR that `mergedParent` may name, before it looks at the PR's base. */
function candidateParent(subject: Pick<ReviewSubject, 'members' | 'edges'>, member: ReviewMember): ReviewMember | undefined {
  if (!isOpenPr(member)) return undefined;
  const parent = subject.edges
    .filter((edge) => edge.child === member.url)
    .map((edge) => subject.members.find((candidate) => candidate.url === edge.parent))
    .find((candidate) => candidate?.merged);
  if (!parent || parent.headRepoUnknown || parent.headBranch === parent.baseBranch) return undefined;
  if (!parent.headRefDeleted && LONG_LIVED.test(parent.headBranch)) return undefined;
  if (parent.headRefDeleted === false && !(Date.parse(parent.mergedAt ?? '') >= Date.parse(member.createdAt))) return undefined;
  return parent;
}

/**
 * The merged parent of a PR that already targets the parent's base, such as one GitHub moved onto main after the
 * parent was squash-merged. Only such a PR can still carry the parent's commits; whether it does takes an ancestry
 * read (`lib/stack-ancestry.ts`). Undefined for every other PR.
 */
export function movedChildParent(
  subject: Pick<ReviewSubject, 'members' | 'edges'>,
  member: ReviewMember
): ReviewMember | undefined {
  const parent = candidateParent(subject, member);
  return parent && parent.baseBranch === member.baseBranch && parent.baseRepo === member.baseRepo && parent.headSha
    ? parent
    : undefined;
}

/**
 * The merged parent of an open PR that has to move onto the branch the parent merged into:
 * - the PR still targets the parent's head branch; once the base changes, this clears;
 * - or the PR already targets the parent's base, such as after GitHub moved it there when the parent was
 *   squash-merged, but its own commits still include the parent's last head commit (`member.parentHeadInPr`, read
 *   for this head and base). Once the PR is moved off those commits, its new head clears this.
 *
 * The base is the PR's own (`member.baseBranch`), never a status read's, so the stack plan, the Overview, Next up and
 * the menu bar always agree. Fail quiet, ignored:
 * - a parent whose head repository is unknown, such as a deleted fork's;
 * - a parent that merged from a branch into itself;
 * - a parent from a long-lived branch that is still there (`LONG_LIVED`);
 * - a parent whose branch lives on and that merged before the PR was opened, or when it merged is unknown;
 * - a PR on the parent's base whose ancestry was not read, could not be read, or is from an older head or base.
 */
export function mergedParent(
  subject: Pick<ReviewSubject, 'members' | 'edges'>,
  member: ReviewMember
): MergedParent | undefined {
  const parent = candidateParent(subject, member);
  if (!parent) return undefined;
  if (parent.baseBranch === member.baseBranch) {
    const carried = member.parentHeadInPr;
    const carries =
      parent.baseRepo === member.baseRepo &&
      carried?.headSha === member.headSha &&
      carried.baseBranch === member.baseBranch &&
      carried.parentHeadSha === parent.headSha;
    return carries ? { parent, onto: member.baseBranch } : undefined;
  }
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
  const order = stackDependencyOrder(subject).members.filter(isOpenPr);
  const conflicting = order.filter((member) => mergeConflictState(current(member, signals(member))) === 'conflicts');
  for (const member of order) {
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
