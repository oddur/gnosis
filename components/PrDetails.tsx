import { ExternalLink, GitBranch } from 'lucide-react';
import type { ReviewMember } from '../lib/workbench';
import type { PrStatus } from '../lib/types';
import { Markdown } from './Markdown';
import { PrLabels } from './PrLabels';
import { githubFailureMessage } from '../lib/github-feedback';

function date(value: string) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? 'Unknown'
    : parsed.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function PrDetails({
  member: m,
  status,
  statusError,
  onRetryStatus,
  showTitle = true,
}: {
  member: ReviewMember;
  status?: PrStatus;
  statusError?: string;
  onRetryStatus?: () => void;
  showTitle?: boolean;
}) {
  const meta = status ?? m;
  const state = m.merged ? 'Merged' : m.state === 'closed' ? 'Closed' : m.isDraft ? 'Draft' : 'Open';
  return (
    <article className="pr-details" aria-label={`Pull request #${m.number}`}>
      <header className="pr-details-heading">
        <div>
          {showTitle && (
            <h2>
              #{m.number} {m.title}
            </h2>
          )}
          <p>
            {showTitle && <>{m.repo} · </>}
            <span className={`pr-state pr-state-${state.toLowerCase()}`}>{state}</span> · by {m.author}
          </p>
        </div>
        <a href={m.url} target="_blank" rel="noopener noreferrer" className="pr-github-link">
          GitHub <ExternalLink size={13} />
        </a>
      </header>
      <div className="pr-details-columns">
        <section className="pr-description" aria-label={`Description for PR #${m.number}`}>
          <h3>Description</h3>
          {m.description.trim() ? (
            <Markdown
              githubSource={{ repo: m.headRepo || m.repo, ref: m.headSha || m.headBranch }}
              className="pr-markdown"
            >
              {m.description}
            </Markdown>
          ) : (
            <p className="text-sm text-muted-foreground">No description provided.</p>
          )}
        </section>
        <aside className="pr-metadata" aria-label={`Metadata for PR #${m.number}`}>
          <h3>PR details</h3>
          <dl>
            <dt>Branches</dt>
            <dd className="pr-branches">
              <GitBranch size={14} aria-hidden="true" />
              <span>
                <code>
                  {m.headRepo !== m.baseRepo ? `${m.headRepo}:` : ''}
                  {m.headBranch}
                </code>{' '}
                → <code>{m.baseBranch}</code>
              </span>
            </dd>
            <dt>Labels</dt>
            <dd>{m.labels.length ? <PrLabels members={[m]} /> : 'None'}</dd>
            <dt>Assignees</dt>
            <dd>{m.assignees?.join(', ') || 'Unassigned'}</dd>
            <dt>Review requested from</dt>
            <dd>
              {[...meta.requestedReviewers, ...meta.requestedTeams.map((team) => `Team ${team}`)].join(', ') ||
                'No reviewers requested'}
            </dd>
            <dt>Commits</dt>
            <dd>{meta.commitCount}</dd>
            {m.changedFileCount !== undefined && (
              <>
                <dt>Changes</dt>
                <dd>
                  {m.changedFileCount} files · +{m.additions ?? 0} / −{m.deletions ?? 0} lines
                </dd>
              </>
            )}
            <dt>Head revision</dt>
            <dd>
              <code title={m.headSha}>{m.headSha.slice(0, 7)}</code>
            </dd>
            <dt>Created</dt>
            <dd>
              <time dateTime={m.createdAt}>{date(m.createdAt)}</time>
            </dd>
            <dt>Updated</dt>
            <dd>
              <time dateTime={m.updatedAt}>{date(m.updatedAt)}</time>
            </dd>
            <dt>Merge conflicts</dt>
            <dd>
              {meta.mergeable === null
                ? 'Not yet checked by GitHub'
                : meta.mergeable
                  ? 'No conflicts'
                  : 'Conflicts to resolve'}
            </dd>
            <dt>Auto-merge</dt>
            <dd>{meta.autoMerge ? `Enabled (${meta.autoMerge.method})` : 'Off'}</dd>
            <dt>Milestone</dt>
            <dd>
              {meta.milestone?.title || 'None'}
              {meta.milestone?.dueOn && ` · due ${date(meta.milestone.dueOn)}`}
            </dd>
          </dl>
          {(status || statusError || onRetryStatus) && (
            <section className="pr-live-status" aria-label="GitHub checks and reviews">
              <h3>Checks & reviews</h3>
              {status ? (
                <>
                  <p>{status.ciChecks.length ? `Checks: ${status.ciConclusion}` : 'No checks reported'}</p>
                  <p>
                    {status.reviewSummary.approved} approvals · {status.reviewSummary.changesRequested} changes
                    requested
                  </p>
                  {status.ciChecks.length > 0 && (
                    <details>
                      <summary>{status.ciChecks.length} checks</summary>
                      <ul>
                        {status.ciChecks.map((check, i) => (
                          <li key={i}>
                            {check.name}: {check.conclusion ?? check.status}
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                </>
              ) : statusError ? (
                <>
                  <p>{githubFailureMessage(statusError)}</p>
                  {onRetryStatus && <button onClick={onRetryStatus}>Retry status</button>}
                </>
              ) : (
                <p>Loading checks and reviews…</p>
              )}
            </section>
          )}
        </aside>
      </div>
    </article>
  );
}
