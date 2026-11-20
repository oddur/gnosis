import { CircleAlert, CircleCheck, Clock3, MessageSquare, MinusCircle, type LucideIcon } from 'lucide-react';
import { BranchBadge, CommitBadge, RepositoryBadge } from './EntityBadge';
import { GitHubAuthor } from './GitHubAuthor';
import { PrLabels } from './PrLabels';
import { Button } from './ui/button';
import { checkSummary, type PrChecks } from '../lib/pr-checks';
import type { GitHubReviewThreads } from '../lib/review-threads';
import type { PrStatus } from '../lib/types';
import type { ReviewMember } from '../lib/workbench';
import type { ReactNode } from 'react';

type Verdict = 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING';
const VERDICTS: Record<Verdict, { icon: LucideIcon; label: string; tone: string }> = {
  APPROVED: { icon: CircleCheck, label: 'Approved', tone: 'success' },
  CHANGES_REQUESTED: { icon: CircleAlert, label: 'Changes requested', tone: 'danger' },
  COMMENTED: { icon: MessageSquare, label: 'Commented', tone: 'neutral' },
  DISMISSED: { icon: MinusCircle, label: 'Dismissed', tone: 'neutral' },
  PENDING: { icon: Clock3, label: 'Review requested', tone: 'review' },
};

/**
 * Each reviewer's current verdict, as GitHub decides it: the latest approval, change request or dismissal wins over
 * later comments; a reviewer still requested and without a decision is pending.
 */
export function reviewerVerdicts(snapshot: Pick<GitHubReviewThreads, 'feedback'> | undefined, requested: readonly string[]) {
  const verdicts = new Map<string, Verdict>();
  const reviews = [...(snapshot?.feedback?.reviews ?? [])]
    .filter((review) => review.author && review.state !== 'PENDING')
    .sort((a, b) => (a.submittedAt ?? a.createdAt).localeCompare(b.submittedAt ?? b.createdAt));
  for (const review of reviews) {
    const login = review.author?.login ?? '';
    const current = verdicts.get(login);
    if (review.state === 'COMMENTED' && current && current !== 'COMMENTED') continue;
    verdicts.set(login, review.state as Verdict);
  }
  for (const login of [...requested, ...(snapshot?.feedback?.requestedReviewers ?? [])])
    if (!verdicts.has(login) || verdicts.get(login) === 'COMMENTED') verdicts.set(login, 'PENDING');
  return [...verdicts.entries()].map(([login, verdict]) => ({ login, verdict }));
}

const date = (value: string) => {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? 'Unknown' : parsed.toLocaleDateString(undefined, { dateStyle: 'medium' });
};

/**
 * The Conversation page's side column (#418): who reviews and how they decided, checks, and the PR's facts. It stays
 * in view beside the timeline; below about 1100px it becomes a compact strip above it.
 */
export function ConversationSidebar({
  member: m,
  status,
  snapshot,
  checks,
  onChecks,
  context,
  evidence,
}: {
  /** Review evidence: check failures and what they block, with About these results. */
  evidence?: ReactNode;
  /** A stack member's place in its stack, above its own details. */
  context?: ReactNode;
  member: ReviewMember;
  status?: PrStatus;
  snapshot?: GitHubReviewThreads;
  checks?: PrChecks;
  onChecks: () => void;
}) {
  const meta = status ?? m;
  const reviewers = reviewerVerdicts(snapshot, meta.requestedReviewers);
  return (
    <aside className="conversation-sidebar pr-metadata" aria-label={`Details for PR #${m.number}`}>
      {context}
      <section>
        <h2>Reviewers</h2>
        {reviewers.length || meta.requestedTeams.length ? (
          <ul className="conversation-reviewers">
            {reviewers.map(({ login, verdict }) => {
              const { icon: Icon, label, tone } = VERDICTS[verdict];
              return (
                <li key={login}>
                  <GitHubAuthor login={login} />
                  <span className="conversation-verdict" data-tone={tone}>
                    <Icon size={13} aria-hidden="true" />
                    {label}
                  </span>
                </li>
              );
            })}
            {meta.requestedTeams.map((team) => (
              <li key={team}>
                <span>Team {team}</span>
                <span className="conversation-verdict" data-tone="review">
                  <Clock3 size={13} aria-hidden="true" />
                  Review requested
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="conversation-empty-value">No reviewers yet</p>
        )}
      </section>
      <section>
        <h2>Checks</h2>
        {evidence ?? <p>{checks ? checkSummary(checks.checks) : 'Checks not loaded'}</p>}
        <Button variant="link" size="sm" onClick={onChecks}>
          Open Checks
        </Button>
      </section>
      <section>
        <h2>Details</h2>
        <dl>
          <dt>Branches</dt>
          <dd className="pr-branches">
            {m.headRepo !== m.baseRepo && <RepositoryBadge repo={m.headRepo} />}
            <BranchBadge branch={m.headBranch} repo={m.headRepo} />
            <span aria-label="into">→</span>
            <BranchBadge branch={m.baseBranch} repo={m.baseRepo} />
          </dd>
          <dt>Labels</dt>
          <dd>{m.labels.length ? <PrLabels members={[m]} /> : 'None'}</dd>
          <dt>Assignees</dt>
          <dd>
            {m.assignees?.length ? (
              <span className="entity-badge-group">
                {m.assignees.map((login) => (
                  <GitHubAuthor key={login} login={login} />
                ))}
              </span>
            ) : (
              'Unassigned'
            )}
          </dd>
          <dt>Commits</dt>
          <dd>{meta.commitCount}</dd>
          <dt>Head</dt>
          <dd>
            <CommitBadge sha={m.headSha} repo={m.headRepo} />
          </dd>
          <dt>Created</dt>
          <dd>
            <time dateTime={m.createdAt} title={new Date(m.createdAt).toLocaleString()}>
              {date(m.createdAt)}
            </time>
          </dd>
        </dl>
      </section>
    </aside>
  );
}
