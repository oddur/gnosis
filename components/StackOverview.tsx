import { useEvidenceDiscussions } from '../lib/use-evidence-discussions';

import { LoadingIndicator } from './LoadingState';
import { stackDependencyOrder } from '../lib/stack-overview';
import { BulkCheckRerun } from './BulkCheckRerun';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { ArrowRight, CircleAlert, CircleCheck, CircleHelp, CircleMinus, Clock3 } from 'lucide-react';
import { conflictIcon as ConflictIcon } from '../lib/interface-icons';
import type { QueueItem, ReviewMember } from '../lib/workbench';
import { type QueueSignals } from '../lib/queue-signals';
import type { PrChecks } from '../lib/pr-checks';
import type { PrChanges } from '../lib/pr-changes';
import { fileRevisionKey } from '../lib/pr-changes';
import { useFileProgress, registerChangeProgress } from '../lib/file-view-progress';
import { inspectionData } from '../lib/inspection-cache';
import { MemberReviewStatus } from './PrReviewStatus';
import { StackDependencyChain } from './StackDependencyChain';
import { stackMemberStatus } from '../lib/stack-member-status';
import { StackMemberDetails } from './StackMergeDetails';
import { Button } from './ui/button';
import { stackMergePlan } from '../lib/stack-merge-plan';
import { StackMergePlan } from './StackMergePlan';
import { StackConflictPlan } from './StackConflictPlan';
import { useStatusNow } from '../lib/status-clock';

