import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commentEvent, mentions, quoteText, withChangeRequest, reviewUrlOf, COMMENT_READS_PER_POLL, type CommentEventInput } from '../lib/notification-comments';
import { planNotifications } from '../lib/github-change-signals';
import type { FeedbackReview, GitHubReviewComment, GitHubReviewThread } from '../lib/review-threads';
import type { NotificationEvent } from '../lib/notification-events';
import { T0 } from './notification-fixtures';

const ME = 'oddur';
const URL = 'https://github.com/acme/app/pull/7';
const iso = (ms: number) => new Date(ms).toISOString();
let ids = 0;
const comment = (author: string | null, body: string, at = T0 + 60_000, extra: Partial<GitHubReviewComment> = {}): GitHubReviewComment => ({
  id: `C_${++ids}`,
  body,
  createdAt: iso(at),
  url: `${URL}#discussion_r${ids}`,
  author: author === null ? null : { login: author, avatarUrl: '', ...(author.endsWith('[bot]') ? { __typename: 'Bot' } : {}) },
  ...extra,
});
const thread = (comments: GitHubReviewComment[], id = `PRRT_${++ids}`): GitHubReviewThread => ({
  id,
  path: 'src/retry.ts',
  line: 4,
  startLine: null,
  diffSide: 'RIGHT',
  isResolved: false,
  isOutdated: false,
  viewerCanResolve: true,
  viewerCanUnresolve: false,
  comments,
});
const feedback = (comments: GitHubReviewComment[] = [], reviews: FeedbackReview[] = []) => ({
  comments,
  reviews,
  requestedReviewers: [],
  viewerCanUpdate: true,
  state: 'OPEN',
});
const input = (discussion: CommentEventInput['discussion'], extra: Partial<CommentEventInput> = {}): CommentEventInput => ({
  discussion,
  pr: { url: URL, title: 'Fix retry backoff', repo: 'acme/app', number: 7, author: 'lena' },
  login: ME,
  reason: 'comment',
  since: T0,
  now: T0 + 120_000,
  ...extra,
});

void test('feed reasons: threads you take part in on known PRs ask for one discussion read, newest first and bounded', () => {
  const api = (n: number) => `https://api.github.com/repos/acme/app/pulls/${n}`;
  const row = (n: number, reason: string, at: number) => ({ id: `t${n}${reason}`, reason, updated_at: iso(at), subject: { type: 'PullRequest', url: api(n) } });
  const threads = [
    row(1, 'mention', T0 + 1000),
    row(2, 'team_mention', T0 + 2000),
    row(3, 'author', T0 + 3000),
    row(4, 'comment', T0 + 4000),
    row(5, 'subscribed', T0 + 5000),
    row(6, 'review_requested', T0 + 6000),
    row(8, 'mention', T0 - 1000),
    row(9, 'mention', T0 + 9000),
  ];
  const known = (url: string) => !url.endsWith('/9');
  assert.deepEqual(planNotifications(threads, undefined, known).comments, [], 'the first page only sets the cursor');
  const plan = planNotifications(threads, T0, known);
  const urls = plan.comments.map((c) => c.url.split('/').at(-1));
  assert.deepEqual(urls, ['6', '4', '3', '2', '1'].slice(0, COMMENT_READS_PER_POLL), 'watching a repository is not taking part; old and unknown threads cost nothing');
  assert.ok(plan.comments.every((c) => c.since === T0));
  assert.equal(plan.comments.find((c) => c.url.endsWith('/2'))?.reason, 'team_mention');
});

void test('a mention anywhere is a mention; the notification quotes it and lands on its thread', () => {
  const inline = thread([comment('maya', 'Looks off'), comment('lena', '@oddur The retry loop never backs off')]);
  const event = commentEvent(input({ threads: [inline], feedback: feedback() }, { pr: { url: URL, title: 'Fix retry backoff', repo: 'acme/app', number: 7, author: 'maya' } }));
  assert.equal(event?.type, 'mention');
  assert.equal(event?.actor, 'lena');
  assert.equal(event?.quote, '@oddur The retry loop never backs off');
  assert.deepEqual(event?.target, { kind: 'pr', pr: { host: 'github.com', owner: 'acme', repo: 'app', number: 7 }, tab: 'feedback', threadId: inline.id });
  assert.deepEqual(event?.reply, { kind: 'thread', prUrl: URL, threadId: inline.id, to: 'lena' });
  assert.equal(event?.key, `comment|${URL}|${inline.comments[1].id}`);
});

void test('a reply: a new comment in a review thread you started or wrote in', () => {
  const mine = thread([comment('maya', 'Why a loop?', T0 - 5000), comment(ME, 'To retry', T0 - 4000), comment('maya', 'It never backs off')]);
  const event = commentEvent(input({ threads: [mine], feedback: feedback() }, { pr: { url: URL, title: 'T', repo: 'acme/app', number: 7, author: 'lena' } }));
  assert.equal(event?.type, 'reply');
  assert.equal(event?.actor, 'maya');
  assert.equal(event?.quote, 'It never backs off');
});

void test('on someone else\'s PR, threads you are not in and top-level comments without a mention are not about you', () => {
  const notMine = thread([comment('maya', 'Nit', T0 - 5000), comment('lena', 'Fixed')]);
  const top = comment('maya', 'Ship it when green');
  assert.equal(commentEvent(input({ threads: [notMine], feedback: feedback([top]) })), undefined);
  // Your own earlier comment in the conversation does not make a top-level comment a reply.
  assert.equal(commentEvent(input({ threads: [], feedback: feedback([comment(ME, 'Ready?', T0 - 9000), top]) })), undefined);
});

