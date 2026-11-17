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
  QUICK_LINES,
  STACKS_SHOWN,
  UNREVIEWED_LIMIT,
  moveCount,
  quote,
  repositoryNames,
  sectionCount,
  waitingOnOthers,
  waitingOnYou,
  type PersonGroup,
} from '../lib/morning';
import { overviewBriefing } from '../lib/overview';
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
  const ready = mine(1, { updatedAt: iso(DAY), additions: 10, deletions: 2 });
  const pending = mine(2, { updatedAt: iso(DAY), additions: 10, deletions: 2 });
  const replied = mine(3);
  const rereview = member(4, { requestedReviewers: [LOGIN], additions: 200, deletions: 50 });
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
  const { items: all } = moveForward(input(model, status, {
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
  const { items: uncapped } = moveForward(input(build(items.filter((entry) => !extra.some((pr) => pr.url === entry.subject.members[0].url)), status), status, { rereviewLines: { [rereview.url]: 120 } }));
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
  const { items: move } = moveForward(input(model, {}));
  assert.equal(morningCount(move, groups), 5, 'each PR once, across both sections');
});

void test('waiting on others groups your PRs by blocker, each PR once: reviewers with Nudge, teams, CI, a stack, and you', () => {
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
    // #2 waits on lena and sam: it is listed once, under the first reviewer GitHub names.
    ['person', 'lena', '2 PRs · 4 d'],
    ['team', 'klang/web', '1 PR · 1 d'],
    ['ci', 'CI', '1 running'],
    // #6 waits for #5, which is yours and failing: the stack says so, and #5 itself is under you.
    ['stack', 'PR 5', '1 PR waits for #5 to merge · #5 has failing checks'],
    ['you', 'you', '2 failing checks, 1 conflict'],
  ]);
  assert.equal(sectionCount(groups), 8, 'each of the eight PRs once');
  assert.deepEqual(groups[3].lines.map((line) => [line.member.number, line.note]), [[5, '#5 has failing checks'], [6, 'after #5']], 'the base leads the expanded stack');
  assert.equal(groups[3].lines[1].hint, 'This PR is stacked on #5 and can merge only after #5 merges.');
  assert.deepEqual(groups[0].nudge?.members.map((m) => m.number), [1, 2]);
  assert.equal(groups[1].nudge, undefined, 'teams are not nudged');
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
  assert.equal(nudgeConfirmation({ nudge: { reviewer: 'sam', members: [both] } }).action, 'Re-request review');
  assert.deepEqual(nudgeRequests(groups[2]), []);
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

// ── Real-data shapes (#390, morning page 3): stacks, counts, unreviewed merges, the review slot ──

const pr = (repo: string, n: number, extra: Partial<ReviewMember> = {}) =>
  member(n, { repo, baseRepo: repo, headRepo: repo, url: `https://github.com/${repo}/pull/${n}`, additions: 20, deletions: 5, ...extra });
const minePr = (repo: string, n: number, extra: Partial<ReviewMember> = {}) => pr(repo, n, { author: LOGIN, role: 'author', ...extra });
/** A stack subject with an explicit id: equal numbers in two repositories must not share one. */
const stack = (members: ReviewMember[], id = `${members[0].repo}#${members[0].number}`, name?: string): QueueItem => {
  const value = item(members);
  return { ...value, subject: { ...value.subject, id, ...(name ? { name } : {}) } };
};
const noReview = (m: ReviewMember) => signals(m, { checks: 'success', decision: null, mergeState: 'CLEAN' });
const approved = (m: ReviewMember, by = 'lena') => signals(m, { checks: 'success', decision: 'APPROVED', mergeState: 'CLEAN', opinions: [{ id: '1', author: by, state: 'APPROVED' }] });
const mergeLane = (model: OverviewModel) => model.lanes.find((state) => state.lane === 'merge')?.rows ?? [];
/** The number a row shows for its PRs: "5 PRs · …", "3 running", "4 PRs wait for …", "17 PRs in 6 stacks", "2 failing checks, 1 conflict". */
const shown = (group: PersonGroup) =>
  group.kind === 'you'
    ? [...group.detail.matchAll(/(\d+) (failing checks?|conflicts?|restacks?)/g)].reduce((total, match) => total + Number(match[1]), 0)
    : Number(group.detail.match(/^(\d+) (PRs?|running|review requests?)\b/)?.[1] ?? NaN);

/** Every section's heading equals the sum of what its rows say, and no PR is listed twice in a section. */
function assertCounts(model: OverviewModel, status: Record<string, QueueSignals>) {
  const morning = input(model, status);
  const move = moveForward(morning).items;
  const you = waitingOnYou(morning);
  const others = waitingOnOthers(morning);
  const decide = needsDecision(morning);
  assert.equal(moveCount(move), move.reduce((total, entry) => total + entry.urls.length, 0));
  for (const entry of move) if (entry.kind !== 'merge' && entry.row.entries.length > 1) assert.match(entry.why, new RegExp(`^${entry.row.entries.length} PRs · `), 'a stack row says how many PRs');
  for (const groups of [you, others]) {
    const urls = groups.flatMap((group) => group.urls);
    assert.equal(new Set(urls).size, urls.length, 'each PR under one row');
    assert.equal(sectionCount(groups), urls.length);
    for (const group of groups) {
      assert.equal(shown(group), group.urls.length, `${group.label}: "${group.detail}" says how many PRs it counts`);
      if (group.children) assert.equal(group.urls.length, group.children.reduce((total, child) => total + child.urls.length, 0));
    }
  }
  assert.equal(decide.length, new Set(decide.map((entry) => entry.member.url)).size);
  // The tab: Move forward now and Waiting on you, each PR once.
  assert.equal(morningCount(move, you), new Set([...move.flatMap((entry) => entry.urls), ...you.flatMap((group) => group.urls)]).size);
  return { move, you, others, decide };
}

void test('stacked PRs: one row per stack, keyed by repository and number, folded over three stacks', () => {
  const status: Record<string, QueueSignals> = {};
  const set = (m: ReviewMember, value: QueueSignals) => { status[m.url] = value; return m; };
  // Launcher i18n: a failing base and three PRs above it, listed twice in the queue.
  const i18n = [set(minePr('klang/launcher', 380, { title: 'Move the launcher text into keys' }), signals(minePr('klang/launcher', 380), { checks: 'failure' }))];
  for (const n of [381, 382, 383]) i18n.push(set(minePr('klang/launcher', n, { baseBranch: `feature-${n - 1}` }), noReview(minePr('klang/launcher', n))));
  // #384 in two repositories: one ready to merge, one waiting on lena.
  const launcher384 = [set(minePr('klang/launcher', 384, { title: 'Launcher: read the language' }), approved(minePr('klang/launcher', 384)))];
  for (const n of [385, 386]) launcher384.push(set(minePr('klang/launcher', n), noReview(minePr('klang/launcher', n))));
  const web384 = [set(minePr('klang/web', 384, { title: 'Web: language picker', requestedReviewers: ['lena'] }), signals(minePr('klang/web', 384), { checks: 'success' }))];
  for (const n of [385, 386]) web384.push(set(minePr('klang/web', n), noReview(minePr('klang/web', n))));
  const small = [10, 20, 30].map((n) => {
    const base = set(minePr('acme/api', n, { title: `API base ${n}`, requestedReviewers: ['sam'] }), signals(minePr('acme/api', n), { checks: 'success' }));
    const top = set(minePr('acme/api', n + 1), noReview(minePr('acme/api', n + 1)));
    return stack([base, top]);
  });
  const items = [stack(i18n, 'i18n', 'Launcher i18n'), stack(i18n, 'i18n-again', 'Launcher i18n'), stack(launcher384), stack(web384), ...small];
  const model = build(items, status);
  const { others } = assertCounts(model, status);
  const folded = others.find((group) => group.kind === 'stacks');
  assert.ok(folded, `over ${STACKS_SHOWN} stacks fold into one row`);
  assert.equal(folded.label, 'Waiting for earlier PRs in a stack to merge');
  assert.equal(folded.detail, '10 PRs in 6 stacks');
  assert.deepEqual([...folded.repos].sort(), ['acme/api', 'klang/launcher', 'klang/web']);
  const byKey = Object.fromEntries((folded.children ?? []).map((child) => [child.key, child]));
  assert.deepEqual(Object.keys(byKey).sort(), ['stack:acme/api#10', 'stack:acme/api#20', 'stack:acme/api#30', 'stack:klang/launcher#380', 'stack:klang/launcher#384', 'stack:klang/web#384']);
  // Listed twice in the queue, counted once; named by the stack.
  assert.deepEqual([byKey['stack:klang/launcher#380'].label, byKey['stack:klang/launcher#380'].detail], ['Launcher i18n', '3 PRs wait for #380 to merge · #380 has failing checks']);
  assert.deepEqual(byKey['stack:klang/launcher#380'].lines.map((line) => [line.member.number, line.note]), [[380, '#380 has failing checks'], [381, 'after #380'], [382, 'after #381'], [383, 'after #382']]);
  // The same number in two repositories: two rows, each named by its base PR, each with its base's state.
  assert.deepEqual([byKey['stack:klang/launcher#384'].label, byKey['stack:klang/launcher#384'].detail, byKey['stack:klang/launcher#384'].base?.action],
    ['Launcher: read the language', '2 PRs wait for #384 to merge · #384 is ready to merge', 'merge']);
  assert.deepEqual([byKey['stack:klang/web#384'].label, byKey['stack:klang/web#384'].detail, byKey['stack:klang/web#384'].base?.action],
    ['Web: language picker', '2 PRs wait for #384 to merge · #384 waits on lena’s review', 'open']);
  // Reviewers first, then stacks, then you.
  assert.deepEqual(others.map((group) => group.kind), ['person', 'person', 'stacks', 'you']);
  // Three stacks or fewer: one row each, no fold.
  const few = waitingOnOthers(input(build([stack(i18n, 'i18n', 'Launcher i18n'), stack(launcher384), stack(web384)], status), status));
  assert.deepEqual(few.filter((group) => group.kind === 'stack').map((group) => group.key), ['stack:klang/launcher#380', 'stack:klang/launcher#384', 'stack:klang/web#384']);
  assert.equal(few.some((group) => group.kind === 'stacks'), false);
});

void test('Waiting on you counts what it lists: a stack is its PRs, and team and unassigned requests are rows', () => {
  // The real report: "Waiting on you 7" over two people. zsolt-klang's stack of five PRs counted five, but the row said 1.
  const zsolt = [1, 2, 3, 4, 5].map((n) => pr('klang/seed', n, { author: 'zsolt-klang', requestedReviewers: [LOGIN], createdAt: iso(14 * DAY), baseBranch: n > 1 ? `feature-${n - 1}` : 'main' }));
  const ivar = pr('klang/launcher', 6, { author: 'ivaremilsson', requestedReviewers: [LOGIN], createdAt: iso(4 * DAY), additions: 600 });
  const team = pr('klang/web', 7, { author: 'maya', role: 'review-requested', createdAt: iso(3 * DAY) });
  const replied = minePr('klang/web', 8);
  const status: Record<string, QueueSignals> = { [replied.url]: signals(replied, { checks: 'success' }) };
  const model = overviewModel({
    items: [stack(zsolt), item([ivar]), item([team]), item([replied], { responses: { [replied.url]: { changesRequested: false, unresolvedThreads: 1, awaitingReply: 1, complete: true } } })],
    signals: (m) => status[m.url],
    login: LOGIN,
    now: T0,
    teamRequests: true,
  });
  const { you, move } = assertCounts(model, status);
  assert.deepEqual(you.map((group) => [group.label, group.detail]), [
    ['zsolt-klang', '5 PRs · oldest 14 d'],
    ['ivaremilsson', '1 PR · oldest 4 d'],
    ['unassigned', '1 PR · oldest 1 h'],
    ['team', '1 review request'],
  ]);
  assert.equal(sectionCount(you), 8);
  assert.deepEqual(you[0].repos, ['klang/seed']);
  // The briefing counts the same PRs.
  assert.match(overviewBriefing(model), /7 reviews are waiting on you\./, 'five from zsolt-klang, one from ivaremilsson, one team request');
  // The tab: Waiting on you, and the reply in Move forward now, each once.
  assert.equal(morningCount(move, you), 8);
});

void test('Move forward now: approved first, unreviewed merges after and capped at two, nothing large', () => {
  const status: Record<string, QueueSignals> = {};
  const set = (m: ReviewMember, value: (m: ReviewMember) => QueueSignals) => { status[m.url] = value(m); return m; };
  const okA = set(minePr('o/r', 1, { updatedAt: iso(5 * 3_600_000) }), (m) => approved(m, 'lena'));
  const okB = set(minePr('o/r', 2, { updatedAt: iso(4 * 3_600_000) }), (m) => approved(m, 'sam'));
  const unreviewed = [11, 12, 13, 14, 15, 16].map((n, i) => set(minePr('o/r', n, { updatedAt: iso((20 - i) * 3_600_000) }), noReview));
  const bigEpic = set(minePr('o/r', 17, { title: 'STACK: EPIC', additions: 2400, deletions: 300, updatedAt: iso(30 * 3_600_000) }), noReview);
  const bigWorker = set(minePr('o/r', 18, { title: 'Integrate the Rust worker', additions: 280, deletions: 40 }), noReview);
  const bigApproved = set(minePr('o/r', 19, { additions: 500 }), (m) => approved(m));
  // A stack whose PRs total over the limit: its small, approved base is not quick either.
  const stackBase = set(minePr('o/r', 21, { additions: 150, deletions: 0 }), (m) => approved(m));
  const stackTop = set(minePr('o/r', 22, { additions: 160, deletions: 0, baseBranch: 'feature-21' }), (m) => signals(m, { checks: 'failure' }));
  const model = build([okA, okB, ...unreviewed, bigEpic, bigWorker, bigApproved].map((m) => item([m])).concat(stack([stackBase, stackTop])), status);
  const { items, moreUnreviewed } = moveForward(input(model, status));
  assert.deepEqual(items.map((entry) => [entry.row.focus.number, entry.why]), [
    [1, 'approved by lena · green'],
    [2, 'approved by sam · green'],
    // Oldest first, labelled in words.
    [11, 'not reviewed · green'],
    [12, 'not reviewed · green'],
  ]);
  assert.equal(items.filter((entry) => entry.unreviewed).length, UNREVIEWED_LIMIT);
  // 4 more small ones, and the two large ones: still ready, still counted, only not quick.
  assert.equal(moreUnreviewed, 6);
  for (const n of [17, 18, 19, 21]) assert.ok(!items.some((entry) => entry.row.focus.number === n), `#${n} is over ${QUICK_LINES} lines, alone or as a stack`);
  assert.ok(mergeLane(model).some((row) => row.focus.number === 17), 'a large PR stays in Merge');
  // Unreviewed merges only fill what the rest leave: they never push out an approved merge or a review.
  const moreApproved = [31, 32, 33, 34, 35].map((n) => set(minePr('o/r', n), (m) => approved(m)));
  const full = moveForward(input(build([okA, okB, ...moreApproved, ...unreviewed].map((m) => item([m])), status), status));
  assert.equal(full.items.length, MOVE_LIMIT);
  assert.equal(full.items.some((entry) => entry.unreviewed), false);
  assert.equal(full.moreUnreviewed, unreviewed.length);
});

void test('Move forward now keeps a slot for the oldest small review request', () => {
  const status: Record<string, QueueSignals> = {};
  const merges = [1, 2, 3, 4, 5, 6, 7].map((n) => {
    const m = minePr('o/r', n);
    status[m.url] = approved(m);
    return m;
  });
  const older = pr('klang/seed', 40, { author: 'zsolt-klang', requestedReviewers: [LOGIN], createdAt: iso(14 * DAY), additions: 60, deletions: 10 });
  const newer = pr('klang/launcher', 41, { author: 'ivaremilsson', requestedReviewers: [LOGIN], createdAt: iso(4 * DAY), additions: 30, deletions: 5 });
  const model = build([...merges.map((m) => item([m])), item([older]), item([newer])], status);
  const { items } = moveForward(input(model, status));
  assert.equal(items.length, MOVE_LIMIT);
  assert.deepEqual(items.filter((entry) => entry.kind === 'review').map((entry) => entry.row.focus.number), [40], 'the oldest review takes the last slot');
  assert.equal(items.filter((entry) => entry.kind === 'merge').length, MOVE_LIMIT - 1);
  // Both requests large: no slot; they stay in Waiting on you.
  const large = [older, newer].map((m) => ({ ...m, additions: 900 }));
  const big = build([...merges.map((m) => item([m])), ...large.map((m) => item([m]))], status);
  assert.equal(moveForward(input(big, status)).items.some((entry) => entry.kind === 'review'), false);
  assert.deepEqual(waitingOnYou({ model: big, now: T0, login: LOGIN }).map((group) => group.label), ['zsolt-klang', 'ivaremilsson']);
});

void test('the briefing says how many merges are approved, and how many can merge without review', () => {
  const status: Record<string, QueueSignals> = {};
  const ready = [1, 2].map((n) => { const m = minePr('o/r', n); status[m.url] = approved(m); return m; });
  const open = [3, 4, 5, 6, 7, 8, 9, 10].map((n) => { const m = minePr('o/r', n); status[m.url] = noReview(m); return m; });
  assert.equal(overviewBriefing(build([...ready, ...open].map((m) => item([m])), status)), '2 PRs are approved and ready to merge, 8 more can merge without review.');
  assert.equal(overviewBriefing(build(open.map((m) => item([m])), status)), '8 PRs can merge without review.');
  assert.equal(overviewBriefing(build(ready.map((m) => item([m])), status)), '2 PRs are approved and ready to merge.');
});

void test('repositories are named by their short name, and owner/repo where two share one', () => {
  const names = repositoryNames(['klang/seed', 'acme/seed', 'klang/web-seed-portal', 'Klang/Launcher']);
  assert.deepEqual([...names.entries()], [
    ['klang/seed', 'klang/seed'],
    ['acme/seed', 'acme/seed'],
    ['klang/web-seed-portal', 'web-seed-portal'],
    ['Klang/Launcher', 'Launcher'],
  ]);
});
