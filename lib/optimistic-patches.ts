import type { QueueSignals } from './queue-signals';
import type { FeedbackReview, GitHubReviewComment, GitHubReviewThread, GitHubReviewThreads } from './review-threads';
import type { DiffSide, PrMetadata } from './types';

/**
 * Optimistic GitHub writes. Each write Gnosis makes adds one patch, keyed by what it changes, before the write starts.
 * The patch is applied over every copy of the PR read from GitHub: the discussion, the PR metadata and the queue
 * signals. So the queue row, the PR page, attention and the menu bar show the change at once.
 *
 * - When the write succeeds, the patch is confirmed and carries GitHub's real objects: ids and URLs.
 * - When it fails, the patch is removed: every copy shows GitHub's state again.
 * - When a fresh read shows the change, that kind of copy is settled and the patch no longer touches it. A patch
 *   never adds what a copy already shows, so the real comment never shows next to the optimistic one.
 * - A confirmed patch expires after `OPTIMISTIC_CONFIRMED_TTL_MS`, after the follow-up reads of #336 stop.
 */
export type OptimisticChange =
  | { action: 'review-comment'; path: string; line: number; startLine?: number; side: DiffSide; body: string }
  | { action: 'thread-reply'; threadId: string; body: string }
  | { action: 'feedback-reply'; body: string }
  | { action: 'thread-resolve' | 'thread-unresolve'; threadId: string }
  | { action: 'comment-edit'; threadId: string; commentId: string; body: string }
  | { action: 'comment-delete'; threadId: string; commentId: string }
  | {
      action: 'submit-review';
      event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';
      body: string;
      headSha?: string;
      comments: { path: string; line: number; startLine?: number; side: DiffSide; body: string }[];
    }
  | { action: 'mark-ready' | 'convert-draft' }
  | { action: 'enable-auto-merge'; method: string }
  | { action: 'disable-auto-merge' }
  | { action: 'request-review'; reviewer: string };
export type OptimisticAction = OptimisticChange['action'];
export type OptimisticKind = 'discussion' | 'metadata' | 'signals';

/** What GitHub returned for a successful write. */
export interface OptimisticResult {
  /** The thread after a reply, resolve, edit or delete. */
  thread?: GitHubReviewThread;
  /** A new inline comment. */
  comment?: { id: string; url: string };
  reviewUrl?: string;
}
export interface OptimisticViewer {
  login: string;
  avatarUrl: string;
}
export interface OptimisticPatch {
  id: string;
  /** Action and target. A newer patch with the same key replaces the older one, such as unresolve after resolve. */
  key: string;
  url: string;
  change: OptimisticChange;
  viewer: OptimisticViewer;
  startedAt: number;
  status: 'pending' | 'confirmed';
  confirmedAt?: number;
  result?: OptimisticResult;
  /** Counts before the write, from local copies. */
  before: { commentCount?: number; reviewCommentCount?: number; comments?: number };
  /** Kinds a fresh read showed the change in. The patch no longer applies to them. */
  settled: OptimisticKind[];
}

/** Longer than the follow-up reads after a write (60 s): until then a lagging GitHub read must not undo the change. */
export const OPTIMISTIC_CONFIRMED_TTL_MS = 90_000;
/** A write that never answers is abandoned after this. */
export const OPTIMISTIC_PENDING_TTL_MS = 5 * 60_000;
/** Server clocks and ours differ. A matching comment created this long before the write still counts as it. */
const CLOCK_SKEW_MS = 2 * 60_000;
export const OPTIMISTIC_ID_PREFIX = 'optimistic:';

export function optimisticKey(url: string, change: OptimisticChange, id: string): string {
  switch (change.action) {
    case 'thread-resolve':
    case 'thread-unresolve':
      return `thread-state|${url}|${change.threadId}`;
    case 'comment-edit':
    case 'comment-delete':
      return `comment-change|${url}|${change.commentId}`;
    case 'submit-review':
      return `review|${url}`;
    case 'mark-ready':
    case 'convert-draft':
      return `draft|${url}`;
    case 'enable-auto-merge':
    case 'disable-auto-merge':
      return `auto-merge|${url}`;
    case 'request-review':
      return `request-review|${url}|${change.reviewer.toLowerCase()}`;
    default:
      // Every new comment is its own target.
      return `comment|${url}|${id}`;
  }
}

