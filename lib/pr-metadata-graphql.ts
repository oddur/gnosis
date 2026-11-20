import type { Octokit } from '@octokit/rest';
import { getPrMetadata, parsePrUrl, sortedNames } from './github';
import { chunked, mapBounded } from './bounded';
import { aliasedGraphql, type AliasedAnswer } from './github-graphql-batch';
import { githubRateLimit } from './github-client';
import { parseGitHubLabels } from './github-labels';
import { reportPrHead } from './pr-heads';
import type { PrMetadata } from './types';

/**
 * The fields of `getPrMetadata` (one REST `pulls.get`) as a GraphQL selection, so many PRs can share one query.
 *
 * - `review_comments` has no GraphQL count. Each review comment belongs to one review, so the sum over submitted
 *   reviews (pending ones excluded, as REST does) gives the same number. `totalCommentsCount` minus the conversation
 *   comments does not: it also counts some review bodies.
 * - A bot's GraphQL login has no `[bot]` suffix; REST's does. Copilot's apps are `Copilot` in REST.
 * - `mergeStateStatus` and `autoMergeRequest.mergeMethod` are uppercase; REST's values are lowercase.
 */
export const PR_METADATA_FIELDS = `number title url body createdAt updatedAt state merged isDraft mergeable mergeStateStatus
      additions deletions changedFiles
      author { __typename login }
      assignees(first:100) { totalCount nodes { login } }
      assignedActors(first:1) { totalCount }
      baseRefName baseRefOid headRefName headRefOid
      baseRepository { nameWithOwner isArchived } headRepository { nameWithOwner }
      comments { totalCount } commits { totalCount }
      reviews(first:100,states:[APPROVED,CHANGES_REQUESTED,COMMENTED,DISMISSED]) { totalCount nodes { comments { totalCount } } }
      labels(first:100) { totalCount nodes { name color description } }
      reviewRequests(first:100) { totalCount nodes { requestedReviewer { __typename ... on User { login } ... on Bot { login } ... on Mannequin { login } ... on Team { name } } } }
      autoMergeRequest { mergeMethod }
      milestone { title dueOn }`;

interface Connection<T> {
  totalCount: number;
  nodes: T[] | null;
}
export interface GraphPrMetadata {
  number: number;
  title: string;
  url: string;
  body: string | null;
  createdAt: string;
  updatedAt: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  merged: boolean;
  isDraft: boolean;
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' | null;
  mergeStateStatus: string | null;
  additions: number;
  deletions: number;
  changedFiles: number;
  author: { __typename?: string; login: string } | null;
  assignees: Connection<{ login: string } | null>;
  /** Users and bots; `assignees` lists users only, so a larger count means an assignee it left out. */
  assignedActors?: { totalCount: number } | null;
  baseRefName: string;
  baseRefOid: string;
  headRefName: string;
  headRefOid: string;
  baseRepository: { nameWithOwner: string; isArchived: boolean } | null;
  headRepository: { nameWithOwner: string } | null;
  comments: { totalCount: number };
  commits: { totalCount: number };
  reviews: Connection<{ comments: { totalCount: number } } | null>;
  labels: Connection<{ name: string; color: string | null; description: string | null } | null>;
  reviewRequests: Connection<{
    requestedReviewer: { __typename?: string; login?: string; name?: string } | null;
  } | null>;
  autoMergeRequest: { mergeMethod: string } | null;
  milestone: { title: string; dueOn: string | null } | null;
}

const complete = (connection: Connection<unknown> | null | undefined) =>
  !!connection?.nodes && connection.nodes.length >= connection.totalCount;
/** GitHub apps whose GraphQL login differs from REST by more than the `[bot]` suffix. */
const APP_LOGINS: Record<string, string> = {
  'copilot-pull-request-reviewer': 'Copilot',
  'copilot-swe-agent': 'Copilot',
};
/**
 * The REST login of a GraphQL actor. A bot's GraphQL login lacks REST's `[bot]` suffix, and Copilot's two apps both
 * appear as `Copilot` in REST. Null for another Copilot identity, whose REST login this cannot know.
 */
