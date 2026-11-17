/**
 * Mentions and replies (#385 part 2). The notifications feed says that a PR thread changed and why (`reason`).
 * Gnosis then reads the PR's discussion once, through the review-thread cache, and this module picks the newest
 * comment that is about the reader: a mention, a new comment in a review thread the reader started or wrote in, or
 * a new comment from someone else on the reader's own PR. Top-level comments on other people's PRs count only when
 * they mention the reader. Pure, so detection, quoting and targets are tested without GitHub.
 */
import { isAutomationActor, sameLogin, type GitHubActor } from './github-actors';
import { prRef, type DeepLinkTarget } from './deep-link';
import type { NotificationEvent, NotificationReplyTarget } from './notification-events';
import { isPendingComment, type GitHubReviewComment, type GitHubReviewThread, type GitHubReviewThreads } from './review-threads';

/** Feed reasons for PR threads the reader takes part in. Watching a repository (`subscribed`, `manual`) is not enough. */
export const COMMENT_REASONS: ReadonlySet<string> = new Set(['mention', 'team_mention', 'author', 'comment', 'review_requested', 'assign']);
/** At most this many discussions are read for one page of the feed. The rest stay unread in the queue. */
export const COMMENT_READS_PER_POLL = 5;

/** One PR thread of the feed that may hold a mention or a reply. */
export interface CommentCandidate {
  url: string;
  reason: string;
  /** The feed cursor before this page: comments created after it are new. */
  since: number;
  updatedAt: number;
}

/** The PR a comment event is about, from the saved queue copy. */
export interface CommentPr {
  url: string;
  title: string;
  repo: string;
  number: number;
  author: string;
}
export interface CommentEventInput {
  discussion: Pick<GitHubReviewThreads, 'threads' | 'feedback'>;
  pr: CommentPr;
  login: string;
  /** The feed reason, such as `mention` or `team_mention`. */
  reason: string;
  /** Epoch milliseconds: only comments created after this are new. */
  since: number;
  now: number;
  /** Bots never notify unless allowed here: "Also notify for these bots" (`botAllowed`). */
  allowBot?: (login: string) => boolean;
}

