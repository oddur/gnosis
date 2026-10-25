import type { Octokit } from '@octokit/rest';
import { githubCacheFor } from '../lib/github-client';
import { isCacheRecord } from '../lib/github-cache';
import type {
  GitHubReviewComment,
  GitHubReviewThread,
  GitHubReviewThreads,
  ReviewThreadAction,
  ReviewCommentAction,
} from '../lib/review-threads';

const commentFields = 'id body createdAt url viewerCanUpdate viewerCanDelete author { login avatarUrl }';
const pageFields = 'pageInfo { hasNextPage endCursor }';
const threadFields = `id path line startLine diffSide isResolved isOutdated viewerCanResolve viewerCanUnresolve comments(first:20) { nodes { ${commentFields} } ${pageFields} }`;
interface Page<T> {
  nodes: T[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}
type ThreadNode = Omit<GitHubReviewThread, 'comments'> & { comments: Page<GitHubReviewComment> };
interface Pull {
  headRefOid: string;
  baseRefOid: string;
  reviewThreads: Page<ThreadNode>;
}
interface Entry {
  value?: GitHubReviewThreads;
  expires: number;
  pending?: Promise<GitHubReviewThreads>;
  version?: number;
}
interface SavedThreads {
  value: GitHubReviewThreads;
  expires: number;
}
function isSavedThreads(value: unknown): value is SavedThreads {
  return (
    isCacheRecord(value) &&
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
    let revision: Pick<GitHubReviewThreads, 'headSha' | 'baseSha'> | undefined;
    do {
      const data: { repository: { pullRequest: Pull | null } | null } = await graphql(
        client,
        `query ReviewThreads($owner:String!,$repo:String!,$number:Int!,$cursor:String) { repository(owner:$owner,name:$repo) { pullRequest(number:$number) { headRefOid baseRefOid reviewThreads(first:50,after:$cursor) { nodes { ${threadFields} } ${pageFields} } } } }`,
        { ...variables, cursor }
      );
      const pr = data.repository?.pullRequest;
      if (!pr) throw new Error('This PR is unavailable or your account cannot read it.');
      if (revision && (revision.headSha !== pr.headRefOid || revision.baseSha !== pr.baseRefOid))
        throw new Error('The PR changed while loading discussions. Refresh comments to try again.');
      revision = { headSha: pr.headRefOid, baseSha: pr.baseRefOid };
      for (const thread of pr.reviewThreads.nodes) {
        let comments = thread.comments;
        const all = [...comments.nodes];
        let after = nextCursor(comments, null);
        while (after) {
          const more: { node: { comments: Page<GitHubReviewComment> } | null } = await graphql(
            client,
            `query ThreadReplies($id:ID!,$after:String!) { node(id:$id) { ... on PullRequestReviewThread { comments(first:100,after:$after) { nodes { ${commentFields} } ${pageFields} } } } }`,
            { id: thread.id, after }
          );
          if (!more.node) throw new Error('This discussion is no longer available. Refresh comments.');
          comments = more.node.comments;
          all.push(...comments.nodes);
          after = nextCursor(comments, after);
        }
        threads.push({ ...thread, comments: all });
      }
      cursor = nextCursor(pr.reviewThreads, cursor);
    } while (cursor);
    return { ...revision, threads };
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
      service.invalidate(client, req.prUrl);
      return thread;
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
      if (entry?.pending) return structuredClone(await entry.pending);
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
        return saved.value.value;
      if (!refresh && entry?.value && entry.expires > now() && (!persistent || entry.version === version))
        return structuredClone(entry.value);
      entry = { expires: 0 };
      cache.set(prUrl, entry);
      const current = entry;
      current.pending = fetchThreads(client, prUrl);
      try {
        const result = await current.pending;
        if (cache.get(prUrl) === current) {
          current.value = result;
          current.expires = now() + 60_000;
          current.version = version;
          if (persistent?.version() === version) persistent?.set(key, { value: result, expires: current.expires });
          while (cache.size > 50) {
            const oldest = cache.keys().next().value;
            if (oldest === undefined) break;
            cache.delete(oldest);
          }
        }
        return structuredClone(result);
      } finally {
        current.pending = undefined;
        if (!current.value && cache.get(prUrl) === current) cache.delete(prUrl);
      }
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
      service.invalidate(client, req.prUrl);
      return thread;
    },
  };
  return service;
}
