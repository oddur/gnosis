export type MergeMethod = 'MERGE' | 'SQUASH' | 'REBASE';
export type PrActionKind =
  | 'merge'
  | 'enable-auto'
  | 'disable-auto'
  | 'update-merge'
  | 'update-rebase'
  | 'mark-ready'
  | 'convert-draft'
  /** Close without merging (#390, Needs a decision). It can be reopened on GitHub. */
  | 'close'
  /** A closed PR's header (#542). */
  | 'reopen'
  /** A merged or closed PR's header (#542): its head branch, while it still points at the PR's last commit. */
  | 'delete-branch';
export interface PrActionRevision {
  url: string;
  headSha: string;
  baseSha: string;
  baseBranch: string;
}
export interface PrActionMember extends PrActionRevision {
  number: number;
  title: string;
  headBranch: string;
  state: string;
  isDraft: boolean;
}
export interface PrActionState extends PrActionMember {
  id: string;
  account: string;
  checkedAt: number;
  headRepo: string | null;
  /** Whether this sign-in can push to the head repository. Undefined in states read before it was requested. */
  headRepoCanWrite?: boolean;
  /** Whether the head branch still exists. Undefined in states read before it was requested. */
  headBranchExists?: boolean;
  /** Whether the head branch is its repository's default branch. */
  headIsDefaultBranch?: boolean;
  /** Triage, write, maintain or admin on the repository: enough to reopen a PR. */
  canTriage?: boolean;
  /** Whether the author lets maintainers push to a fork's head branch. Undefined in states read before it was requested. */
  maintainerCanModify?: boolean;
  repository: string;
  archived: boolean;
  canWrite: boolean;
  mergeable: string;
  mergeState: string;
  /** GitHub's review decision for this sign-in. Undefined in states read before it was requested. */
  reviewDecision?: string | null;
  /** The head commit's check rollup (`SUCCESS`, `FAILURE`, `PENDING`…); null when no checks are reported. */
  checkState?: string | null;
  methods: MergeMethod[];
  defaultMethod: MergeMethod;
  autoMerge: MergeMethod | null;
  canEnableAuto: boolean;
  canDisableAuto: boolean;
  canUpdateBranch: boolean;
  canChangeDraft: boolean;
  mergeQueue: boolean;
  inMergeQueue: boolean;
  stack: {
    number: number;
    baseBranch: string;
    members: PrActionMember[];
    complete: boolean;
    mergeQueue: boolean;
  } | null;
}
export interface PrMergePlan {
  target: PrActionState;
  members: PrActionMember[];
  baseBranch: string;
  methods: MergeMethod[];
  mergeQueue: boolean;
  createStack: boolean;
  blockedReason?: string;
}
export interface PrActionRequest {
  account: string;
  kind: PrActionKind;
  url: string;
  revisions: PrActionRevision[];
  method?: MergeMethod;
  commitTitle?: string;
  commitBody?: string;
  createStack?: boolean;
  /** Close only: a comment posted first, such as why. */
  comment?: string;
}
export interface PrActionResult {
  status: 'completed' | 'pending' | 'merged' | 'enqueued';
  message: string;
  operation?: { url: string; uuid: string; members: string[] };
}
export const mergeMethodLabels: Record<MergeMethod, string> = {
  SQUASH: 'Squash and merge',
  MERGE: 'Create a merge commit',
  REBASE: 'Rebase and merge',
};
/**
 * GitHub reports BLOCKED, but every requirement Gnosis can see is met: no review blocker, checks passed or none. GitHub
 * evaluates rules for the account and token asking, so its website can allow this merge while Gnosis's sign-in reads
 * BLOCKED. The merge stays available: GitHub refuses a merge it does not allow, and the dialog shows its reason.
 */
export function blockedButMet(state: Pick<PrActionState, 'mergeable' | 'mergeState' | 'reviewDecision' | 'checkState'>): boolean {
  return (
    state.mergeState === 'BLOCKED' &&
    state.mergeable === 'MERGEABLE' &&
    state.reviewDecision !== undefined &&
    state.reviewDecision !== 'CHANGES_REQUESTED' &&
    state.reviewDecision !== 'REVIEW_REQUIRED' &&
    (state.checkState === null || state.checkState === 'SUCCESS')
  );
}

export const WORKFLOW_MERGE_REASON = 'Needs the workflow permission. Sign in again, or merge on GitHub.';
export const WORKFLOW_REBASE_REASON = 'Needs the workflow permission. Sign in again, or update the branch on GitHub.';

/**
 * GitHub refuses a token without `workflow` any write that creates commits changing `.github/workflows/`. Merging this
 * PR does, and so does rebasing its branch, which rewrites its commits. A merge-commit update only writes the base
 * branch's changes, which Gnosis does not list, so it stays available and GitHub's refusal shows if it comes.
 * `lacksWorkflow` is from `missingScopes`; `workflowFiles` from `changedWorkflowFiles`, undefined while unknown.
 */
