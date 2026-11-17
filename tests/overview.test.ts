import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OVERVIEW_LANES,
  OVERVIEW_STALE_MS,
  nextOverviewVisit,
  overviewCountLine,
  overviewModel,
  overviewVisitKey,
  parseOverviewVisit,
  rowReasons,
  waitingLabel,
  type OverviewLane,
  type OverviewModel,
  type OverviewVisit,
} from '../lib/overview';
import { DEFAULT_QUEUE_FILTERS, describeQueueFilters, matchesQueueFilters, normalizeQueueFilters, withLaneUrls, activeQueueFilterCount } from '../lib/queue-filters';
import { formatDeepLink, parseDeepLink, targetFromLocation } from '../lib/deep-link';
import { homeTabPreference, rememberHomeTab, restoredTool, HOME_TAB_KEY } from '../lib/home-tab';
import type { HomeLocation } from '../lib/navigation-history';
import { countWorkspaceListing, workspaceListingRequest, workspaceTabTitle } from '../lib/workspace-listings';
import type { QueueItem, ReviewMember } from '../lib/workbench';
import type { QueueSignals } from '../lib/queue-signals';
import type { ReviewHistoryEntry } from '../lib/types';
import { LOGIN, T0, member, mine, signals, readySignals } from './notification-fixtures';

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
const review = (url: string, extra: Partial<ReviewHistoryEntry> = {}) =>
  ({ id: `review-${url.split('/').pop()}`, prUrl: url, prTitle: 'PR', status: 'completed', unread: true, ...extra }) as ReviewHistoryEntry;
function model(items: QueueItem[], options: { signals?: Record<string, QueueSignals>; now?: number; previous?: OverviewVisit; excluded?: Set<string> } = {}) {
  return overviewModel({ items, signals: (m) => options.signals?.[m.url], login: LOGIN, now: options.now ?? T0, previous: options.previous, excluded: options.excluded });
}
const lane = (result: OverviewModel, name: OverviewLane) => result.lanes.find((state) => state.lane === name)?.rows ?? [];
const numbers = (result: OverviewModel, name: OverviewLane) => lane(result, name).map((row) => row.focus.number);
const passing = (pr: ReviewMember, extra: Parameters<typeof signals>[1] = {}) => signals(pr, { checks: 'success', decision: 'REVIEW_REQUIRED', ...extra });

void test('every attention kind lands in its lane, and lanes come in a fixed order', () => {
  const requested = member(1, { requestedReviewers: [LOGIN] });
  const updated = member(2);
  const changes = mine(3);
  const failing = mine(4);
  const conflicted = mine(5);
  const replies = mine(6);
  const ready = mine(7);
  const explained = member(8);
  const result = model(
    [
      item([requested]),
      item([updated], { attention: 'updated', review: review(updated.url, { unread: false }) }),
      item([changes]),
      item([failing]),
      item([conflicted]),
      item([replies], { responses: { [replies.url]: { changesRequested: false, unresolvedThreads: 1, awaitingReply: 1, complete: true } } }),
      item([ready]),
      item([explained], { review: review(explained.url) }),
    ],
    {
      signals: {
        [changes.url]: passing(changes, { review: { id: '1', author: 'maya', state: 'CHANGES_REQUESTED' } }),
        [failing.url]: signals(failing, { checks: 'failure' }),
        [conflicted.url]: passing(conflicted, { mergeable: 'CONFLICTING', mergeState: 'DIRTY' }),
        [replies.url]: passing(replies),
        [ready.url]: readySignals(ready),
      },
    }
  );
  assert.deepEqual(result.lanes.map((state) => state.lane), [...OVERVIEW_LANES]);
  assert.deepEqual(numbers(result, 'merge'), [7]);
  assert.deepEqual(numbers(result, 'answer').sort(), [3, 6]);
  assert.deepEqual(numbers(result, 'review').sort(), [1, 2]);
  assert.deepEqual(numbers(result, 'fix').sort(), [4, 5]);
  assert.deepEqual(lane(result, 'review').find((row) => row.focus.number === 2)?.reasons, ['updated-since-review']);
  // An unread explanation alone needs no review: it is a marker on Review rows, never a row of its own.
  assert.ok(!result.lanes.some((state) => state.rows.some((row) => row.focus.number === 8)));
  assert.deepEqual(result.counts, { merge: 1, answer: 2, review: 2, fix: 2, waiting: 0 });
  assert.equal(result.actionable, 7);
  assert.equal(overviewCountLine(result.counts), 'Merge 1 · Answer 2 · Review 2 · Fix 2 · Waiting 0');
});

