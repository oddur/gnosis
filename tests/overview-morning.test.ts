import { test } from 'node:test';
import assert from 'node:assert/strict';
import { overviewModel, type OverviewModel } from '../lib/overview';
import {
  MOVE_LIMIT,
  SMALL_REVIEW_LINES,
  closeConfirmation,
  closeRequest,
  effortLabel,
  moveEffort,
  moveForward,
  moveMinutes,
  morningCount,
  needsDecision,
  nudgeConfirmation,
  nudgeRequests,
  quote,
  waitingOnOthers,
  waitingOnYou,
} from '../lib/morning';
import { appendSinceEvents, parseSinceEvent, sinceEventsFromNotifications, sinceLabel, sinceLine, sinceSummary, SINCE_LOG_LIMIT, SINCE_LOG_MAX_AGE_MS, type SinceEvent } from '../lib/since-log';
import { parseRereviewTargets, rereviewCompare, rereviewSize, REREVIEW_LIMIT } from '../lib/rereview-lines';
import { reviewedCommit, waitingReply } from '../lib/use-morning';
import { closeBlockedReason, type PrActionState } from '../lib/pr-actions';
import type { QueueItem, ReviewMember } from '../lib/workbench';
import type { QueueSignals } from '../lib/queue-signals';
import type { NotificationEvent } from '../lib/notification-events';
import type { GitHubReviewThreads } from '../lib/review-threads';
import { LOGIN, T0, member, mine, signals, readySignals } from './notification-fixtures';

const DAY = 86_400_000;
const iso = (ago: number) => new Date(T0 - ago).toISOString();
const item = (members: ReviewMember[], extra: Partial<QueueItem> = {}): QueueItem => ({
  subject: {
    id: members.length > 1 ? `stack-${members[0].number}` : members[0].url,
    kind: members.length > 1 ? 'stack' : 'pr',
    title: members.length > 1 ? `Stack ${members[0].number}` : members[0].title,
    members,
    edges: members.slice(1).map((child, i) => ({ parent: members[i].url, child: child.url, evidence: 'branch' as const })),
    warnings: [],
  },
  attention: 'other',
  ...extra,
});
const build = (items: QueueItem[], status: Record<string, QueueSignals>, now = T0): OverviewModel =>
  overviewModel({ items, signals: (m) => status[m.url], login: LOGIN, now });
const input = (model: OverviewModel, status: Record<string, QueueSignals>, extra: Partial<Parameters<typeof moveForward>[0]> = {}) => ({
  model,
  now: T0,
  login: LOGIN,
  signals: (m: ReviewMember) => status[m.url],
  ...extra,
});

