import { BulkCheckRerun } from './BulkCheckRerun';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { ArrowRight } from 'lucide-react';
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

export function StackOverview({
  now,
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
}: {
  now: number;
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
}) {
  const { subject } = item;
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
  return (
    <section className="stack-overview" aria-label="Stack overview">
      <StackMergePlan key={subject.id} plan={plan} onOpen={onOpen} account={account} onChanged={onRefresh} />
      <div className="stack-overview-heading">
        <div>
          <h2>Stack dependencies</h2>
          {filtered && (
            <span className="stack-filter-context">
              {matchingUrls.length} of {subject.members.length} match filters; dependencies included.
            </span>
          )}
          {!openMembers.length && <span className="stack-filter-context">All PRs complete.</span>}
        </div>
        <BulkCheckRerun key={subject.id} members={subject.members} values={checks} onChanged={onRefresh} />
        {next && (
          <Button size="sm" variant="outline" onClick={() => onOpen(next)}>
            Continue review
            <ArrowRight size={14} />
          </Button>
        )}
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
          return (
            <>
              <span className="stack-personal-progress">
                {snapshot
                  ? `${viewedCount(member)}/${snapshot.metadata.changedFileCount ?? snapshot.files.length} files viewed${snapshot.filesTruncated ? ' · Partial file list' : ''}`
                  : 'File progress unavailable'}
              </span>
            </>
          );
        }}
        renderColumns={(member) => {
          const facts = factsFor(member);
          return (
            <>
              <div className="stack-status-cell" role="group" aria-label="Review status">
                <span className="stack-cell-label">Review status</span>
                <MemberReviewStatus
                  member={member}
                  signals={signals.find((s) => s.url === member.url && s.headSha === member.headSha)}
                  now={now}
                  checking={checking}
                  staleLabel="Status needs refresh"
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
                  className={`stack-check-result is-${facts.checksTone}`}
                  onClick={() => onChecks(member)}
                  title={checkErrors[member.url] || 'View check results'}
                >
                  {checkErrors[member.url]
                    ? checks[member.url]
                      ? `${facts.checkLabel} · Updates delayed`
                      : 'Checks unavailable'
                    : checksBusy && !checks[member.url]
                      ? 'Checking…'
                      : facts.checkLabel}
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
                <span>{facts.branch.label}</span>
                {facts.branch.detail && <small>{facts.branch.detail}</small>}
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
            onRefresh={onRefresh}
            refreshDisabled={refreshBusy}
          />
        )}
      />
    </section>
  );
}
