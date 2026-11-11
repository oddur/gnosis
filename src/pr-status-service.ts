import type { Octokit } from '@octokit/rest';
import { githubCacheFor } from '../lib/github-client';
import { isCacheRecord } from '../lib/github-cache';
import { parsePrUrl } from '../lib/github';
import { checkCounts, type CheckTarget, type PrChecks } from '../lib/pr-checks';
import { createGitHubWork, joinGitHubWork, type GitHubWork } from '../lib/github-scheduler';
import type { QueueSignalOptions, QueueSignalRequest, QueueSignals } from '../lib/queue-signals';
import type { PrMetadata, PrStatus, ReviewSummary } from '../lib/types';
import { withCachedCheckDetails } from './pr-checks-service';

/** A saved status core older than this is never shown; the PR waits for GitHub instead. */
export const PR_STATUS_MAX_STALE_MS = 24 * 60 * 60_000;

type StatusCore = Pick<
  PrStatus,
  | 'labels'
  | 'isDraft'
  | 'baseBranch'
  | 'commitCount'
  | 'requestedReviewers'
  | 'requestedTeams'
  | 'autoMerge'
  | 'milestone'
  | 'reviewSummary'
>;
/** The top-level `url` lets a scoped GitHub write mark this entry stale. */
interface SavedPrStatus {
  url: string;
  headSha: string;
  baseSha: string;
  checkedAt: number;
  core: StatusCore;
}
const strings = (value: unknown) => Array.isArray(value) && value.every((item) => typeof item === 'string');
function isSavedPrStatus(value: unknown): value is SavedPrStatus {
  if (!isCacheRecord(value) || !isCacheRecord(value.core)) return false;
  const core = value.core;
  const summary = core.reviewSummary;
  return (
    typeof value.url === 'string' &&
    typeof value.headSha === 'string' &&
    typeof value.baseSha === 'string' &&
    typeof value.checkedAt === 'number' &&
    Number.isFinite(value.checkedAt) &&
    strings(core.labels) &&
    typeof core.isDraft === 'boolean' &&
    typeof core.baseBranch === 'string' &&
    typeof core.commitCount === 'number' &&
    strings(core.requestedReviewers) &&
    strings(core.requestedTeams) &&
    (core.autoMerge === null || (isCacheRecord(core.autoMerge) && typeof core.autoMerge.method === 'string')) &&
    (core.milestone === null || (isCacheRecord(core.milestone) && typeof core.milestone.title === 'string')) &&
    isCacheRecord(summary) &&
    ['approved', 'changesRequested', 'commented'].every((key) => typeof summary[key] === 'number')
  );
}

function ciConclusion(signals: QueueSignals | undefined, checks: PrChecks | undefined): PrStatus['ciConclusion'] {
  if (signals) return signals.checks.state;
  if (!checks) return 'neutral';
  const counts = checkCounts(checks.checks);
  return counts.attention ? 'failure' : counts.running ? 'pending' : checks.checks.length ? 'success' : 'neutral';
}

export interface PrStatusDependencies {
  metadata: (client: Octokit, owner: string, repo: string, pullNumber: number, fresh: boolean) => Promise<PrMetadata>;
  reviews: (client: Octokit, owner: string, repo: string, pullNumber: number) => Promise<ReviewSummary>;
  checks: (
    client: Octokit,
    input: CheckTarget,
    options: { cachedOnly?: boolean; force?: boolean }
  ) => Promise<PrChecks | undefined>;
  signals: (client: Octokit, requests: QueueSignalRequest[], options: QueueSignalOptions) => Promise<QueueSignals[]>;
  now?: () => number;
}
interface StatusRead {
  status: PrStatus;
  metadata: PrMetadata;
}

