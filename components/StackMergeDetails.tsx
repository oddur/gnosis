import { AlertCircle, CircleHelp, ExternalLink } from 'lucide-react';
import { checkLabel } from '../lib/pr-checks';
import { stackMergeMessage, type StackMergeStatus, type StackMergeEntry, type StackMergeCategory } from '../lib/stack-merge-status';
import type { ReviewMember, ReviewSubject } from '../lib/workbench';

/** Explain saved merge evidence without fetching or changing merge policy. */
export function StackMergeDetails({
  subject,
  status,
  onOpen,
  onChecks,
  onRefresh,
  refreshDisabled,
}: {
  subject: ReviewSubject;
  status: StackMergeStatus;
  onOpen: (member: ReviewMember) => void;
  onChecks: (member: ReviewMember) => void;
  onRefresh: () => void;
  refreshDisabled: boolean;
}) {
  const issues = status.entries.filter(entry => entry.category !== 'ready');
  if (!issues.length) return null;
  const mixedRepos = new Set(subject.members.map((member) => member.repo)).size > 1;
  const row = (entry: StackMergeEntry) => {
    const { member, category, failedChecks, checkWarning } = entry;
    const uncertain = category === 'unconfirmed';
    const Icon = uncertain ? CircleHelp : AlertCircle;
    const { title, details } = stackMergeMessage(entry);
    return (
      <li key={member.url} className="stack-merge-issue">
        <Icon
          size={16}
          className={`stack-merge-issue-icon is-${uncertain ? 'muted' : category === 'blocked' ? 'danger' : 'warning'}`}
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
              {failedChecks.length > 2 && <li>{failedChecks.length - 2} more checks · View checks for details</li>}
            </ul>
          )}
          <div className="stack-merge-issue-actions">
            {(checkWarning || failedChecks.length > 0 || entry.readiness.label === 'Checks need attention') && (
              <button aria-label={`View checks for PR #${member.number}`} onClick={() => onChecks(member)}>View checks</button>
            )}
            {uncertain && <button disabled={refreshDisabled} onClick={onRefresh}>Refresh status</button>}
            <a aria-label={`View PR #${member.number} on GitHub`} href={member.url} target="_blank" rel="noopener noreferrer">
              View on GitHub <ExternalLink size={12} aria-hidden="true" />
            </a>
          </div>
        </div>
      </li>
    );
  };
  const groups: { category: StackMergeCategory; title: string }[] = [
    { category: 'blocked', title: 'Blocking merge' },
    { category: 'waiting', title: 'Waiting on GitHub' },
    { category: 'unconfirmed', title: 'Not yet confirmed' },
    { category: 'warning', title: 'Checks that do not block merging' },
  ];
  return (
    <section className="stack-merge-details" aria-label="Stack merge status">
      <h2>Merge status</h2>
      {groups.map(({ category, title }) => {
        const entries = issues.filter(entry => entry.category === category);
        if (!entries.length) return null;
        return <section key={category} className="stack-merge-group" aria-label={title}>
          <h3>{title} <span>{entries.length} {entries.length === 1 ? 'PR' : 'PRs'}</span></h3>
          <ul className="stack-merge-issues">{entries.slice(0, 3).map(row)}</ul>
          {entries.length > 3 && <details className="stack-merge-more">
            <summary>Show {entries.length - 3} more {entries.length === 4 ? 'PR' : 'PRs'}</summary>
            <ul className="stack-merge-issues">{entries.slice(3).map(row)}</ul>
          </details>}
        </section>;
      })}
    </section>
  );
}