void test('quick wins: merges first, then replies, re-reviews and small reviews by effort, capped, with a total', () => {
  const ready = mine(1, { updatedAt: iso(DAY) });
  const pending = mine(2, { updatedAt: iso(DAY) });
  const replied = mine(3);
  const rereview = member(4, { requestedReviewers: [LOGIN], additions: 400, deletions: 100 });
  const small = member(5, { requestedReviewers: [LOGIN], additions: 30, deletions: 10, author: 'sam' });
  const large = member(6, { requestedReviewers: [LOGIN], additions: 500, deletions: 200, author: 'maya' });
  const explained = member(7, { requestedReviewers: [LOGIN], additions: 250, deletions: 50, author: 'lena' });
  const extra = Array.from({ length: 6 }, (_, i) => member(20 + i, { requestedReviewers: [LOGIN], additions: 10, deletions: 0, createdAt: iso((10 - i) * DAY) }));
  const status: Record<string, QueueSignals> = {
    [ready.url]: { ...readySignals(ready), opinions: [{ url: 'r1', author: 'lena', state: 'APPROVED', submittedAt: iso(DAY), headSha: ready.headSha }] },
    // Approved and mergeable, but checks still running: not a quick win yet.
    [pending.url]: { ...readySignals(pending), checks: { state: 'pending', passed: 0, total: 1 } },
    [replied.url]: signals(replied, { checks: 'success' }),
  };
  const items = [
    item([ready]),
    item([pending]),
    item([replied], { responses: { [replied.url]: { changesRequested: false, unresolvedThreads: 1, awaitingReply: 1, complete: true } } }),
    item([rereview], { attention: 'updated' }),
    item([small]),
    item([large]),
    item([explained], { review: { id: 'x', prUrl: explained.url, prTitle: 'x', status: 'completed', unread: false, explanation: { url: explained.url } } as never }),
    ...extra.map((pr) => item([pr])),
  ];
  const model = build(items, status);
  const all = moveForward(input(model, status, {
    rereviewLines: { [rereview.url]: 120 },
    replies: { [replied.url]: { author: 'owen', text: 'Could we keep the old loading order behind a flag until every plugin has migrated?' } },
  }));
  assert.equal(all.length, MOVE_LIMIT, 'capped');
  assert.deepEqual(all.slice(0, 2).map((entry) => [entry.kind, entry.row.focus.number, entry.why, entry.minutes]), [
    ['merge', 1, 'approved by lena · green', 1],
    ['reply', 3, 'owen: “Could we keep the old loading order behind a flag until…”', 3],
  ]);
  // Sorted by minutes, then the longest waiting.
  for (let i = 1; i < all.length; i++) assert.ok(all[i - 1].minutes <= all[i].minutes, 'cheapest first');
  assert.ok(!all.some((entry) => entry.row.focus.number === 2), 'checks still running are not a quick win');
  assert.ok(!all.some((entry) => entry.row.focus.number === 6), `a review over ${SMALL_REVIEW_LINES} lines is not quick`);
  // Without the cap: the re-review names the lines since your review; an explanation lets a larger review count.
  const uncapped = moveForward(input(build(items.filter((entry) => !extra.some((pr) => pr.url === entry.subject.members[0].url)), status), status, { rereviewLines: { [rereview.url]: 120 } }));
  const byNumber = Object.fromEntries(uncapped.map((entry) => [entry.row.focus.number, entry]));
  assert.equal(byNumber[4].why, '+120 lines since your review');
  assert.equal(byNumber[4].minutes, 5);
  assert.equal(byNumber[5].why, '40 lines');
  assert.equal(byNumber[3].why, 'Someone is waiting on your reply', 'without the saved thread, who is waiting');
  assert.equal(moveMinutes(uncapped), uncapped.reduce((total, entry) => total + entry.minutes, 0));
});

void test('the effort heuristic and its labels', () => {
  assert.equal(moveEffort('merge', undefined), 1);
  assert.equal(moveEffort('reply', undefined), 3);
  assert.equal(moveEffort('rereview', undefined), 5, 'unknown size');
  assert.equal(moveEffort('rereview', 120), 5);
  assert.equal(moveEffort('review', 40), 4);
  assert.equal(moveEffort('review', 300, true), 7, 'an explanation takes a third off');
  assert.equal(effortLabel(9), '~9 min');
  assert.equal(effortLabel(80), '~1 h 20 min');
  assert.equal(effortLabel(60), '~1 h');
  assert.equal(quote('Short and `plain`.'), 'Short and plain.');
  assert.ok(quote('x '.repeat(100)).endsWith('…'));
  assert.ok(quote('word '.repeat(40)).length <= 61);
});

void test('waiting on you groups people by their oldest wait, and team requests last', () => {
  const lena1 = member(1, { author: 'lena', requestedReviewers: [LOGIN], createdAt: iso(2 * DAY) });
  const lena2 = member(2, { author: 'lena', requestedReviewers: [LOGIN], createdAt: iso(4 * DAY) });
  const sam = member(3, { author: 'sam', requestedReviewers: [LOGIN], createdAt: iso(DAY) });
  const team = member(4, { author: 'maya', role: 'review-requested', createdAt: iso(3 * DAY) });
  const replied = mine(5);
  const model = overviewModel({
    items: [item([lena1]), item([lena2]), item([sam]), item([team]), item([replied], { responses: { [replied.url]: { changesRequested: false, unresolvedThreads: 1, awaitingReply: 1, complete: true } } })],
    signals: (m) => (m.url === replied.url ? { ...signals(replied, { checks: 'success' }), activity: { recent: [{ kind: 'comment', id: 'c', at: iso(5 * DAY), author: 'owen', automated: false }] } } : undefined),
    login: LOGIN,
    now: T0,
    teamRequests: true,
  });
  const groups = waitingOnYou({ model, now: T0, login: LOGIN });
  assert.deepEqual(groups.map((group) => [group.label, group.detail]), [
    ['owen', '1 PR · oldest 5 d'],
    ['lena', '2 PRs · oldest 4 d'],
    ['sam', '1 PR · oldest 1 d'],
    ['team', '1 review request'],
  ]);
  assert.deepEqual(groups[1].rows.map((row) => row.focus.number), [2, 1], 'oldest first');
  const move = moveForward(input(model, {}));
  assert.equal(morningCount(move, groups), 5, 'each PR once, across both sections');
});

