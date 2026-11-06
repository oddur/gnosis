import { stackMergeStatus } from './stack-merge-status';
import { stackMemberStatus } from './stack-member-status';
import { stackDependencyOrder } from './stack-overview';
import type { ReviewSubject } from './workbench';
import type { QueueSignals } from './queue-signals';
import type { PrChecks } from './pr-checks';

/** This is guidance from current evidence, never permission to merge or modify a PR. */
export function stackMergePlan(
  subject: ReviewSubject,
  signals: QueueSignals[],
  checks: Record<string, PrChecks | undefined>,
  now: number
) {
  const entries = stackDependencyOrder(subject)
    .members.map((member) => ({
      member,
      facts: stackMemberStatus(
        member,
        signals.find((s) => s.url === member.url),
        checks[member.url],
        now
      ),
    }))
    .filter((entry) => !entry.facts.finished);
  const labels = [
    ['conflicts', 'Resolve merge conflicts'],
    ['update', 'Update branches that require it'],
    ['draft', 'Mark drafts ready for review'],
    ['checks', 'Resolve required check failures'],
    ['check-status', 'Confirm which checks are required'],
    ['review', 'Obtain required approvals'],
    ['rules', 'Resolve other GitHub requirements'],
    ['waiting', 'Wait for required checks'],
    ['queue', 'Wait for the GitHub merge queue'],
    ['refresh', 'Merge status not confirmed'],
  ] as const;
  const groups = labels
    .map(([key, label]) => ({
      key,
      label,
      entries: entries
        .filter(({ facts }) => {
          if (key === 'refresh')
            return facts.readiness.stale || !facts.policy || facts.readiness.label === 'Readiness unknown';
          if (key === 'check-status') return facts.checksUnconfirmed;
          if (key === 'waiting') return facts.requiredRunning.length > 0;
          if (key === 'queue') return !!facts.policy?.queueState;
          return facts.blockers.some((blocker) => blocker.key === key);
        })
        .map((entry) => {
          const { facts } = entry;
          const detail =
            key === 'refresh'
              ? facts.readiness.stale
                ? 'Saved merge status is out of date.'
                : !facts.policy
                  ? 'Merge status has not been loaded for these commits.'
                  : facts.policy.mergeState === 'HAS_HOOKS'
                    ? 'Repository hooks may impose additional merge requirements.'
                    : 'GitHub has not finished evaluating whether this PR can merge.'
              : key === 'waiting'
                ? `${facts.requiredRunning.length} required ${facts.requiredRunning.length === 1 ? 'check is' : 'checks are'} still running or queued.`
                : key === 'check-status'
                  ? 'GitHub reports check issues. Open the PR to inspect required checks.'
                  : key === 'queue'
                    ? `GitHub merge queue: ${facts.policy?.queueState?.toLowerCase().replace(/_/g, ' ')}.`
                    : facts.blockers.find((blocker) => blocker.key === key)?.text;
          return { ...entry, detail };
        }),
    }))
    .filter((group) => group.entries.length);
  const remaining = entries.filter(({ facts }) => !facts.readiness.ready);
  const checkSnapshots = entries.flatMap(({ member }) => {
    const snapshot = checks[member.url];
    return snapshot?.url === member.url && snapshot.headSha === member.headSha ? [snapshot] : [];
  });
  return {
    status: stackMergeStatus(subject, signals, checks, now),
    groups,
    entries,
    ready: entries.length > 0 && !remaining.length,
    checksCheckedAt:
      checkSnapshots.length === entries.length && entries.length
        ? Math.min(...checkSnapshots.map((s) => s.checkedAt))
        : undefined,
    loadedChecks: checkSnapshots.length,
  };
}