void test('status lanes are for your own PRs; others only reach Review', () => {
  const theirsFailing = member(1);
  const theirsReady = member(2);
  const theirsRequested = member(3, { requestedReviewers: [LOGIN] });
  const result = model([item([theirsFailing]), item([theirsReady]), item([theirsRequested])], {
    signals: { [theirsFailing.url]: signals(theirsFailing, { checks: 'failure' }), [theirsReady.url]: readySignals(theirsReady), [theirsRequested.url]: signals(theirsRequested, { checks: 'failure' }) },
  });
  assert.deepEqual(numbers(result, 'fix'), []);
  assert.deepEqual(numbers(result, 'merge'), []);
  assert.deepEqual(numbers(result, 'waiting'), []);
  assert.deepEqual(numbers(result, 'review'), [3]);
  // A team request counts only with the team setting, as notifications do.
  const team = member(4, { role: 'review-requested' });
  assert.deepEqual(numbers(model([item([team])]), 'review'), []);
  assert.deepEqual(numbers(overviewModel({ items: [item([team])], signals: () => undefined, login: LOGIN, now: T0, teamRequests: true }), 'review'), [4]);
});

void test('a fix comes before merging, and Waiting holds only PRs with nothing for you to do', () => {
  const failingButApproved = mine(1);
  const pending = mine(2);
  const awaiting = mine(3, { requestedReviewers: ['lena'] });
  const draft = mine(4, { isDraft: true, requestedReviewers: ['lena'] });
  const approvedRunning = mine(5);
  const result = model([item([failingButApproved]), item([pending]), item([awaiting]), item([draft]), item([approvedRunning])], {
    signals: {
      [failingButApproved.url]: signals(failingButApproved, { checks: 'failure', decision: 'APPROVED', mergeState: 'CLEAN' }),
      [pending.url]: signals(pending, { checks: 'pending', decision: 'APPROVED', mergeState: 'BLOCKED' }),
      [awaiting.url]: passing(awaiting),
      [draft.url]: signals(draft, { checks: 'pending' }),
      [approvedRunning.url]: signals(approvedRunning, { checks: 'pending', decision: 'APPROVED' }),
    },
  });
  assert.deepEqual(numbers(result, 'fix'), [1]);
  assert.deepEqual(numbers(result, 'merge'), []);
  assert.deepEqual(numbers(result, 'waiting').sort(), [2, 3, 5]);
  assert.deepEqual(lane(result, 'waiting').find((row) => row.focus.number === 2)?.reasons, ['checks-pending']);
  assert.deepEqual(lane(result, 'waiting').find((row) => row.focus.number === 3)?.reasons, ['review-pending']);
  assert.equal(lane(result, 'waiting').find((row) => row.focus.number === 3)?.person, 'lena');
  // Waiting is not work: it is not counted as actionable.
  assert.equal(result.actionable, 1);
});

void test('a stack is one row per lane, in each lane where any member needs you', () => {
  const base = mine(10);
  const middle = mine(11, { baseBranch: 'feature-10' });
  const top = mine(12, { baseBranch: 'feature-11' });
  const stack = item([base, middle, top]);
  const result = model([stack], {
    signals: {
      [base.url]: readySignals(base),
      [middle.url]: signals(middle, { checks: 'failure' }),
      [top.url]: signals(top, { checks: 'success', decision: 'REVIEW_REQUIRED', mergeable: 'CONFLICTING', mergeState: 'DIRTY' }),
    },
  });
  const fix = lane(result, 'fix');
  assert.equal(fix.length, 1);
  assert.equal(fix[0].kind, 'stack');
  assert.equal(fix[0].stackSize, 3);
  assert.deepEqual(fix[0].entries.map((entry) => entry.member.number), [11, 12]);
  assert.deepEqual(fix[0].reasons, ['checks-failed', 'conflicts']);
  assert.equal(fix[0].title, 'Stack 10');
  const merge = lane(result, 'merge');
  assert.equal(merge.length, 1);
  assert.deepEqual(merge[0].entries.map((entry) => entry.member.number), [10]);
  assert.equal(result.counts.fix, 1);
  assert.deepEqual(result.urls.fix.sort(), [middle.url, top.url].sort());
});

