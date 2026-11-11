import type { Octokit } from '@octokit/rest';
import { githubCacheFor } from '../lib/github-client';
import { isCacheRecord } from '../lib/github-cache';
import { parsePrUrl, summarizeReviews } from '../lib/github';
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

interface PreloadedPull {
  headRefOid: string;
  baseRefOid: string;
  isDraft: boolean;
  baseRefName: string;
  commits: { totalCount: number };
  labels: { nodes: ({ name: string } | null)[] | null } | null;
  reviewRequests: {
    nodes: ({ requestedReviewer: { __typename: string; login?: string; name?: string } | null } | null)[] | null;
  } | null;
  autoMergeRequest: { mergeMethod: string } | null;
  milestone: { title: string; dueOn: string | null } | null;
  reviews: { nodes: ({ state: string; author: { login: string } | null } | null)[] | null } | null;
}
const prUrlPattern = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)$/;
function coreOf(pr: PreloadedPull): StatusCore {
  const reviewers = (pr.reviewRequests?.nodes ?? []).flatMap((node) => (node?.requestedReviewer ? [node.requestedReviewer] : []));
  return {
    labels: (pr.labels?.nodes ?? []).flatMap((label) => (label?.name ? [label.name] : [])),
    isDraft: pr.isDraft,
    baseBranch: pr.baseRefName,
    commitCount: pr.commits.totalCount,
    requestedReviewers: reviewers.flatMap((r) => (r.__typename !== 'Team' && r.login ? [r.login] : [])),
    requestedTeams: reviewers.flatMap((r) => (r.__typename === 'Team' && r.name ? [r.name] : [])),
    autoMerge: pr.autoMergeRequest ? { method: pr.autoMergeRequest.mergeMethod.toLowerCase() } : null,
    milestone: pr.milestone ? { title: pr.milestone.title, dueOn: pr.milestone.dueOn } : null,
    reviewSummary: summarizeReviews(
      (pr.reviews?.nodes ?? []).flatMap((review) =>
        review ? [{ login: review.author?.login ?? 'unknown', state: review.state }] : []
      )
    ),
  };
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
  const preloading = new WeakMap<Octokit, Map<string, Promise<unknown>>>();
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
    /** Local data only. The saved record's identity and age, for deciding whether to refresh it. */
    saved(client: Octokit, url: string) {
      const saved = githubCacheFor(client)?.get(key(url), isSavedPrStatus);
      if (!saved || saved.value.url !== url) return;
      const { headSha, baseSha, checkedAt } = saved.value;
      return { headSha, baseSha, checkedAt, revalidate: saved.revalidate };
    },
    /**
     * Saves status cores for up to 25 PRs from one GraphQL query. A core is saved only for the expected
     * head, when no write happened during the query, and when no newer copy exists. Never reports mergeability.
     */
    preload(client: Octokit, targets: { url: string; headSha: string }[]): Promise<string[]> {
      if (targets.length > 25) return Promise.reject(new Error('Preload at most 25 PR statuses.'));
      const unique = [...new Map(targets.map((target) => [target.url, target])).values()];
      const parsed = unique.flatMap((target) => {
        const match = prUrlPattern.exec(target.url);
        return match && /^[a-f\d]{40}$/i.test(target.headSha)
          ? [{ target, owner: match[1], repo: match[2], number: Number(match[3]) }]
          : [];
      });
      if (parsed.length !== unique.length) return Promise.reject(new Error('Invalid PR status preload.'));
      if (!parsed.length) return Promise.resolve([]);
      const cache = githubCacheFor(client);
      const version = cache?.version();
      const checkedAt = now();
      const query = `query { rateLimit { cost } ${parsed
        .map(
          ({ owner, repo, number }, i) => `p${i}: repository(owner:${JSON.stringify(owner)},name:${JSON.stringify(repo)}) { pullRequest(number:${number}) {
      headRefOid baseRefOid isDraft baseRefName
      commits { totalCount }
      labels(first:100) { nodes { name } }
      reviewRequests(first:100) { nodes { requestedReviewer { __typename ... on User { login } ... on Bot { login } ... on Mannequin { login } ... on Team { name } } } }
      autoMergeRequest { mergeMethod }
      milestone { title dueOn }
      reviews(last:100,states:[APPROVED,CHANGES_REQUESTED,COMMENTED]) { nodes { state author { login } } }
    } }`
        )
        .join('\n')} }`;
      const run = (async () => {
        const response = await client.request('POST /graphql', { query });
        const result = response.data as {
          data?: Record<string, { pullRequest: PreloadedPull | null } | null> | null;
          errors?: { message: string; path?: (string | number)[] }[];
        };
        const failed = new Set<string>();
        for (const error of result.errors ?? []) {
          // An error without a path, such as a rate limit, invalidates the whole response.
          if (typeof error.path?.[0] !== 'string') throw new Error(error.message);
          failed.add(error.path[0]);
        }
        if (!result.data) throw new Error('GitHub returned no PR status data.');
        const saved: string[] = [];
        for (const [i, { target }] of parsed.entries()) {
          const pr = failed.has(`p${i}`) ? undefined : result.data[`p${i}`]?.pullRequest;
          // A new head, a write during the query, or a newer read must not be replaced by this copy.
          if (!pr || pr.headRefOid !== target.headSha || !cache || cache.version() !== version) continue;
          const existing = cache.get(key(target.url), isSavedPrStatus);
          if (existing && existing.value.checkedAt > checkedAt) continue;
          cache.set(key(target.url), {
            url: target.url,
            headSha: pr.headRefOid,
            baseSha: pr.baseRefOid,
            checkedAt,
            core: coreOf(pr),
          } satisfies SavedPrStatus);
          saved.push(target.url);
        }
        return saved;
      })();
      let inflight = preloading.get(client);
      if (!inflight) {
        inflight = new Map();
        preloading.set(client, inflight);
      }
      const owner = inflight;
      for (const { target } of parsed) owner.set(target.url, run);
      void run
        .finally(() => {
          for (const { target } of parsed) if (owner.get(target.url) === run) owner.delete(target.url);
        })
        .catch(() => {});
      return run;
    },
    /**
     * Local data only. Serves the saved core for exactly this head revision, at most 24 hours old and
     * not marked stale by a write. Checks and signals come only from snapshots of the same head.
     */
    async cached(client: Octokit, url: string, headSha: string): Promise<PrStatus | undefined> {
      // A click during a hover prefetch waits briefly, so it can still open from the saved copy.
      const inflight = preloading.get(client)?.get(url);
      if (inflight) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          inflight.catch(() => {}),
          new Promise((resolve) => {
            timer = setTimeout(resolve, 250);
          }),
        ]);
        clearTimeout(timer);
      }
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
