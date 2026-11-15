import { createGitHubWriteRefresher, type GitHubWriteAction, type GitHubWriteEvent } from '../../lib/github-write-refresh';
import type { GitHubSyncUpdate, GitHubSyncInterest } from '../../lib/github-sync';
import type { QueueSignals, QueueSignalRequest } from '../../lib/queue-signals';
import type { PrStatus } from '../../lib/types';
import type { QueueItem, ReviewMember } from '../../lib/workbench';
import { lifecycleOf } from '../../lib/pr-lifecycle';

type Readiness = NonNullable<QueueSignals['readiness']>;
interface GitHubPr {
  metadata: ReviewMember;
  signals: Omit<QueueSignals, 'url' | 'headSha' | 'checkedAt'>;
}
/**
 * A synthetic GitHub for writes. Each write changes GitHub only after `lag` more reads of the PR, like GitHub's
 * eventually consistent merge state, review decision and check runs. The real `createGitHubWriteRefresher` stands in
 * for main: it reads this GitHub, publishes through the sync fixture, and tells the page. Nothing here reaches GitHub.
 */
export function installGitHubWritesFixture(mocks: Record<string, unknown>, items: QueueItem[]) {
  const sync = (window as unknown as {
    syncFixture: { emit: (update: GitHubSyncUpdate) => void; subscriptions: Map<string, GitHubSyncInterest> };
  }).syncFixture;
  const github = new Map<string, GitHubPr>();
  const pending = new Map<string, { after: number; apply: (pr: GitHubPr) => void }>();
  const reads = new Map<string, number>();
  const listeners = new Set<(event: GitHubWriteEvent) => void>();
  const record = { writes: [] as string[], reads: 0, forcedStatus: 0, events: [] as GitHubWriteEvent[] };
  let clock = Date.parse('2026-11-15T09:00:00Z');
  const stamp = () => new Date((clock += 60_000)).toISOString();
  const readiness = (patch: Partial<Readiness> = {}): Readiness => ({
    state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', mergeState: 'CLEAN', reviewDecision: 'APPROVED',
    baseBranch: 'main', baseSha: 'base', behindBy: 0, mergeQueue: false, queueState: null, ...patch,
  });
  const member = (url: string) => {
    const found = items.flatMap((item) => item.subject.members).find((m) => m.url === url);
    if (!found) throw Error(`Unknown fixture PR ${url}`);
    return found;
  };
  const signalsOf = (url: string, pr: GitHubPr): QueueSignals => ({ ...pr.signals, url, headSha: pr.metadata.headSha, checkedAt: Date.now() });
  const statusOf = (url: string, pr: GitHubPr): PrStatus => ({
    signals: signalsOf(url, pr), labels: [], mergeable: pr.metadata.mergeable, isDraft: pr.metadata.isDraft,
    ciChecks: [], ciConclusion: pr.signals.checks.state, reviewSummary: { approved: 0, changesRequested: 0, commented: 0 },
    baseBranch: pr.metadata.baseBranch, commitCount: 1, requestedReviewers: [], requestedTeams: [], mergeableState: 'clean',
    autoMerge: null, milestone: null, headSha: pr.metadata.headSha, checkedAt: Date.now(),
    lifecycle: lifecycleOf(pr.metadata), metadata: pr.metadata,
  });
  /** What main's sync service does for watched views: read the kinds again and push them. */
  const pushWatched = (url: string, kinds: string[]) => {
    const pr = github.get(url);
    if (!pr) return;
    for (const interest of sync.subscriptions.values()) {
      if (!interest.targets.some((target) => target.url === url) || !kinds.includes(interest.kind)) continue;
      if (interest.kind === 'metadata') sync.emit({ kind: 'metadata', url, value: pr.metadata });
      if (interest.kind === 'signals') sync.emit({ kind: 'signals', url, value: signalsOf(url, pr) });
    }
  };
  const refresher = createGitHubWriteRefresher({
    active: () => document.visibilityState !== 'hidden',
    account: () => 'fixture-token',
    baseline: (url) => {
      const pr = github.get(url);
      return pr ? { metadata: pr.metadata, signals: signalsOf(url, pr) } : {};
    },
    invalidate: (urls, kinds) => urls.forEach((url) => pushWatched(url, kinds)),
    read: (probe, target) => {
      const pr = github.get(target.url);
      if (!pr) return Promise.resolve(undefined);
      record.reads++;
      if (probe === 'metadata') {
        const count = (reads.get(target.url) ?? 0) + 1;
        reads.set(target.url, count);
        const change = pending.get(target.url);
        if (change && count > change.after) {
          pending.delete(target.url);
          change.apply(pr);
          pr.metadata = { ...pr.metadata, updatedAt: stamp() };
        }
        sync.emit({ kind: 'metadata', url: target.url, value: pr.metadata });
        return Promise.resolve(pr.metadata);
      }
      const value = signalsOf(target.url, pr);
      sync.emit({ kind: 'signals', url: target.url, value });
      return Promise.resolve(value);
    },
    refreshed: (event) => {
      record.events.push(event);
      listeners.forEach((listener) => listener(event));
    },
  });
  const write = async <T>(action: GitHubWriteAction, url: string, lag: number, apply: (pr: GitHubPr) => void, result: T, details = {}) => {
    record.writes.push(action);
    reads.set(url, 0);
    pending.set(url, { after: lag, apply });
    await refresher.after(action, [url], details);
    return result;
  };
  const readSignals = mocks.getQueueSignals as (requests: QueueSignalRequest[]) => Promise<QueueSignals[]>;
  const readStatus = mocks.getPrStatus as (url: string, force?: boolean, options?: { cachedOnly?: boolean }) => Promise<PrStatus | null>;
  Object.assign(mocks, {
    onGitHubWriteRefreshed: (callback: (event: GitHubWriteEvent) => void) => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    getPrStatus: (url: string, force?: boolean, options?: { cachedOnly?: boolean }) => {
      const pr = github.get(url);
      if (!pr) return readStatus(url, force, options);
      if (force) record.forcedStatus++;
      return Promise.resolve(options?.cachedOnly ? null : statusOf(url, pr));
    },
    getQueueSignals: async (requests: QueueSignalRequest[]) => {
      const values = await readSignals(requests);
      return values.map((value) => {
        const pr = github.get(value.url);
        return pr && pr.metadata.headSha === value.headSha ? signalsOf(value.url, pr) : value;
      });
    },
    performPrAction: (request: { kind: string; url: string }) => {
      const lag = 2;
      if (request.kind === 'merge')
        return write('merge', request.url, lag, (pr) => {
          pr.metadata = { ...pr.metadata, merged: true, state: 'closed' };
          pr.signals = { ...pr.signals, readiness: readiness({ state: 'MERGED' }) };
        }, { status: 'merged', message: 'Merged on GitHub.' });
      if (request.kind === 'update-merge')
        return write('update-branch', request.url, lag, (pr) => {
          pr.metadata = { ...pr.metadata, headSha: 'f'.repeat(40), mergeable: true };
          pr.signals = { ...pr.signals, readiness: readiness() };
        }, { status: 'completed', message: 'Branch update requested.' });
      return Promise.reject(Error(`The writes fixture does not cover ${request.kind}`));
    },
    submitReview: (request: { prUrl: string; event: string }) => {
      const reviewUrl = `${request.prUrl}#pullrequestreview-1`;
      return write('submit-review', request.prUrl, 2, (pr) => {
        pr.signals = {
          ...pr.signals,
          readiness: readiness({ reviewDecision: 'APPROVED' }),
          latestReview: { url: reviewUrl, author: 'oddur', state: request.event === 'APPROVE' ? 'APPROVED' : 'COMMENTED', submittedAt: new Date().toISOString(), headSha: pr.metadata.headSha },
        };
      }, { reviewUrl, droppedCommentCount: 0 }, { reviewUrl });
    },
    feedbackAction: (request: { prUrl: string }) =>
      write('feedback-reply', request.prUrl, 2, (pr) => {
        pr.metadata = { ...pr.metadata, commentCount: (pr.metadata.commentCount ?? 0) + 1 };
        pr.signals = { ...pr.signals, comments: pr.signals.comments + 1 };
      }, undefined),
    rerunChecks: (request: { url: string }) =>
      write('rerun-checks', request.url, 2, (pr) => {
        pr.signals = { ...pr.signals, checks: { state: 'pending', passed: 1, running: 1, total: 2 } };
      }, undefined),
  });
  Object.assign(window, {
    writeFixture: {
      record,
      pending: () => refresher.pending(),
      /** GitHub's state for one PR, before the next write. */
      github: (url: string, metadata: Partial<ReviewMember>, signals: Partial<Omit<QueueSignals, 'readiness'>> & { readiness?: Partial<Readiness> }) => {
        const previous = github.get(url);
        github.set(url, {
          metadata: { ...(previous?.metadata ?? member(url)), ...metadata, updatedAt: stamp() },
          signals: {
            comments: 0,
            checks: { state: 'success', passed: 2, total: 2 },
            latestReview: null,
            ...previous?.signals,
            ...signals,
            readiness: readiness({ ...previous?.signals.readiness, ...signals.readiness }),
          },
        });
        pushWatched(url, ['metadata', 'signals']);
      },
    },
  });
}
