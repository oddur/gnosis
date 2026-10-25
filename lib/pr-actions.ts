export type MergeMethod = 'MERGE' | 'SQUASH' | 'REBASE';
export type PrActionKind = 'merge' | 'enable-auto' | 'disable-auto' | 'update-merge' | 'update-rebase';
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
  repository: string;
  archived: boolean;
  canWrite: boolean;
  mergeable: string;
  mergeState: string;
  methods: MergeMethod[];
  defaultMethod: MergeMethod;
  autoMerge: MergeMethod | null;
  canEnableAuto: boolean;
  canDisableAuto: boolean;
  canUpdateBranch: boolean;
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
export function mergeBlockedReason(state: PrActionState): string | undefined {
  if (state.archived) return 'This repository is archived.';
  if (state.state !== 'OPEN') return state.state === 'MERGED' ? 'This PR is already merged.' : 'This PR is closed.';
  if (!state.canWrite) return 'You need write permission to merge this PR.';
  if (state.isDraft) return 'Mark this PR ready for review on GitHub first.';
  if (state.inMergeQueue) return 'This PR is already in the merge queue.';
  if (state.mergeable === 'CONFLICTING') return 'Resolve merge conflicts before merging.';
  // Stack policy is evaluated atomically by GitHub, including its ultimate base branch.
  if (
    !state.stack &&
    (state.mergeable !== 'MERGEABLE' || !['CLEAN', 'HAS_HOOKS', 'UNSTABLE'].includes(state.mergeState))
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