void test('waiting on others groups your PRs by blocker: reviewers with Nudge, teams, CI, an open base, and you', () => {
  const lena = mine(1, { requestedReviewers: ['lena'], createdAt: iso(4 * DAY) });
  const both = mine(2, { requestedReviewers: ['lena', 'sam'], createdAt: iso(2 * DAY) });
  const team = mine(3, { requestedTeams: ['klang/web'], createdAt: iso(DAY) });
  const ci = mine(4);
  const base = mine(5, { headBranch: 'b1' });
  const top = mine(6, { baseBranch: 'b1' });
  const failing = mine(7);
  const conflict = mine(8);
  const status: Record<string, QueueSignals> = {
    [lena.url]: signals(lena, { checks: 'success' }),
    [both.url]: signals(both, { checks: 'success' }),
    [team.url]: signals(team, { checks: 'success' }),
    [ci.url]: signals(ci, { checks: 'pending', decision: 'APPROVED' }),
    [base.url]: signals(base, { checks: 'failure' }),
    [top.url]: readySignals(top),
    [failing.url]: signals(failing, { checks: 'failure' }),
    [conflict.url]: signals(conflict, { checks: 'success', mergeable: 'CONFLICTING', mergeState: 'DIRTY' }),
  };
  const model = build([item([lena]), item([both]), item([team]), item([ci]), item([base, top]), item([failing]), item([conflict])], status);
  const groups = waitingOnOthers({ model, now: T0, login: LOGIN });
  assert.deepEqual(groups.map((group) => [group.kind, group.label, group.detail]), [
    ['person', 'lena', '2 PRs · 4 d'],
    ['person', 'sam', '1 PR · 2 d'],
    ['team', 'klang/web', '1 PR · 1 d'],
    ['ci', 'CI', '1 running'],
    ['base', 'base #5', '1 PR · 1 h'],
    ['you', 'you', '2 failing checks, 1 conflict'],
  ]);
  assert.deepEqual(groups[0].nudge?.members.map((m) => m.number), [1, 2]);
  assert.equal(groups[2].nudge, undefined, 'teams are not nudged');
  // Nudge: one requested-reviewers write per PR, after a confirmation that names them.
  assert.deepEqual(nudgeRequests(groups[0]), [
    { prUrl: lena.url, action: 'nudge', reviewer: 'lena' },
    { prUrl: both.url, action: 'nudge', reviewer: 'lena' },
  ]);
  assert.deepEqual(nudgeConfirmation(groups[0]), {
    title: 'Nudge lena?',
    body: 'Gnosis asks GitHub to request lena’s review again on PRs #1, #2. GitHub notifies lena.',
    action: 'Re-request 2 reviews',
  });
  assert.equal(nudgeConfirmation(groups[1]).action, 'Re-request review');
  assert.deepEqual(nudgeRequests(groups[3]), []);
});

void test('needs a decision: failing, never approved or idle for over a week, one reason each, oldest first', () => {
  const failing = mine(1, { updatedAt: iso(9 * DAY) });
  const failingNew = mine(2, { updatedAt: iso(2 * DAY) });
  const unapproved = mine(3, { createdAt: iso(10 * DAY), updatedAt: iso(4 * DAY) });
  const idle = mine(4, { requestedReviewers: ['lena'], createdAt: iso(20 * DAY), updatedAt: iso(8 * DAY) });
  const busy = mine(5, { requestedReviewers: ['lena'], updatedAt: iso(DAY) });
  const status: Record<string, QueueSignals> = {
    [failing.url]: signals(failing, { checks: 'failure' }),
    [failingNew.url]: signals(failingNew, { checks: 'failure' }),
    [unapproved.url]: signals(unapproved, { checks: 'success', decision: '', mergeState: 'CLEAN' }),
    [idle.url]: signals(idle, { checks: 'success' }),
    [busy.url]: signals(busy, { checks: 'success' }),
  };
  const model = build([item([failing]), item([failingNew]), item([unapproved]), item([idle]), item([busy])], status);
  const decisions = needsDecision({ model, now: T0 });
  assert.deepEqual(decisions.map((entry) => [entry.member.number, entry.reason, entry.label]), [
    [3, 'unapproved', 'Never approved · 10 d'],
    [1, 'failing', 'Failing 9 d'],
    [4, 'idle', 'Idle 8 d'],
  ]);
});