interface Entry {
  comment: GitHubReviewComment;
  thread?: GitHubReviewThread;
  /** Earlier comments of the same review thread. */
  before: GitHubReviewComment[];
}
const CODE_BLOCK = /```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g;
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** `@login` as GitHub links it: not inside an email address or a longer name, and not in code. */
export function mentions(body: string, login: string): boolean {
  if (!login) return false;
  const text = body.replace(CODE_BLOCK, ' ').replace(/`[^`\n]*`/g, ' ');
  return new RegExp(`(^|[^\\w@/.-])@${escape(login)}(?![\\w-]|/[\\w])`, 'i').test(text);
}
/** A team mention, `@org/team`. The feed's `team_mention` reason says the reader is in that team. */
const mentionsTeam = (body: string) => /(^|[^\w@/.-])@[A-Za-z0-9][\w-]*\/[\w-]+/.test(body.replace(CODE_BLOCK, ' ').replace(/`[^`\n]*`/g, ' '));

/**
 * The words of a comment worth quoting in a notification: no code, quoted replies, images, markup or links,
 * whitespace collapsed. Undefined when nothing is left, such as a comment that is only a code suggestion.
 */
export function quoteText(body: string): string | undefined {
  const text = body
    .replace(/<!--[\s\S]*?(?:-->|$)/g, ' ')
    .replace(CODE_BLOCK, ' ')
    .split('\n')
    .filter((line) => !/^\s*>/.test(line))
    .join('\n')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]*>/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/^\s{0,3}(?:#{1,6}\s+|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/gm, '')
    .replace(/(\*\*|__|~~)(.+?)\1/g, '$2')
    .replace(/(^|\W)[*_](\S(?:.*?\S)?)[*_](?=\W|$)/g, '$1$2')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[<>&]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text || undefined;
}

const bot = (actor: GitHubActor | null, allow?: (login: string) => boolean) => !!actor && isAutomationActor(actor) && !allow?.(actor.login);
const time = (comment: GitHubReviewComment) => Date.parse(comment.createdAt);

/** Every comment of a discussion, with its review thread and the thread's earlier comments. */
function entries(discussion: CommentEventInput['discussion']): Entry[] {
  const list: Entry[] = [];
  for (const thread of discussion.threads)
    thread.comments.forEach((comment, index) => list.push({ comment, thread, before: thread.comments.slice(0, index) }));
  for (const comment of discussion.feedback?.comments ?? []) list.push({ comment, before: [] });
  // A review's own text is conversation feedback. Approvals and change requests have events of their own.
  for (const review of discussion.feedback?.reviews ?? [])
    if (review.state === 'COMMENTED' && review.body.trim()) list.push({ comment: review, before: [] });
  return list;
}

/** Where a click and a reply land for one comment: its review thread, or the conversation item itself. */
function places(entry: Entry, pr: CommentPr): { target?: DeepLinkTarget; reply: NotificationReplyTarget } {
  const ref = prRef(pr.url);
  const to = entry.comment.author?.login ?? '';
  const threadId = entry.thread?.id ?? entry.comment.id;
  return {
    ...(ref ? { target: { kind: 'pr', pr: ref, tab: 'feedback', threadId } } : {}),
    reply: entry.thread
      ? { kind: 'thread', prUrl: pr.url, threadId: entry.thread.id, to }
      : { kind: 'feedback', prUrl: pr.url, sourceId: entry.comment.id, to },
  };
}

/**
 * The one event for a changed PR thread: the newest mention, or else the newest reply to the reader. Undefined
 * when no new comment is about the reader. Own comments, bots, hidden comments, pending review comments and
 * comments not yet confirmed by GitHub never count.
 */
export function commentEvent(input: CommentEventInput): NotificationEvent | undefined {
  const { pr, login } = input;
  const own = sameLogin(pr.author, login);
  const fresh = entries(input.discussion).filter(({ comment }) => {
    const at = time(comment);
    return (
      Number.isFinite(at) &&
      at > input.since &&
      !!comment.author &&
      !sameLogin(comment.author.login, login) &&
      !bot(comment.author, input.allowBot) &&
      !comment.isMinimized &&
      !comment.sending &&
      !isPendingComment(comment)
    );
  });
  const mentioned = (entry: Entry) =>
    mentions(entry.comment.body, login) || (input.reason === 'team_mention' && mentionsTeam(entry.comment.body));
  // A thread the reader started or wrote in; on the reader's own PR, any comment from someone else.
  const replied = (entry: Entry) => (!!entry.thread && entry.before.some((c) => sameLogin(c.author?.login, login))) || own;
  const newest = (list: Entry[]) => [...list].sort((a, b) => time(b.comment) - time(a.comment)).at(0);
  const mention = newest(fresh.filter(mentioned));
  const reply = mention ? undefined : newest(fresh.filter(replied));
  const entry = mention ?? reply;
  if (!entry?.comment.author) return undefined;
  const quote = quoteText(entry.comment.body);
  const { target, reply: replyTarget } = places(entry, pr);
  return {
    type: mention ? 'mention' : 'reply',
    key: `comment|${pr.url}|${entry.comment.id}`,
    title: pr.title,
    url: pr.url,
    repo: pr.repo,
    number: pr.number,
    actor: entry.comment.author.login,
    ...(isAutomationActor(entry.comment.author) ? { actorIsBot: true } : {}),
    ...(own ? { mine: true } : {}),
    at: input.now,
    ...(target ? { target } : {}),
    ...(quote ? { quote } : {}),
    reply: replyTarget,
  };
}

/** The review URL of a "Changes requested" event, from its idempotency key `review|<url>`. */
export const reviewUrlOf = (event: Pick<NotificationEvent, 'type' | 'key'>) =>
  event.type === 'changes-requested' && event.key.startsWith('review|') ? event.key.slice('review|'.length) : undefined;

/**
 * A "Changes requested" event with the review's words, its thread as the click target and its reply target.
 * The review's own text is answered in the conversation; a review with only inline comments is answered on its
 * first thread. Unchanged when the saved discussion does not hold the review.
 */
export function withChangeRequest(event: NotificationEvent, discussion: Pick<GitHubReviewThreads, 'threads' | 'feedback'> | undefined): NotificationEvent {
  const url = reviewUrlOf(event);
  const review = url ? discussion?.feedback?.reviews.find((r) => r.url === url) : undefined;
  if (!review || !event.url || !review.author) return event;
  const pr: CommentPr = { url: event.url, title: event.title, repo: event.repo ?? '', number: event.number ?? 0, author: '' };
  const thread = review.body.trim()
    ? undefined
    : discussion?.threads.find((t) => t.comments[0]?.pullRequestReview?.id === review.id);
  const entry: Entry = thread ? { comment: thread.comments[0], thread, before: [] } : { comment: review, before: [] };
  const quote = quoteText(entry.comment.body);
  const { target, reply } = places({ ...entry, comment: { ...entry.comment, author: review.author } }, pr);
  return { ...event, ...(quote ? { quote } : {}), ...(target ? { target } : {}), reply };
}
