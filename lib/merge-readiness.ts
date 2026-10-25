import { QUEUE_SIGNALS_TTL, type QueueSignals } from './queue-signals';
import type { ReviewMember, ReviewSubject } from './workbench';

export interface MergeReadiness {
  label: string;
  tone: 'success' | 'danger' | 'warning' | 'muted';
  ready: boolean;
  details: string[];
  checkedAt?: number;
  stale: boolean;
}

/** GitHub evaluates merge policy. Counts of approvals or passing checks cannot replace that decision. */
export function mergeReadiness(
  member: Pick<ReviewMember, 'url' | 'headSha' | 'merged' | 'state' | 'isDraft' | 'baseBranch'>,
  signals?: QueueSignals,
  now = Date.now()
): MergeReadiness {
  const snapshot = signals && signals.url === member.url && signals.headSha === member.headSha ? signals : undefined;
  const status = snapshot?.readiness;
  const checkedAt = status ? snapshot.checkedAt : undefined;
  const stale = checkedAt !== undefined && now - checkedAt >= QUEUE_SIGNALS_TTL;
  const result = (label: string, tone: MergeReadiness['tone'], details: string[], ready = false): MergeReadiness => ({
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
  const conflicts = status.mergeable === 'CONFLICTING' || status.mergeState === 'DIRTY';
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
    details.push(
      status.mergeState === 'CLEAN'
        ? `Behind ${base} by ${status.behindBy} commit${status.behindBy === 1 ? '' : 's'}; updating is optional for merging.`
        : `Behind ${base} by ${status.behindBy} commit${status.behindBy === 1 ? '' : 's'}. GitHub has not confirmed whether an update is required.`
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
      ? `Next: #${next.member.number} ${next.readiness.label.toLowerCase()}${blocked.length ? ` · ${blocked.length} blocked` : ''}`
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