void test('Close PR: the request carries the confirmed revision and an optional comment; the confirmation says it can be reopened', () => {
  const state = { account: LOGIN, url: 'https://github.com/o/r/pull/9', headSha: 'h', baseSha: 'b', baseBranch: 'main' };
  assert.deepEqual(closeRequest(state, '  '), { account: LOGIN, kind: 'close', url: state.url, revisions: [{ url: state.url, headSha: 'h', baseSha: 'b', baseBranch: 'main' }] });
  assert.equal(closeRequest(state, ' Superseded by #12. ').comment, 'Superseded by #12.');
  const words = closeConfirmation({ number: 9, title: 'Old idea', repo: 'o/r' });
  assert.equal(words.title, 'Close #9?');
  assert.match(words.body, /reopen it on GitHub/);
  const open = { archived: false, state: 'OPEN', canChangeDraft: true } as PrActionState;
  assert.equal(closeBlockedReason(open), undefined);
  assert.match(closeBlockedReason({ ...open, canChangeDraft: false }) ?? '', /author or someone with write permission/);
  assert.match(closeBlockedReason({ ...open, state: 'CLOSED' }) ?? '', /already closed/);
  assert.match(closeBlockedReason({ ...open, archived: true }) ?? '', /archived/);
});

void test('since yesterday: events from notifications and sync, aggregated once per PR, in one short line', () => {
  const base = { title: 'T', repo: 'o/r', number: 1, at: T0 - 5 * 3_600_000 };
  const events = sinceEventsFromNotifications([
    { ...base, type: 'review-requested', key: 'requested|u1|1', url: 'https://github.com/o/r/pull/1' },
    { ...base, type: 'team-review-requested', key: 'team|u2|1', url: 'https://github.com/o/r/pull/2' },
    { ...base, type: 'reply', key: 'reply|c1', url: 'https://github.com/o/r/pull/3', actor: 'lena' },
    { ...base, type: 'mention', key: 'mention|c2', url: 'https://github.com/o/r/pull/4', actor: 'owen' },
    { ...base, type: 'reply', key: 'reply|c3', url: 'https://github.com/o/r/pull/4', actor: 'dependabot', actorIsBot: true },
    { ...base, type: 'checks-failed', key: 'checks-failed|u5|h', url: 'https://github.com/o/r/pull/5', mine: true },
    { ...base, type: 'checks-failed', key: 'checks-failed|u6|h', url: 'https://github.com/o/r/pull/6' },
    { ...base, type: 'approved', key: 'review|x', url: 'https://github.com/o/r/pull/7' },
  ] as NotificationEvent[]);
  assert.deepEqual(events.map((event) => [event.type, event.actor ?? '']), [
    ['review-requested', ''], ['review-requested', ''], ['reply', 'lena'], ['reply', 'owen'], ['reply', ''], ['checks-red', ''],
  ]);
  const sync: SinceEvent[] = [
    { type: 'merged', key: 'merged|8', url: 'https://github.com/o/r/pull/8', at: T0 - 2 * 3_600_000 },
    // Red, then green: counts once, as green.
    { type: 'checks-red', key: 'red|9', url: 'https://github.com/o/r/pull/9', at: T0 - 6 * 3_600_000 },
    { type: 'checks-green', key: 'green|9', url: 'https://github.com/o/r/pull/9', at: T0 - 3 * 3_600_000 },
    // Before the last visit: left out.
    { type: 'merged', key: 'merged|10', url: 'https://github.com/o/r/pull/10', at: T0 - 30 * 3_600_000 },
  ];
  const log = appendSinceEvents(appendSinceEvents([], events, T0), [...sync, ...events], T0);
  assert.equal(log.length, events.length + sync.length, 'each key once');
  const visit = T0 - 20 * 3_600_000;
  const summary = sinceSummary(log, visit);
  assert.deepEqual(summary, { merged: 1, requests: 2, repliers: ['lena', 'owen'], red: 1, green: 1 });
  assert.equal(sinceLine(summary, visit, T0), 'Since yesterday: 1 merged · 2 new review requests · lena and owen replied · checks failed on 1, passed on 1');
  assert.equal(sinceLine(sinceSummary(log, T0), visit, T0), '', 'nothing changed: no line');
  assert.equal(sinceLine({ merged: 0, requests: 0, repliers: ['a', 'b', 'c', 'd'], red: 0, green: 0 }, visit, T0), 'Since yesterday: a, b and 2 more replied');
  const morning = new Date(T0);
  morning.setHours(8, 5, 0, 0);
  assert.match(sinceLabel(morning.getTime(), morning.getTime() + 3_600_000), /^Since \d{2}[:.]\d{2}/, 'a visit earlier today names its time');
});

