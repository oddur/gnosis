import { useId, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ExternalLink,
  GitPullRequest,
  MessageSquare,
  CircleHelp,
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
}: {
  subject: ReviewSubject;
  signals: QueueSignals[];
  checks: Partial<Record<string, PrChecks>>;
  checkErrors: Partial<Record<string, string>>;
  account: string | null;
  now: number;
  onChecks: (url: string, id?: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
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
  const summaries =
    subject.kind === 'pr'
      ? evidence[0].rows
          .filter((row) => row.kind !== 'discussion' || row.checkedAt !== undefined)
          .map((row) => ({ label: row.label, tone: row.tone }))
      : [
          { label: `${subject.members.length} PRs`, tone: 'muted' },
          {
            label: `${evidence.filter((entry) => entry.rows.some((row) => row.tone === 'danger' || row.tone === 'warning')).length} PRs with concerns`,
            tone: 'muted',
          },
          {
            label: `${evidence.filter((entry) => entry.rows.some((row) => !row.hasEvidence)).length} PRs with missing evidence`,
            tone: 'muted',
          },
        ];
  function rowContent(row: EvidenceRow, url: string) {
    const Icon =
      row.tone === 'danger' || row.tone === 'warning'
        ? AlertCircle
        : row.checkedAt === undefined
          ? CircleHelp
          : icons[row.kind];
    return (
      <div className="review-evidence-row" key={row.kind}>
        <div className="review-evidence-category">
          <Icon size={16} aria-hidden="true" />
          <span>{names[row.kind]}</span>
        </div>
        <div className="review-evidence-observation">
          <strong data-tone={row.tone}>{row.label}</strong>
          <p>{row.detail}</p>
          <small>
            {row.headSha && (
              <>
                Commit <code>{row.headSha.slice(0, 7)}</code> ·{' '}
              </>
            )}
            {row.checkedAt !== undefined ? (
              <time dateTime={new Date(row.checkedAt).toISOString()} title={new Date(row.checkedAt).toLocaleString()}>
                Checked {timeAgo(new Date(row.checkedAt).toISOString())}
              </time>
            ) : (
              'Check time unknown'
            )}
          </small>
        </div>
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
      </div>
    );
  }
  return (
    <section className="review-evidence" aria-labelledby={`${id}-title`}>
      <header>
        <div>
          <h2 id={`${id}-title`}>Review evidence</h2>
          <div className="review-evidence-summary">
            {summaries.map((item, index) => (
              <span key={index} data-tone={item.tone}>
                {item.label}
              </span>
            ))}
          </div>
        </div>
        <Button
          variant="ghost"
          size="sm"
          aria-expanded={expanded}
          aria-controls={`${id}-details`}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? 'Hide evidence' : 'View evidence'}
          <ChevronDown size={14} className={expanded ? 'is-expanded' : undefined} />
        </Button>
      </header>
      {expanded && (
        <div id={`${id}-details`} className="review-evidence-details">
          {!account && <p className="review-evidence-gap">Connect GitHub to load review evidence.</p>}
          {evidence.map(({ member, rows }) => (
            <section key={member.url} aria-label={`Evidence for PR #${member.number}`}>
              {subject.kind === 'stack' && (
                <h3>
                  <a href={member.url} target="_blank" rel="noopener noreferrer">
                    #{member.number}
                  </a>{' '}
                  {member.title}
                </h3>
              )}
              {rows.map((row) => rowContent(row, member.url))}
            </section>
          ))}
          <p className="review-evidence-gap">
            <CircleHelp size={15} aria-hidden="true" />
            No bug reproduction runs are recorded here. Check results and reviews alone do not verify a reported fix.
          </p>
        </div>
      )}
    </section>
  );
}
