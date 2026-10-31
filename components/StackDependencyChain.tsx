import type { ReactNode } from 'react';
import {
  CheckCircle2,
  CircleHelp,
  Clock3,
  GitBranch,
  GitMerge,
  GitPullRequestClosed,
  GitPullRequestDraft,
  AlertCircle,
  ChevronRight,
} from 'lucide-react';
import { BranchBadge, PrBadge, RepositoryBadge } from './EntityBadge';
import { stackDependencyOrder, stackMergeLabel, stackMergeTarget } from '../lib/stack-overview';
import type { QueueSignals } from '../lib/queue-signals';
import type { ReviewMember, ReviewSubject } from '../lib/workbench';

export function StackDependencyChain({
  subject,
  signals,
  now,
  checking,
  currentUrl,
  matchingUrls,
  unreadUrls,
  onOpen,
  renderProgress,
  renderColumns,
  renderDetails,
}: {
  subject: ReviewSubject;
  signals: QueueSignals[];
  now: number;
  checking?: boolean;
  currentUrl?: string;
  matchingUrls?: string[];
  unreadUrls?: string[];
  onOpen: (member: ReviewMember) => void;
  renderProgress?: (member: ReviewMember) => ReactNode;
  renderColumns?: (member: ReviewMember) => ReactNode;
  renderDetails?: (member: ReviewMember) => ReactNode;
}) {
  const order = stackDependencyOrder(subject);
  const members = order.linear ? [...order.members].reverse() : order.members;
  const base = order.members.at(0);
  const baseTarget =
    base &&
    stackMergeTarget(
      subject,
      base,
      signals.find((signal) => signal.url === base.url),
      now
    );
  const mixedRepos = new Set(subject.members.map((member) => member.repo)).size > 1;
  return (
    <div className={`stack-dependency-chain ${renderColumns ? 'stack-status-table' : ''}`} data-linear={order.linear}>
      {!order.linear && (
        <p className="stack-chain-note">This group is not a single linear chain. Dependencies are listed per PR.</p>
      )}
      {renderColumns && (
        <div className="stack-status-columns" aria-hidden="true">
          <span>{order.linear ? 'Pull request · tip to base' : 'Pull request · dependencies'}</span>
          <span>Review status</span>
          <span>Checks</span>
          <span>Branch</span>
        </div>
      )}
      <ol className="stack-overview-members" aria-label={order.linear ? 'Stack from tip to base' : 'PR dependencies'}>
        {members.map((member) => {
          const signal = signals.find((value) => value.url === member.url && value.headSha === member.headSha);
          const state = stackMergeLabel(member, signal, now, checking);
          const target = stackMergeTarget(subject, member, signal, now);
          const parents = subject.edges
            .filter((edge) => edge.child === member.url)
            .flatMap((edge) => subject.members.filter((parent) => parent.url === edge.parent));
          const Icon =
            state.label === 'Merged'
              ? GitMerge
              : state.label === 'Draft'
                ? GitPullRequestDraft
                : state.label === 'Closed'
                  ? GitPullRequestClosed
                  : state.tone === 'success'
                    ? CheckCircle2
                    : state.tone === 'danger'
                      ? AlertCircle
                      : state.tone === 'warning'
                        ? Clock3
                        : CircleHelp;
          return (
            <li
              key={member.url}
              data-pr-url={member.url}
              aria-current={currentUrl === member.url ? 'page' : undefined}
              className={`stack-overview-member ${unreadUrls?.includes(member.url) ? 'is-unread' : ''}`}
            >
              <span className={`stack-chain-node is-${state.tone}`}>
                <Icon size={16} aria-hidden="true" />
              </span>
              <div className="stack-member-main">
                <div className="stack-member-title">
                  <PrBadge url={member.url} number={member.number} title={member.title} />
                  <button onClick={() => onOpen(member)}>{member.title}</button>
                  {currentUrl === member.url && <span className="stack-current-label">Current PR</span>}
                </div>
                <div className="stack-member-branches">
                  {mixedRepos && <RepositoryBadge repo={member.repo} />}
                  <BranchBadge branch={member.headBranch} repo={member.headRepo} />
                  <span>into</span>
                  {target.parent ? (
                    <button className="stack-parent-link" onClick={() => target.parent && onOpen(target.parent)}>
                      #{target.parent.number}
                    </button>
                  ) : (
                    <BranchBadge branch={target.branch} repo={member.baseRepo} />
                  )}
                  {!order.linear && parents.length > 0 && (
                    <span>Builds on {parents.map((parent) => `#${parent.number}`).join(', ')}</span>
                  )}
                  {matchingUrls && !matchingUrls.includes(member.url) && <span>Outside filters</span>}
                  {renderProgress && <span className="stack-member-progress">{renderProgress(member)}</span>}
                </div>
              </div>
              {renderColumns ? (
                <div className="stack-member-signals">{renderColumns(member)}</div>
              ) : (
                <div className="stack-member-status">
                  <span className={`stack-merge-state is-${state.tone}`} title={state.details.join(' ')}>
                    {state.label}
                  </span>
                  <button
                    className="workbench-icon"
                    onClick={() => onOpen(member)}
                    aria-label={`Open PR #${member.number}`}
                  >
                    <ChevronRight size={16} />
                  </button>
                </div>
              )}
              {renderDetails && <div className="stack-member-details">{renderDetails(member)}</div>}
            </li>
          );
        })}
      </ol>
      {order.linear && base && (
        <div className="stack-chain-base">
          <GitBranch size={16} aria-hidden="true" />
          <span>Base branch</span>
          <BranchBadge branch={baseTarget?.branch ?? base.baseBranch} repo={base.baseRepo} />
        </div>
      )}
    </div>
  );
}