void test('a PR whose stack parent merged needs a restack', () => {
  const parent = mine(20, { merged: true, state: 'closed' });
  const child = mine(21, { baseBranch: 'feature-20' });
  const result = model([item([parent, child])], { signals: { [child.url]: passing(child) } });
  assert.deepEqual(lane(result, 'fix')[0]?.reasons, ['restack']);
  assert.deepEqual(rowReasons(lane(result, 'fix')[0]), ['restack']);
});

void test('snoozed, muted, merged and closed PRs are left out, as in the queue', () => {
  const snoozed = mine(1);
  const muted = mine(2);
  const merged = mine(3, { merged: true });
  const closed = mine(4, { state: 'closed' });
  const kept = mine(5);
  const all = [snoozed, muted, merged, closed, kept];
  const result = model([item([snoozed, kept], { snoozedUrls: [snoozed.url] }), item([muted]), item([merged]), item([closed])], {
    signals: Object.fromEntries(all.map((pr) => [pr.url, signals(pr, { checks: 'failure' })])),
    excluded: new Set([muted.url]),
  });
  assert.deepEqual(lane(result, 'fix').flatMap((row) => row.entries.map((entry) => entry.member.number)), [5]);
});

void test('each lane sorts oldest first, from when the item entered its state', () => {
  const older = mine(1);
  const newer = mine(2);
  const requested = member(3, { requestedReviewers: [LOGIN], createdAt: '2026-11-10T00:00:00Z' });
  const rerequested = member(4, { requestedReviewers: [LOGIN], createdAt: '2026-11-01T00:00:00Z' });
  const result = model([item([newer]), item([older]), item([rerequested]), item([requested])], {
    signals: {
      [older.url]: signals(older, { checks: 'success', decision: 'CHANGES_REQUESTED', opinions: [{ id: '1', author: 'maya', state: 'CHANGES_REQUESTED', at: '2026-11-05T00:00:00Z' }] }),
      [newer.url]: signals(newer, { checks: 'success', decision: 'CHANGES_REQUESTED', opinions: [{ id: '2', author: 'sam', state: 'CHANGES_REQUESTED', at: '2026-11-13T00:00:00Z' }] }),
      // You reviewed #4 on the 12th; the request that brought it back came after.
      [rerequested.url]: signals(rerequested, { opinions: [{ id: '3', author: LOGIN, state: 'APPROVED', at: '2026-11-12T00:00:00Z' }] }),
    },
  });
  assert.deepEqual(numbers(result, 'answer'), [1, 2]);
  const answer = lane(result, 'answer');
  assert.equal(answer[0].since, Date.parse('2026-11-05T00:00:00Z'));
  assert.equal(answer[0].source, 'change-request');
  assert.equal(answer[0].person, 'maya');
  assert.deepEqual(numbers(result, 'review'), [3, 4]);
  assert.equal(lane(result, 'review')[1].source, 'your-review');
  assert.equal(lane(result, 'review')[0].source, 'opened');
});

void test('ready to merge waits since the approval; stale items are flagged after three days', () => {
  const ready = mine(1);
  const approvedAt = T0 - OVERVIEW_STALE_MS - 60_000;
  const fresh = mine(2);
  const result = model([item([ready]), item([fresh])], {
    signals: {
      [ready.url]: { ...readySignals(ready), opinions: [{ url: 'x', author: 'lena', state: 'APPROVED', submittedAt: new Date(approvedAt).toISOString(), headSha: ready.headSha }] },
      [fresh.url]: { ...readySignals(fresh), opinions: [{ url: 'y', author: 'sam', state: 'APPROVED', submittedAt: new Date(T0 - 3_600_000).toISOString(), headSha: fresh.headSha }] },
    },
  });
  const rows = lane(result, 'merge');
  assert.deepEqual(rows.map((row) => row.focus.number), [1, 2]);
  assert.equal(rows[0].source, 'approval');
  assert.equal(rows[0].person, 'lena');
  assert.equal(rows[0].stale, true);
  assert.equal(rows[0].waiting, '3 d');
  assert.equal(rows[1].stale, false);
  assert.equal(rows[1].waiting, '1 h');
});

