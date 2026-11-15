import type { Octokit } from '@octokit/rest';
import { withGitHubPriority, createGitHubWork, joinGitHubWork, type GitHubWork } from '../lib/github-scheduler';
import { githubCacheFor } from '../lib/github-client';
import { isCacheRecord } from '../lib/github-cache';
import {
  QUEUE_SIGNALS_TTL,
  ACTIVE_SIGNALS_TTL,
  queueSignalKey,
  queueSignalsCacheKey,
  checkSignals,
  type QueueSignalRequest,
  type QueueSignals,
  type QueueSignalOptions,
} from '../lib/queue-signals';
import { mergeConflictState } from '../lib/merge-conflicts';
import { isAutomationActor, type GitHubActor } from '../lib/github-actors';
import { readPrChecksBatch } from './pr-checks-service';

interface SuiteRun {
  workflowRun: { databaseId: number | null; event: string; workflow: { databaseId: number | null } } | null;
}
/** Whether a commit holds more than one run of a workflow for one event, so the rollup counts superseded jobs. */
export function hasSupersededRuns(suites: (SuiteRun | null)[]) {
  const runs = new Map<string, number>();
  for (const suite of suites) {
    const run = suite?.workflowRun;
    if (!run?.databaseId || !run.workflow.databaseId) continue;
    const key = `${run.workflow.databaseId}:${run.event}`;
    const previous = runs.get(key);
    if (previous !== undefined && previous !== run.databaseId) return true;
    runs.set(key, run.databaseId);
  }
  return false;
}

interface PullSignals {
  headRefOid: string;
  state: string;
  isDraft: boolean;
  mergeable: string;
  mergeStateStatus: string;
  reviewDecision: string | null;
  baseRefName: string;
  baseRefOid: string;
  baseRef: { compare: { behindBy: number } | null } | null;
  mergeQueue: { id: string } | null;
  mergeQueueEntry: { state: string } | null;
  totalCommentsCount?: number | null;
  comments: { totalCount: number; nodes?: { id: string; createdAt: string; isMinimized?: boolean; author: GitHubActor | null }[] };
  reviews?: { nodes: { id: string; url?: string; submittedAt: string | null; state: string; isMinimized?: boolean; author: GitHubActor | null; commit?: { oid: string } | null }[] };
  latestOpinionatedReviews?: { nodes: ({ url: string; submittedAt: string | null; state: string; author: { login: string } | null; commit: { oid: string } | null } | null)[] | null } | null;
  reviewThreads?: { totalCount: number; nodes: { id: string; isResolved: boolean }[] };
  commits: {
    nodes: {
      commit: {
        author?: { user: { login: string } | null } | null;
        committer?: { user: { login: string } | null } | null;
        checkSuites?: { nodes: (SuiteRun | null)[] | null } | null;
        statusCheckRollup: null | {
          state: string;
          contexts: {
            totalCount: number;
            checkRunCountsByState: { state: string; count: number }[];
            statusContextCountsByState: { state: string; count: number }[];
          };
        };
      };
    }[];
  };
}
const isReview = (review: unknown) =>
  isCacheRecord(review) && ['url', 'author', 'state', 'submittedAt'].every(key => typeof review[key] === 'string') &&
  (review.headSha === null || typeof review.headSha === 'string');
