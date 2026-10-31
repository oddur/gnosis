import { useEffect, useState, useSyncExternalStore } from 'react';
import { ArrowRight } from 'lucide-react';
import type { QueueItem, ReviewMember } from '../lib/workbench';
import { QUEUE_SIGNALS_TTL, type QueueSignals } from '../lib/queue-signals';
import type { PrChecks } from '../lib/pr-checks';
import { checkCounts, checkSummary } from '../lib/pr-checks';
import type { PrChanges } from '../lib/pr-changes';
import { fileRevisionKey } from '../lib/pr-changes';
import { useFileProgress, registerChangeProgress } from '../lib/file-view-progress';
import { inspectionData } from '../lib/inspection-cache';
import { MemberReviewStatus } from './PrReviewStatus';
import { StackDependencyChain } from './StackDependencyChain';
import { stackMergeLabel, stackMergeTarget, stackNextStep } from '../lib/stack-overview';
import { stackMergeStatus } from '../lib/stack-merge-status';
import { openConflictWorkspace } from '../lib/open-conflict-workspace';
import { Button } from './ui/button';

export function StackOverview({
  now,
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
  onChecks: (member: ReviewMember) => void;
}) {
  const { subject } = item;
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
  const mergeStatus = stackMergeStatus(subject, signals, checks, now);
  const step = stackNextStep(subject, mergeStatus);
  const stepSignal =
    step &&
    signals.find((signal) => signal.url === step.entry.member.url && signal.headSha === step.entry.member.headSha);
  const target = step && stackMergeTarget(subject, step.entry.member, stepSignal, now);
  return (
    <section className="stack-overview" aria-label="Stack overview">
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
        {next && (
          <Button size="sm" variant="outline" onClick={() => onOpen(next)}>
            Continue review
            <ArrowRight size={14} />
          </Button>
        )}
      </div>
      {step && (
        <div className="stack-next-step" role="region" aria-label="Next merge step">
          <div>
            <p>
              <strong>
                {step.action === 'resolve'
                  ? `#${step.entry.member.number} conflicts with ${target?.label}`
                  : `#${step.entry.member.number}: ${stackMergeLabel(step.entry.member, stepSignal, now, checking).label}`}
              </strong>
            </p>
            {(step.action === 'resolve' || step.entry.readiness.label === 'Update required to merge') &&
              step.children.length > 0 && (
                <p>
                  After updating this PR, recheck {step.children.map((member) => `#${member.number}`).join(', ')}.
                  Dependent branches may need their own update.
                </p>
              )}
          </div>
          <Button
            size="sm"
            disabled={step.action === 'refresh' && refreshBusy}
            onClick={() => {
              if (step.action === 'resolve') openConflictWorkspace(step.entry.member.url);
              else if (step.action === 'checks') onChecks(step.entry.member);
              else if (step.action === 'refresh') onRefresh();
              else onOpen(step.entry.member);
            }}
          >
            {step.action === 'resolve'
              ? `Resolve #${step.entry.member.number} conflicts…`
              : step.action === 'checks'
                ? `View #${step.entry.member.number} checks`
                : step.action === 'refresh'
                  ? refreshBusy
                    ? 'Refreshing…'
                    : 'Refresh merge status'
                  : `Open PR #${step.entry.member.number}`}
          </Button>
        </div>
      )}
      {signals.some((signal) => now - signal.checkedAt >= QUEUE_SIGNALS_TTL) && (
        <div className="stack-status-refresh">
          <span>Saved review and merge status needs refresh.</span>
          <button disabled={refreshBusy} onClick={onRefresh}>
            {refreshBusy ? 'Refreshing…' : 'Refresh status'}
          </button>
        </div>
      )}
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
          const counts =
            checks[member.url]?.headSha === member.headSha ? checkCounts(checks[member.url]?.checks ?? []) : undefined;
          return (
            <>
              <span className="stack-personal-progress">
                Your review ·{' '}
                {snapshot
                  ? `${viewedCount(member)}/${snapshot.metadata.changedFileCount ?? snapshot.files.length} files viewed${snapshot.filesTruncated ? ' · Partial file list' : ''}`
                  : 'File progress unavailable'}
              </span>
              <span className="stack-github-review">
                GitHub{' '}
                <MemberReviewStatus
                  member={member}
                  signals={signals.find((signal) => signal.url === member.url && signal.headSha === member.headSha)}
                  now={now}
                  checking={checking}
                  staleLabel="Status needs refresh"
                />
              </span>
              <button
                className={counts?.attention ? 'stack-checks-failed' : ''}
                onClick={() => onChecks(member)}
                title={checkErrors[member.url] || 'Open check results'}
              >
                {checkErrors[member.url]
                  ? 'Checks unavailable'
                  : checks[member.url] && !counts
                    ? 'Checks need refresh'
                    : !counts
                      ? checksBusy
                        ? 'Loading checks…'
                        : 'Checks unavailable'
                      : checkSummary(checks[member.url]?.checks ?? [])}
              </button>
            </>
          );
        }}
      />
    </section>
  );
}