export function StackOverview({
  account,
  checking,
  onRefresh,
  refreshBusy,
  item,
  signals,
  checks,
  checkErrors,
  checksBusy,
  matchingUrls,
  onOpen,
  onChecks,
  onFeedback,
}: {
  account: string | null;
  checking: boolean;
  onRefresh: () => void;
  refreshBusy: boolean;
  item: QueueItem;
  signals: QueueSignals[];
  checks: Record<string, PrChecks | undefined>;
  checkErrors: Partial<Record<string, string>>;
  checksBusy: boolean;
  matchingUrls?: string[];
  onOpen: (member: ReviewMember) => void;
  onChecks: (member: ReviewMember, id?: string) => void;
  onFeedback: (member: ReviewMember) => void;
}) {
  const { subject } = item;
  const discussions = useEvidenceDiscussions(subject, account, false);
  const linear = stackDependencyOrder(subject).linear;
  const now = useStatusNow();
  const plan = stackMergePlan(subject, signals, checks, now);
  const progress = useFileProgress();
  useSyncExternalStore(inspectionData.subscribe, inspectionData.getVersion);
  const [inventories, setInventories] = useState<PrChanges[]>(() =>
    subject.members.flatMap((m) => inspectionData.peekChanges(m) ?? [])
  );
  const revisions = JSON.stringify(subject.members.map(({ url, baseSha, headSha }) => ({ url, baseSha, headSha })));
  useEffect(() => {
    let live = true;
    // One local SQLite read. The overview must not trigger GitHub downloads for progress.
    void window.electronAPI
      .getPreparedInventories(JSON.parse(revisions) as Pick<ReviewMember, 'url' | 'baseSha' | 'headSha'>[])
      .then((result) => {
        if (live) {
          result.changes.forEach(registerChangeProgress);
          setInventories(result.changes);
        }
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [revisions]);
  const manifest = (m: ReviewMember) =>
    [inspectionData.peekChanges(m), ...inventories].find(
      (s) => s?.url === m.url && s.metadata.baseSha === m.baseSha && s.metadata.headSha === m.headSha
    );
  const viewedCount = (m: ReviewMember) =>
    manifest(m)?.files.filter((f) => progress.isFileViewed(fileRevisionKey(m.url, f.path, m.baseSha, m.headSha)))
      .length ?? 0;
  const openMembers = subject.members.filter((m) => m.state === 'open' && !m.merged);
  const next =
    openMembers.find((m) => item.unreadUrls?.includes(m.url)) ??
    openMembers.find((m) => {
      const snapshot = manifest(m);
      return !snapshot || snapshot.filesTruncated || viewedCount(m) < snapshot.files.length;
    });
  const filtered = matchingUrls && matchingUrls.length < subject.members.length;
  const factsFor = (member: ReviewMember) =>
    stackMemberStatus(
      member,
      signals.find((signal) => signal.url === member.url && signal.headSha === member.headSha),
      checks[member.url],
      now
    );
  const mergedCount = subject.members.filter((m) => m.merged).length;
  const attentionCount = openMembers.filter((m) => {
    const facts = factsFor(m);
    return facts.blockers.length > 0 || facts.checksTone !== 'muted' || facts.branch.tone === 'danger';
  }).length;
  const fileTotals = openMembers.reduce(
    (sum, m) => {
      const snapshot = manifest(m);
      return snapshot
        ? { viewed: sum.viewed + viewedCount(m), total: sum.total + (snapshot.metadata.changedFileCount ?? snapshot.files.length) }
        : sum;
    },
    { viewed: 0, total: 0 }
  );
  return (
    <section className="stack-overview" aria-label="Stack overview">
      <StackConflictPlan subject={subject} signals={signals} account={account} />
      <StackMergePlan key={subject.id} plan={plan} onOpen={onOpen} account={account} onChanged={onRefresh} refreshing={checking || refreshBusy} />
      <div className="stack-overview-heading">
        <div>
          <h2>Pull requests <span className="stack-member-count">{subject.members.length}</span></h2>
          {linear && <span className="stack-chain-direction">Dependent PRs first · base branch below</span>}
          {filtered && (
            <span className="stack-filter-context">
              {matchingUrls.length} of {subject.members.length} match filters; dependencies included.
            </span>
          )}
          {!openMembers.length && <span className="stack-filter-context">All PRs complete.</span>}
          {openMembers.length > 0 && (
            <p className="stack-progress-summary">
              {mergedCount > 0 && <span>{mergedCount} of {subject.members.length} merged</span>}
              <span className={attentionCount ? 'is-attention' : undefined}>
                {attentionCount
                  ? `${attentionCount} ${attentionCount === 1 ? 'PR needs' : 'PRs need'} attention`
                  : 'No open PR needs attention'}
              </span>
              {fileTotals.total > 0 && <span>{fileTotals.viewed}/{fileTotals.total} files viewed in open PRs</span>}
            </p>
          )}
        </div>
        <div className="stack-overview-actions">
        <BulkCheckRerun key={subject.id} members={subject.members} values={checks} onChanged={onRefresh} />
        {next && (
          <Button size="sm" variant="outline" onClick={() => onOpen(next)}>
            Continue review
            <ArrowRight size={14} />
          </Button>
        )}
        </div>
      </div>
      <StackDependencyChain
        subject={subject}
        signals={signals}
        now={now}
        checking={checking}
        matchingUrls={matchingUrls}
        unreadUrls={item.unreadUrls}
        onOpen={onOpen}
        renderProgress={(member) => {
          const snapshot = manifest(member);
          if (!snapshot) return <span className="stack-personal-progress">File progress unavailable</span>;
          const viewed = viewedCount(member);
          const total = snapshot.metadata.changedFileCount ?? snapshot.files.length;
          return (
            <span className={`stack-personal-progress ${total && viewed >= total ? 'is-complete' : ''}`}>
              <span className="stack-progress-bar" aria-hidden="true">
                <span style={{ width: `${total ? Math.min(100, (viewed / total) * 100) : 0}%` }} />
              </span>
              {`${viewed}/${total} files viewed${snapshot.filesTruncated ? ' · Partial file list' : ''}`}
            </span>
          );
        }}
        renderColumns={(member) => {
          const facts = factsFor(member);
          const signal = signals.find((s) => s.url === member.url && s.headSha === member.headSha);
          if (facts.finished)
            // A merged or closed PR needs nothing more; one quiet label spans its status columns.
            return (
              <div className="stack-status-cell stack-status-finished" role="group" aria-label="Status">
                <MemberReviewStatus member={member} signals={signal} now={now} checking={checking} />
              </div>
            );
          const checksError = checkErrors[member.url];
          const checksLoading = !checksError && checksBusy && !checks[member.url];
          // Healthy results stay quiet: passing counts without the skipped tally, which remains in the tooltip.
          const healthyChecks = !checksError && !!facts.checkList && facts.checksTone === 'muted' && !facts.attention.length && /passed/.test(facts.checkLabel) && !/running/.test(facts.checkLabel);
          const checkText = checksError
            ? checks[member.url]
              ? `${facts.checkLabel} · Updates delayed`
              : 'Checks unavailable'
            : healthyChecks
              ? facts.checkLabel.split(' · ').filter((part) => !/skipped|neutral/.test(part)).join(' · ') || facts.checkLabel
              : facts.checkLabel;
          const CheckIcon = checksError ? CircleHelp : healthyChecks ? CircleCheck : /running/.test(facts.checkLabel) && !facts.attention.length ? Clock3 : facts.checksTone === 'muted' ? (facts.checkLabel === 'No checks reported' ? CircleMinus : CircleHelp) : CircleAlert;
          const quietBranch = facts.branch.tone === 'muted' && ['Up to date', 'No conflicts'].includes(facts.branch.label);
          const optionalUpdate = facts.branch.detail === 'Update optional';
          return (
            <>
              <div className="stack-status-cell" role="group" aria-label="Review status">
                <span className="stack-cell-label">Review</span>
                <MemberReviewStatus
                  member={member}
                  signals={signal}
                  now={now}
                  checking={checking}
                  staleLabel="Status needs refresh"
                  quietUnknown
                />
                {facts.policy?.isDraft &&
                  ['REVIEW_REQUIRED', 'CHANGES_REQUESTED'].includes(facts.policy.reviewDecision ?? '') && (
                    <small>
                      {facts.policy.reviewDecision === 'CHANGES_REQUESTED' ? 'Changes requested' : 'Approval required'}
                    </small>
                  )}
              </div>
              <div className="stack-status-cell" role="group" aria-label="Checks">
                <span className="stack-cell-label">Checks</span>
                <button
                  className={`stack-check-result is-${facts.checksTone} ${healthyChecks ? 'is-quiet' : ''}`}
                  onClick={() => onChecks(member)}
                  title={checksError || `${facts.checkLabel}. View check results`}
                >
                  {checksLoading ? (
                    <LoadingIndicator>Checking…</LoadingIndicator>
                  ) : (
                    <>
                      <CheckIcon size={14} aria-hidden="true" />
                      <span>{checkText}</span>
                    </>
                  )}
                </button>
                {facts.attention.length > 0 && (
                  <small>
                    {facts.readiness.ready
                      ? 'Does not block merging'
                      : facts.required.length
                        ? `${facts.required.length} required to merge`
                        : facts.attention.every((check) => check.required === false)
                          ? 'Optional · Not a merge blocker'
                          : 'Requirements not confirmed'}
                  </small>
                )}
              </div>
              <div
                className={`stack-status-cell stack-member-status is-${facts.branch.tone}`}
                role="group"
                aria-label="Branch status"
              >
                <span className="stack-cell-label">Branch</span>
                {quietBranch ? (
                  <span className="stack-status-quiet" title={facts.branch.label}>
                    <span className="sr-only">{facts.branch.label}</span>
                  </span>
                ) : (
                  <span title={facts.branch.detail ? `${facts.branch.label} · ${facts.branch.detail}` : undefined}>
                    {facts.branch.label === 'Conflicts' && <ConflictIcon size={14} aria-hidden="true" className="stack-conflict-icon" />}
                    {facts.branch.label}
                  </span>
                )}
                {facts.branch.detail &&
                  (optionalUpdate ? (
                    <span className="sr-only">{facts.branch.detail}</span>
                  ) : (
                    <small>{facts.branch.detail}</small>
                  ))}
              </div>
            </>
          );
        }}
        renderDetails={(member) => (
          <StackMemberDetails
            key={`${member.url}:${member.headSha}`}
            member={member}
            facts={factsFor(member)}
            onChecks={() =>
              onChecks(member, factsFor(member).required[0]?.id ?? factsFor(member).requiredRunning[0]?.id)
            }
            onFeedback={() => onFeedback(member)}
            feedbackCount={discussions.values[member.url]?.threads.filter(thread => !thread.isResolved).length}
            onRefresh={onRefresh}
            refreshDisabled={refreshBusy}
          />
        )}
      />
    </section>
  );
}