/** The kinds of copy a change shows in. */
export function optimisticKinds(change: OptimisticChange): OptimisticKind[] {
  switch (change.action) {
    // The queue badge shows GitHub's total: conversation and inline comments. Signals also list unresolved threads.
    case 'review-comment':
    case 'thread-reply':
    case 'comment-delete':
    case 'feedback-reply':
    case 'submit-review':
      return ['discussion', 'metadata', 'signals'];
    case 'thread-resolve':
    case 'thread-unresolve':
      return ['discussion', 'signals'];
    case 'comment-edit':
      return ['discussion'];
    case 'mark-ready':
    case 'convert-draft':
      return ['metadata', 'signals'];
    case 'enable-auto-merge':
    case 'disable-auto-merge':
      return ['metadata'];
    case 'request-review':
      return ['discussion', 'metadata'];
  }
}

const same = (a: string | undefined | null, b: string | undefined | null) =>
  !!a && !!b && a.toLowerCase() === b.toLowerCase();
const text = (value: string) => value.replace(/\r\n/g, '\n').trim();
const isoAt = (ms: number) => new Date(ms).toISOString();
const optimisticId = (patch: OptimisticPatch, suffix = '') => `${OPTIMISTIC_ID_PREFIX}${patch.id}${suffix}`;
const author = (patch: OptimisticPatch) => ({ login: patch.viewer.login, avatarUrl: patch.viewer.avatarUrl });

/** A comment GitHub returned for this write: its id when known, otherwise the reader's comment with the same text. */
function matches(patch: OptimisticPatch, comment: GitHubReviewComment, body: string, id?: string) {
  if (comment.id.startsWith(OPTIMISTIC_ID_PREFIX)) return false;
  if (id) return comment.id === id;
  return (
    same(comment.author?.login, patch.viewer.login) &&
    text(comment.body) === text(body) &&
    Date.parse(comment.createdAt) >= patch.startedAt - CLOCK_SKEW_MS
  );
}
function pendingComment(patch: OptimisticPatch, body: string, suffix = ''): GitHubReviewComment {
  return {
    id: optimisticId(patch, suffix),
    body,
    createdAt: isoAt(patch.startedAt),
    url: '',
    author: author(patch),
    viewerCanUpdate: false,
    viewerCanDelete: false,
    sending: true,
  };
}
/** The reply GitHub created, from the thread it returned. */
function realReply(patch: OptimisticPatch & { change: { action: 'thread-reply' } }) {
  const comments = patch.result?.thread?.comments ?? [];
  return [...comments].reverse().find((comment) => matches(patch, comment, patch.change.body));
}
const threadHas = (thread: GitHubReviewThread, test: (comment: GitHubReviewComment) => boolean) =>
  thread.comments.some(test);
const findComment = (base: GitHubReviewThreads, id: string) =>
  base.threads.flatMap((thread) => thread.comments).find((comment) => comment.id === id);
