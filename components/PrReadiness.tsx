import { PrActions } from './PrActions';
import { DiffStats } from './DiffStats';
import { ChevronDown, CircleCheck, CircleHelp, CircleAlert, Clock3, GitPullRequest } from 'lucide-react';
import type { ReviewMember } from '../lib/workbench';
import type { PrStatus } from '../lib/types';
import { githubFailureMessage } from '../lib/github-feedback';
import type { QueueSignals } from '../lib/queue-signals';
import { mergeReadiness } from '../lib/merge-readiness';
import { ReadinessBadge, ReadinessCheckedAt } from './MergeReadiness';

export function memberReadiness(
  member: ReviewMember,
  status?: PrStatus,
  _error?: string,
  signals?: QueueSignals
): string {
  return mergeReadiness(member, signals ?? status?.signals).label;
}

export function PrReadiness({
  member,
  status,
  signals,
  error,
  onRetry,
}: {
  member: ReviewMember;
  status?: PrStatus;
  signals?: QueueSignals;
  error?: string;
  onRetry?: () => void;
}) {
  const currentSignals =
    signals && (!status?.signals || signals.checkedAt >= status.signals.checkedAt) ? signals : status?.signals;
  const readiness = mergeReadiness(member, currentSignals);
  const rollup = currentSignals?.headSha === member.headSha ? currentSignals.checks : undefined;
  const checks = rollup
    ? !rollup.total
      ? 'No checks reported'
      : rollup.state === 'success'
        ? 'Checks passed'
        : rollup.state === 'failure'
          ? 'Checks failing'
          : rollup.state === 'pending'
            ? 'Checks running'
            : 'Checks need inspection'
    : !status
      ? error
        ? 'Checks unavailable'
        : onRetry
          ? 'Loading checks…'
          : 'Checks not saved'
      : !status.ciChecks.length
        ? 'No checks reported'
        : status.ciConclusion === 'success'
          ? 'Checks passed'
          : status.ciConclusion === 'failure'
            ? 'Checks failing'
            : status.ciConclusion === 'pending'
              ? 'Checks running'
              : 'Checks need inspection';
  const conclusion = rollup?.state ?? status?.ciConclusion;
  const CheckIcon =
    conclusion === 'failure'
      ? CircleAlert
      : conclusion === 'pending'
        ? Clock3
        : (rollup?.total || status?.ciChecks.length) && conclusion === 'success'
          ? CircleCheck
          : CircleHelp;
  const mergeable = currentSignals?.readiness
    ? currentSignals.readiness.mergeable === 'UNKNOWN'
      ? null
      : currentSignals.readiness.mergeable === 'MERGEABLE'
    : (status ?? member).mergeable;
  return (
    <section className="pr-readiness" aria-label={`Review readiness for PR #${member.number}`}>
      <div className="pr-merge-detail">
        <ReadinessBadge readiness={readiness} />
        <ul>
          {readiness.details.map((detail) => (
            <li key={detail}>{detail}</li>
          ))}
        </ul>
        <div className="pr-merge-detail-actions">
          <ReadinessCheckedAt readiness={readiness} />
          <a href={member.url} target="_blank" rel="noopener noreferrer">
            View merge requirements on GitHub
          </a>
        </div>
      </div>
      <div className="pr-readiness-row">
        {status?.ciChecks.length ? (
          <details className="pr-checks">
            <summary>
              <CheckIcon size={14} />
              <span>{checks}</span>
              <ChevronDown size={12} className="pr-check-chevron" />
            </summary>
            <ul>
              {status.ciChecks.map((check, index) => (
                <li key={index}>
                  {check.url ? (
                    <a href={check.url} target="_blank" rel="noopener noreferrer">
                      {check.name}
                    </a>
                  ) : (
                    check.name
                  )}
                  <span>{check.conclusion ?? (check.status === 'in_progress' ? 'Running' : check.status)}</span>
                </li>
              ))}
            </ul>
            {rollup && rollup.total > status.ciChecks.length && (
              <p className="text-muted-foreground">
                Showing {status.ciChecks.length} of {rollup.total} checks.{' '}
                <a href={`${member.url}/checks`} target="_blank" rel="noopener noreferrer">
                  View all checks on GitHub
                </a>
              </p>
            )}
          </details>
        ) : (
          <span>
            <CheckIcon size={14} />
            {checks}
          </span>
        )}
        <span>
          <GitPullRequest size={14} />
          {status
            ? `${status.reviewSummary.approved} ${status.reviewSummary.approved === 1 ? 'approval' : 'approvals'}`
            : error
              ? 'Reviews unavailable'
              : onRetry
                ? 'Loading reviews…'
                : 'Reviews not saved'}
          {!!status?.reviewSummary.changesRequested && ` · ${status.reviewSummary.changesRequested} changes requested`}
        </span>
        <span>
          {mergeable === false ? (
            <CircleAlert size={14} />
          ) : mergeable ? (
            <CircleCheck size={14} />
          ) : (
            <CircleHelp size={14} />
          )}
          {mergeable === null ? 'Conflicts not checked' : mergeable ? 'No conflicts' : 'Merge conflicts'}
        </span>
        <span>
          {member.changedFileCount === undefined ? (
            `${member.commitCount} commits`
          ) : (
            <>
              {member.changedFileCount} files ·{' '}
              <DiffStats additions={member.additions ?? 0} deletions={member.deletions ?? 0} /> lines
            </>
          )}
        </span>
      </div>
      <PrActions key={member.url} member={member} onChanged={onRetry} />
      {error && (
        <div className="pr-status-error" role="status">
          <p>{githubFailureMessage(error)}</p>
          {onRetry && <button onClick={onRetry}>Retry GitHub status</button>}
        </div>
      )}
    </section>
  );
}