function restLogin(actor: { __typename?: string; login?: string } | null | undefined): string | null | undefined {
  if (actor?.login === undefined) return undefined;
  if (actor.__typename !== 'Bot') return actor.login;
  const known = APP_LOGINS[actor.login.toLowerCase()];
  if (known) return known;
  return /copilot/i.test(actor.login) ? null : `${actor.login}[bot]`;
}

/**
 * The `PrMetadata` that `getPrMetadata` would return for this PR, or undefined when only REST can give the exact value:
 * more than 100 reviews, labels, assignees or review requests, or a Copilot identity this does not know.
 */
export function prMetadataFromGraph(pr: GraphPrMetadata): PrMetadata | undefined {
  if (!pr.baseRepository || ![pr.assignees, pr.reviews, pr.labels, pr.reviewRequests].every(complete)) return undefined;
  // REST lists every assignee. GraphQL's `assignees` includes Copilot (checked on public Copilot-agent PRs), but a
  // count that differs from `assignedActors` means some other actor is missing.
  if (!pr.assignedActors || pr.assignedActors.totalCount !== pr.assignees.totalCount) return undefined;
  const nodes = <T>(connection: Connection<T | null>) => (connection.nodes ?? []).filter((n): n is T => !!n);
  const reviewers = nodes(pr.reviewRequests).map((request) => request.requestedReviewer);
  const people = reviewers.flatMap((r) => (r && r.__typename !== 'Team' ? [restLogin(r)] : []));
  const author = restLogin(pr.author);
  if (author === null || people.includes(null)) return undefined;
  const labels = nodes(pr.labels);
  return {
    title: pr.title,
    commentCount: pr.comments.totalCount,
    reviewCommentCount: nodes(pr.reviews).reduce((sum, review) => sum + review.comments.totalCount, 0),
    description: pr.body ?? '',
    // REST shows a deleted account as `ghost`.
    author: author ?? 'ghost',
    assignees: nodes(pr.assignees).map((user) => user.login),
    baseBranch: pr.baseRefName,
    baseRepo: pr.baseRepository.nameWithOwner,
    repoArchived: pr.baseRepository.isArchived,
    headRepo: pr.headRepository?.nameWithOwner ?? pr.baseRepository.nameWithOwner,
    headBranch: pr.headRefName,
    baseSha: pr.baseRefOid,
    headSha: pr.headRefOid,
    merged: pr.merged,
    state: pr.state === 'OPEN' ? 'open' : 'closed',
    createdAt: pr.createdAt,
    updatedAt: pr.updatedAt,
    url: pr.url,
    labels: labels.map((label) => label.name).filter(Boolean),
    labelDetails: parseGitHubLabels(labels),
    mergeable: pr.mergeable === 'MERGEABLE' ? true : pr.mergeable === 'CONFLICTING' ? false : null,
    isDraft: pr.isDraft,
    commitCount: pr.commits.totalCount,
    changedFileCount: pr.changedFiles,
    additions: pr.additions,
    deletions: pr.deletions,
    // Sorted as `getPrMetadata` sorts them, so the order never depends on which API answered.
    requestedReviewers: sortedNames(people.filter((login): login is string => !!login)),
    requestedTeams: sortedNames(reviewers.flatMap((r) => (r?.__typename === 'Team' && r.name ? [r.name] : []))),
    mergeableState: pr.mergeStateStatus ? pr.mergeStateStatus.toLowerCase() : null,
    autoMerge: pr.autoMergeRequest ? { method: pr.autoMergeRequest.mergeMethod.toLowerCase() } : null,
    milestone: pr.milestone ? { title: pr.milestone.title, dueOn: pr.milestone.dueOn } : null,
    // Comment counts from GraphQL can differ from REST's lagging counters; a comparison must stay with one source.
    source: 'graphql',
  };
}

/** PRs per metadata query. Each carries four connections of up to 100 nodes; 25 PRs cost 1 point, as measured. */
export const PR_METADATA_PER_QUERY = 25;

