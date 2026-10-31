import { checkGroup, type PrChecks } from './pr-checks';
import { mergeReadiness } from './merge-readiness';
import { QUEUE_SIGNALS_TTL, type QueueSignals } from './queue-signals';
import type { ReviewMember } from './workbench';

export function stackMemberStatus(
  member: ReviewMember,
  signal: QueueSignals | undefined,
  checks: PrChecks | undefined,
  now: number
) {
  const readiness = mergeReadiness(member, signal, now);
  const current =
    signal?.url === member.url && signal.headSha === member.headSha && now - signal.checkedAt < QUEUE_SIGNALS_TTL
      ? signal
      : undefined;
  const policy = current?.readiness;
  const finished =
    member.merged || member.state === 'closed' || policy?.state === 'MERGED' || policy?.state === 'CLOSED';
  const checkList =
    checks?.url === member.url && checks.headSha === member.headSha && now - checks.checkedAt < QUEUE_SIGNALS_TTL
      ? checks.checks
      : undefined;
  const attention = checkList?.filter((check) => checkGroup(check) === 'attention') ?? [];
  const cancelled = attention.filter((check) => check.conclusion === 'cancelled');
  const failed = attention.filter((check) => check.conclusion !== 'cancelled');
  const running = checkList?.filter((check) => checkGroup(check) === 'running').length ?? 0;
  const passed = checkList?.filter((check) => checkGroup(check) === 'passed').length ?? 0;
  const skipped =
    checkList?.filter((check) => check.status === 'completed' && check.conclusion === 'skipped').length ?? 0;
  const neutral =
    checkList?.filter((check) => check.status === 'completed' && check.conclusion === 'neutral').length ?? 0;
  const required = attention.filter((check) => check.required === true);
  const requiredFailed = required.filter((check) => check.conclusion !== 'cancelled').length;
  const requiredCancelled = required.length - requiredFailed;
  const requiredRunning =
    !finished && !readiness.ready
      ? (checkList?.filter((check) => check.required === true && checkGroup(check) === 'running') ?? [])
      : [];
  const blockers: { key: string; text: string }[] = [];
  if (!finished && policy) {
    if (policy.isDraft) blockers.push({ key: 'draft', text: 'Still a draft' });
    if (policy.mergeable === 'CONFLICTING' || policy.mergeState === 'DIRTY')
      blockers.push({ key: 'conflicts', text: `Conflicts with ${policy.baseBranch || member.baseBranch}` });
    if (policy.mergeState === 'BEHIND')
      blockers.push({
        key: 'update',
        text: `Update from ${policy.baseBranch || member.baseBranch} required`,
      });
    if (policy.reviewDecision === 'CHANGES_REQUESTED')
      blockers.push({ key: 'review', text: 'Changes requested — address feedback and obtain approval' });
    if (policy.reviewDecision === 'REVIEW_REQUIRED')
      blockers.push({ key: 'review', text: 'Required approval missing or outdated' });
    if (policy.mergeState === 'BLOCKED' && !blockers.length && !required.length && !requiredRunning.length)
      blockers.push({
        key: 'rules',
        text: 'Other GitHub merge requirements are not met',
      });
  }
  if (!finished && !readiness.ready && required.length)
    blockers.push({
      key: 'checks',
      text: [
        requiredFailed && `${requiredFailed} required ${requiredFailed === 1 ? 'check' : 'checks'} failed`,
        requiredCancelled && `${requiredCancelled} required ${requiredCancelled === 1 ? 'check' : 'checks'} cancelled`,
      ]
        .filter(Boolean)
        .join(' · '),
    });
  const branch = finished
    ? { label: member.merged || policy?.state === 'MERGED' ? 'Merged' : 'Closed', tone: 'muted' }
    : !policy
      ? { label: readiness.stale ? 'Status needs refresh' : 'Not confirmed', tone: 'muted' }
      : policy.mergeable === 'CONFLICTING' || policy.mergeState === 'DIRTY'
        ? { label: 'Conflicts', tone: 'danger' }
        : policy.mergeState === 'BEHIND'
          ? { label: 'Update required', tone: 'danger' }
          : policy.behindBy
            ? {
                label: `${policy.behindBy} behind`,
                detail: policy.mergeState === 'CLEAN' ? 'Update optional' : 'Requirement unknown',
                tone: 'muted',
              }
            : policy.behindBy === 0
              ? { label: 'Up to date', tone: 'muted' }
              : policy.mergeable === 'MERGEABLE'
                ? { label: 'No conflicts', tone: 'muted' }
                : { label: 'Not confirmed', tone: 'muted' };
  const checkLabel = checkList
    ? [
        failed.length && `${failed.length} failed`,
        cancelled.length && `${cancelled.length} cancelled`,
        running && `${running} running`,
      ]
        .filter(Boolean)
        .join(' · ') ||
      (checkList.length
        ? [passed && `${passed} passed`, skipped && `${skipped} skipped`, neutral && `${neutral} neutral`]
            .filter(Boolean)
            .join(' · ')
        : 'No checks reported')
    : checks
      ? 'Checks need refresh'
      : current?.checks.state === 'failure'
        ? 'Checks did not pass'
        : current?.checks.state === 'pending'
          ? 'Checks running'
          : 'Checks not loaded';
  return {
    readiness,
    policy,
    finished,
    checkList,
    attention,
    required,
    requiredRunning,
    checksUnconfirmed:
      !!policy &&
      !finished &&
      !readiness.ready &&
      readiness.label === 'Checks need attention' &&
      !required.length &&
      !requiredRunning.length,
    blockers,
    branch,
    checkLabel,
    checksTone:
      !finished && !readiness.ready && required.length
        ? 'danger'
        : attention.length || current?.checks.state === 'failure'
          ? 'warning'
          : 'muted',
  };
}

export function stackStatusReasons(
  members: ReviewMember[],
  signals: QueueSignals[],
  checks: Record<string, PrChecks | undefined>,
  now: number
) {
  const facts = members
    .map((member) =>
      stackMemberStatus(
        member,
        signals.find((s) => s.url === member.url),
        checks[member.url],
        now
      )
    )
    .filter((value) => !value.finished);
  const count = (key: string) => facts.filter((value) => value.blockers.some((b) => b.key === key)).length;
  const plural = (n: number, one: string, many: string) => (n ? `${n} ${n === 1 ? one : many}` : '');
  const unknown = facts.filter(
    (value) => value.readiness.stale || !value.policy || value.readiness.label === 'Readiness unknown'
  ).length;
  return [
    plural(count('draft'), 'draft PR', 'draft PRs'),
    plural(count('conflicts'), 'PR with conflicts', 'PRs with conflicts'),
    plural(count('update'), 'branch update required', 'branch updates required'),
    plural(count('review'), 'PR needs approval', 'PRs need approval'),
    plural(count('checks'), 'PR blocked by checks', 'PRs blocked by checks'),
    plural(count('rules'), 'PR with unmet GitHub requirements', 'PRs with unmet GitHub requirements'),
    plural(unknown, 'PR needs a status check', 'PRs need a status check'),
  ]
    .filter(Boolean)
    .join(' · ');
}