function isSignals(value: unknown): value is QueueSignals {
  if (isCacheRecord(value) && value.latestReview != null && !isReview(value.latestReview)) return false;
  if (isCacheRecord(value) && value.opinions !== undefined && !(Array.isArray(value.opinions) && value.opinions.every(isReview))) return false;
  if (isCacheRecord(value) && value.readiness !== undefined) {
    const readiness = value.readiness;
    if (
      !isCacheRecord(readiness) ||
      !['state', 'mergeable', 'mergeState', 'baseBranch', 'baseSha'].every(
        (key) => typeof readiness[key] === 'string'
      ) ||
      typeof readiness.isDraft !== 'boolean' ||
      typeof readiness.mergeQueue !== 'boolean' ||
      (readiness.reviewDecision !== null && typeof readiness.reviewDecision !== 'string') ||
      (readiness.queueState !== null && typeof readiness.queueState !== 'string') ||
      (readiness.behindBy !== null && (typeof readiness.behindBy !== 'number' || !Number.isFinite(readiness.behindBy)))
    )
      return false;
  }
  return (
    isCacheRecord(value) &&
    typeof value.url === 'string' &&
    typeof value.headSha === 'string' &&
    typeof value.checkedAt === 'number' &&
    typeof value.comments === 'number' &&
    isCacheRecord(value.checks) &&
    ['success', 'failure', 'pending', 'neutral'].includes(String(value.checks.state)) &&
    typeof value.checks.total === 'number' &&
    typeof value.checks.passed === 'number'
  );
}
/** Read-only ordering input; never starts a GitHub request. */
export function cachedQueueSignals(client: Octokit, requests: QueueSignalRequest[]): QueueSignals[] {
  const cache = githubCacheFor(client);
  return requests.flatMap(request => cache?.get(queueSignalsCacheKey(request), isSignals)?.value ?? []);
}
/** Local data only. The saved signals for one PR revision and whether a write marked them stale. */
export function savedQueueSignals(client: Octokit, request: QueueSignalRequest) {
  const saved = githubCacheFor(client)?.get(queueSignalsCacheKey(request), isSignals);
  return saved && { value: saved.value, revalidate: saved.revalidate };
}
/** Visible-row reads, batched across repositories, with credential-scoped snapshots and backoff. */
export function createQueueSignalsService(now = Date.now, revisionChanged?: (client: Octokit, url: string, headSha: string) => void) {
  const accounts = new WeakMap<Octokit, { retryAt: number; pending: Map<string, GitHubWork<QueueSignals[]>> }>();
  return async (
    client: Octokit,
    requests: QueueSignalRequest[],
    options: QueueSignalOptions = {}
  ): Promise<QueueSignals[]> => {
    if (!Array.isArray(requests) || requests.length > 25) throw new Error('Request at most 25 PR statuses.');
    const unique = [...new Map(requests.map((request) => [queueSignalKey(request), request])).values()];
    const parsed = unique.map((request) => {
      const match = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)$/.exec(request.url);
      if (!match || !/^[a-zA-Z0-9_-]{1,64}$/.test(request.headSha)) throw new Error('Invalid PR status request.');
      return { request, owner: match[1], repo: match[2], number: Number(match[3]) };
    });
    const cache = githubCacheFor(client);
    let account = accounts.get(client);
    if (!account) {
      account = { retryAt: 0, pending: new Map() };
      accounts.set(client, account);
    }
    const result: QueueSignals[] = [];
    const stale: QueueSignals[] = [];
    const missing = parsed.filter(({ request }) => {
      const saved = cache?.get(queueSignalsCacheKey(request), isSignals);
      if (
        !options.force &&
        saved &&
        !saved.revalidate &&
        now() - saved.value.checkedAt < (options.active ? ACTIVE_SIGNALS_TTL : QUEUE_SIGNALS_TTL) &&
        !(options.recheckMerge && mergeConflictState(saved.value) === 'computing')
      ) {
        result.push(saved.value);
        return false;
      }
      if (saved) stale.push(saved.value);
      return true;
    });
    if (options.cachedOnly || !missing.length || account.retryAt > now()) return [...result, ...stale];
    const batchKey = missing
      .map(({ request }) => queueSignalKey(request))
      .sort()
      .join('|');
    const priority = options.force ? 'interactive' : options.active ? 'foreground' : 'background';
    const existing = account.pending.get(batchKey);
    if (existing) return [...result, ...(await withGitHubPriority(priority, () => joinGitHubWork(existing)))];
    const version = cache?.version();
    const query = `query { rateLimit { cost } ${missing
      .map(
        (
          { owner, repo, number, request },
          i
        ) => `p${i}: repository(owner:${JSON.stringify(owner)},name:${JSON.stringify(repo)}) { pullRequest(number:${number}) {
      headRefOid state isDraft mergeable mergeStateStatus reviewDecision baseRefName baseRefOid
      baseRef { compare(headRef:${JSON.stringify(request.headSha)}) { behindBy } }
      mergeQueue { id } mergeQueueEntry { state }
      totalCommentsCount
      comments(last:10) { totalCount nodes { id createdAt isMinimized author { __typename login } } }
      reviews(last:10,states:[APPROVED,CHANGES_REQUESTED,COMMENTED,DISMISSED]) { nodes { id url submittedAt state isMinimized author { __typename login } commit { oid } } }
      latestOpinionatedReviews(first:100,writersOnly:true) { nodes { url submittedAt state author { login } commit { oid } } }
      reviewThreads(first:100) { totalCount nodes { id isResolved } }
      commits(last:1) { nodes { commit {
        author { user { login } } committer { user { login } }
        checkSuites(first:100) { nodes { workflowRun { databaseId event workflow { databaseId } } } }
        statusCheckRollup { state contexts {
        totalCount checkRunCountsByState { state count } statusContextCountsByState { state count }
      } } } } }
    } }`
      )
      .join('\n')} }`;
    const state = account;
    const pending = withGitHubPriority(priority, () => createGitHubWork(async () => {
      try {
        type Data = Record<string, { pullRequest: PullSignals | null } | null>;
        let data: Data;
        try {
          data = await client.graphql<Data>(query);
        } catch (error) {
          // Without Actions access GitHub cannot list workflow runs; the rollup is still the best available answer.
          const partial = error as { data?: Data; errors?: { path?: (string | number)[] }[] };
          if (!partial.data || !partial.errors?.length || partial.errors.some((e) => !e.path?.includes('checkSuites')))
            throw error;
          data = partial.data;
        }
        const cost = (data.rateLimit as { cost?: unknown } | null | undefined)?.cost;
        if (typeof cost === 'number') options.cost?.(cost);
        const fresh: QueueSignals[] = [];
        const superseded: QueueSignals[] = [];
        for (const [i, { request }] of missing.entries()) {
          const pr = data[`p${i}`]?.pullRequest;
          // Never attach a green check from a different revision to the displayed PR.
          if (!pr) continue;
          if (pr.headRefOid !== request.headSha) { revisionChanged?.(client, request.url, pr.headRefOid); continue; }
          const rollup = pr.commits.nodes[0]?.commit.statusCheckRollup;
          const counts = rollup
            ? [...rollup.contexts.checkRunCountsByState, ...rollup.contexts.statusContextCountsByState]
            : [];
          const newestComment = pr.comments.nodes?.at(-1);
          const newestReview = pr.reviews?.nodes.at(-1);
          const head = pr.commits.nodes.at(0)?.commit;
          const recent: NonNullable<NonNullable<QueueSignals['activity']>['recent']> = [
            ...(pr.comments.nodes ?? []).map((c) => ({ kind: 'comment' as const, id: c.id, at: c.createdAt, author: c.author?.login ?? '', automated: isAutomationActor(c.author), minimized: c.isMinimized === true })),
            ...(pr.reviews?.nodes ?? []).flatMap((r) => r.submittedAt ? [{ kind: 'review' as const, id: r.url ?? r.id, at: r.submittedAt, state: r.state, author: r.author?.login ?? '', automated: isAutomationActor(r.author), minimized: r.isMinimized === true }] : []),
          ];
          const value: QueueSignals = {
            ...request,
            checkedAt: now(),
            comments: pr.totalCommentsCount ?? pr.comments.totalCount,
            ...(pr.reviews ? { latestReview: newestReview?.submittedAt ? {
              url: newestReview.url ?? request.url,
              author: newestReview.author?.login ?? 'Deleted user',
              state: newestReview.state,
              submittedAt: newestReview.submittedAt,
              headSha: newestReview.commit?.oid ?? null,
            } : null } : {}),
            ...(pr.latestOpinionatedReviews ? { opinions: (pr.latestOpinionatedReviews.nodes ?? []).flatMap(review =>
              review?.submittedAt && ['APPROVED', 'CHANGES_REQUESTED'].includes(review.state) ? [{
                url: review.url, author: review.author?.login ?? 'Deleted user', state: review.state,
                submittedAt: review.submittedAt, headSha: review.commit?.oid ?? null,
              }] : []) } : {}),
            activity: {
              comment: newestComment ? { id: newestComment.id, at: newestComment.createdAt, author: newestComment.author?.login ?? '' } : undefined,
              review: newestReview?.submittedAt ? { id: newestReview.url ?? newestReview.id, state: newestReview.state, at: newestReview.submittedAt, author: newestReview.author?.login ?? '' } : undefined,
              recent,
              ...(head?.author !== undefined ? { head: { author: head.author?.user?.login ?? null, committer: head.committer?.user?.login ?? null } } : {}),
            },
            ...(pr.reviewThreads ? { threads: {
              unresolved: pr.reviewThreads.nodes.filter((t) => !t.isResolved).map((t) => t.id),
              complete: pr.reviewThreads.nodes.length >= pr.reviewThreads.totalCount,
            } } : {}),
            readiness: pr.mergeStateStatus
              ? {
                  state: pr.state,
                  isDraft: pr.isDraft,
                  mergeable: pr.mergeable,
                  mergeState: pr.mergeStateStatus,
                  reviewDecision: pr.reviewDecision,
                  baseBranch: pr.baseRefName,
                  baseSha: pr.baseRefOid,
                  behindBy: pr.baseRef?.compare?.behindBy ?? null,
                  mergeQueue: !!pr.mergeQueue,
                  queueState: pr.mergeQueueEntry?.state ?? null,
                }
              : undefined,
            checks: {
              state: !rollup
                ? 'neutral'
                : rollup.state === 'SUCCESS'
                  ? 'success'
                  : ['FAILURE', 'ERROR'].includes(rollup.state)
                    ? 'failure'
                    : 'pending',
              total: rollup?.contexts.totalCount ?? 0,
              failed: counts.filter(c => ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STALE', 'STARTUP_FAILURE'].includes(c.state)).reduce((n,c) => n + c.count, 0),
              running: counts.filter(c => ['PENDING', 'QUEUED', 'IN_PROGRESS', 'WAITING', 'REQUESTED', 'PENDING_DEPLOYMENT'].includes(c.state)).reduce((n,c) => n + c.count, 0),
              skipped: counts
                .filter((c) => c.state === 'SKIPPED' || c.state === 'NEUTRAL')
                .reduce((sum, c) => sum + c.count, 0),
              passed: counts.filter((c) => c.state === 'SUCCESS').reduce((sum, c) => sum + c.count, 0),
            },
          };
          fresh.push(value);
          // The rollup also counts jobs of superseded workflow runs, such as runs cancelled by a concurrency group.
          // When those could change the outcome, count the current check runs instead, as the Checks tab does.
          if (
            rollup &&
            (value.checks.state !== 'success' || value.checks.failed || value.checks.running) &&
            hasSupersededRuns(pr.commits.nodes[0]?.commit.checkSuites?.nodes ?? [])
          )
            superseded.push(value);
        }
        if (superseded.length) {
          try {
            const snapshots = await readPrChecksBatch(client, superseded.map(({ url, headSha }) => ({ url, headSha })));
            for (const value of superseded) {
              const snapshot = snapshots.find((item) => item.url === value.url && item.headSha === value.headSha);
              if (snapshot) value.checks = checkSignals(snapshot.checks);
            }
          } catch {
            // Keep GitHub's rollup when the check list cannot be read; the next refresh tries again.
          }
        }
        for (const value of fresh)
          if (cache?.version() === version) cache?.set(queueSignalsCacheKey(value), value);
        return fresh;
      } catch {
        // The shared GitHub client owns Retry-After and rate-limit deadlines.
        // Also suppress repeated visible-row retries for other network failures.
        state.retryAt = now() + QUEUE_SIGNALS_TTL;
        return stale;
      } finally {
        state.pending.delete(batchKey);
      }
    }));
    state.pending.set(batchKey, pending);
    return [...result, ...(await pending.promise)];
  };
}
