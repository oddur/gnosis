import {
  Check,
  CircleDot,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  MessageSquare,
  Minus,
  X,
} from 'lucide-react';
import { GitHubAuthor } from './GitHubAuthor';
import type { ReviewMember, ReviewSubject } from '../lib/workbench';
import { useQueueSignals } from '../lib/use-queue-signals';
import { QUEUE_SIGNALS_TTL } from '../lib/queue-signals';
import { timeAgo } from '../lib/utils';
import { subjectReadiness } from '../lib/merge-readiness';
import { ReadinessBadge } from './MergeReadiness';

export function PrStateIcon({ member }: { member: ReviewMember }) {
  const state = member.merged ? 'merged' : member.state === 'closed' ? 'closed' : member.isDraft ? 'draft' : 'open';
  const Icon =
    state === 'merged'
      ? GitMerge
      : state === 'closed'
        ? GitPullRequestClosed
        : state === 'draft'
          ? GitPullRequestDraft
          : GitPullRequest;
  return (
    <span
      className={`queue-pr-icon is-${state}`}
      role="img"
      aria-label={`${state} pull request`}
      title={`${state[0].toUpperCase()}${state.slice(1)} pull request`}
    >
      <Icon size={17} aria-hidden="true" />
    </span>
  );
}
export function QueueMetadata({ subject, account }: { subject: ReviewSubject; account: string | null }) {
  const { ref, values, loaded } = useQueueSignals(
    account,
    subject.members.map((m) => ({ url: m.url, headSha: m.headSha }))
  );
  const member = subject.members[0];
  const stack = subject.kind === 'stack';
  const complete = values.length === subject.members.length;
  const total = values.reduce((n, value) => n + value.checks.total, 0);
  const passed = values.reduce((n, value) => n + value.checks.passed, 0);
  const skipped = values.reduce((n, value) => n + (value.checks.skipped ?? 0), 0);
  const stale = values.some((value) => Date.now() - value.checkedAt >= QUEUE_SIGNALS_TTL);
  const lastChecked = complete
    ? timeAgo(new Date(Math.min(...values.map((value) => value.checkedAt))).toISOString())
    : null;
  const state = !complete
    ? 'unknown'
    : values.some((v) => v.checks.state === 'failure')
      ? 'failure'
      : values.some((v) => v.checks.state === 'pending')
        ? 'pending'
        : total
          ? 'success'
          : 'neutral';
  const CheckIcon = state === 'failure' ? X : state === 'pending' ? CircleDot : state === 'success' ? Check : Minus;
  const checkLabel = !complete
    ? loaded
      ? 'Checks unavailable'
      : 'Checks not loaded'
    : !total
      ? 'No checks'
      : `${passed + skipped}/${total}`;
  const checkDescription = !complete
    ? checkLabel
    : `${passed} of ${total} checks passed${skipped ? `, ${skipped} skipped or neutral` : ''}${state === 'failure' ? ', some checks failed' : state === 'pending' ? ', checks pending' : ''}${stack ? ' across this stack' : ''}. Last checked ${lastChecked}.`;
  const counts = subject.members.map(
    (m) => values.find((v) => v.url === m.url && v.headSha === m.headSha)?.comments ?? m.commentCount
  );
  const comments = counts.every((n) => n !== undefined) ? counts.reduce<number>((n, count) => n + count, 0) : undefined;
  const timestamp = stack
    ? subject.members.reduce((latest, m) => (m.updatedAt > latest ? m.updatedAt : latest), member.updatedAt)
    : member.createdAt;
  return (
    <div ref={ref} className="queue-metadata-line">
      <div className="queue-meta">
        <span className="queue-repository">{member.repo}</span>
        <span className="queue-pr-origin">
          {stack ? `${subject.members.length} PRs in stack · updated ` : `#${member.number} opened `}
          <time dateTime={timestamp} title={new Date(timestamp).toLocaleString()}>
            {timeAgo(timestamp)}
          </time>
          {!stack && (
            <>
              {' '}
              by <GitHubAuthor login={member.author} />
            </>
          )}
        </span>
        <span
          className={`queue-checks is-${state}${stale ? ' is-stale' : ''}`}
          title={checkDescription}
          aria-label={checkDescription}
        >
          <CheckIcon size={14} aria-hidden="true" />
          {checkLabel}
        </span>
        <ReadinessBadge readiness={subjectReadiness(subject, values)} />
      </div>
      {comments !== undefined && comments > 0 && (
        <span
          className="queue-comments"
          title={`${comments} conversation comment${comments === 1 ? '' : 's'}${stack ? ' across this stack' : ''}`}
          aria-label={`${comments} conversation comments`}
        >
          <MessageSquare size={15} aria-hidden="true" />
          {comments}
        </span>
      )}
    </div>
  );
}
