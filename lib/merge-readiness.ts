import type { PrStatus } from './types';
import { QUEUE_SIGNALS_TTL, type QueueSignals } from './queue-signals';
import type { ReviewMember, ReviewSubject } from './workbench';
import { hasMergeConflicts } from './merge-conflicts';
import { lacksOrgRead, lacksWorkflow } from './github-access';

export interface MergeReadiness {
  label: string;
  tone: 'success' | 'danger' | 'warning' | 'muted';
  ready: boolean;
  details: string[];
  checkedAt?: number;
  stale: boolean;
  blockedCount?: number;
  /**
   * GitHub reports BLOCKED, yet every requirement Gnosis can see is met: GitHub evaluates merge rules per account and
   * token, so its website can show the PR ready while Gnosis's sign-in reads BLOCKED.
   */
  mismatch?: boolean;
  /** The sign-in lacks `read:org` or `workflow`, which GitHub may need for this merge. Offer "Sign in again". */
  signIn?: boolean;
  /** The PR changes `.github/workflows/` and the sign-in lacks `workflow`: GitHub refuses the merge. */
  needsWorkflow?: boolean;
}

/** Wording for a GitHub-blocked PR that meets every requirement Gnosis can see. */
export const GITHUB_BLOCKED_LABEL = 'GitHub reports this as blocked';
export const GITHUB_BLOCKED_DETAIL =
  'Every requirement Gnosis can see is met. GitHub works out merge rules for the account and access asking, so check the PR on GitHub.';
export const ORG_SCOPE_DETAIL =
  'Gnosis’s sign-in can’t read your organization’s settings, which GitHub may need for this. Sign in again to allow it.';
export const WORKFLOW_LABEL = 'Needs the workflow permission';
export const WORKFLOW_DETAIL =
  'This PR changes GitHub Actions workflows (.github/workflows/…). GitHub only lets sign-ins with the workflow permission merge it.';
/** The sign-in lacks `workflow` and the PR's files are not loaded yet, so Gnosis can't tell whether it matters. */
export const WORKFLOW_SCOPE_DETAIL =
  'Gnosis’s sign-in can’t update workflow files. If this PR changes GitHub Actions workflows, GitHub needs that permission to merge it. Sign in again to allow it.';
/** GitHub allows the merge in these states, so the branch rules do not require an up-to-date branch. */
const MERGE_ALLOWED = ['CLEAN', 'UNSTABLE', 'HAS_HOOKS'];