/**
 * `getPrMetadata` for many PRs, as aliased GraphQL queries of up to 25 PRs each, keyed by the requested URL. A PR
 * GitHub does not return gets its own 404 error, as REST would. A PR whose answer is incomplete, any PR alias with an
 * error at or under it (so a nulled nested field such as `headRepository` is never trusted), and every PR of a query
 * that failed, is read through `getPrMetadata` instead.
 */
export async function getPrMetadataBatch(
  octokit: Octokit,
  urls: readonly string[],
  options: { fresh?: boolean } = {}
): Promise<Map<string, { metadata: PrMetadata } | { error: unknown }>> {
  const results = new Map<string, { metadata: PrMetadata } | { error: unknown }>();
  const rest: string[] = [];
  const targets = [...new Set(urls)].flatMap((url) => {
    try {
      return [{ url, ...parsePrUrl(url) }];
    } catch (error) {
      results.set(url, { error });
      return [];
    }
  });
  // Two queries at once. A rate limit stops the read: it is thrown, never answered with 25 REST reads.
  await mapBounded(chunked(targets, PR_METADATA_PER_QUERY), 2, async (batch) => {
      const query = `query { rateLimit { cost } ${batch
        .map(
          ({ owner, repo, pullNumber }, i) =>
            `p${i}: repository(owner:${JSON.stringify(owner)},name:${JSON.stringify(repo)}) { pullRequest(number:${pullNumber}) { ${PR_METADATA_FIELDS} } }`
        )
        .join('\n')} }`;
      let answer: AliasedAnswer<Record<string, { pullRequest: GraphPrMetadata | null } | null>> | undefined;
      try {
        answer = await aliasedGraphql(octokit, query);
      } catch (error) {
        const limited = githubRateLimit(error);
        if (limited) throw limited;
        // No usable data: every PR of this query goes through REST.
      }
      for (const [i, { url }] of batch.entries()) {
        const alias = `p${i}`;
        const entry = answer?.data[alias];
        const pr = entry?.pullRequest;
        const metadata = pr && !answer?.failed(alias) ? prMetadataFromGraph(pr) : undefined;
        if (metadata) {
          reportPrHead(octokit, metadata.url, metadata.headSha, { updatedAt: metadata.updatedAt, source: 'metadata' });
          results.set(url, { metadata });
        } else if (
          answer &&
          (entry === null || entry?.pullRequest === null) &&
          // GitHub answers a missing PR with `pullRequest: null` and a NOT_FOUND error at that field: REST's 404.
          (!answer.failed(alias) || answer.notFound(alias, 'pullRequest'))
        )
          results.set(url, { error: Object.assign(new Error(`GitHub could not find ${url}.`), { status: 404 }) });
        else rest.push(url);
      }
  });
  // The REST fallback stops at the first rate limit: the PRs it did not reach report that limit.
  let limited: Error | undefined;
  await mapBounded(rest, 5, async (url) => {
    if (limited) return void results.set(url, { error: limited });
    const { owner, repo, pullNumber } = parsePrUrl(url);
    try {
      results.set(url, { metadata: await getPrMetadata(octokit, owner, repo, pullNumber, options.fresh) });
    } catch (error) {
      limited ??= githubRateLimit(error);
      results.set(url, { error });
    }
  });
  return results;
}

/**
 * A metadata read after a write, from the same source as `baseline` where it can be, so comment counts compare like
 * with like: GraphQL counts comments as they are, while REST's counters can lag behind. When GraphQL cannot answer
 * this PR exactly, the copy comes from REST and says so in `source`; the write refresh then treats its counts as
 * inconclusive (`sameCountSource`) and reads again instead of settling.
 */
export async function readMetadataLike(
  octokit: Octokit,
  url: string,
  baseline: Partial<PrMetadata> | undefined,
  rest: () => Promise<PrMetadata>
): Promise<PrMetadata> {
  if (baseline?.source !== 'graphql') return rest();
  const result = (await getPrMetadataBatch(octokit, [url], { fresh: true })).get(url);
  if (!result || 'error' in result) throw result?.error instanceof Error ? result.error : new Error(`Could not read ${url}.`);
  return result.metadata;
}
