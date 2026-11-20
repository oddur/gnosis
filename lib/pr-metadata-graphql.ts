import type { Octokit } from '@octokit/rest';
import { getPrMetadata, parsePrUrl } from './github';
import { mapBounded } from './bounded';
import { parseGitHubLabels } from './github-labels';
import { reportPrHead } from './pr-heads';
import type { PrMetadata } from './types';

/**
 * The fields of `getPrMetadata` (one REST `pulls.get`) as a GraphQL selection, so many PRs can share one query.
 *
 * - `review_comments` has no GraphQL count. Each review comment belongs to one review, so the sum over submitted
 *   reviews (pending ones excluded, as REST does) gives the same number. `totalCommentsCount` minus the conversation
 *   comments does not: it also counts some review bodies.
 * - A bot's GraphQL login has no `[bot]` suffix; REST's does.
 * - `mergeStateStatus` and `autoMergeRequest.mergeMethod` are uppercase; REST's values are lowercase.
 */
export const PR_METADATA_FIELDS = `number title url body createdAt updatedAt state merged isDraft mergeable mergeStateStatus
      additions deletions changedFiles
      author { __typename login }
      assignees(first:100) { totalCount nodes { login } }
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
const restLogin = (actor: { __typename?: string; login?: string } | null | undefined) =>
  actor?.login === undefined ? undefined : actor.__typename === 'Bot' ? `${actor.login}[bot]` : actor.login;

/**
 * The `PrMetadata` that `getPrMetadata` would return for this PR, or undefined when the answer is incomplete (more
 * than 100 reviews, labels, assignees or review requests) and only REST can give the exact value.
 */
export function prMetadataFromGraph(pr: GraphPrMetadata): PrMetadata | undefined {
  if (!pr.baseRepository || ![pr.assignees, pr.reviews, pr.labels, pr.reviewRequests].every(complete)) return undefined;
  const nodes = <T>(connection: Connection<T | null>) => (connection.nodes ?? []).filter((n): n is T => !!n);
  const reviewers = nodes(pr.reviewRequests).map((request) => request.requestedReviewer);
  const labels = nodes(pr.labels);
  return {
    title: pr.title,
    commentCount: pr.comments.totalCount,
    reviewCommentCount: nodes(pr.reviews).reduce((sum, review) => sum + review.comments.totalCount, 0),
    description: pr.body ?? '',
    // REST shows a deleted account as `ghost`.
    author: restLogin(pr.author) ?? 'ghost',
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
    requestedReviewers: reviewers.flatMap((r) => (r && r.__typename !== 'Team' ? [restLogin(r) ?? ''] : [])).filter(Boolean),
    requestedTeams: reviewers.flatMap((r) => (r?.__typename === 'Team' && r.name ? [r.name] : [])),
    mergeableState: pr.mergeStateStatus ? pr.mergeStateStatus.toLowerCase() : null,
    autoMerge: pr.autoMergeRequest ? { method: pr.autoMergeRequest.mergeMethod.toLowerCase() } : null,
    milestone: pr.milestone ? { title: pr.milestone.title, dueOn: pr.milestone.dueOn } : null,
  };
}

/** PRs per metadata query. Each carries four connections of up to 100 nodes, so 25 PRs cost about 1–2 points. */
export const PR_METADATA_PER_QUERY = 25;
/**
 * `getPrMetadata` for many PRs, as aliased GraphQL queries of up to 25 PRs each. A PR GitHub does not return gets its
 * own error, as a REST 404 would. A PR whose answer is incomplete, and every PR of a query that failed, is read
 * through `getPrMetadata` instead, so the result never differs from the REST read. `extra` adds fields to each PR's
 * selection; their raw values come back in `graph`.
 */
export async function getPrMetadataBatch(
  octokit: Octokit,
  urls: readonly string[],
  options: { extra?: string; cost?: (cost: number) => void; fresh?: boolean } = {}
): Promise<Map<string, { metadata: PrMetadata; graph?: Record<string, unknown> } | { error: unknown }>> {
  const unique = [...new Set(urls)];
  const results = new Map<string, { metadata: PrMetadata; graph?: Record<string, unknown> } | { error: unknown }>();
  const rest: string[] = [];
  const targets = unique.flatMap((url) => {
    try {
      return [{ url, ...parsePrUrl(url) }];
    } catch (error) {
      results.set(url, { error });
      return [];
    }
  });
  const batches: (typeof targets)[] = [];
  for (let i = 0; i < targets.length; i += PR_METADATA_PER_QUERY) batches.push(targets.slice(i, i + PR_METADATA_PER_QUERY));
  await Promise.all(
    batches.map(async (batch) => {
      const query = `query { rateLimit { cost } ${batch
        .map(
          ({ owner, repo, pullNumber }, i) =>
            `p${i}: repository(owner:${JSON.stringify(owner)},name:${JSON.stringify(repo)}) { pullRequest(number:${pullNumber}) { ${PR_METADATA_FIELDS} ${options.extra ?? ''} } }`
        )
        .join('\n')} }`;
      type Data = Record<string, { pullRequest: (GraphPrMetadata & Record<string, unknown>) | null } | null> & {
        rateLimit?: { cost?: number } | null;
      };
      let data: Data | undefined;
      let partial = false;
      try {
        data = await octokit.graphql<Data>(query);
      } catch (error) {
        // A missing repository or PR fails only its own alias; anything unanswered goes through REST.
        data = (error as { data?: Data | null }).data ?? undefined;
        partial = true;
      }
      const cost = data?.rateLimit?.cost;
      if (typeof cost === 'number') options.cost?.(cost);
      for (const [i, { url }] of batch.entries()) {
        const entry = data?.[`p${i}`];
        const pr = entry?.pullRequest;
        const metadata = pr ? prMetadataFromGraph(pr) : undefined;
        if (pr && metadata) {
          reportPrHead(octokit, metadata.url, metadata.headSha, { updatedAt: metadata.updatedAt, source: 'metadata' });
          results.set(url, { metadata, graph: pr });
        } else if (data && !partial && (entry === null || (entry && pr === null)))
          results.set(url, { error: Object.assign(new Error(`GitHub could not find ${url}.`), { status: 404 }) });
        else rest.push(url);
      }
    })
  );
  await mapBounded(rest, 5, async (url) => {
    const { owner, repo, pullNumber } = parsePrUrl(url);
    try {
      results.set(url, { metadata: await getPrMetadata(octokit, owner, repo, pullNumber, options.fresh) });
    } catch (error) {
      results.set(url, { error });
    }
  });
  return results;
}

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((value) => b.includes(value));
/**
 * `next` with the reviewer and team order of `previous` when the sets are equal. GraphQL lists review requests in a
 * different order than REST, and a saved copy should not appear to change because of where it was read.
 */
export function withReviewerOrder(
  next: PrMetadata,
  previous: Partial<Pick<PrMetadata, 'requestedReviewers' | 'requestedTeams'>>
): PrMetadata {
  const reviewers = previous.requestedReviewers,
    teams = previous.requestedTeams;
  const keepReviewers = !!reviewers && sameSet(reviewers, next.requestedReviewers),
    keepTeams = !!teams && sameSet(teams, next.requestedTeams);
  if (!keepReviewers && !keepTeams) return next;
  return {
    ...next,
    ...(keepReviewers ? { requestedReviewers: [...reviewers] } : {}),
    ...(keepTeams ? { requestedTeams: [...teams] } : {}),
  };
}