/** GitHub evaluates merge policy. Counts of approvals or passing checks cannot replace that decision. */
export function mergeReadiness(
  member: Pick<ReviewMember, 'url' | 'headSha' | 'merged' | 'state' | 'isDraft' | 'baseBranch'>,
  signals?: QueueSignals,
  now = Date.now(),
  /** The scopes GitHub reports for Gnosis's sign-in, to explain a BLOCKED answer. See `GitHubAccess`. */
  access?: { scopes?: readonly string[] | null },
  /**
   * This revision's changed paths under `.github/workflows/`, from the Changes inventory. Undefined while the paths
   * are not loaded (or GitHub capped the list before any matched).
   */
  workflowFiles?: readonly string[]
): MergeReadiness {
  const snapshot = signals && signals.url === member.url && signals.headSha === member.headSha ? signals : undefined;
  const status = snapshot?.readiness;
  const checkedAt = status ? snapshot.checkedAt : undefined;
  const stale = checkedAt !== undefined && now - checkedAt >= QUEUE_SIGNALS_TTL;
  const result = (
    label: string,
    tone: MergeReadiness['tone'],
    details: string[],
    ready = false,
    extra: Pick<MergeReadiness, 'mismatch' | 'signIn' | 'needsWorkflow'> = {}
  ): MergeReadiness => ({
    ...extra,
    label: stale && ready ? 'Readiness out of date' : label,
    tone: stale ? 'muted' : tone,
    ready: ready && !stale,
    details: stale ? [`Last reported: ${label}. Refresh status before relying on it.`, ...details] : details,
    checkedAt,
    stale,
  });
  // A cached open status must not make a now-completed bookmark appear mergeable.
  const state = member.merged ? 'MERGED' : member.state === 'closed' ? 'CLOSED' : (status?.state ?? 'OPEN');
  if (state === 'MERGED') return result('Merged', 'muted', ['This PR has already been merged.']);
  if (state === 'CLOSED') return result('Closed', 'muted', ['This PR is closed without merging.']);
  if (!status)
    return result('Readiness unknown', 'muted', ['GitHub merge requirements have not been checked for this revision.']);

  const base = status.baseBranch || member.baseBranch;
  const details: string[] = [];
  const conflicts = hasMergeConflicts(status);
  const updateRequired = status.mergeState === 'BEHIND';
  if (conflicts)
    details.push(
      `Rebase onto ${base}, or merge ${base} into this PR branch, and resolve the conflicts before merging.`
    );
  if (updateRequired)
    details.push(
      `GitHub requires this branch to be up to date with ${base}. Rebase onto ${base}, or merge ${base} into this PR branch, then let required checks run again.`
    );
  if (status.isDraft) details.push('Mark this PR ready for review before merging.');
  if (status.reviewDecision === 'CHANGES_REQUESTED')
    details.push('Changes have been requested. Address the review and obtain the required approval.');
  if (status.reviewDecision === 'REVIEW_REQUIRED')
    details.push('Required approvals are missing or no longer apply to the current changes.');
  if (snapshot.checks.state === 'failure')
    details.push('Some checks are failing. Open GitHub to see which checks are required for merging.');
  if (snapshot.checks.state === 'pending') details.push('Some checks are still running or waiting to start.');
  if (!conflicts && !updateRequired && status.behindBy && status.behindBy > 0) {
    const behind = `Behind ${base} by ${status.behindBy} commit${status.behindBy === 1 ? '' : 's'}`;
    // GitHub reports BEHIND when its rules require an up-to-date branch. A state that allows merging rules that out.
    details.push(
      MERGE_ALLOWED.includes(status.mergeState)
        ? `${behind}; updating is optional for merging.`
        : `${behind}. GitHub hasn’t said whether it must be updated.`
    );
  }
  if (conflicts) return result('Merge conflicts', 'danger', details);
  if (updateRequired) return result('Update required to merge', 'warning', details);
  if (status.isDraft) return result('Draft PR', 'muted', details);
  if (status.reviewDecision === 'CHANGES_REQUESTED') return result('Changes requested', 'danger', details);
  if (status.reviewDecision === 'REVIEW_REQUIRED') return result('Approval required', 'warning', details);
  if (status.queueState)
    return result('In merge queue', 'warning', [
      ...details,
      `GitHub is processing this PR in the merge queue (${status.queueState.toLowerCase().replace(/_/g, ' ')}).`,
    ]);
  // GitHub reports BLOCKED while required checks run. With no review blocker, that is a wait, not a failure.
  if (status.mergeState === 'BLOCKED' && snapshot.checks.state === 'pending')
    return result('Checks running', 'warning', [
      ...details,
      'GitHub blocks merging until required checks finish. Recheck when they complete; other requirements may remain.',
    ]);
  // Rulesets and organization rules are evaluated for the account and token asking. GitHub's website can show the
  // PR ready while Gnosis's sign-in reads BLOCKED, so say what is known instead of a flat "Merge blocked".
  if (
    status.mergeState === 'BLOCKED' &&
    status.mergeable === 'MERGEABLE' &&
    (snapshot.checks.state === 'success' || snapshot.checks.state === 'neutral')
  ) {
    const noWorkflow = lacksWorkflow(access?.scopes);
    // GitHub reports BLOCKED to a token without `workflow` when merging would update workflow files.
    if (noWorkflow && workflowFiles?.length)
      return result(WORKFLOW_LABEL, 'warning', [...details, WORKFLOW_DETAIL], false, {
        mismatch: true,
        signIn: true,
        needsWorkflow: true,
      });
    const noOrg = lacksOrgRead(access?.scopes);
    // Unknown paths: say what the missing scope would mean. Known paths with no workflow files: it doesn't matter.
    const workflowNote = noWorkflow && workflowFiles === undefined;
    return result(
      GITHUB_BLOCKED_LABEL,
      'warning',
      [...details, GITHUB_BLOCKED_DETAIL, ...(noOrg ? [ORG_SCOPE_DETAIL] : []), ...(workflowNote ? [WORKFLOW_SCOPE_DETAIL] : [])],
      false,
      { mismatch: true, signIn: noOrg || workflowNote }
    );
  }
  if (status.mergeState === 'BLOCKED')
    return result('Merge blocked', 'danger', [
      ...details,
      'GitHub reports unmet merge requirements. Open GitHub for the complete list, including repository rules and unresolved conversations.',
    ]);
  if (status.mergeState === 'UNSTABLE')
    return result('Checks need attention', 'warning', [
      ...details,
      'GitHub reports an unstable check state. Inspect required checks on GitHub before merging.',
    ]);
  if (status.mergeState === 'CLEAN' && status.mergeable === 'MERGEABLE') {
    if (status.mergeQueue)
      return result(
        'Ready for merge queue',
        'success',
        [
          ...details,
          'GitHub reports merge requirements satisfied. Add this PR to its base branch’s merge queue on GitHub.',
        ],
        true
      );
    return result(
      'Ready to merge',
      'success',
      [
        ...details,
        'GitHub reports merge requirements satisfied for this revision. Your permissions and available merge methods are checked on GitHub.',
      ],
      true
    );
  }
  return result('Readiness unknown', 'muted', [
    ...details,
    status.mergeState === 'HAS_HOOKS'
      ? 'Repository hooks may impose additional requirements. Check merge eligibility on GitHub.'
      : 'GitHub has not finished evaluating merge requirements. Refresh status shortly.',
  ]);
}