void test('"new" compares with the last visit, per row and its revisions', () => {
  const failing = mine(1, { updatedAt: '2026-11-14T08:00:00Z' });
  const requested = member(2, { requestedReviewers: [LOGIN], updatedAt: '2026-11-14T08:00:00Z' });
  const items = [item([failing]), item([requested])];
  const values = { [failing.url]: signals(failing, { checks: 'failure' }) };
  const first = model(items, { signals: values });
  assert.equal(first.lanes.flatMap((state) => state.rows).filter((row) => row.isNew).length, 0, 'the first visit marks nothing');
  const visit = nextOverviewVisit(first, Date.parse('2026-11-14T09:00:00Z'));
  assert.equal(model(items, { signals: values, previous: visit }).fresh, 0);
  // A new review request appears, and the failing PR gets a new push.
  const pushed = { ...failing, headSha: 'head-1b', updatedAt: '2026-11-14T09:30:00Z' };
  const added = member(3, { requestedReviewers: [LOGIN], updatedAt: '2026-11-14T07:00:00Z' });
  const next = model([item([pushed]), item([requested]), item([added])], { signals: { [pushed.url]: signals(pushed, { checks: 'failure' }) }, previous: visit });
  assert.deepEqual(next.lanes.flatMap((state) => state.rows).filter((row) => row.isNew).map((row) => row.focus.number).sort(), [1, 3]);
  assert.equal(next.fresh, 2);
  // Updated after the visit, with the same key, is new too.
  const touched = model([item([failing]), item([{ ...requested, updatedAt: '2026-11-14T09:45:00Z' }])], { signals: values, previous: visit });
  assert.deepEqual(touched.lanes.flatMap((state) => state.rows).filter((row) => row.isNew).map((row) => row.focus.number), [2]);
});

void test('visits are saved per account and parsed defensively', () => {
  assert.equal(overviewVisitKey('oddur'), 'gnosis-overview-visit:v1:oddur');
  assert.deepEqual(parseOverviewVisit(JSON.stringify({ at: 5, keys: ['a', 3, 'b'] })), { at: 5, keys: ['a', 'b'] });
  assert.equal(parseOverviewVisit('not json'), undefined);
  assert.equal(parseOverviewVisit(JSON.stringify({ at: 'x', keys: [] })), undefined);
  assert.equal(parseOverviewVisit(null), undefined);
});

void test('old status leaves your PRs out of status lanes and is counted as unchecked', () => {
  const failing = mine(1);
  const result = model([item([failing])], { signals: { [failing.url]: signals(failing, { checks: 'failure', checkedAt: T0 - 31 * 60_000 }) } });
  assert.deepEqual(numbers(result, 'fix'), []);
  assert.equal(result.unchecked, 1);
  // A request from someone else's metadata is known without status.
  assert.deepEqual(numbers(model([item([mine(2, { requestedReviewers: ['lena'] })])]), 'waiting'), [2]);
});

void test('rows open where the notification for their reason opens', () => {
  const ready = mine(1);
  const failing = mine(2);
  const replies = mine(3);
  const requested = member(4, { requestedReviewers: [LOGIN] });
  const result = model(
    [item([ready]), item([failing]), item([replies], { responses: { [replies.url]: { changesRequested: false, unresolvedThreads: 1, awaitingReply: 1, complete: true } } }), item([requested], { review: review(requested.url) })],
    { signals: { [ready.url]: readySignals(ready), [failing.url]: signals(failing, { checks: 'failure' }), [replies.url]: passing(replies) } }
  );
  const target = (name: OverviewLane) => lane(result, name)[0]?.target;
  assert.deepEqual(target('merge'), { kind: 'pr', pr: { host: 'github.com', owner: 'o', repo: 'r', number: 1 }, focus: 'merge' });
  assert.deepEqual(target('fix'), { kind: 'pr', pr: { host: 'github.com', owner: 'o', repo: 'r', number: 2 }, tab: 'checks' });
  assert.deepEqual(target('answer'), { kind: 'pr', pr: { host: 'github.com', owner: 'o', repo: 'r', number: 3 }, tab: 'feedback' });
  assert.deepEqual(target('review'), { kind: 'pr', pr: { host: 'github.com', owner: 'o', repo: 'r', number: 4 }, tab: 'changes', focus: 'unviewed-file' });
  // A saved, current explanation marks the Review row.
  assert.deepEqual(lane(result, 'review')[0]?.explanation, { reviewId: 'review-4' });
  assert.deepEqual(rowReasons(lane(result, 'review')[0]), []);
});

