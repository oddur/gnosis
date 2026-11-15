import type { QueueSignals } from './queue-signals';
import { isPendingComment, type GitHubReviewThread, type GitHubReviewThreads } from './review-threads';
import type { ReviewMember } from './workbench';
import { isAutomationActor, sameLogin } from './github-actors';

export interface ResponseNeeded {
  changesRequested: boolean;
  /** GitHub's count of unresolved conversations, outdated ones included. */
  unresolvedThreads: number;
  /** Unresolved threads whose last visible human comment is from someone else. */
  awaitingReply: number;
  /** False means absence of feedback has not yet been confirmed. */
  complete: boolean;
}

/**
 * GitHub's unresolved conversation: not resolved, with at least one submitted comment. Outdated and
 * automation threads count, as in GitHub's "N unresolved conversations". A thread that holds only your
 * pending (unsubmitted) comments does not exist for anyone else yet.
 */
export const isUnresolvedThread = (thread: GitHubReviewThread) =>
  !thread.isResolved && thread.comments.some((comment) => !isPendingComment(comment));

/**
 * The thread waits for your reply: it is unresolved, you are involved (you wrote the PR or the thread),
 * and its last submitted, visible comment by a person is from someone else. Bot comments and hidden
 * comments neither ask for nor give a reply.
 */
export function isResponseThread(thread: GitHubReviewThread, account: string, prAuthor: string) {
  if (!isUnresolvedThread(thread)) return false;
  const human = thread.comments.filter(
    (comment) => !isPendingComment(comment) && !comment.isMinimized && !isAutomationActor(comment.author)
  );
  const last = human.at(-1);
  if (!last || sameLogin(last.author?.login, account)) return false;
  return sameLogin(prAuthor, account) || human.some((comment) => sameLogin(comment.author?.login, account));
}

/** Comments do not supersede a review decision; approval or dismissal does. */
export function changesRequestedReviews(discussion: GitHubReviewThreads, account?: string) {
  const latest = new Map<string, NonNullable<GitHubReviewThreads['feedback']>['reviews'][number]>();
  for (const review of discussion.feedback?.reviews ?? []) {
    const login = review.author?.login.toLowerCase();
    if (
      !login ||
      login === account?.toLowerCase() ||
      !['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(review.state)
    )
      continue;
    const previous = latest.get(login);
    if (!previous || (review.submittedAt ?? review.createdAt) >= (previous.submittedAt ?? previous.createdAt))
      latest.set(login, review);
  }
  return [...latest.values()].filter((review) => review.state === 'CHANGES_REQUESTED');
}

/**
 * Signals newer than the saved discussion carry the current unresolved thread ids: resolving a thread on
 * github.com adds no comment or review, so nothing else tells the queue to read the discussion again.
 */
function currentThreads(threads: GitHubReviewThread[], signals?: QueueSignals, discussion?: GitHubReviewThreads) {
  const live = signals?.threads;
  if (!live || signals.checkedAt <= (discussion?.checkedAt ?? 0)) return { threads, unknown: 0 };
  const unresolved = new Set(live.unresolved);
  const known = new Set(threads.map((thread) => thread.id));
  return {
    threads: threads.map((thread) =>
      unresolved.has(thread.id)
        ? { ...thread, isResolved: false }
        : live.complete && !thread.isResolved
          ? { ...thread, isResolved: true }
          : thread
    ),
    // Threads started after the discussion was saved. Their authors are unknown until it is read again.
    unknown: live.unresolved.filter((id) => !known.has(id)).length,
  };
}

/** Local evidence only. Unresolved feedback survives new commits until explicitly resolved. */
export function responseNeeded(
  member: ReviewMember,
  account: string,
  signals?: QueueSignals,
  discussion?: GitHubReviewThreads
): ResponseNeeded {
  const empty = { changesRequested: false, unresolvedThreads: 0, awaitingReply: 0, complete: true };
  if (member.state !== 'open' || member.merged || member.author.toLowerCase() !== account.toLowerCase()) return empty;
  const currentSignals = signals?.headSha === member.headSha ? signals : undefined;
  const decision = currentSignals?.readiness?.reviewDecision;
  // A newer discussion read can contain a resolution before the next signals refresh.
  const useDecision = decision && (!discussion?.feedback || currentSignals.checkedAt >= (discussion.checkedAt ?? 0));
  const { threads, unknown } = currentThreads(discussion?.threads ?? [], currentSignals, discussion);
  return {
    changesRequested: useDecision
      ? decision === 'CHANGES_REQUESTED'
      : !!discussion && changesRequestedReviews(discussion, account).length > 0,
    unresolvedThreads: threads.filter(isUnresolvedThread).length + unknown,
    awaitingReply: threads.filter((thread) => isResponseThread(thread, account, member.author)).length,
    complete: !!discussion?.feedback && !discussion.stale && !unknown && discussion.headSha === member.headSha,
  };
}

export const needsResponse = (value?: ResponseNeeded) =>
  !!value && (value.changesRequested || value.awaitingReply > 0);
export const awaitingReplyLabel = (count: number) =>
  `${count} ${count === 1 ? 'thread awaits' : 'threads await'} your reply`;
export function responseNeededLabel(value: ResponseNeeded) {
  return [
    value.changesRequested ? 'Changes requested' : '',
    value.awaitingReply ? awaitingReplyLabel(value.awaitingReply) : '',
  ]
    .filter(Boolean)
    .join(' · ');
}
/** A conversation still open on the current diff: unresolved and not outdated. */
export const isOpenOnCurrentDiff = (thread: GitHubReviewThread) => isUnresolvedThread(thread) && !thread.isOutdated;
/**
 * The Changes file tree count: submitted comments, replies included, in conversations open on the current
 * diff. Resolved and outdated threads are read in Feedback.
 */
export function openDiffComments(threads: GitHubReviewThread[] | undefined) {
  return threads
    ?.filter(isOpenOnCurrentDiff)
    .reduce((total, thread) => total + thread.comments.filter((comment) => !isPendingComment(comment)).length, 0);
}
