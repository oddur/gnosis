import { mergeReadiness, type MergeReadiness } from './merge-readiness';
import { checkGroup, type PrChecks } from './pr-checks';
import { QUEUE_SIGNALS_TTL, type QueueSignals } from './queue-signals';
import type { ReviewSubject } from './workbench';

export type StackMergeCategory = 'blocked' | 'waiting' | 'unconfirmed' | 'warning' | 'ready';

/** Display evidence for the whole stack; never used to authorize a merge. */
export function stackMergeStatus(
  subject: ReviewSubject,
  signals: QueueSignals[],
  checks: Record<string, PrChecks | undefined>,
  now: number
) {
  const entries = subject.members.flatMap((member) => {
    const signal = signals.find(value => value.url === member.url && value.headSha === member.headSha);
    const readiness = mergeReadiness(member, signal, now);
    if (['Merged', 'Closed'].includes(readiness.label)) return [];
    const uncertain = readiness.stale || readiness.label === 'Readiness unknown';
    const value = checks[member.url];
    const failedChecks = !uncertain && value?.headSha === member.headSha && now - value.checkedAt < QUEUE_SIGNALS_TTL
      ? value.checks.filter(check => checkGroup(check) === 'attention') : [];
    const checkWarning = signal?.checks.state === 'failure' || failedChecks.length > 0;
    const category: StackMergeCategory = uncertain ? 'unconfirmed'
      : readiness.ready ? checkWarning ? 'warning' : 'ready'
      : readiness.label === 'In merge queue' ? 'waiting'
      : readiness.label === 'Checks need attention' ? 'unconfirmed'
      : 'blocked';
    return [{ member, readiness, failedChecks, checkWarning, category }];
  });
  const count = (category: StackMergeCategory) => entries.filter(entry => entry.category === category).length;
  const blocked = count('blocked');
  const unconfirmed = count('unconfirmed');
  const waiting = count('waiting');
  const checked = entries.flatMap(({ readiness }) => readiness.checkedAt === undefined ? [] : [readiness.checkedAt]);
  const allMerged = subject.members.every(member => member.merged || mergeReadiness(member, signals.find(s => s.url === member.url), now).label === 'Merged');
  const summary: MergeReadiness = {
    label: blocked ? `Cannot merge stack · ${blocked} ${blocked === 1 ? 'PR is' : 'PRs are'} blocked`
      : unconfirmed ? 'Stack merge status not confirmed'
      : waiting ? 'Stack is waiting on the merge queue'
      : entries.length ? 'All open PRs meet merge requirements'
      : allMerged ? 'Stack merged' : 'Stack closed',
    tone: blocked ? 'danger' : unconfirmed ? 'muted' : waiting ? 'warning' : entries.length ? 'success' : 'muted',
    ready: entries.length > 0 && !blocked && !unconfirmed && !waiting,
    stale: entries.length > 0 && entries.every(entry => entry.readiness.stale),
    checkedAt: checked.length === entries.length && checked.length > 0 ? Math.min(...checked) : undefined,
    details: entries.map(({ member, readiness }) => `#${member.number}: ${readiness.label}.`),
  };
  return { entries, summary, blocked, unconfirmed };
}

export type StackMergeStatus = ReturnType<typeof stackMergeStatus>;
export type StackMergeEntry = StackMergeStatus['entries'][number];

/** Keep stale evidence in the past tense; do not present old requirements as current instructions. */
export function stackMergeMessage({ readiness, category, failedChecks }: StackMergeEntry): { title: string; details: string[] } {
  if (readiness.stale) return { title: 'Status needs refresh', details: readiness.details.slice(0, 1) };
  if (category === 'warning') return {
    title: failedChecks.length > 0 && failedChecks.every(check => check.required === false) ? 'Optional checks did not pass' : 'Checks did not pass',
    details: [readiness.label === 'Ready for merge queue'
      ? 'GitHub allows this PR into its merge queue. These check results do not block it.'
      : 'GitHub allows this PR to merge. These check results do not block it.'],
  };
  if (readiness.label === 'Readiness unknown') return {
    title: readiness.checkedAt === undefined ? 'Merge status not checked' : 'GitHub has not confirmed merge status',
    details: readiness.details,
  };
  const titles: Record<string, string> = {
    'Update required to merge': 'Branch update required',
    'Draft PR': 'Still a draft',
    'Merge blocked': 'GitHub requirements not met',
    'Checks need attention': 'Check requirements not confirmed',
    'In merge queue': 'Waiting in the merge queue',
  };
  return {
    title: titles[readiness.label] ?? readiness.label,
    details: readiness.details.flatMap(detail => detail.startsWith('Some checks are failing.')
      ? failedChecks.length ? [] : ['Some checks did not pass. View checks to see which are required for merging.']
      : [detail]),
  };
}
