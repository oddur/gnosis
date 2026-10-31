import { AlertCircle, CircleHelp, ExternalLink } from 'lucide-react';
import { mergeReadiness } from '../lib/merge-readiness';
import { QUEUE_SIGNALS_TTL, type QueueSignals } from '../lib/queue-signals';
import { checkGroup, checkLabel, type PrChecks } from '../lib/pr-checks';
import type { ReviewMember, ReviewSubject } from '../lib/workbench';

/** Explain saved merge evidence without fetching or changing merge policy. */
export function StackMergeDetails({
  subject,
  signals,
  checks,
  now,
  onOpen,
  onChecks,
}: {
  subject: ReviewSubject;
  signals: QueueSignals[];
  checks: Record<string, PrChecks | undefined>;
  now: number;
  onOpen: (member: ReviewMember) => void;
  onChecks: (member: ReviewMember) => void;
}) {
  const issues = subject.members.flatMap((member) => {
    const signal = signals.find((value) => value.url === member.url && value.headSha === member.headSha);
    const readiness = mergeReadiness(member, signal, now);
    if (['Merged', 'Closed'].includes(readiness.label)) return [];
    const checkWarning = signal?.checks.state === 'failure';
    if (readiness.ready && !checkWarning) return [];
    const uncertain = readiness.stale || readiness.label === 'Readiness unknown';
    const value = checks[member.url];
    const failedChecks =
      !uncertain && value?.headSha === member.headSha && now - value.checkedAt < QUEUE_SIGNALS_TTL
        ? value.checks.filter((check) => checkGroup(check) === 'attention')
        : [];
    return [{ member, readiness, uncertain, failedChecks, checkWarning }];
  });
  if (!issues.length) return null;
  // Known causes come first; missing/stale information must never hide a conflict.
  const ordered = [...issues].sort(
    (a, b) => Number(a.uncertain) - Number(b.uncertain) || Number(a.readiness.ready) - Number(b.readiness.ready)
  );
  const mixedRepos = new Set(subject.members.map((member) => member.repo)).size > 1;
  const row = ({ member, readiness, uncertain, failedChecks, checkWarning }: (typeof issues)[number]) => {
    const Icon = uncertain ? CircleHelp : AlertCircle;
    const title = readiness.stale
      ? 'Status needs refresh'
      : readiness.ready
        ? 'Checks need attention'
        : readiness.label;
    const details = readiness.ready
      ? ['GitHub reports this PR can merge, but some checks need attention.']
      : readiness.details.filter((detail) => !(failedChecks.length && detail.startsWith('Some checks are failing.')));
    return (
      <li key={member.url} className="stack-merge-issue">
        <Icon
          size={16}
          className={`stack-merge-issue-icon is-${uncertain ? 'muted' : readiness.tone === 'danger' ? 'danger' : 'warning'}`}
          aria-hidden="true"
        />
        <div className="stack-merge-issue-content">
          <div className="stack-merge-issue-title">
            <button onClick={() => onOpen(member)} title={member.title}>
              {mixedRepos ? `${member.repo} #${member.number}` : `#${member.number}`}
            </button>
            <strong>{title}</strong>
          </div>
          <ul className="stack-merge-reasons">
            {details.map((detail) => (
              <li key={detail}>{detail}</li>
            ))}
          </ul>
          {failedChecks.length > 0 && (
            <ul className="stack-merge-check-names">
              {failedChecks.slice(0, 2).map((check) => (
                <li key={check.id}>
                  {check.name} — {checkLabel(check).toLowerCase()}
                  {check.required === true ? ' (required)' : check.required === false ? ' (optional)' : ''}
                </li>
              ))}
              {failedChecks.length > 2 && <li>{failedChecks.length - 2} more</li>}
            </ul>
          )}
          <div className="stack-merge-issue-actions">
            {(checkWarning || failedChecks.length > 0 || readiness.label === 'Checks need attention') && (
              <button onClick={() => onChecks(member)}>View checks</button>
            )}
            <a href={member.url} target="_blank" rel="noopener noreferrer">
              View on GitHub <ExternalLink size={12} aria-hidden="true" />
            </a>
          </div>
        </div>
      </li>
    );
  };
  return (
    <section className="stack-merge-details" aria-label="Stack merge requirements">
      <h2>
        Merge requirements{' '}
        <span>
          {issues.length} {issues.length === 1 ? 'PR needs' : 'PRs need'} attention
        </span>
      </h2>
      <ul className="stack-merge-issues">{ordered.slice(0, 3).map(row)}</ul>
      {ordered.length > 3 && (
        <details className="stack-merge-more">
          <summary>Show {ordered.length - 3} more PRs</summary>
          <ul className="stack-merge-issues">{ordered.slice(3).map(row)}</ul>
        </details>
      )}
    </section>
  );
}