void test('a row signature changes only with what the row shows', () => {
  const failing = mine(1);
  const values = { [failing.url]: signals(failing, { checks: 'failure' }) };
  const a = lane(model([item([failing])], { signals: values }), 'fix')[0];
  const b = lane(model([item([failing])], { signals: { [failing.url]: { ...values[failing.url], checkedAt: T0 - 1000 } } }), 'fix')[0];
  assert.equal(a.signature, b.signature, 'a sync tick with the same content keeps the row');
  const c = lane(model([item([{ ...failing, title: 'Renamed' }])], { signals: values }), 'fix')[0];
  assert.notEqual(a.signature, c.signature);
});

void test('waiting labels', () => {
  assert.equal(waitingLabel(T0, T0), 'now');
  assert.equal(waitingLabel(T0 - 12 * 60_000, T0), '12 m');
  assert.equal(waitingLabel(T0 - 5 * 3_600_000, T0), '5 h');
  assert.equal(waitingLabel(T0 - 2 * 86_400_000, T0), '2 d');
  assert.equal(waitingLabel(T0 - 70 * 86_400_000, T0), '10 w');
});

void test('the lane filter: saved as a word, resolved to PRs in the window, ignored where unresolved', () => {
  const a = mine(1);
  const b = mine(2);
  const filters = normalizeQueueFilters({ ...DEFAULT_QUEUE_FILTERS, lane: 'fix', laneUrls: [a.url] });
  assert.equal(filters.lane, 'fix');
  assert.equal(filters.laneUrls, undefined, 'resolved PRs are never saved');
  assert.equal(normalizeQueueFilters({ lane: 'bogus' }).lane, undefined);
  assert.equal('lane' in normalizeQueueFilters({}), false, 'filters saved before the Overview stay as they were');
  const resolved = withLaneUrls(filters, { merge: [], answer: [], review: [], fix: [a.url], waiting: [] });
  assert.equal(matchesQueueFilters(item([a]), resolved, T0, LOGIN), true);
  assert.equal(matchesQueueFilters(item([b]), resolved, T0, LOGIN), false);
  assert.equal(matchesQueueFilters(item([b]), withLaneUrls({ ...filters, lane: 'merge' }, { merge: [], answer: [], review: [], fix: [], waiting: [] }), T0, LOGIN), false, 'an empty lane matches nothing');
  assert.equal(matchesQueueFilters(item([b]), filters, T0, LOGIN), true, 'main, without lane PRs, does not narrow');
  assert.equal(withLaneUrls(DEFAULT_QUEUE_FILTERS, undefined), DEFAULT_QUEUE_FILTERS);
  assert.deepEqual(describeQueueFilters(filters), [{ key: 'lane', label: 'Overview: Fix' }]);
  assert.equal(activeQueueFilterCount(filters), 1);
});