export function subjectReadiness(subject: ReviewSubject, signals: QueueSignals[], now = Date.now()): MergeReadiness {
  const members = subject.members.map((member) => ({
    member,
    readiness: mergeReadiness(
      member,
      signals.find((s) => s.url === member.url && s.headSha === member.headSha),
      now
    ),
  }));
  if (subject.kind !== 'stack' || members.length === 1) return members[0].readiness;
  const remaining = members.filter(({ readiness }) => !['Merged', 'Closed'].includes(readiness.label));
  const next = remaining.find(
    ({ member, readiness }) =>
      readiness.ready &&
      !subject.edges.some(
        (edge) =>
          edge.child === member.url && members.find((m) => m.member.url === edge.parent)?.readiness.label !== 'Merged'
      )
  );
  const checked = members.flatMap(({ readiness }) => (readiness.checkedAt === undefined ? [] : [readiness.checkedAt]));
  const stale = members.some(({ readiness }) => readiness.stale);
  const unknown = remaining.some((m) => m.readiness.stale || m.readiness.label === 'Readiness unknown');
  const blocked = remaining.filter(
    (m) => !m.readiness.ready && !m.readiness.stale && m.readiness.label !== 'Readiness unknown'
  );
  return {
    label: next
      ? `Next: #${next.member.number} ${next.readiness.label.toLowerCase()}`
      : remaining.length
        ? blocked.length
          ? 'Stack has merge blockers'
          : unknown
            ? 'Stack readiness unknown'
            : 'Waiting on base PR'
        : members.every((m) => m.readiness.label === 'Merged')
          ? 'Stack merged'
          : 'Stack closed',
    tone: next
      ? 'success'
      : remaining.some((m) => m.readiness.tone === 'danger')
        ? 'danger'
        : blocked.length
          ? 'warning'
          : 'muted',
    ready: !!next,
    blockedCount: next ? blocked.length : undefined,
    checkedAt: checked.length === members.length ? Math.min(...checked) : undefined,
    stale,
    details: [
      ...members.map(
        ({ member, readiness }) => `#${member.number}: ${readiness.label}${readiness.stale ? ' (out of date)' : ''}.`
      ),
      'Merge from the base upward. Recheck remaining PRs after each merge; their base and requirements may change.',
    ],
  };
}

export function memberReadiness(
  member: ReviewMember,
  status?: PrStatus,
  _error?: string,
  signals?: QueueSignals
): string {
  return mergeReadiness(member, signals ?? status?.signals).label;
}