/** PR status reads, with a saved per-PR core that a later open can show before GitHub answers. */
export function createPrStatusService({ metadata, reviews, checks, signals, now = Date.now }: PrStatusDependencies) {
  const pending = new WeakMap<Octokit, Map<string, GitHubWork<StatusRead>>>();
  const key = (url: string) => `pr-status:v1:${url}`;
  async function fetchStatus(client: Octokit, url: string, force: boolean): Promise<StatusRead> {
    const cache = githubCacheFor(client);
    const version = cache?.version();
    const checkedAt = now();
    const { owner, repo, pullNumber } = parsePrUrl(url);
    const [prData, reviewSummary] = await Promise.all([
      metadata(client, owner, repo, pullNumber, force),
      reviews(client, owner, repo, pullNumber),
    ]);
    let ciError: string | undefined;
    const [checkSnapshot, [prSignals]] = await Promise.all([
      checks(client, { url, headSha: prData.headSha }, { force }).catch((error: unknown) => {
        ciError = error instanceof Error ? error.message : String(error);
        return undefined;
      }),
      signals(client, [{ url, headSha: prData.headSha }], { force, active: true }),
    ]);
    const core: StatusCore = {
      labels: prData.labels,
      isDraft: prData.isDraft,
      baseBranch: prData.baseBranch,
      commitCount: prData.commitCount,
      requestedReviewers: prData.requestedReviewers,
      requestedTeams: prData.requestedTeams,
      autoMerge: prData.autoMerge,
      milestone: prData.milestone,
      reviewSummary,
    };
    // A write or account change during the read may have made this core outdated.
    if (cache && cache.version() === version)
      cache.set(key(url), {
        url,
        headSha: prData.headSha,
        baseSha: prData.baseSha,
        checkedAt,
        core,
      } satisfies SavedPrStatus);
    return {
      metadata: prData,
      status: {
        ...core,
        signals: prSignals,
        mergeable: prData.mergeable,
        mergeableState: prData.mergeableState,
        checkSnapshot: checkSnapshot && withCachedCheckDetails(client, checkSnapshot),
        ciError,
        ciChecks: checkSnapshot?.checks ?? [],
        ciConclusion: ciConclusion(prSignals, checkSnapshot),
        headSha: prData.headSha,
        checkedAt,
      },
    };
  }
  return {
    /** Reads GitHub. Concurrent non-forced reads of a PR share one operation. */
    read(client: Octokit, url: string, force = false): Promise<StatusRead> {
      if (force) return fetchStatus(client, url, true);
      let work = pending.get(client);
      if (!work) {
        work = new Map();
        pending.set(client, work);
      }
      const existing = work.get(url);
      if (existing) return joinGitHubWork(existing).then((result) => structuredClone(result));
      const current = createGitHubWork(() => fetchStatus(client, url, false));
      work.set(url, current);
      const owner = work;
      void current.promise
        .finally(() => {
          if (owner.get(url) === current) owner.delete(url);
        })
        .catch(() => {});
      return current.promise.then((result) => structuredClone(result));
    },
    /**
     * Local data only. Serves the saved core for exactly this head revision, at most 24 hours old and
     * not marked stale by a write. Checks and signals come only from snapshots of the same head.
     */
    async cached(client: Octokit, url: string, headSha: string): Promise<PrStatus | undefined> {
      const saved = githubCacheFor(client)?.get(key(url), isSavedPrStatus);
      if (!saved || saved.revalidate) return;
      const value = saved.value;
      const age = now() - value.checkedAt;
      if (value.url !== url || value.headSha !== headSha || age < 0 || age >= PR_STATUS_MAX_STALE_MS) return;
      const [checkSnapshot, prSignals] = await Promise.all([
        checks(client, { url, headSha }, { cachedOnly: true }).then(
          (snapshot) => (snapshot?.headSha === headSha ? snapshot : undefined),
          () => undefined
        ),
        signals(client, [{ url, headSha }], { cachedOnly: true }).then(
          (values) => values.find((item) => item.url === url && item.headSha === headSha),
          () => undefined
        ),
      ]);
      return {
        ...value.core,
        signals: prSignals,
        mergeable: null,
        mergeableState: null,
        checkSnapshot: checkSnapshot && withCachedCheckDetails(client, checkSnapshot),
        ciChecks: checkSnapshot?.checks ?? [],
        ciConclusion: ciConclusion(prSignals, checkSnapshot),
        headSha,
        checkedAt: value.checkedAt,
        stale: true,
      };
    },
  };
}