void test('deep links name a lane and the Overview, and older links are unchanged', () => {
  const lane = parseDeepLink('gnosis://queue?lane=fix', ['gnosis']);
  assert.deepEqual(lane, { target: { kind: 'queue', filters: { lane: 'fix' } } });
  assert.equal(formatDeepLink({ kind: 'queue', filters: { lane: 'answer' } }), 'gnosis://queue?lane=answer');
  assert.ok('error' in parseDeepLink('gnosis://queue?lane=everything', ['gnosis']));
  assert.deepEqual(parseDeepLink('gnosis://queue?section=overview', ['gnosis']), { target: { kind: 'queue', section: 'overview' } });
  assert.deepEqual(parseDeepLink('gnosis://queue?section=requested', ['gnosis']), { target: { kind: 'queue', section: 'requested' } });
  const home: HomeLocation = { account: LOGIN, filters: DEFAULT_QUEUE_FILTERS, savedView: false, savedQuery: '', viewId: null, muted: false, item: null, tab: 'summary', selected: null, scroll: 0 };
  assert.deepEqual(targetFromLocation({ page: 'home', home: { ...home, overview: true } }), { kind: 'queue', section: 'overview' });
  assert.deepEqual(targetFromLocation({ page: 'home', home: { ...home, filters: { ...DEFAULT_QUEUE_FILTERS, lane: 'merge' } } }), { kind: 'queue', filters: { lane: 'merge' } });
});

void test('the home tab: Overview by default, the last choice remembered, named lists kept', () => {
  const values = new Map<string, string>();
  const store = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value) };
  assert.equal(homeTabPreference(store), 'overview');
  rememberHomeTab('queue', store);
  assert.equal(values.get(HOME_TAB_KEY), 'queue');
  assert.equal(homeTabPreference(store), 'queue');
  const home: HomeLocation = { account: LOGIN, filters: DEFAULT_QUEUE_FILTERS, savedView: false, savedQuery: '', viewId: null, muted: false, item: null, tab: 'summary', selected: null, scroll: 0 };
  assert.equal(restoredTool({ ...home, overview: true }, 'queue'), 'overview');
  assert.equal(restoredTool({ ...home, overview: false }, 'overview'), null);
  // Saved before the Overview existed: a plain queue opens the default; a named list keeps its list.
  assert.equal(restoredTool(home, 'overview'), 'overview');
  assert.equal(restoredTool(home, 'queue'), null);
  assert.equal(restoredTool({ ...home, viewId: 'view-1' }, 'overview'), null);
  assert.equal(restoredTool({ ...home, filters: { ...DEFAULT_QUEUE_FILTERS, attention: 'requested' } }, 'overview'), null);
  assert.equal(restoredTool({ ...home, muted: true }, 'overview'), 'muted');
  assert.equal(homeTabPreference({ getItem: () => { throw new Error('no storage'); }, setItem: () => undefined }), 'overview');
});

void test('the Overview tab title counts only the four action lanes, and nothing when there is no work', () => {
  const home: HomeLocation = { account: LOGIN, filters: DEFAULT_QUEUE_FILTERS, savedView: false, savedQuery: '', viewId: null, muted: false, overview: true, item: null, tab: 'summary', selected: null, scroll: 0 };
  const queue = { items: [item([mine(1)])], warnings: [], remaining: 0 };
  const tab = { id: 't', title: 'Overview', label: 'Queue', detail: '', section: 'queue', location: { page: 'home' as const, home } };
  const request = workspaceListingRequest(tab);
  assert.ok(request);
  assert.deepEqual(countWorkspaceListing(request, queue, [], LOGIN, T0, undefined, 13), { count: 13, unread: false });
  assert.equal(countWorkspaceListing(request, queue, [], LOGIN, T0, undefined, 0), undefined);
  assert.equal(countWorkspaceListing(request, queue, [], LOGIN, T0), undefined, 'unknown until the lanes are built');
  assert.equal(workspaceTabTitle(tab, countWorkspaceListing(request, queue, [], LOGIN, T0, undefined, 0)), 'Overview');
  assert.equal(workspaceTabTitle(tab, countWorkspaceListing(request, queue, [], LOGIN, T0, undefined, 4)), 'Overview (4)');
  // The queue tab keeps its own count.
  const queueTab = { ...tab, location: { page: 'home' as const, home: { ...home, overview: false } } };
  const queueRequest = workspaceListingRequest(queueTab);
  assert.ok(queueRequest);
  assert.equal(countWorkspaceListing(queueRequest, queue, [], LOGIN, T0, undefined, 4)?.count, 1);
  // The actionable count leaves Waiting out.
  assert.equal(model([item([mine(5, { requestedReviewers: ['lena'] })])]).actionable, 0);
});
