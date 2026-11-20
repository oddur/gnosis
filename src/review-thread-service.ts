import type { Octokit } from '@octokit/rest';
import { githubCacheFor } from '../lib/github-client';
import { isCacheRecord } from '../lib/github-cache';
import { createGitHubWork, joinGitHubWork, type GitHubWork } from '../lib/github-scheduler';
import { feedbackReplyBody } from '../lib/review-threads';
import type {
  FeedbackEvent,
  GitHubReviewComment,
  PrFeedback,
  FeedbackReview,
  FeedbackAction,
  GitHubReviewThread,
  GitHubReviewThreads,
  ReviewThreadAction,
  ReviewCommentAction,
} from '../lib/review-threads';

const bodyFields = 'id body createdAt updatedAt url isMinimized minimizedReason author { __typename login avatarUrl }';
const commentFields = `${bodyFields} viewerCanUpdate viewerCanDelete diffHunk pullRequestReview { id state }`;
const reviewFields = `${bodyFields} state submittedAt`;
type ReviewRequest = { requestedReviewer: { login?: string } | null };
type Login = { login: string } | null;
/** One node of `timelineItems`: commits, force-pushes, review requests, and merge, close and reopen events. */
type TimelineNode =
  | { __typename: 'PullRequestCommit'; id: string; commit: { oid: string; messageHeadline: string; committedDate: string; url?: string; author: { name: string | null; user: Login } | null } }
  | { __typename: 'HeadRefForcePushedEvent'; id: string; createdAt: string; actor: Login; beforeCommit: { oid: string } | null; afterCommit: { oid: string } | null }
  | { __typename: 'ReviewRequestedEvent'; id: string; createdAt: string; actor: Login; requestedReviewer: { login?: string; name?: string } | null }
  | { __typename: 'MergedEvent' | 'ClosedEvent' | 'ReopenedEvent'; id: string; createdAt: string; actor: Login };
