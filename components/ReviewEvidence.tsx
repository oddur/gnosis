import { SubjectIcon } from './SubjectIcon';
import { useId, useLayoutEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ExternalLink,
  GitPullRequest,
  MessageSquare,
  CircleHelp,
  Clock3,
  RefreshCw,
} from 'lucide-react';
import { Button } from './ui/button';
import { reviewEvidence, type EvidenceRow } from '../lib/review-evidence';
import { useEvidenceDiscussions } from '../lib/use-evidence-discussions';
import type { ReviewSubject } from '../lib/workbench';
import type { QueueSignals } from '../lib/queue-signals';
import type { PrChecks } from '../lib/pr-checks';
import { timeAgo } from '../lib/utils';

export function ReviewEvidence({
  subject,
  signals,
  checks,
  checkErrors,
  account,
  now,
  onChecks,
  onRefresh,
  refreshBusy,
  refreshError,
  compact = false,
}: {
  subject: ReviewSubject;
  signals: QueueSignals[];
  checks: Partial<Record<string, PrChecks>>;
  checkErrors: Partial<Record<string, string>>;
  account: string | null;
  now: number;
  onChecks: (url: string, id?: string) => void;
  onRefresh: () => void;
  refreshBusy: boolean;
  refreshError?: string;
  compact?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const focusDetails = useRef(false);
  useLayoutEffect(() => {
    if (expanded && focusDetails.current) {
      focusDetails.current = false;
      heading.current?.focus({ preventScroll: true });
    }
  }, [expanded]);
  const id = useId();
  const discussions = useEvidenceDiscussions(subject, account, expanded);
  const evidence = subject.members.map((member) =>
    reviewEvidence(member, {
      signals: account
        ? signals.filter((signal) => signal.url === member.url).sort((a, b) => b.checkedAt - a.checkedAt)[0]
        : undefined,
      checks: account ? checks[member.url] : undefined,
      checkError: checkErrors[member.url],
      discussion: discussions.values[member.url],
      discussionError: discussions.errors[member.url],
      now,
    })
  );
  const icons = { checks: CheckCircle2, review: GitPullRequest, discussion: MessageSquare };
  const names = { checks: 'Checks', review: 'Latest review', discussion: 'Code discussions' };
  const busy = refreshBusy || discussions.busy;
  const issues = evidence.flatMap((entry) =>
    entry.rows.flatMap((row) => (row.issue && (expanded || row.kind !== 'discussion') ? [row.issue] : []))
  );
  const retryAt = Math.max(0, ...issues.map((issue) => issue.retryAt ?? 0));
  const status = !account
    ? 'Connect GitHub to load this information.'
    : busy
      ? 'Refreshing GitHub information…'
      : issues.length || refreshError
        ? retryAt > now
          ? `Updates delayed. Automatic retry at ${new Date(retryAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`
          : 'Some updates are delayed. Automatic retries continue; you can also refresh.'
        : expanded
          ? 'From GitHub · Updates automatically while open'
          : 'From GitHub · Checks and reviews update automatically';
  const summaries =
    subject.kind === 'pr'
      ? evidence[0].rows.map((row) => ({
          label:
            row.kind === 'discussion' && row.checkedAt === undefined && !row.issue
              ? compact
                ? 'Load discussions'
                : 'Discussions: show details to load'
              : row.label,
          tone: row.tone,
          parts: row.labelParts,
        }))
      : [
          { label: `${subject.members.length} PRs`, tone: 'muted', parts: undefined },
          {
            label: `${evidence.filter((entry) => entry.rows.some((row) => row.tone === 'danger' || row.tone === 'warning')).length} with items to inspect`,
            tone: 'muted',
            parts: undefined,
          },
          {
            label: `${evidence.filter((entry) => entry.rows.some((row) => !row.hasEvidence)).length} with details unavailable`,
            tone: 'muted',
            parts: undefined,
          },
        ];
  function labelContent(label: string, parts?: EvidenceRow['labelParts']) {
    return parts
      ? parts.map((part, index) => (
          <span key={index}>
            {index > 0 && <span data-tone="muted"> · </span>}
            <span data-tone={part.tone}>{part.text}</span>
          </span>
        ))
      : label;
  }
  function rowContent(row: EvidenceRow, url: string) {
    const Icon =
      row.tone === 'danger' || row.tone === 'warning' ? AlertCircle : !row.hasEvidence ? CircleHelp : icons[row.kind];
    const checkedDate =
      row.checkedAt !== undefined && Number.isFinite(row.checkedAt) ? new Date(row.checkedAt) : undefined;
    return (
      <div className="review-evidence-row" key={row.kind} data-freshness={row.freshness}>
        <div className="review-evidence-category">
          <Icon size={16} aria-hidden="true" />
          <span>{names[row.kind]}</span>
        </div>
        <div className="review-evidence-observation">
          <strong data-tone={row.tone}>{labelContent(row.label, row.labelParts)}</strong>
          {row.detail && (
            <p>{!account && row.kind === 'discussion' ? 'Connect GitHub to load code discussions.' : row.detail}</p>
          )}
          <div className="review-evidence-meta">
            {row.submittedAt && (
              <small>
                Review submitted{' '}
                <time dateTime={row.submittedAt} title={new Date(row.submittedAt).toLocaleString()}>
                  {timeAgo(row.submittedAt)}
                </time>
              </small>
            )}
            {row.headSha && (
              <small>
                {row.kind === 'review'
                  ? 'Reviewed commit'
                  : row.kind === 'checks'
                    ? 'Checks for commit'
                    : 'Discussions fetched for commit'}{' '}
                <code>{row.headSha.slice(0, 7)}</code>
              </small>
            )}
            <small className="review-evidence-freshness">
              {row.freshness === 'saved' && 'Last known result · '}
              {row.freshness === 'delayed' && 'Updates delayed · '}
              {checkedDate ? (
                <time dateTime={checkedDate.toISOString()} title={checkedDate.toLocaleString()}>
                  GitHub refreshed {timeAgo(checkedDate.toISOString())}
                </time>
              ) : (
                'Not yet checked with GitHub'
              )}
            </small>
          </div>
          {row.issue && (
            <details className="review-evidence-error">
              <summary>Update details</summary>
              <p>{row.issue.message}</p>
            </details>
          )}
        </div>
        <div className="review-evidence-actions">
          {row.kind === 'checks' ? (
            <Button variant="ghost" size="sm" onClick={() => onChecks(url, row.checkId)}>
              {row.action}
            </Button>
          ) : (
            <a href={row.href} target="_blank" rel="noopener noreferrer">
              {row.action}
              <ExternalLink size={12} aria-hidden="true" />
            </a>
          )}
          {row.allHref && (
            <a href={row.allHref} target="_blank" rel="noopener noreferrer">
              View all discussions
              <ExternalLink size={12} aria-hidden="true" />
            </a>
          )}
        </div>
      </div>
    );
  }
  const summary = (
    <div className="review-evidence-summary">
      {summaries.map((item, index) =>
        compact ? (
          <button
            key={index}
            data-tone={item.tone}
            onClick={() => {
              if (index === 0) onChecks(subject.members[0].url);
              else {
                focusDetails.current = true;
                setExpanded(true);
              }
            }}
          >
            {index === 0 ? (
              item.tone === 'danger' ? (
                <AlertCircle size={14} aria-hidden="true" />
              ) : item.tone === 'warning' ? (
                <Clock3 size={14} aria-hidden="true" />
              ) : item.tone === 'success' ? (
                <CheckCircle2 size={14} aria-hidden="true" />
              ) : (
                <CircleHelp size={14} aria-hidden="true" />
              )
            ) : index === 1 ? (
              <GitPullRequest size={14} aria-hidden="true" />
            ) : (
              <MessageSquare size={14} aria-hidden="true" />
            )}
            <span>{labelContent(item.label, item.parts)}</span>
          </button>
        ) : (
          <span key={index} data-tone={item.tone}>
            {labelContent(item.label, item.parts)}
          </span>
        )
      )}
    </div>
  );
  return (
    <section className={`review-evidence ${compact ? 'review-evidence-compact' : ''}`} aria-labelledby={`${id}-title`}>
      <header>
        <div className={compact && !expanded ? 'sr-only' : undefined}>
          <h2 id={`${id}-title`} ref={heading} tabIndex={-1}>
            Checks, reviews &amp; discussions
          </h2>
          {!compact && (
            <p className="review-evidence-intro">Check what needs attention before you submit your review.</p>
          )}
        </div>
        {compact && !expanded && summary}
        <div className="review-evidence-controls">
          <Button
            variant="ghost"
            size="sm"
            disabled={!account || busy}
            aria-label="Refresh GitHub information"
            onClick={() => {
              onRefresh();
              if (expanded) void discussions.refresh();
            }}
          >
            <RefreshCw size={14} aria-hidden="true" className={busy ? 'animate-spin' : undefined} />
            {!compact && 'Refresh'}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={expanded}
            aria-controls={`${id}-details`}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? 'Hide details' : 'Show details'}
            <ChevronDown size={14} aria-hidden="true" className={expanded ? 'is-expanded' : undefined} />
          </Button>
        </div>
      </header>
      <p
        className={`review-evidence-sync ${compact && !expanded && account && !busy && !issues.length && !refreshError ? 'sr-only' : ''}`}
        role="status"
      >
        {status}
      </p>
      <span className="sr-only" aria-live="polite" aria-atomic="true">
        {expanded
          ? evidence
              .map(({ member, rows }) => `PR ${member.number}. ${rows.map((row) => row.label).join('. ')}`)
              .join('. ')
          : ''}
      </span>
      {!compact && !expanded && summary}
      {expanded && (
        <div id={`${id}-details`} className="review-evidence-details">
          {evidence.map(({ member, rows }) => (
            <section key={member.url} aria-label={`GitHub information for PR #${member.number}`}>
              <div className="review-evidence-scope">
                {subject.kind === 'stack' && (
                  <h3>
                    <SubjectIcon kind="pr" /><a href={member.url} target="_blank" rel="noopener noreferrer">
                      #{member.number}
                    </a>{' '}
                    {member.title}
                  </h3>
                )}
                <small>
                  Displayed commit <code>{member.headSha.slice(0, 7)}</code>
                </small>
              </div>
              {rows.map((row) => rowContent(row, member.url))}
            </section>
          ))}
          <details className="review-evidence-help">
            <summary>About these results</summary>
            <p>
              These are GitHub check results, submitted reviews, and code discussions. General PR comments are not
              included. Passing checks do not establish test coverage or prove that a reported bug is fixed. No AI
              generation is needed to update this information.
            </p>
          </details>
        </div>
      )}
    </section>
  );
}