void test('the since log is bounded, drops old events and validates what crosses IPC', () => {
  const many: SinceEvent[] = Array.from({ length: SINCE_LOG_LIMIT + 50 }, (_, i) => ({ type: 'merged', key: `k${i}`, url: `https://github.com/o/r/pull/${i + 1}`, at: T0 - i * 1000 }));
  const log = appendSinceEvents([], many, T0);
  assert.equal(log.length, SINCE_LOG_LIMIT);
  assert.equal(log[0].key, 'k0', 'newest first');
  assert.equal(appendSinceEvents(log, [], T0 + SINCE_LOG_MAX_AGE_MS + 1).length, 0, 'old events leave');
  assert.equal(parseSinceEvent({ type: 'merged', key: 'k', url: 'https://evil.example/pull/1', at: 1 }), undefined);
  assert.equal(parseSinceEvent({ type: 'deleted', key: 'k', url: 'https://github.com/o/r/pull/1', at: 1 }), undefined);
  assert.deepEqual(parseSinceEvent({ type: 'reply', key: 'k', url: 'https://github.com/o/r/pull/1', at: 1, actor: 'lena', extra: true }), { type: 'reply', key: 'k', url: 'https://github.com/o/r/pull/1', at: 1, actor: 'lena' });
});

void test('re-review lines: one compare per PR from your reviewed commit to the head, validated and summed', () => {
  const target = { url: 'https://github.com/o/r/pull/4', from: 'abc1234', to: 'def5678' };
  assert.deepEqual(parseRereviewTargets([target]), [target]);
  assert.equal(parseRereviewTargets([{ ...target, from: 'not a sha' }]), undefined);
  assert.equal(parseRereviewTargets(Array.from({ length: REREVIEW_LIMIT + 1 }, () => target)), undefined);
  assert.deepEqual(rereviewCompare(target), { owner: 'o', repo: 'r', basehead: 'abc1234...def5678', per_page: 1 });
  assert.deepEqual(rereviewSize(target, [{ additions: 30, deletions: 2 }, { additions: 10 }]), { ...target, lines: 42, files: 2 });
  // The commit your latest review was on, from status.
  const pr = member(4, { headSha: 'def5678' });
  const status = { ...signals(pr), opinions: [
    { url: 'a', author: LOGIN, state: 'APPROVED', submittedAt: iso(3 * DAY), headSha: 'abc1234' },
    { url: 'b', author: 'lena', state: 'APPROVED', submittedAt: iso(DAY), headSha: 'def5678' },
  ] };
  assert.equal(reviewedCommit(status, LOGIN), 'abc1234');
  assert.equal(reviewedCommit(signals(pr), LOGIN), undefined);
});

void test('the reply quoted on a row is the last human comment of a thread waiting on you', () => {
  const comment = (id: string, login: string, body: string, bot = false) => ({ id, body, createdAt: iso(DAY), url: `u#${id}`, author: { login, avatarUrl: '', ...(bot ? { __typename: 'Bot' } : {}) } });
  const discussion = {
    headSha: 'h', baseSha: 'b',
    threads: [
      { id: 't1', path: 'a', line: 1, startLine: null, diffSide: 'RIGHT', isResolved: true, isOutdated: false, viewerCanResolve: true, viewerCanUnresolve: true, comments: [comment('1', 'lena', 'resolved one')] },
      { id: 't2', path: 'a', line: 2, startLine: null, diffSide: 'RIGHT', isResolved: false, isOutdated: false, viewerCanResolve: true, viewerCanUnresolve: true, comments: [comment('2', LOGIN, 'mine'), comment('3', 'owen', 'Could we keep it?'), comment('4', 'ci-bot', 'beep', true)] },
    ],
  } as unknown as GitHubReviewThreads;
  assert.deepEqual(waitingReply(discussion, LOGIN, LOGIN), { author: 'owen', text: 'Could we keep it?' });
  assert.equal(waitingReply(undefined, LOGIN, LOGIN), undefined);
});
