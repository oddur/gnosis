import { useEffect, useState, useSyncExternalStore } from 'react';
import { ArrowRight, Check, GitPullRequest } from 'lucide-react';
import type { QueueItem, ReviewMember } from '../lib/workbench';
import type { QueueSignals } from '../lib/queue-signals';
import type { PrChecks } from '../lib/pr-checks';
import { checkCounts } from '../lib/pr-checks';
import type { PrChanges } from '../lib/pr-changes';
import { fileRevisionKey } from '../lib/pr-changes';
import { useFileProgress, registerChangeProgress } from '../lib/file-view-progress';
import { inspectionData } from '../lib/inspection-cache';
import { MemberReviewStatus } from './PrReviewStatus';
import { PrBadge, RepositoryBadge } from './EntityBadge';
import { UnreadPrMarker } from './UnreadPrMarker';
import { Button } from './ui/button';

export function StackOverview({ item, signals, checks, checkErrors, checksBusy, matchingUrls, onOpen, onChecks }: {
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
  const [inventories, setInventories] = useState<PrChanges[]>(() => subject.members.flatMap(m => inspectionData.peekChanges(m) ?? []));
  const revisions = JSON.stringify(subject.members.map(({ url, baseSha, headSha }) => ({ url, baseSha, headSha })));
  useEffect(() => {
    let live = true;
    // One local SQLite read. The overview must not trigger GitHub downloads for progress.
    void window.electronAPI.getPreparedInventories(JSON.parse(revisions)).then(result => {
      if (live) { result.changes.forEach(registerChangeProgress); setInventories(result.changes); }
    }).catch(() => {});
    return () => { live = false; };
  }, [revisions]);
  const manifest = (m: ReviewMember) => [inspectionData.peekChanges(m), ...inventories].find(s => s?.url === m.url && s.metadata.baseSha === m.baseSha && s.metadata.headSha === m.headSha);
  const viewedCount = (m: ReviewMember) => manifest(m)?.files.filter(f => progress.isFileViewed(fileRevisionKey(m.url, f.path, m.baseSha, m.headSha))).length ?? 0;
  const openMembers = subject.members.filter(m => m.state === 'open' && !m.merged);
  const next = openMembers.find(m => item.unreadUrls?.includes(m.url)) ?? openMembers.find(m => !manifest(m) || viewedCount(m) < manifest(m)!.files.length);
  const filtered = matchingUrls && matchingUrls.length < subject.members.length;
  return <section className="stack-overview" aria-label="Stack overview">
    <div className="stack-overview-heading">
      <div><h2>PRs in dependency order</h2><p>{openMembers.length ? 'Start at the base, then follow the change upward.' : 'All PRs in this stack are complete.'}</p></div>
      {next && <Button size="sm" onClick={() => onOpen(next)}>Continue with #{next.number}<ArrowRight size={14} /></Button>}
    </div>
    {filtered && <p className="stack-filter-context">{matchingUrls.length} of {subject.members.length} PRs match your filters. All members are shown for context.</p>}
    <ol className="stack-overview-members">
      {subject.members.map((m, index) => {
        const parents = subject.edges.filter(e => e.child === m.url).flatMap(e => subject.members.filter(p => p.url === e.parent));
        const files = manifest(m)?.files;
        const viewed = viewedCount(m);
        const completed = m.merged || m.state === 'closed';
        const counts = checks[m.url]?.headSha === m.headSha ? checkCounts(checks[m.url]!.checks) : undefined;
        return <li key={m.url} className={`stack-overview-member ${item.unreadUrls?.includes(m.url) ? 'is-unread' : ''}`}>
          <span className="stack-member-order" aria-label={`Step ${index + 1}`}>{completed ? <Check size={16} /> : index + 1}</span>
          <div className="stack-member-main">
            <div className="stack-member-title"><button onClick={() => onOpen(m)}>{m.title}</button><UnreadPrMarker urls={[m.url]} /></div>
            <div className="stack-member-meta"><PrBadge url={m.url} number={m.number} title={m.title} /><RepositoryBadge repo={m.repo} /><span>{parents.length ? `Builds on ${parents.map(p => `#${p.number}`).join(', ')}` : 'Base of stack'}</span>{filtered && <span>{matchingUrls.includes(m.url) ? 'Matches filters' : 'Dependency context'}</span>}</div>
            <div className="stack-member-status"><MemberReviewStatus member={m} signals={signals.find(s => s.url === m.url && s.headSha === m.headSha)} />
              <button className={counts?.attention ? 'stack-checks-failed' : ''} onClick={() => onChecks(m)} title={checkErrors[m.url] || 'Open check results'}>
                {checkErrors[m.url] ? 'Checks unavailable · View details' : checks[m.url] && !counts ? 'Checks out of date · View details' : !counts ? checksBusy ? 'Loading checks…' : 'Checks unavailable · View details' : !checks[m.url]!.checks.length ? 'No checks reported' : counts.attention ? `${counts.attention} ${counts.attention === 1 ? 'check needs' : 'checks need'} attention` : counts.running ? `${counts.running} checks running` : `${counts.passed}/${checks[m.url]!.checks.length} checks passed`}
              </button>
              <span>{files ? `${viewed}/${files.length} files viewed` : 'File progress unavailable'}</span>
            </div>
          </div>
          <button className="workbench-icon" onClick={() => onOpen(m)} aria-label={`Open PR #${m.number}`}><GitPullRequest size={16} /></button>
        </li>;
      })}
    </ol>
  </section>;
}