/** The review GitHub reports for this write: by URL when known, otherwise the reader's newest review since it. */
function reviewSeen(
  patch: OptimisticPatch,
  review: { url: string; author?: string | null; submittedAt?: string | null; state?: string }
) {
  if (patch.result?.reviewUrl) return review.url === patch.result.reviewUrl;
  return (
    same(review.author, patch.viewer.login) && Date.parse(review.submittedAt ?? '') >= patch.startedAt - CLOCK_SKEW_MS
  );
}
const reviewState = (event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT') =>
  event === 'APPROVE' ? 'APPROVED' : event === 'REQUEST_CHANGES' ? 'CHANGES_REQUESTED' : 'COMMENTED';
const count = (value: number | undefined) => value ?? 0;
/** New inline comments a change adds: one comment, one reply, or a review's comments. Delete removes one. */
function reviewCommentDelta(change: OptimisticChange) {
  if (change.action === 'review-comment' || change.action === 'thread-reply') return 1;
  if (change.action === 'submit-review') return change.comments.length;
  if (change.action === 'comment-delete') return -1;
  return 0;
}
/** Comments a change adds to GitHub's PR total (`totalCommentsCount`), which the queue badge shows. */
const signalCommentDelta = (change: OptimisticChange): number => reviewCommentDelta(change) + commentDelta(change);
/** Ids of the threads a change starts: a new inline comment, or a review's comments. */
function newThreadIds(patch: OptimisticPatch): string[] {
  if (patch.change.action === 'review-comment') return [optimisticId(patch)];
  if (patch.change.action === 'submit-review') return patch.change.comments.map((_, index) => optimisticId(patch, `:${index}`));
  return [];
}
/** Conversation comments a change adds. */
const commentDelta = (change: OptimisticChange): number => (change.action === 'feedback-reply' ? 1 : 0);

// ── Seen: a fresh copy already shows the change ──

export function seenInDiscussion(patch: OptimisticPatch, base: GitHubReviewThreads): boolean {
  const { change } = patch;
  switch (change.action) {
    case 'review-comment':
      return base.threads.some((thread) =>
        threadHas(thread, (comment) => matches(patch, comment, change.body, patch.result?.comment?.id))
      );
    case 'thread-reply': {
      const thread = base.threads.find((candidate) => candidate.id === change.threadId);
      const real =
        patch.status === 'confirmed' ? realReply(patch as OptimisticPatch & { change: typeof change }) : undefined;
      return !!thread && threadHas(thread, (comment) => matches(patch, comment, change.body, real?.id));
    }
    case 'feedback-reply':
      return !!base.feedback?.comments.some((comment) => matches(patch, comment, change.body));
    case 'thread-resolve':
    case 'thread-unresolve': {
      const thread = base.threads.find((candidate) => candidate.id === change.threadId);
      // A thread that is gone has nothing left to show.
      return !thread || thread.isResolved === (change.action === 'thread-resolve');
    }
    case 'comment-edit': {
      const comment = findComment(base, change.commentId);
      return !comment || text(comment.body) === text(change.body);
    }
    case 'comment-delete':
      return !findComment(base, change.commentId);
    case 'submit-review': {
      const reviews = base.feedback?.reviews;
      // Without the feedback part, the copy cannot show the review: it does not count as seen.
      return !!reviews?.some((review) =>
        reviewSeen(patch, { url: review.url, author: review.author?.login, submittedAt: review.submittedAt })
      );
    }
    case 'request-review':
      return !!base.feedback?.requestedReviewers.some((login) => same(login, change.reviewer));
    default:
      return true;
  }
}

export function seenInMetadata(
  patch: OptimisticPatch,
  base: Pick<PrMetadata, 'isDraft' | 'autoMerge' | 'requestedReviewers' | 'commentCount' | 'reviewCommentCount'>
): boolean {
  const { change, before } = patch;
  switch (change.action) {
    case 'mark-ready':
      return !base.isDraft;
    case 'convert-draft':
      return base.isDraft;
    case 'enable-auto-merge':
      return !!base.autoMerge;
    case 'disable-auto-merge':
      return !base.autoMerge;
    case 'request-review':
      return base.requestedReviewers.some((login) => same(login, change.reviewer));
    case 'submit-review':
      if (base.requestedReviewers.some((login) => same(login, patch.viewer.login))) return false;
      break;
    default:
      break;
  }
  const reviews = reviewCommentDelta(change);
  if (reviews && before.reviewCommentCount !== undefined) {
    const target = before.reviewCommentCount + reviews;
    if (reviews > 0 ? count(base.reviewCommentCount) < target : count(base.reviewCommentCount) > target) return false;
  }
  const comments = commentDelta(change);
  if (comments && before.commentCount !== undefined && count(base.commentCount) < before.commentCount + comments)
    return false;
  return true;
}

export function seenInSignals(patch: OptimisticPatch, base: QueueSignals): boolean {
  const { change, before } = patch;
  switch (change.action) {
    case 'submit-review':
      return !!base.latestReview && reviewSeen(patch, base.latestReview);
    case 'mark-ready':
      return !base.readiness || !base.readiness.isDraft;
    case 'convert-draft':
      return !base.readiness || base.readiness.isDraft;
    case 'thread-resolve':
    case 'thread-unresolve':
      // Older entries carry no thread ids: nothing to show there.
      return !base.threads || base.threads.unresolved.includes(change.threadId) === (change.action === 'thread-unresolve');
    default: {
      const delta = signalCommentDelta(change);
      if (!delta || before.comments === undefined) return true;
      return delta > 0 ? base.comments >= before.comments + delta : base.comments <= before.comments + delta;
    }
  }
}

// ── Apply: the expected change over a copy ──

function withThread(
  base: GitHubReviewThreads,
  id: string,
  edit: (thread: GitHubReviewThread) => GitHubReviewThread | undefined
): GitHubReviewThreads {
  if (!base.threads.some((thread) => thread.id === id)) return base;
  const threads = base.threads.flatMap((thread) => {
    if (thread.id !== id) return [thread];
    const next = edit(thread);
    return next && next.comments.length ? [next] : [];
  });
  return { ...base, threads };
}
function withComment(
  base: GitHubReviewThreads,
  threadId: string,
  commentId: string,
  edit: (comment: GitHubReviewComment) => GitHubReviewComment | undefined
) {
  // A comment that moved threads in a later read is still found by its id.
  const owner =
    base.threads.find((thread) => thread.id === threadId && thread.comments.some((c) => c.id === commentId)) ??
    base.threads.find((thread) => thread.comments.some((c) => c.id === commentId));
  if (!owner) return base;
  return withThread(base, owner.id, (thread) => ({
    ...thread,
    comments: thread.comments.flatMap((comment) => {
      if (comment.id !== commentId) return [comment];
      const next = edit(comment);
      return next ? [next] : [];
    }),
  }));
}
function newThread(
  patch: OptimisticPatch,
  where: { path: string; line: number; startLine?: number; side: DiffSide },
  comment: GitHubReviewComment,
  suffix = ''
): GitHubReviewThread {
  return {
    id: optimisticId(patch, suffix),
    path: where.path,
    line: where.line,
    startLine: where.startLine ?? null,
    diffSide: where.side,
    isResolved: false,
    isOutdated: false,
    viewerCanResolve: false,
    viewerCanUnresolve: false,
    comments: [comment],
    ...(comment.sending ? { sending: 'comment' as const } : {}),
  };
}

export function applyToDiscussion(patch: OptimisticPatch, base: GitHubReviewThreads): GitHubReviewThreads {
  const { change } = patch;
  const confirmed = patch.status === 'confirmed';
  switch (change.action) {
    case 'review-comment': {
      const real = patch.result?.comment;
      const comment = real
        ? {
            ...pendingComment(patch, change.body),
            id: real.id,
            url: real.url,
            sending: undefined,
            viewerCanUpdate: true,
            viewerCanDelete: true,
          }
        : pendingComment(patch, change.body);
      const thread = newThread(patch, change, comment);
      return {
        ...base,
        threads: [...base.threads, real ? { ...thread, sending: undefined, viewerCanResolve: true } : thread],
      };
    }
    case 'thread-reply': {
      const real = confirmed ? realReply(patch as OptimisticPatch & { change: typeof change }) : undefined;
      return withThread(base, change.threadId, (thread) => ({
        ...thread,
        comments: [...thread.comments, real ?? pendingComment(patch, change.body)],
      }));
    }
    case 'feedback-reply':
      return base.feedback
        ? {
            ...base,
            feedback: {
              ...base.feedback,
              comments: [
                ...base.feedback.comments,
                { ...pendingComment(patch, change.body), ...(confirmed ? { sending: undefined } : {}) },
              ],
            },
          }
        : base;
    case 'thread-resolve':
    case 'thread-unresolve': {
      const resolved = change.action === 'thread-resolve';
      return withThread(base, change.threadId, (thread) => ({
        ...thread,
        isResolved: resolved,
        viewerCanResolve: thread.viewerCanResolve || thread.viewerCanUnresolve,
        viewerCanUnresolve: thread.viewerCanUnresolve || thread.viewerCanResolve,
        ...(confirmed ? {} : { sending: resolved ? ('resolving' as const) : ('reopening' as const) }),
      }));
    }
    case 'comment-edit':
      return withComment(base, change.threadId, change.commentId, (comment) => ({
        ...comment,
        body: change.body,
        updatedAt: isoAt(patch.startedAt),
        ...(confirmed ? {} : { sending: true as const }),
      }));
    case 'comment-delete':
      return withComment(base, change.threadId, change.commentId, () => undefined);
    case 'submit-review': {
      const state = reviewState(change.event);
      const review: FeedbackReview = {
        ...pendingComment(patch, change.body, ':review'),
        url: patch.result?.reviewUrl ?? '',
        state,
        submittedAt: isoAt(patch.startedAt),
        ...(confirmed ? { sending: undefined } : {}),
      };
      const threads = change.comments.map((comment, index) => {
        const body = {
          ...pendingComment(patch, comment.body, `:${index}`),
          ...(confirmed ? { sending: undefined } : {}),
          // Linked to the review, so Feedback shows a comment-only review as its threads, as GitHub does.
          pullRequestReview: { id: review.id },
        };
        return newThread(patch, comment, body, `:${index}`);
      });
      return {
        ...base,
        threads: [...base.threads, ...threads],
        ...(base.feedback
          ? {
              feedback: {
                ...base.feedback,
                reviews: [...base.feedback.reviews, review],
                requestedReviewers: base.feedback.requestedReviewers.filter(
                  (login) => !same(login, patch.viewer.login)
                ),
              },
            }
          : {}),
      };
    }
    case 'request-review':
      return base.feedback
        ? {
            ...base,
            feedback: { ...base.feedback, requestedReviewers: [...base.feedback.requestedReviewers, change.reviewer] },
          }
        : base;
    default:
      return base;
  }
}

export function applyToMetadata<T extends PrMetadata>(patch: OptimisticPatch, base: T): T {
  const { change, before } = patch;
  let next: T = base;
  const reviews = reviewCommentDelta(change);
  if (reviews && before.reviewCommentCount !== undefined) {
    const target = before.reviewCommentCount + reviews;
    const value =
      reviews > 0
        ? Math.max(count(base.reviewCommentCount), target)
        : Math.min(count(base.reviewCommentCount), Math.max(0, target));
    if (value !== base.reviewCommentCount) next = { ...next, reviewCommentCount: value };
  }
  const comments = commentDelta(change);
  if (comments && before.commentCount !== undefined) {
    const value = Math.max(count(base.commentCount), before.commentCount + comments);
    if (value !== base.commentCount) next = { ...next, commentCount: value };
  }
  switch (change.action) {
    case 'mark-ready':
    case 'convert-draft':
      return { ...next, isDraft: change.action === 'convert-draft' };
    case 'enable-auto-merge':
      return { ...next, autoMerge: base.autoMerge ?? { method: change.method } };
    case 'disable-auto-merge':
      return { ...next, autoMerge: null };
    case 'request-review':
      return { ...next, requestedReviewers: [...base.requestedReviewers, change.reviewer] };
    case 'submit-review': {
      // GitHub ends the reader's review request with the review. The queue row leaves Review requested at once.
      const requestedReviewers = base.requestedReviewers.filter((login) => !same(login, patch.viewer.login));
      const role = (base as { role?: string }).role;
      const member =
        role === 'review-requested'
          ? { role: same((base as { author?: string }).author, patch.viewer.login) ? 'author' : 'watched' }
          : {};
      return { ...next, requestedReviewers, ...member };
    }
    default:
      return next;
  }
}

export function applyToSignals(patch: OptimisticPatch, base: QueueSignals): QueueSignals {
  const { change, before } = patch;
  const delta = signalCommentDelta(change);
  let next = base;
  if (delta && before.comments !== undefined) {
    const target = Math.max(0, before.comments + delta);
    const comments = delta > 0 ? Math.max(base.comments, target) : Math.min(base.comments, target);
    if (comments !== base.comments) next = { ...next, comments };
  }
  // New threads count as unresolved, as GitHub counts them. They are the reader's, so they never await a reply.
  const added = newThreadIds(patch);
  if (added.length && base.threads) {
    const unresolved = [...base.threads.unresolved, ...added.filter((id) => !base.threads?.unresolved.includes(id))];
    next = { ...next, threads: { ...base.threads, unresolved } };
  }
  switch (change.action) {
    case 'submit-review': {
      const state = reviewState(change.event);
      const decision =
        change.event === 'APPROVE' ? 'APPROVED' : change.event === 'REQUEST_CHANGES' ? 'CHANGES_REQUESTED' : undefined;
      const review = {
        url: patch.result?.reviewUrl ?? '',
        author: patch.viewer.login,
        state,
        submittedAt: isoAt(patch.startedAt),
        headSha: change.headSha ?? base.headSha,
      };
      // An approval or a request for changes replaces the reader's earlier opinion, as in GitHub's latest opinions.
      const opinions = decision
        ? [...(base.opinions ?? []).filter((opinion) => !same(opinion.author, patch.viewer.login)), review]
        : base.opinions;
      return {
        ...next,
        latestReview: review,
        // The reader's own latest review: the PR is no longer "updated since your review" at this head.
        mine: review,
        ...(opinions ? { opinions } : {}),
        ...(base.readiness && decision ? { readiness: { ...base.readiness, reviewDecision: decision } } : {}),
      };
    }
    case 'mark-ready':
    case 'convert-draft':
      return base.readiness
        ? { ...next, readiness: { ...base.readiness, isDraft: change.action === 'convert-draft' } }
        : next;
    case 'thread-resolve':
    case 'thread-unresolve': {
      if (!base.threads) return next;
      const others = base.threads.unresolved.filter((id) => id !== change.threadId);
      const unresolved = change.action === 'thread-unresolve' ? [...others, change.threadId] : others;
      return { ...next, threads: { ...base.threads, unresolved } };
    }
    default:
      return next;
  }
}

// ── The layer ──

export interface OptimisticLayerOptions {
  now?: () => number;
  /** Unique patch ids. Tests pass a counter. */
  id?: () => string;
}
export interface OptimisticBegin {
  url: string;
  change: OptimisticChange;
  viewer: OptimisticViewer;
  before?: OptimisticPatch['before'];
}

export function createOptimisticLayer(options: OptimisticLayerOptions = {}) {
  const now = options.now ?? Date.now;
  let sequence = 0;
  const nextId = options.id ?? (() => `${now().toString(36)}-${++sequence}`);
  /** In the order the writes started, so later writes apply over earlier ones. */
  const patches = new Map<string, OptimisticPatch>();
  const byId = (id: string) => [...patches.values()].find((patch) => patch.id === id);
  const live = (url: string, kind: OptimisticKind) =>
    [...patches.values()].filter(
      (patch) => patch.url === url && !patch.settled.includes(kind) && optimisticKinds(patch.change).includes(kind)
    );
  const finished = (patch: OptimisticPatch) =>
    optimisticKinds(patch.change).every((kind) => patch.settled.includes(kind));

  const layer = {
    begin(input: OptimisticBegin): OptimisticPatch {
      const id = nextId();
      const key = optimisticKey(input.url, input.change, id);
      const patch: OptimisticPatch = {
        id,
        key,
        url: input.url,
        change: input.change,
        viewer: input.viewer,
        startedAt: now(),
        status: 'pending',
        before: input.before ?? {},
        settled: [],
      };
      // A newer write to the same target replaces the older one and moves to the end.
      patches.delete(key);
      patches.set(key, patch);
      return patch;
    },
    /** The write succeeded: keep showing the change, now with GitHub's objects, until a fresh read shows it. */
    confirm(id: string, result: OptimisticResult = {}): OptimisticPatch | undefined {
      const patch = byId(id);
      if (!patch) return undefined;
      patch.status = 'confirmed';
      patch.confirmedAt = now();
      patch.result = { ...patch.result, ...result };
      return patch;
    },
    /** The write failed: roll back. Returns the removed patch. */
    fail(id: string): OptimisticPatch | undefined {
      const patch = byId(id);
      if (patch) patches.delete(patch.key);
      return patch;
    },
    /**
     * A fresh copy of one kind arrived. Confirmed patches whose change it shows stop applying to that kind; patches
     * settled in every kind they touch are cleared. Pending patches are never settled: the write may still fail.
     * Returns whether any patch changed.
     */
    observe(url: string, kind: OptimisticKind, base: GitHubReviewThreads | PrMetadata | QueueSignals): boolean {
      let changed = false;
      for (const patch of live(url, kind)) {
        if (patch.status !== 'confirmed') continue;
        const seen =
          kind === 'discussion'
            ? seenInDiscussion(patch, base as GitHubReviewThreads)
            : kind === 'metadata'
              ? seenInMetadata(patch, base as PrMetadata)
              : seenInSignals(patch, base as QueueSignals);
        if (!seen) continue;
        patch.settled = [...patch.settled, kind];
        changed = true;
        if (finished(patch)) patches.delete(patch.key);
      }
      return changed;
    },
    /** Clears patches that outlived their write. Returns the PRs whose copies change. */
    expire(): string[] {
      const urls = new Set<string>();
      const at = now();
      for (const patch of [...patches.values()]) {
        const old =
          patch.status === 'confirmed'
            ? at - (patch.confirmedAt ?? patch.startedAt) > OPTIMISTIC_CONFIRMED_TTL_MS
            : at - patch.startedAt > OPTIMISTIC_PENDING_TTL_MS;
        if (!old) continue;
        patches.delete(patch.key);
        urls.add(patch.url);
      }
      return [...urls];
    },
    discussion(url: string, base: GitHubReviewThreads): GitHubReviewThreads {
      return live(url, 'discussion').reduce(
        (value, patch) => (seenInDiscussion(patch, value) ? value : applyToDiscussion(patch, value)),
        base
      );
    },
    /** One thread, such as the one a write returned, with the other writes to it still applied. */
    thread(url: string, thread: GitHubReviewThread): GitHubReviewThread {
      const value = layer.discussion(url, { headSha: '', baseSha: '', threads: [thread] });
      return value.threads.find((candidate) => candidate.id === thread.id) ?? thread;
    },
    metadata<T extends PrMetadata>(base: T): T {
      return live(base.url, 'metadata').reduce(
        (value, patch) => (seenInMetadata(patch, value) ? value : applyToMetadata(patch, value)),
        base
      );
    },
    signals(base: QueueSignals): QueueSignals {
      return live(base.url, 'signals').reduce(
        (value, patch) => (seenInSignals(patch, value) ? value : applyToSignals(patch, value)),
        base
      );
    },
    has: (url: string) => [...patches.values()].some((patch) => patch.url === url),
    list: (url?: string) => [...patches.values()].filter((patch) => !url || patch.url === url),
    clear() {
      patches.clear();
    },
  };
  return layer;
}
export type OptimisticLayer = ReturnType<typeof createOptimisticLayer>;

/** The renderer's view of one failed write, kept until the reader retries or dismisses it. */
export interface OptimisticFailure {
  key: string;
  url: string;
  action: OptimisticAction;
  /** Short, specific: what did not happen. */
  title: string;
  /** GitHub's reason. */
  detail: string;
  /** The text the reader typed, kept so nothing is lost. */
  body?: string;
}

/** What did not happen, in the reader's words. */
export function failureTitle(action: OptimisticAction): string {
  switch (action) {
    case 'review-comment':
      return 'Comment wasn’t posted. Your text is kept.';
    case 'thread-reply':
      return 'Reply wasn’t posted. Your text is kept.';
    case 'feedback-reply':
      return 'Reply wasn’t posted. Your text is kept.';
    case 'thread-resolve':
      return 'Thread wasn’t resolved.';
    case 'thread-unresolve':
      return 'Thread wasn’t reopened.';
    case 'comment-edit':
      return 'Changes weren’t saved. Your text is kept.';
    case 'comment-delete':
      return 'Comment wasn’t deleted.';
    case 'submit-review':
      return 'Review wasn’t submitted. Your review is kept.';
    case 'mark-ready':
      return 'PR wasn’t marked ready for review.';
    case 'convert-draft':
      return 'PR wasn’t converted to a draft.';
    case 'enable-auto-merge':
      return 'Auto-merge wasn’t turned on.';
    case 'disable-auto-merge':
      return 'Auto-merge wasn’t turned off.';
    case 'request-review':
      return 'Review wasn’t requested.';
  }
}

/** The change a PR action shows before GitHub answers. Merges and branch updates wait for GitHub. */
export function prActionChange(kind: string, method?: string): OptimisticChange | undefined {
  if (kind === 'mark-ready' || kind === 'convert-draft') return { action: kind };
  if (kind === 'enable-auto') return { action: 'enable-auto-merge', method: method ?? 'MERGE' };
  if (kind === 'disable-auto') return { action: 'disable-auto-merge' };
  return undefined;
}
/** The PR action state with a draft or auto-merge change applied. */
export function applyToActionState<
  T extends { isDraft: boolean; autoMerge: string | null; canEnableAuto: boolean; canDisableAuto: boolean },
>(state: T, change: OptimisticChange): T {
  switch (change.action) {
    case 'mark-ready':
    case 'convert-draft':
      return { ...state, isDraft: change.action === 'convert-draft' };
    case 'enable-auto-merge':
      return {
        ...state,
        autoMerge: (state.autoMerge ?? change.method) as T['autoMerge'],
        canDisableAuto: true,
        canEnableAuto: false,
      };
    case 'disable-auto-merge':
      return { ...state, autoMerge: null, canEnableAuto: state.canEnableAuto || state.canDisableAuto };
    default:
      return state;
  }
}