void test('on your own PR, any new comment from someone else is a reply, inline or in the conversation', () => {
  const own = { url: URL, title: 'Fix retry backoff', repo: 'acme/app', number: 7, author: ME };
  const top = comment('lena', 'The **retry loop** never backs off. See [docs](https://example.com).');
  const event = commentEvent(input({ threads: [], feedback: feedback([top]) }, { pr: own }));
  assert.equal(event?.type, 'reply');
  assert.equal(event?.quote, 'The retry loop never backs off. See docs.');
  assert.deepEqual(event?.reply, { kind: 'feedback', prUrl: URL, sourceId: top.id, to: 'lena' });
  assert.equal(event?.target?.kind === 'pr' && event.target.threadId, top.id);
  const inline = thread([comment('maya', 'Rename this')]);
  assert.equal(commentEvent(input({ threads: [inline], feedback: feedback() }, { pr: own }))?.reply?.kind, 'thread');
});

void test('own comments, bots, hidden, pending and old comments never notify', () => {
  const own = { url: URL, title: 'T', repo: 'acme/app', number: 7, author: ME };
  const discussion = {
    threads: [],
    feedback: feedback([
      comment(ME, '@oddur note to self'),
      comment('coderabbitai[bot]', 'Summary for @oddur'),
      comment('github-actions', 'Deployed'),
      comment('maya', 'spam', T0 + 60_000, { isMinimized: true }),
      comment('maya', 'draft', T0 + 60_000, { pullRequestReview: { id: 'R', state: 'PENDING' } }),
      comment('maya', 'sending', T0 + 60_000, { sending: true }),
      comment('maya', 'Before the cursor', T0 - 1),
      comment(null, 'ghost'),
    ]),
  };
  assert.equal(commentEvent(input(discussion, { pr: own })), undefined);
  // Part 1's allow list can let a bot through.
  assert.equal(commentEvent(input(discussion, { pr: own, allowBot: (login) => login === 'coderabbitai[bot]' }))?.actor, 'coderabbitai[bot]');
});

void test('the newest mention wins over a newer reply; otherwise the newest reply', () => {
  const own = { url: URL, title: 'T', repo: 'acme/app', number: 7, author: ME };
  const mention = comment('lena', 'cc @oddur', T0 + 10_000);
  const later = comment('maya', 'Also this', T0 + 20_000);
  assert.equal(commentEvent(input({ threads: [], feedback: feedback([mention, later]) }, { pr: own }))?.actor, 'lena');
  const a = comment('maya', 'first', T0 + 10_000);
  const b = comment('lena', 'second', T0 + 20_000);
  assert.equal(commentEvent(input({ threads: [], feedback: feedback([b, a]) }, { pr: own }))?.actor, 'lena');
});

void test('mentions: whole logins, not emails, longer names, teams or code; team mentions with the feed reason', () => {
  assert.equal(mentions('Thanks @oddur!', ME), true);
  assert.equal(mentions('@ODDUR please', ME), true);
  assert.equal(mentions('mail oddur@example.com', ME), false);
  assert.equal(mentions('@oddurs or @oddur-bot', ME), false);
  assert.equal(mentions('@oddur/team', ME), false);
  assert.equal(mentions('```\n@oddur\n```', ME), false);
  assert.equal(mentions('`@oddur`', ME), false);
  const team = comment('lena', '@acme/reviewers please look');
  assert.equal(commentEvent(input({ threads: [], feedback: feedback([team]) }))?.type, undefined);
  assert.equal(commentEvent(input({ threads: [], feedback: feedback([team]) }, { reason: 'team_mention' }))?.type, 'mention');
});

void test('quotes leave out code, quoted replies, images, markup and links', () => {
  assert.equal(quoteText('> earlier words\nThe retry loop never backs off'), 'The retry loop never backs off');
  assert.equal(quoteText('```suggestion\nretry()\n```'), undefined);
  assert.equal(quoteText('## Heading\n- item with `code` and ![img](x.png) <b>bold</b>'), 'Heading item with code and bold');
  assert.equal(quoteText('a <!-- hidden --> b & c'), 'a b c');
  assert.equal(quoteText('See https://example.com/x for _why_'), 'See for why');
});

void test('a change request quotes the review and replies on its thread; one with only inline comments answers its first thread', () => {
  const url = 'https://github.com/acme/app/pull/7#pullrequestreview-1';
  const base: NotificationEvent = { type: 'changes-requested', key: `review|${url}`, title: 'Fix retry backoff', url: URL, repo: 'acme/app', number: 7, actor: 'lena', at: T0 };
  assert.equal(reviewUrlOf(base), url);
  const review: FeedbackReview = { ...comment('lena', 'The retry loop never backs off'), id: 'PRR_1', url, state: 'CHANGES_REQUESTED', submittedAt: iso(T0) };
  const withBody = withChangeRequest(base, { threads: [], feedback: feedback([], [review]) });
  assert.equal(withBody.quote, 'The retry loop never backs off');
  assert.deepEqual(withBody.reply, { kind: 'feedback', prUrl: URL, sourceId: 'PRR_1', to: 'lena' });
  assert.equal(withBody.target?.kind === 'pr' && withBody.target.threadId, 'PRR_1');
  const inline = thread([comment('lena', 'Back off here', T0, { pullRequestReview: { id: 'PRR_1', state: 'CHANGES_REQUESTED' } })]);
  const onlyInline = withChangeRequest(base, { threads: [inline], feedback: feedback([], [{ ...review, body: '' }]) });
  assert.equal(onlyInline.quote, 'Back off here');
  assert.deepEqual(onlyInline.reply, { kind: 'thread', prUrl: URL, threadId: inline.id, to: 'lena' });
  assert.equal(withChangeRequest(base, undefined), base, 'without the saved discussion the event is unchanged');
});
