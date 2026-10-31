import { mergeReadiness } from './merge-readiness';
import { QUEUE_SIGNALS_TTL, type QueueSignals } from './queue-signals';
import type { ReviewMember, ReviewSubject } from './workbench';
import type { StackMergeStatus } from './stack-merge-status';

/** Only draw a single connected rail when the evidence really describes a chain. */
export function stackDependencyOrder(subject: ReviewSubject) {
  const members = new Map(subject.members.map((member) => [member.url, member]));
  const edges = subject.edges.filter((edge) => members.has(edge.parent) && members.has(edge.child));
  const parents = new Map([...members.keys()].map((url) => [url, 0]));
  const children = new Map<string, string[]>();
  for (const edge of edges) {
    parents.set(edge.child, (parents.get(edge.child) ?? 0) + 1);
    children.set(edge.parent, [...(children.get(edge.parent) ?? []), edge.child]);
  }
  const linearDegrees = [...members.keys()].every(
    (url) => (parents.get(url) ?? 0) <= 1 && (children.get(url)?.length ?? 0) <= 1
  );
  const ready = [...members.keys()].filter((url) => parents.get(url) === 0);
  const ordered: ReviewMember[] = [];
  for (let index = 0; index < ready.length; index++) {
    const url = ready[index];
    const member = members.get(url);
    if (member) ordered.push(member);
    for (const child of children.get(url) ?? []) {
      const remaining = (parents.get(child) ?? 0) - 1;
      parents.set(child, remaining);
      if (remaining === 0) ready.push(child);
    }
  }
  const linear =
    ordered.length === members.size &&
    edges.length === subject.edges.length &&
    edges.length === members.size - 1 &&
    linearDegrees;
  return { linear, members: ordered.length === members.size ? ordered : subject.members };
}

export function stackMergeLabel(member: ReviewMember, signal: QueueSignals | undefined, now: number, checking = false) {
  const readiness = mergeReadiness(member, signal, now);
  const label = readiness.label;
  if (readiness.stale) return { ...readiness, label: 'Status needs refresh' };
  if (label === 'Merged' || label === 'Closed') return readiness;
  if (readiness.ready)
    return { ...readiness, label: label === 'Ready for merge queue' ? 'Ready for merge queue' : 'Ready' };
  const labels: Record<string, string> = {
    'Merge conflicts': 'Conflicts',
    'Update required to merge': 'Update required',
    'Draft PR': 'Draft',
    'Approval required': 'Review required',
  };
  if (labels[label]) return { ...readiness, label: labels[label] };
  if (label === 'Changes requested' || label === 'In merge queue') return readiness;
  if (signal?.headSha === member.headSha && readiness.checkedAt !== undefined) {
    if (signal.checks.state === 'failure') return { ...readiness, label: 'Checks failing', tone: 'danger' as const };
    if (signal.checks.state === 'pending') return { ...readiness, label: 'Checks running', tone: 'warning' as const };
  }
  return {
    ...readiness,
    label:
      label === 'Readiness unknown'
        ? checking
          ? 'Checking…'
          : readiness.checkedAt === undefined
            ? 'Not checked'
            : 'Not confirmed'
        : label === 'Merge blocked'
          ? 'Requirements unmet'
          : label,
  };
}

/** Use the actual base branch, not a historical or manually linked dependency. */
export function stackMergeTarget(
  subject: ReviewSubject,
  member: ReviewMember,
  signal?: QueueSignals,
  now = Date.now()
) {
  const branch =
    signal?.url === member.url && signal.headSha === member.headSha && now - signal.checkedAt < QUEUE_SIGNALS_TTL
      ? signal.readiness?.baseBranch || member.baseBranch
      : member.baseBranch;
  const parent = subject.members.find(
    (candidate) =>
      candidate.url !== member.url && candidate.headRepo === member.baseRepo && candidate.headBranch === branch
  );
  return { branch, parent, label: parent ? `#${parent.number} (${branch})` : branch };
}

export function stackNextStep(subject: ReviewSubject, status: StackMergeStatus) {
  const order = stackDependencyOrder(subject).members;
  const ordered = order.flatMap((member) => status.entries.filter((entry) => entry.member.url === member.url));
  const entry =
    ordered.find((value) => value.category === 'blocked') ??
    ordered.find((value) => value.category === 'unconfirmed') ??
    ordered.find((value) => value.category === 'waiting');
  if (!entry) return undefined;
  const action =
    entry.readiness.stale || entry.readiness.label === 'Readiness unknown'
      ? 'refresh'
      : entry.readiness.label === 'Merge conflicts'
        ? 'resolve'
        : ['Approval required', 'Changes requested', 'Draft PR', 'Update required to merge'].includes(
              entry.readiness.label
            )
          ? 'open'
          : entry.readiness.label === 'Checks need attention' ||
              entry.failedChecks.length ||
              entry.readiness.details.some((detail) => /checks are (failing|still running)/.test(detail))
            ? 'checks'
            : 'open';
  const children = subject.edges
    .filter((edge) => edge.parent === entry.member.url)
    .flatMap((edge) =>
      subject.members.filter((member) => member.url === edge.child && !member.merged && member.state !== 'closed')
    );
  return { entry, action, children };
}
