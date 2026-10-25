import { DiffStats } from './DiffStats';
import { ChevronDown, CircleCheck, CircleHelp, CircleAlert, Clock3, GitPullRequest } from 'lucide-react';
import type { ReviewMember } from '../lib/workbench';
import type { PrStatus } from '../lib/types';
import { githubFailureMessage } from '../lib/github-feedback';

export function memberReadiness(member: ReviewMember, status?: PrStatus, error?: string): string {
  if (member.merged) return 'Merged';
  if (member.state === 'closed') return 'Closed';
  if (error) return 'Status unavailable';
  if (!status) return 'Checks not loaded';
  if (status.mergeable === false) return 'Merge conflicts';
  if (status.reviewSummary.changesRequested) return 'Changes requested';
  if (status.ciConclusion === 'failure') return 'Checks failing';
  if (status.ciConclusion === 'pending') return 'Checks running';
  if (member.isDraft) return 'Draft';
  return !status.ciChecks.length
    ? 'No checks reported'
    : status.ciConclusion === 'success'
      ? 'Checks passed'
      : 'Checks need inspection';
}

export function PrReadiness({
  member,
  status,
  error,
  onRetry,
}: {
  member: ReviewMember;
  status?: PrStatus;
  error?: string;
  onRetry?: () => void;
}) {
  const checks = !status
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
  const CheckIcon =
    status?.ciConclusion === 'failure'
      ? CircleAlert
      : status?.ciConclusion === 'pending'
        ? Clock3
        : status?.ciChecks.length && status.ciConclusion === 'success'
          ? CircleCheck
          : CircleHelp;
  const mergeable = (status ?? member).mergeable;
  return (
    <section className="pr-readiness" aria-label={`Review readiness for PR #${member.number}`}>
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
      {error && (
        <div className="pr-status-error" role="status">
          <p>{githubFailureMessage(error)}</p>
          {onRetry && <button onClick={onRetry}>Retry GitHub status</button>}
        </div>
      )}
    </section>
  );
}