export function workflowPermissionReason(
  state: Pick<PrActionState, 'mergeable' | 'mergeState' | 'reviewDecision' | 'checkState' | 'stack'>,
  kind: 'merge' | 'update-rebase',
  lacksWorkflow: boolean,
  workflowFiles: readonly string[] | undefined
): string | undefined {
  if (!lacksWorkflow || !workflowFiles?.length) return undefined;
  if (kind === 'update-rebase') return WORKFLOW_REBASE_REASON;
  // Merging: GitHub's BLOCKED answer, with every visible requirement met, is the workflow scope's doing.
  if (!state.stack && blockedButMet(state)) return WORKFLOW_MERGE_REASON;
}

export function mergeBlockedReason(state: PrActionState): string | undefined {
  if (state.archived) return 'This repository is archived.';
  if (state.state !== 'OPEN') return state.state === 'MERGED' ? 'This PR is already merged.' : 'This PR is closed.';
  if (!state.canWrite) return 'You need write permission to merge this PR.';
  if (state.isDraft) return 'Mark this PR ready for review first.';
  if (state.inMergeQueue) return 'This PR is already in the merge queue.';
  if (state.mergeable === 'CONFLICTING') return 'Resolve merge conflicts before merging.';
  // Stack policy is evaluated atomically by GitHub, including its ultimate base branch.
  if (
    !state.stack &&
    (state.mergeable !== 'MERGEABLE' ||
      (!['CLEAN', 'HAS_HOOKS', 'UNSTABLE'].includes(state.mergeState) && !blockedButMet(state)))
  )
    return 'GitHub has not confirmed this PR is ready to merge. Refresh its status or inspect the merge requirements.';
}

export function singleMergePlan(state: PrActionState): PrMergePlan {
  const index = state.stack?.members.findIndex((m) => m.url === state.url) ?? -1;
  const members = state.stack ? state.stack.members.slice(0, index + 1).filter((m) => m.state !== 'MERGED') : [state];
  return {
    target: state,
    members,
    baseBranch: state.stack?.baseBranch ?? state.baseBranch,
    methods: state.methods,
    mergeQueue: state.stack?.mergeQueue ?? state.mergeQueue,
    createStack: false,
    blockedReason:
      state.stack && (!state.stack.complete || index < 0)
        ? 'The complete GitHub stack could not be loaded.'
        : members.some((m) => m.state !== 'OPEN' || m.isDraft)
          ? 'Every PR to merge must be open and ready for review.'
          : mergeBlockedReason(state),
  };
}

export function draftActionBlockedReason(
  state: PrActionState,
  kind: 'mark-ready' | 'convert-draft'
): string | undefined {
  if (state.archived || state.state !== 'OPEN') return 'Only open PRs in active repositories can change draft status.';
  if (!state.canChangeDraft) return 'Only the PR author or someone with write permission can change draft status.';
  if (state.isDraft !== (kind === 'mark-ready'))
    return state.isDraft
      ? 'This PR is already a draft. Refresh its status.'
      : 'This PR is already ready for review. Refresh its status.';
}

export function branchUpdateBlockedReason(state: PrActionState): string | undefined {
  if (state.archived || state.state !== 'OPEN') return 'Only open PRs in active repositories can update their branch.';
  if (state.mergeable === 'CONFLICTING' || state.mergeState === 'DIRTY')
    return 'Resolve merge conflicts locally or on GitHub before updating this branch.';
  if (!state.canUpdateBranch)
    return 'This branch is up to date, cannot be updated automatically, or you do not have permission.';
}

/** Close: open, in an active repository, and you wrote it or can write to the repository. */
export function closeBlockedReason(state: PrActionState): string | undefined {
  if (state.archived) return 'This repository is archived.';
  if (state.state !== 'OPEN') return state.state === 'MERGED' ? 'This PR is already merged.' : 'This PR is already closed.';
  if (!state.canChangeDraft) return 'Only the PR author or someone with write permission can close this PR.';
}

/** Reopen: closed without merging, in an active repository, and you wrote it or can write to the repository. */
export function reopenBlockedReason(state: PrActionState): string | undefined {
  if (state.archived) return 'This repository is archived.';
  if (state.state !== 'CLOSED') return state.state === 'MERGED' ? 'A merged PR cannot be reopened.' : 'This PR is already open.';
  if (state.headBranchExists === false) return 'Its branch is deleted. Restore the branch on GitHub first.';
  if (!state.canChangeDraft && !state.canTriage) return 'Only the PR author or someone with triage or write permission can reopen this PR.';
}

/** Delete branch: the PR is merged or closed, and its head branch is still there for you to delete. */
export function deleteBranchBlockedReason(state: PrActionState): string | undefined {
  if (state.archived) return 'This repository is archived.';
  if (state.state === 'OPEN') return 'Merge or close this PR before deleting its branch.';
  if (!state.headRepo) return 'The branch’s repository no longer exists.';
  if (state.headBranchExists === false) return 'The branch is already deleted.';
  if (state.headBranchExists === undefined) return 'Refresh this PR to check its branch.';
  if (state.headIsDefaultBranch) return 'This is its repository’s default branch.';
  if (!state.headRepoCanWrite) return 'You need write permission to the branch’s repository.';
}