const timelineFields = `timelineItems(last:100,itemTypes:[PULL_REQUEST_COMMIT,HEAD_REF_FORCE_PUSHED_EVENT,REVIEW_REQUESTED_EVENT,MERGED_EVENT,CLOSED_EVENT,REOPENED_EVENT]) { pageInfo { hasPreviousPage } nodes { __typename ... on PullRequestCommit { id commit { oid messageHeadline committedDate url author { name user { login } } } } ... on HeadRefForcePushedEvent { id createdAt actor { login } beforeCommit { oid } afterCommit { oid } } ... on ReviewRequestedEvent { id createdAt actor { login } requestedReviewer { ... on User { login } ... on Team { name } } } ... on MergedEvent { id createdAt actor { login } } ... on ClosedEvent { id createdAt actor { login } } ... on ReopenedEvent { id createdAt actor { login } } } }`;
/** GitHub's timeline nodes as Feedback events; unknown kinds are skipped. */
export function feedbackEvents(nodes: TimelineNode[]): FeedbackEvent[] {
  return nodes.flatMap((node): FeedbackEvent[] => {
    switch (node.__typename) {
      case 'PullRequestCommit':
        return [{ kind: 'commit', id: node.id, at: node.commit.committedDate, sha: node.commit.oid, message: node.commit.messageHeadline, author: node.commit.author?.user?.login ?? node.commit.author?.name ?? null, url: node.commit.url }];
      case 'HeadRefForcePushedEvent':
        return [{ kind: 'force-push', id: node.id, at: node.createdAt, actor: node.actor?.login ?? null, before: node.beforeCommit?.oid, after: node.afterCommit?.oid }];
      case 'ReviewRequestedEvent': {
        const reviewer = node.requestedReviewer?.login ?? node.requestedReviewer?.name;
        return reviewer ? [{ kind: 'review-requested', id: node.id, at: node.createdAt, actor: node.actor?.login ?? null, reviewer }] : [];
      }
      case 'MergedEvent':
      case 'ClosedEvent':
      case 'ReopenedEvent':
        return [{ kind: node.__typename === 'MergedEvent' ? 'merged' : node.__typename === 'ClosedEvent' ? 'closed' : 'reopened', id: node.id, at: node.createdAt, actor: node.actor?.login ?? null }];
      default:
        return [];
    }
  });
}
interface FeedbackPage {
  comments?: Page<GitHubReviewComment>;
  reviews?: Page<FeedbackReview>;
  reviewRequests?: Page<ReviewRequest>;
  timelineItems?: { nodes: TimelineNode[]; pageInfo: { hasPreviousPage: boolean } };
  viewerCanUpdate?: boolean;
  state?: string;
}
const pageFields = 'pageInfo { hasNextPage endCursor }';
const threadFields = `id path line startLine diffSide isResolved isOutdated viewerCanResolve viewerCanUnresolve resolvedBy { login } comments(first:20) { nodes { ${commentFields} } ${pageFields} }`;
interface Page<T> {
  nodes: T[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}
const requestedReviewerFields = 'requestedReviewer { ... on User { login } }';
/** The first page of a PR's discussion. `include` limits the feedback summary to the first page of a paginated read. */
const pullFields = (include: string, after: string) =>
  `headRefOid baseRefOid viewerCanUpdate state comments(first:50)${include} { nodes { ${bodyFields} } ${pageFields} } reviews(first:50)${include} { nodes { ${reviewFields} } ${pageFields} } reviewRequests(first:100)${include} { nodes { ${requestedReviewerFields} } ${pageFields} } ${timelineFields.replace(') {', `)${include} {`)} reviewThreads(first:50${after}) { nodes { ${threadFields} } ${pageFields} }`;
function feedbackOf(
  pr: FeedbackPage,
  comments: GitHubReviewComment[],
  reviews: FeedbackReview[],
  requests: ReviewRequest[]
): PrFeedback {
  return {
    comments,
    reviews,
    requestedReviewers: requests.flatMap((r) => (r.requestedReviewer?.login ? [r.requestedReviewer.login] : [])),
    viewerCanUpdate: pr.viewerCanUpdate === true,
    state: pr.state ?? 'OPEN',
    ...(pr.timelineItems
      ? { events: feedbackEvents(pr.timelineItems.nodes), earlierEvents: pr.timelineItems.pageInfo.hasPreviousPage }
      : {}),
  };
}
type ThreadNode = Omit<GitHubReviewThread, 'comments'> & { comments: Page<GitHubReviewComment> };
interface Pull extends FeedbackPage {
  headRefOid: string;
  baseRefOid: string;
  reviewThreads: Page<ThreadNode>;
}
/** A saved discussion older than this is never shown; the PR waits for GitHub instead. */
export const REVIEW_THREADS_MAX_STALE_MS = 24 * 60 * 60_000;
interface Entry {
  value?: GitHubReviewThreads;
  expires: number;
  /** Shared by revalidation, explicit refresh and sync, so an interactive caller promotes it. */
  pending?: GitHubWork<GitHubReviewThreads>;
  version?: number;
}
/** The top-level `url` lets a scoped GitHub write mark this record stale. Older records have none. */
interface SavedThreads {
  url?: string;
  value: GitHubReviewThreads;
  expires: number;
}
function isSavedThreads(value: unknown): value is SavedThreads {
  return (
    isCacheRecord(value) &&
    (value.url === undefined || typeof value.url === 'string') &&
    typeof value.expires === 'number' &&
    Number.isFinite(value.expires) &&
    isCacheRecord(value.value) &&
    typeof value.value.headSha === 'string' &&
    typeof value.value.baseSha === 'string' &&
    Array.isArray(value.value.threads) &&
    value.value.threads.every(
      (t: unknown) =>
        isCacheRecord(t) &&
        typeof t.id === 'string' &&
        typeof t.path === 'string' &&
        (t.line === null || (typeof t.line === 'number' && Number.isSafeInteger(t.line))) &&
        (t.startLine === null || (typeof t.startLine === 'number' && Number.isSafeInteger(t.startLine))) &&
        (t.diffSide === 'LEFT' || t.diffSide === 'RIGHT') &&
        typeof t.isResolved === 'boolean' &&
        typeof t.isOutdated === 'boolean' &&
        typeof t.viewerCanResolve === 'boolean' &&
        typeof t.viewerCanUnresolve === 'boolean' &&
        Array.isArray(t.comments) &&
        t.comments.every(
          (c: unknown) =>
            isCacheRecord(c) &&
            typeof c.id === 'string' &&
            typeof c.body === 'string' &&
            typeof c.url === 'string' &&
            typeof c.createdAt === 'string' &&
            (c.author === null ||
              (isCacheRecord(c.author) && typeof c.author.login === 'string' && typeof c.author.avatarUrl === 'string'))
        )
    )
  );
}

function parseUrl(url: string) {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/.exec(url);
  if (!match) throw new Error('A GitHub pull request URL is required.');
  return { owner: match[1], repo: match[2], number: Number(match[3]) };
}
async function graphql<T>(client: Octokit, query: string, variables: Record<string, unknown>): Promise<T> {
  const response = await client.request('POST /graphql', { query, variables });
  const result = response.data as { data?: T; errors?: { message: string }[] };
  if (result.errors?.length) throw new Error(result.errors.map((e) => e.message).join('\n'));
  if (!result.data) throw new Error('GitHub returned no review discussion data.');
  return result.data;
}
/** Long review threads whose next reply page shares one aliased `node(id:)` query. */
const THREADS_PER_QUERY = 25;
function nextCursor<T>(page: Page<T>, previous: string | null) {
  if (!page.pageInfo.hasNextPage) return null;
  const next = page.pageInfo.endCursor;
  if (!next || next === previous) throw new Error('GitHub could not load the remaining discussion pages.');
  return next;
}

/** Cache by authenticated client and PR. Reads share in-flight work; writes are never replayed. */
export function createReviewThreadService(now = Date.now) {
  const caches = new WeakMap<Octokit, Map<string, Entry>>();
  function cacheFor(client: Octokit) {
    let cache = caches.get(client);
    if (!cache) {
      cache = new Map();
      caches.set(client, cache);
    }
    return cache;
  }
  async function fetchThreads(client: Octokit, prUrl: string): Promise<GitHubReviewThreads> {
    const variables = parseUrl(prUrl);
    let cursor: string | null = null;
    const threads: GitHubReviewThread[] = [];
    let feedback: PrFeedback | undefined;
    let revision: Pick<GitHubReviewThreads, 'headSha' | 'baseSha'> | undefined;
    do {
      const data: { repository: { pullRequest: Pull | null } | null } = await graphql(
        client,
        `query ReviewThreads($owner:String!,$repo:String!,$number:Int!,$cursor:String,$summary:Boolean!) { rateLimit { cost } repository(owner:$owner,name:$repo) { pullRequest(number:$number) { ${pullFields(' @include(if:$summary)', ',after:$cursor')} } } }`,
        { ...variables, cursor, summary: cursor === null }
      );
      const pr = data.repository?.pullRequest;
      if (!pr) throw new Error('This PR is unavailable or your account cannot read it.');
      if (cursor === null && pr.comments && pr.reviews && pr.reviewRequests) {
        async function collect<T>(first: Page<T>, field: string, fields: string): Promise<T[]> {
          const all = [...first.nodes];
          let after = nextCursor(first, null);
          const visited = new Set<string>();
          while (after) {
            if (visited.has(after)) throw new Error('GitHub repeated a feedback page. Refresh to try again.');
            visited.add(after);
            const more = await graphql<{ repository: { pullRequest: Record<string, Page<T>> | null } | null }>(
              client,
              `query FeedbackPage($owner:String!,$repo:String!,$number:Int!,$after:String!) { rateLimit { cost } repository(owner:$owner,name:$repo) { pullRequest(number:$number) { ${field}(first:100,after:$after) { nodes { ${fields} } ${pageFields} } } } }`,
              { ...variables, after }
            );
            const page = more.repository?.pullRequest?.[field];
            if (!page) throw new Error('Some feedback is unavailable. Refresh to try again.');
            all.push(...page.nodes);
            after = nextCursor(page, after);
          }
          return all;
        }
        // The three lists page independently, so their remaining pages load together.
        const [comments, reviews, requests] = await Promise.all([
          collect(pr.comments, 'comments', bodyFields),
          collect(pr.reviews, 'reviews', reviewFields),
          collect(pr.reviewRequests, 'reviewRequests', requestedReviewerFields),
        ]);
        feedback = feedbackOf(pr, comments, reviews, requests);
      }
      if (revision && (revision.headSha !== pr.headRefOid || revision.baseSha !== pr.baseRefOid))
        throw new Error('The PR changed while loading discussions. Refresh comments to try again.');
      revision = { headSha: pr.headRefOid, baseSha: pr.baseRefOid };
      // Every thread with more replies than the first page reads its next page in one aliased query, 25 threads each.
      const replies = pr.reviewThreads.nodes.map((thread) => ({
        thread,
        all: [...thread.comments.nodes],
        after: nextCursor(thread.comments, null),
      }));
      for (let open = replies.filter((r) => r.after); open.length; open = replies.filter((r) => r.after)) {
        for (let i = 0; i < open.length; i += THREADS_PER_QUERY) {
          const batch = open.slice(i, i + THREADS_PER_QUERY);
          const more = await graphql<Record<string, { comments: Page<GitHubReviewComment> } | null>>(
            client,
            `query ThreadReplies { rateLimit { cost } ${batch
              .map(
                (r, j) =>
                  `t${j}: node(id:${JSON.stringify(r.thread.id)}) { ... on PullRequestReviewThread { comments(first:100,after:${JSON.stringify(r.after)}) { nodes { ${commentFields} } ${pageFields} } } }`
              )
              .join(' ')} }`,
            {}
          );
          for (const [j, r] of batch.entries()) {
            const node = more[`t${j}`];
            if (!node) throw new Error('This discussion is no longer available. Refresh comments.');
            r.all.push(...node.comments.nodes);
            r.after = nextCursor(node.comments, r.after);
          }
        }
      }
      for (const { thread, all } of replies) threads.push({ ...thread, comments: all });
      cursor = nextCursor(pr.reviewThreads, cursor);
    } while (cursor);
    return { ...revision, threads, checkedAt: now(), ...(feedback ? { feedback } : {}) };
  }
  /** Keeps the discussion in memory and on disk, unless a write or account change happened since `version`. */
  function remember(client: Octokit, prUrl: string, entry: Entry, result: GitHubReviewThreads, version: number | undefined) {
    const cache = cacheFor(client);
    const persistent = githubCacheFor(client);
    entry.value = result;
    entry.expires = now() + 60_000;
    entry.version = version;
    if (persistent?.version() === version)
      persistent?.set(`review-threads:${prUrl}`, { url: prUrl, value: result, expires: entry.expires } satisfies SavedThreads);
    while (cache.size > 50) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  }
  const service = {
    invalidate(client: Octokit, prUrl: string) {
      cacheFor(client).delete(prUrl);
      githubCacheFor(client)?.delete(`review-threads:${prUrl}`);
    },
    async comment(client: Octokit, req: ReviewCommentAction): Promise<GitHubReviewThread> {
      parseUrl(req.prUrl);
      if (!['edit', 'delete'].includes(req.action)) throw new Error('Unknown comment action.');
      const snapshot = await service.list(client, req.prUrl);
      const thread = snapshot.threads.find((t) => t.id === req.threadId);
      const comment = thread?.comments.find((c) => c.id === req.commentId);
      if (!thread || !comment) throw new Error('This comment does not belong to the selected PR. Refresh comments.');
      if (req.action === 'edit') {
        if (!comment.viewerCanUpdate) throw new Error('Your account cannot edit this comment.');
        const body = req.body?.trim();
        if (!body || body.length > 65536) throw new Error('Enter a comment of at most 65,536 characters.');
        const result = await graphql<{
          updatePullRequestReviewComment: { pullRequestReviewComment: GitHubReviewComment };
        }>(
          client,
          `mutation EditReviewComment($id:ID!,$body:String!) { updatePullRequestReviewComment(input:{pullRequestReviewCommentId:$id,body:$body}) { pullRequestReviewComment { ${commentFields} } } }`,
          { id: comment.id, body }
        );
        thread.comments = thread.comments.map((c) =>
          c.id === comment.id ? result.updatePullRequestReviewComment.pullRequestReviewComment : c
        );
      } else {
        if (!comment.viewerCanDelete) throw new Error('Your account cannot delete this comment.');
        await graphql(
          client,
          'mutation DeleteReviewComment($id:ID!) { deletePullRequestReviewComment(input:{id:$id}) { clientMutationId } }',
          { id: comment.id }
        );
        thread.comments = thread.comments.filter((c) => c.id !== comment.id);
      }
      service.markStale(client, req.prUrl);
      return thread;
    },
    /**
     * Local data only. The last discussion, past its 60-second freshness, while no write has
     * marked it stale and it is under 24 hours old. Writes never use this.
     */
    stale(client: Octokit, prUrl: string): GitHubReviewThreads | undefined {
      const persistent = githubCacheFor(client);
      const servable = (value: GitHubReviewThreads) => {
        const age = now() - (value.checkedAt ?? Number.NaN);
        return age >= 0 && age < REVIEW_THREADS_MAX_STALE_MS;
      };
      const saved = persistent?.get(`review-threads:${prUrl}`, isSavedThreads);
      if (saved && !saved.revalidate && servable(saved.value.value)) return saved.value.value;
      const entry = cacheFor(client).get(prUrl);
      if (entry?.value && (!persistent || entry.version === persistent.version()) && servable(entry.value))
        return structuredClone(entry.value);
    },
    /**
     * Local data only, for the queue's unresolved-thread count. The last discussion while it is under 24
     * hours old. A copy that new activity or a write marked stale is still returned, with `stale: true`,
     * so the count keeps its last known value until the next read replaces it.
     */
    latest(client: Octokit, prUrl: string): GitHubReviewThreads | undefined {
      const servable = (value: GitHubReviewThreads) => {
        const age = now() - (value.checkedAt ?? Number.NaN);
        return age >= 0 && age < REVIEW_THREADS_MAX_STALE_MS;
      };
      const persistent = githubCacheFor(client);
      const saved = persistent?.get(`review-threads:${prUrl}`, isSavedThreads);
      const entry = cacheFor(client).get(prUrl);
      const memory = entry?.value && servable(entry.value) ? entry : undefined;
      if (saved && servable(saved.value.value) && (saved.value.value.checkedAt ?? 0) >= (memory?.value?.checkedAt ?? 0))
        return saved.revalidate ? { ...saved.value.value, stale: true } : saved.value.value;
      if (memory?.value) return memory.expires > 0 ? memory.value : { ...memory.value, stale: true };
    },
    /**
     * New activity: the saved discussion is out of date, but its threads are still the best local evidence.
     * Marks it for revalidation instead of deleting it. A read in flight may predate the activity, so it is
     * not saved.
     */
    markStale(client: Octokit, prUrl: string) {
      const cache = cacheFor(client);
      const entry = cache.get(prUrl);
      const persistent = githubCacheFor(client);
      if (persistent) {
        cache.delete(prUrl);
        const key = `review-threads:${prUrl}`;
        // Older records have no `url` to match, so they cannot be marked and are deleted as before.
        if (persistent.get(key, isSavedThreads)?.value.url === undefined) persistent.delete(key);
        else persistent.invalidate((value) => isCacheRecord(value) && value.url === prUrl);
      } else if (entry?.value) cache.set(prUrl, { value: entry.value, expires: 0 });
      else cache.delete(prUrl);
    },
    cached(client: Octokit, prUrl: string): GitHubReviewThreads | undefined {
      return (
        githubCacheFor(client)?.get(`review-threads:${prUrl}`, isSavedThreads)?.value.value ??
        cacheFor(client).get(prUrl)?.value
      );
    },
    async list(client: Octokit, prUrl: string, refresh = false): Promise<GitHubReviewThreads> {
      parseUrl(prUrl);
      const cache = cacheFor(client);
      let entry = cache.get(prUrl);
      if (entry?.pending) return structuredClone(await joinGitHubWork(entry.pending));
      const persistent = githubCacheFor(client);
      const version = persistent?.version();
      const key = `review-threads:${prUrl}`;
      const saved = persistent?.get(key, isSavedThreads);
      if (
        !refresh &&
        saved &&
        !saved.revalidate &&
        saved.value.expires > now() &&
        saved.value.expires <= now() + 60_000
      )
        // Callers such as `act` and `comment` edit the result. The cached value is frozen and shared.
        return structuredClone(saved.value.value);
      if (!refresh && entry?.value && entry.expires > now() && (!persistent || entry.version === version))
        return structuredClone(entry.value);
      entry = { expires: 0 };
      cache.set(prUrl, entry);
      const current = entry;
      current.pending = createGitHubWork(() => fetchThreads(client, prUrl));
      try {
        const result = await current.pending.promise;
        if (cache.get(prUrl) === current) remember(client, prUrl, current, result, version);
        return structuredClone(result);
      } finally {
        current.pending = undefined;
        if (!current.value && cache.get(prUrl) === current) cache.delete(prUrl);
      }
    },
    /** Local data only. Whether `list` without `refresh` would answer from a saved copy, without a request. */
    fresh(client: Octokit, prUrl: string) {
      const entry = cacheFor(client).get(prUrl);
      if (entry?.pending) return true;
      const persistent = githubCacheFor(client);
      const saved = persistent?.get(`review-threads:${prUrl}`, isSavedThreads);
      if (saved && !saved.revalidate && saved.value.expires > now() && saved.value.expires <= now() + 60_000) return true;
      return !!entry?.value && entry.expires > now() && (!persistent || entry.version === persistent.version());
    },
    /** Local data only. The saved record's identity and age, for deciding whether to refresh it. */
    saved(client: Octokit, prUrl: string) {
      const saved = githubCacheFor(client)?.get(`review-threads:${prUrl}`, isSavedThreads);
      const value = saved?.value.value;
      if (!saved || typeof value?.checkedAt !== 'number') return;
      return { headSha: value.headSha, baseSha: value.baseSha, checkedAt: value.checkedAt, revalidate: saved.revalidate };
    },
    /**
     * Saves the discussions of up to five PRs from one query, exactly as `list` would. A PR with more
     * than one page of threads, replies or feedback is reported as incomplete and nothing is saved for it.
     * PRs with a read in flight are left to that read.
     */
    async preload(client: Octokit, prUrls: string[]): Promise<{ saved: string[]; incomplete: string[] }> {
      if (prUrls.length > 5) throw new Error('Preload at most five PR discussions.');
      const cache = cacheFor(client);
      const targets = [...new Set(prUrls)]
        .map((url) => ({ url, ...parseUrl(url) }))
        .filter(({ url }) => !cache.get(url)?.pending);
      if (!targets.length) return { saved: [], incomplete: [] };
      const persistent = githubCacheFor(client);
      const version = persistent?.version();
      const checkedAt = now();
      const query = `query { rateLimit { cost } ${targets
        .map(
          ({ owner, repo, number }, i) =>
            `p${i}: repository(owner:${JSON.stringify(owner)},name:${JSON.stringify(repo)}) { pullRequest(number:${number}) { ${pullFields('', '')} } }`
        )
        .join(' ')} }`;
      const response = await client.request('POST /graphql', { query });
      const result = response.data as {
        data?: Record<string, { pullRequest: Pull | null } | null> | null;
        errors?: { message: string; path?: (string | number)[] }[];
      };
      const failed = new Set<string>();
      for (const error of result.errors ?? []) {
        if (typeof error.path?.[0] !== 'string') throw new Error(error.message);
        failed.add(error.path[0]);
      }
      if (!result.data) throw new Error('GitHub returned no review discussion data.');
      const saved: string[] = [];
      const incomplete: string[] = [];
      for (const [i, { url }] of targets.entries()) {
        const pr = failed.has(`p${i}`) ? undefined : result.data[`p${i}`]?.pullRequest;
        if (!pr?.comments || !pr.reviews || !pr.reviewRequests) continue;
        if (
          [pr.comments, pr.reviews, pr.reviewRequests, pr.reviewThreads].some((page) => page.pageInfo.hasNextPage) ||
          pr.reviewThreads.nodes.some((thread) => thread.comments.pageInfo.hasNextPage)
        ) {
          incomplete.push(url);
          continue;
        }
        const value: GitHubReviewThreads = {
          headSha: pr.headRefOid,
          baseSha: pr.baseRefOid,
          threads: pr.reviewThreads.nodes.map((thread) => ({ ...thread, comments: thread.comments.nodes })),
          checkedAt,
          feedback: feedbackOf(pr, pr.comments.nodes, pr.reviews.nodes, pr.reviewRequests.nodes),
        };
        // A read that started or finished meanwhile, or a write during this query, wins.
        const existing = cache.get(url);
        if (existing?.pending || (existing?.value?.checkedAt ?? 0) > checkedAt) continue;
        if ((service.saved(client, url)?.checkedAt ?? 0) > checkedAt) continue;
        if (persistent?.version() !== version) continue;
        const entry: Entry = { expires: 0 };
        cache.delete(url);
        cache.set(url, entry);
        remember(client, url, entry, value, version);
        saved.push(url);
      }
      return { saved, incomplete };
    },
    async feedbackAction(client: Octokit, req: FeedbackAction): Promise<void> {
      const { owner, repo, number: pull_number } = parseUrl(req.prUrl);
      // IPC payloads are runtime inputs even when the preload types are narrow.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (req.action !== 'reply' && req.action !== 'request-review' && req.action !== 'nudge') throw new Error('Unknown feedback action.');
      if (req.action !== 'reply' && (typeof req.reviewer !== 'string' || !/^[A-Za-z0-9][\w-]{0,38}$/.test(req.reviewer)))
        throw new Error('Choose a GitHub user to request a review from.');
      // Refresh mutable permissions/review state before a write; never replay the write.
      const snapshot = await service.list(client, req.prUrl, true);
      const feedback = snapshot.feedback;
      if (!feedback) throw new Error('Feedback is incomplete. Refresh and try again.');
      if (req.action === 'reply') {
        const source = [...feedback.comments, ...feedback.reviews].find((c) => c.id === req.sourceId);
        if (!source) throw new Error('This feedback does not belong to the selected PR. Refresh feedback.');
        const body = typeof req.body === 'string' ? req.body.trim() : '';
        if (!body || body.length > 65000) throw new Error('Enter a reply of at most 65,000 characters.');
        const url = new URL(source.url);
        if (`${url.origin}${url.pathname}` !== req.prUrl.replace(/\/$/, ''))
          throw new Error('The feedback source URL is invalid.');
        await client.issues.createComment({
          owner,
          repo,
          issue_number: pull_number,
          body: feedbackReplyBody(source.url, body),
        });
      } else if (req.action === 'nudge') {
        if (!feedback.viewerCanUpdate || feedback.state !== 'OPEN')
          throw new Error('Your account cannot request a review on this PR.');
        const reviewer = req.reviewer.toLowerCase();
        const known =
          feedback.requestedReviewers.some((login) => login.toLowerCase() === reviewer) ||
          feedback.reviews.some((review) => review.author?.login.toLowerCase() === reviewer);
        if (!known) throw new Error(`${req.reviewer} is not a reviewer of this PR any more. Refresh the Overview.`);
        // GitHub sends the reviewer a new request, also when one is pending.
        await client.pulls.requestReviewers({ owner, repo, pull_number, reviewers: [req.reviewer] });
      } else {
        if (!feedback.viewerCanUpdate || feedback.state !== 'OPEN')
          throw new Error('Your account cannot request a review on this PR.');
        const latest = feedback.reviews
          .filter((r) => r.author?.login.toLowerCase() === req.reviewer.toLowerCase() && r.state !== 'PENDING')
          .sort((a, b) => (b.submittedAt ?? b.createdAt).localeCompare(a.submittedAt ?? a.createdAt))
          .at(0);
        if (latest?.state !== 'CHANGES_REQUESTED')
          throw new Error('This reviewer no longer has a changes-requested review. Refresh feedback.');
        if (feedback.requestedReviewers.some((login) => login.toLowerCase() === req.reviewer.toLowerCase())) return;
        await client.pulls.requestReviewers({ owner, repo, pull_number, reviewers: [req.reviewer] });
      }
      service.markStale(client, req.prUrl);
    },
    async act(client: Octokit, req: ReviewThreadAction): Promise<GitHubReviewThread> {
      parseUrl(req.prUrl);
      if (!['reply', 'resolve', 'unresolve'].includes(req.action)) throw new Error('Unknown discussion action.');
      const snapshot = await service.list(client, req.prUrl);
      const thread = snapshot.threads.find((t) => t.id === req.threadId);
      if (!thread) throw new Error('This thread does not belong to the selected PR. Refresh comments.');
      if (req.action === 'reply') {
        const body = req.body?.trim();
        if (!body || body.length > 65536) throw new Error('Enter a reply of at most 65,536 characters.');
        const result = await graphql<{ addPullRequestReviewThreadReply: { comment: GitHubReviewComment } }>(
          client,
          `mutation ReplyToThread($id:ID!,$body:String!) { addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$id,body:$body}) { comment { ${commentFields} } } }`,
          { id: thread.id, body }
        );
        thread.comments.push(result.addPullRequestReviewThreadReply.comment);
      } else {
        if (req.action === 'resolve' ? !thread.viewerCanResolve : !thread.viewerCanUnresolve)
          throw new Error('Your account cannot change this thread’s resolution.');
        const field = req.action === 'resolve' ? 'resolveReviewThread' : 'unresolveReviewThread';
        const result = await graphql<
          Record<string, { thread: Pick<GitHubReviewThread, 'isResolved' | 'viewerCanResolve' | 'viewerCanUnresolve'> }>
        >(
          client,
          `mutation ResolveThread($id:ID!) { ${field}(input:{threadId:$id}) { thread { isResolved viewerCanResolve viewerCanUnresolve } } }`,
          { id: thread.id }
        );
        Object.assign(thread, result[field].thread);
      }
      service.markStale(client, req.prUrl);
      return thread;
    },
  };
  return service;
}
