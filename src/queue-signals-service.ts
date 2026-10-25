import type { Octokit } from '@octokit/rest';
import { githubCacheFor } from '../lib/github-client';
import { isCacheRecord } from '../lib/github-cache';
import {
  QUEUE_SIGNALS_TTL,
  queueSignalKey,
  type QueueSignalRequest,
  type QueueSignals,
  type QueueSignalOptions,
} from '../lib/queue-signals';

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
  comments: { totalCount: number };
  commits: {
    nodes: {
      commit: {
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
function isSignals(value: unknown): value is QueueSignals {
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
/** Visible-row reads, batched across repositories, with credential-scoped snapshots and backoff. */
export function createQueueSignalsService(now = Date.now) {
  const accounts = new WeakMap<Octokit, { retryAt: number; pending: Map<string, Promise<QueueSignals[]>> }>();
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
      const saved = cache?.get(`queue-signals:v3:${queueSignalKey(request)}`, isSignals);
      if (!options.force && saved && !saved.revalidate && now() - saved.value.checkedAt < QUEUE_SIGNALS_TTL) {
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
    const existing = account.pending.get(batchKey);
    if (existing) return [...result, ...(await existing)];
    const version = cache?.version();
    const query = `query { ${missing
      .map(
        (
          { owner, repo, number, request },
          i
        ) => `p${i}: repository(owner:${JSON.stringify(owner)},name:${JSON.stringify(repo)}) { pullRequest(number:${number}) {
      headRefOid state isDraft mergeable mergeStateStatus reviewDecision baseRefName baseRefOid
      baseRef { compare(headRef:${JSON.stringify(request.headSha)}) { behindBy } }
      mergeQueue { id } mergeQueueEntry { state }
      comments { totalCount } commits(last:1) { nodes { commit { statusCheckRollup { state contexts {
        totalCount checkRunCountsByState { state count } statusContextCountsByState { state count }
      } } } } }
    } }`
      )
      .join('\n')} }`;
    const state = account;
    const pending = (async () => {
      try {
        const data = await client.graphql<Record<string, { pullRequest: PullSignals | null } | null>>(query);
        const fresh: QueueSignals[] = [];
        for (const [i, { request }] of missing.entries()) {
          const pr = data[`p${i}`]?.pullRequest;
          // Never attach a green check from a different revision to the displayed PR.
          if (!pr || pr.headRefOid !== request.headSha) continue;
          const rollup = pr.commits.nodes[0]?.commit.statusCheckRollup;
          const counts = rollup
            ? [...rollup.contexts.checkRunCountsByState, ...rollup.contexts.statusContextCountsByState]
            : [];
          const value: QueueSignals = {
            ...request,
            checkedAt: now(),
            comments: pr.comments.totalCount,
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
              skipped: counts
                .filter((c) => c.state === 'SKIPPED' || c.state === 'NEUTRAL')
                .reduce((sum, c) => sum + c.count, 0),
              passed: counts.filter((c) => c.state === 'SUCCESS').reduce((sum, c) => sum + c.count, 0),
            },
          };
          fresh.push(value);
          if (cache?.version() === version) cache?.set(`queue-signals:v3:${queueSignalKey(request)}`, value);
        }
        return fresh;
      } catch {
        // The shared GitHub client owns Retry-After and rate-limit deadlines.
        // Also suppress repeated visible-row retries for other network failures.
        state.retryAt = now() + QUEUE_SIGNALS_TTL;
        return stale;
      } finally {
        state.pending.delete(batchKey);
      }
    })();
    state.pending.set(batchKey, pending);
    return [...result, ...(await pending)];
  };
}
