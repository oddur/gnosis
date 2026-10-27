import type { ReactNode } from 'react';
import { SearchableSelect } from './SearchableSelect';
import { PrEntryActions, type PrGenerationActionsFor } from './PrEntryActions';
import { PrDetails } from './PrDetails';
import { memberReadiness } from './PrReadiness';
import type { ReviewSubject } from '../lib/workbench';
import type { PrStatus } from '../lib/types';
import type { QueueSignals } from '../lib/queue-signals';
import { mergeReadiness } from '../lib/merge-readiness';
import { ReadinessBadge } from './MergeReadiness';
import { MemberReviewStatus } from './PrReviewStatus';

export function PrSubjectDetails({
  subject,
  activeUrl,
  onSelect,
  statuses = {},
  statusErrors = {},
  onRetryStatus,
  compactIdentity = false,
  statusChecking = false,
  signals = [],
  starredUrls,
  starBusy,
  onStarChange,
  onMute,
  muteBusy,
  generationActions,
  onReview,
  reviewDisabled,
  checkSummary,
}: {
  subject: ReviewSubject;
  generationActions?: PrGenerationActionsFor;
  onReview?: (member: ReviewSubject['members'][number]) => void;
  reviewDisabled?: boolean;
  checkSummary?: (url: string) => ReactNode;
  activeUrl: string;
  onSelect: (url: string) => void;
  statuses?: Partial<Record<string, PrStatus>>;
  statusErrors?: Record<string, string>;
  onRetryStatus?: () => void;
  compactIdentity?: boolean;
  statusChecking?: boolean;
  signals?: QueueSignals[];
  starredUrls?: ReadonlySet<string>;
  starBusy?: boolean;
  muteBusy?: boolean;
  onMute?: (members: ReviewSubject['members']) => void;
  onStarChange?: (members: ReviewSubject['members'], starred: boolean) => void;
}) {
  const member = subject.members.find((m) => m.url === activeUrl) ?? subject.members[0];
  const stacked = subject.members.length > 1;
  const relationship = (url: string) => {
    const parents = subject.edges
      .filter((e) => e.child === url)
      .map((e) => subject.members.find((m) => m.url === e.parent)?.number);
    return parents.length
      ? `Builds on ${parents.map((n) => (n === undefined ? 'an earlier PR' : `#${n}`)).join(', ')}`
      : 'Base of stack';
  };
  return (
    <div className={`pr-subject-details ${stacked ? 'has-stack' : ''}`}>
      {stacked && (
        <>
          <nav className="pr-stack-nav" aria-label="PRs in this stack">
            <h2>PRs in this stack</h2>
            <p>Read from the base upward.</p>
            <ol>
              {subject.members.map((m, i) => (
                <li key={m.url}>
                  <button
                    aria-current={m.url === member.url ? 'true' : undefined}
                    aria-controls="pr-member-detail"
                    onClick={() => onSelect(m.url)}
                  >
                    <span className="pr-stack-number">{i + 1}</span>
                    <span>
                      <strong>
                        #{m.number} {m.title}
                      </strong>
                      <small>{relationship(m.url)}</small>
                      {onRetryStatus && <MemberReviewStatus member={m} signals={signals.find(s => s.url === m.url && s.headSha === m.headSha) ?? statuses[m.url]?.signals} checking={statusChecking && !statusErrors[m.url]} />}
                      <ReadinessBadge
                        reviewStatusShown={!!onRetryStatus}
                        readiness={mergeReadiness(m, signals.find((s) => s.url === m.url) ?? statuses[m.url]?.signals)}
                      />
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          </nav>
          {!compactIdentity && <div className="pr-stack-select">
            <label htmlFor="pr-stack-member">PR in stack</label>
            <SearchableSelect id="pr-stack-member" label="PR in stack" value={member.url} onValueChange={onSelect}
              options={subject.members.map((m, i) => ({ value: m.url,
                label: `${i + 1} of ${subject.members.length} · #${m.number} · ${memberReadiness(
                  m, statuses[m.url], statusErrors[m.url], signals.find(s => s.url === m.url)
                )} — ${m.title}` }))}
            />
          </div>}
        </>
      )}
      <div
        id="pr-member-detail"
        className="pr-member-detail"
        role="region"
        aria-label={`Selected PR #${member.number}`}
      >
        {stacked && (
          <p className="pr-member-relationship">
            {relationship(member.url)} · {subject.members.findIndex((m) => m.url === member.url) + 1} of{' '}
            {subject.members.length} PRs
          </p>
        )}
        {stacked && onRetryStatus && <div className="pr-member-review-status">
          <MemberReviewStatus member={member} signals={signals.find(s => s.url === member.url && s.headSha === member.headSha) ?? statuses[member.url]?.signals} checking={statusChecking && !statusErrors[member.url]} />
        </div>}
        <PrDetails
          key={member.url}
          member={member}
          checkSummary={checkSummary?.(member.url)}
          starControl={
            stacked && starredUrls && onStarChange ? (
              <PrEntryActions {...generationActions?.([member])} onReview={onReview} reviewDisabled={reviewDisabled} members={[member]} starredUrls={starredUrls} busy={starBusy || muteBusy} onStarChange={onStarChange} onMute={onMute} />
            ) : undefined
          }
          showTitle={stacked}
          showIdentity={stacked || !compactIdentity}
          status={statuses[member.url]}
          signals={signals.find((s) => s.url === member.url)}
          statusError={statusErrors[member.url]}
          onRetryStatus={onRetryStatus}
        />
      </div>
    </div>
  );
}
