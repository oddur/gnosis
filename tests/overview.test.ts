import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OVERVIEW_IDLE_MS,
  OVERVIEW_LANES,
  OVERVIEW_STALE_AFTER,
  dominantReason,
  elapsed,
  overviewCountChange,
  overviewRef,
  overviewRowDescription,
  repoName,
  spokenWaiting,
  isStale,
  nextOverviewVisit,
  overviewLaneSummary,
  overviewCountLine,
  overviewModel,
  overviewStaleLabel,
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
import { dedupeRestoredOverviews, defaultHomeTab, homeTabPreference, rememberHomeTab, restoredTool, HOME_TAB_KEY } from '../lib/home-tab';
import { initialWorkspaceTabs, newWorkspaceTab, reduceWorkspaceTabs, restoreWorkspaceTabs, saveWorkspaceTabs, type SavedWorkspaceTab, type WorkspaceTabsState } from '../lib/workspace-tabs';
import type { HomeLocation } from '../lib/navigation-history';
import { countWorkspaceListing, isOverviewTab, workspaceListingRequest, workspaceTabTitle } from '../lib/workspace-listings';
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

void test('ready to merge waits since the approval; a Ready merge is flagged after a day', () => {
  const ready = mine(1);
  const approvedAt = T0 - 3 * 86_400_000 - 60_000;
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
  // The note names the approver, so the row shows no person chip.
  assert.equal(rows[0].person, undefined);
  assert.deepEqual(rows[0].merge?.notes.map((note) => note.text), ['Approved by lena']);
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
  // Updated after the visit with no change of state (a label, a comment) is not new: the dot is for state changes.
  const touched = model([item([failing]), item([{ ...requested, updatedAt: '2026-11-14T09:45:00Z' }])], { signals: values, previous: visit });
  assert.deepEqual(touched.lanes.flatMap((state) => state.rows).filter((row) => row.isNew).map((row) => row.focus.number), []);
  // A PR whose status was still loading at the last visit is not new once it loads: its state then is not known.
  const loading = model(items, { signals: {} });
  const early = nextOverviewVisit(loading, Date.parse('2026-11-14T09:00:00Z'));
  assert.deepEqual(model(items, { signals: values, previous: early }).lanes.flatMap((state) => state.rows).filter((row) => row.isNew).map((row) => row.focus.number), []);
  // Its checks turning red after a visit that knew them green is new.
  const green = nextOverviewVisit(model(items, { signals: { [failing.url]: signals(failing, { checks: 'success', decision: 'REVIEW_REQUIRED' }) } }), Date.parse('2026-11-14T09:00:00Z'));
  assert.deepEqual(model(items, { signals: values, previous: green }).lanes.flatMap((state) => state.rows).filter((row) => row.isNew).map((row) => row.focus.number), [1]);
  // A visit saved before PR states were kept marks nothing new.
  assert.equal(model([item([pushed]), item([added])], { signals: values, previous: { at: visit.at, keys: [] } }).fresh, 0);
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

const ago = (days: number) => new Date(T0 - days * 86_400_000).toISOString();
const mergeRows = (result: OverviewModel) => [...lane(result, 'merge'), ...(result.lanes.find((state) => state.lane === 'merge')?.parked ?? [])];
const notes = (result: OverviewModel, n: number) => mergeRows(result).find((row) => row.focus.number === n)?.merge?.notes.map((note) => note.text);
const clean = (pr: ReviewMember, extra: Parameters<typeof signals>[1] = {}) => signals(pr, { checks: 'success', mergeState: 'CLEAN', ...extra });

void test('each Merge row says why it can merge, from what GitHub reported', () => {
  const one = mine(1);
  const many = mine(2);
  const unnamed = mine(3);
  const older = mine(4);
  const free = mine(5);
  const unknown = mine(6);
  const behind = mine(7);
  const behindSignals = clean(behind, { decision: null });
  const result = model([one, many, unnamed, older, free, unknown, behind].map((pr) => item([pr])), {
    signals: {
      [one.url]: clean(one, { decision: 'APPROVED', opinions: [{ id: '1', author: 'lena', state: 'APPROVED' }] }),
      // Newest approver first; your own review does not count.
      [many.url]: clean(many, {
        decision: 'APPROVED',
        opinions: [
          { id: '1', author: 'sam', state: 'APPROVED', at: '2026-11-13T00:00:00Z' },
          { id: '2', author: 'maya', state: 'APPROVED', at: '2026-11-14T08:00:00Z' },
          { id: '3', author: 'owen', state: 'APPROVED', at: '2026-11-12T00:00:00Z' },
          { id: '4', author: LOGIN, state: 'APPROVED' },
        ],
      }),
      // GitHub says approved but names nobody: say only that.
      [unnamed.url]: readySignals(unnamed),
      // A snapshot from before opinions were read names the newest review.
      [older.url]: clean(older, { decision: 'APPROVED', review: { id: '9', author: 'ivar', state: 'APPROVED' } }),
      [free.url]: clean(free, { decision: null }),
      // A review decision GitHub has not described: say what is known, no more.
      [unknown.url]: clean(unknown, { decision: 'PENDING_SOMETHING' }),
      [behind.url]: { ...behindSignals, readiness: { ...behindSignals.readiness!, behindBy: 3 } },
    },
  });
  assert.deepEqual(notes(result, 1), ['Approved by lena']);
  assert.deepEqual(notes(result, 2), ['Approved by maya and 2 others']);
  assert.deepEqual(notes(result, 3), ['Approved']);
  assert.deepEqual(notes(result, 4), ['Approved by ivar']);
  assert.deepEqual(notes(result, 5), ['No review required']);
  assert.deepEqual(notes(result, 6), ['Mergeable, not approved']);
  assert.deepEqual(notes(result, 7), ['No review required', 'Behind main by 3 commits']);
  assert.deepEqual(mergeRows(result).find((row) => row.focus.number === 7)?.merge?.notes.map((note) => note.kind), ['no-review', 'behind']);
});

void test('a stack member whose base is still open says so, and the stack merges base first', () => {
  const base = mine(10);
  const child = mine(11, { baseBranch: 'feature-10' });
  const top = mine(12, { baseBranch: 'feature-11' });
  const result = model([item([base, child, top])], {
    signals: {
      [base.url]: signals(base, { checks: 'failure' }),
      [child.url]: clean(child, { decision: 'APPROVED', opinions: [{ id: '1', author: 'lena', state: 'APPROVED' }] }),
      [top.url]: clean(top, { decision: null }),
    },
  });
  const [row] = lane(result, 'merge');
  assert.equal(row.merge?.member.number, 11, 'the lowest PR in the lane is the one to merge');
  assert.deepEqual(row.merge?.notes.map((note) => note.text), ['Approved by lena', 'Waits for #10 to merge']);
  // Once the base can merge too, it goes first and has no open base of its own.
  const ready = model([item([base, child])], { signals: { [base.url]: clean(base, { decision: null }), [child.url]: clean(child, { decision: null }) } });
  assert.equal(lane(ready, 'merge')[0].merge?.member.number, 10);
  assert.deepEqual(lane(ready, 'merge')[0].merge?.notes.map((note) => note.text), ['No review required']);
});

void test('the viewer is never the person on a row, in any lane', () => {
  const ready = mine(1);
  const replied = mine(2);
  const failing = mine(3);
  const awaiting = mine(4);
  const selfRequested = mine(5, { requestedReviewers: [LOGIN, 'sam'] });
  const requested = member(6, { requestedReviewers: [LOGIN] });
  const result = model(
    [
      item([ready]),
      item([replied], { responses: { [replied.url]: { changesRequested: false, unresolvedThreads: 1, awaitingReply: 1, complete: true } } }),
      item([failing]),
      item([awaiting]),
      item([selfRequested]),
      item([requested]),
    ],
    {
      signals: {
        [ready.url]: clean(ready, { decision: null }),
        [replied.url]: passing(replied),
        [failing.url]: signals(failing, { checks: 'failure' }),
        [awaiting.url]: passing(awaiting),
        [selfRequested.url]: passing(selfRequested),
      },
    }
  );
  const rows = result.lanes.flatMap((state) => [...state.rows, ...state.parked]);
  assert.equal(rows.length, 6);
  assert.ok(rows.every((row) => row.person?.toLowerCase() !== LOGIN), 'no row names you');
  const person = (name: OverviewLane, n: number) => lane(result, name).find((row) => row.focus.number === n)?.person;
  assert.equal(person('merge', 1), undefined);
  assert.equal(person('answer', 2), undefined, 'no reply by anyone else: no person');
  assert.equal(person('fix', 3), undefined, 'your own PR: no author chip');
  assert.equal(person('waiting', 4), undefined, 'GitHub requires a review and nobody is requested');
  assert.equal(person('waiting', 5), 'sam', 'the first requested reviewer who is not you');
  assert.equal(person('review', 6), 'alice', 'other people stay');
});

void test('Merge splits into Ready and Parked; only Ready counts as work', () => {
  const approved = mine(1);
  const free = mine(2);
  const idleFree = mine(3, { updatedAt: ago(5) });
  const idleApproved = mine(4, { updatedAt: ago(6) });
  const unapproved = mine(5);
  const reapproved = mine(6, { updatedAt: ago(6) });
  const result = model([approved, free, idleFree, idleApproved, unapproved, reapproved].map((pr) => item([pr])), {
    signals: {
      [approved.url]: clean(approved, { decision: 'APPROVED', opinions: [{ id: '1', author: 'lena', state: 'APPROVED' }] }),
      [free.url]: clean(free, { decision: null }),
      [idleFree.url]: clean(idleFree, { decision: null }),
      [idleApproved.url]: clean(idleApproved, { decision: 'APPROVED', opinions: [{ id: '1', author: 'lena', state: 'APPROVED', at: ago(6) }] }),
      [unapproved.url]: clean(unapproved, { decision: 'PENDING_SOMETHING' }),
      // An approval yesterday on a PR untouched for a week is recent activity.
      [reapproved.url]: clean(reapproved, { decision: 'APPROVED', opinions: [{ id: '1', author: 'sam', state: 'APPROVED', at: ago(1) }] }),
    },
  });
  const merge = result.lanes.find((state) => state.lane === 'merge');
  assert.deepEqual(merge?.rows.map((row) => row.focus.number).sort(), [1, 2, 6]);
  assert.deepEqual(merge?.parked.map((row) => row.focus.number).sort(), [3, 4, 5]);
  assert.ok(merge?.rows.every((row) => row.merge?.ready) && merge.parked.every((row) => row.merge?.ready === false));
  // The strip and the tab title count Ready only; the queue's lane filter keeps every mergeable PR.
  assert.equal(result.counts.merge, 3);
  assert.equal(result.parked, 3);
  assert.equal(result.actionable, 3);
  assert.equal(overviewCountLine(result.counts), 'Merge 3 · Answer 0 · Review 0 · Fix 0 · Waiting 0');
  assert.equal(result.urls.merge.length, 6);
  assert.equal(result.keys.length, 6, 'parked rows are part of the visit');
  // Only parked merges: nothing for the tab title.
  const parkedOnly = model([item([idleFree])], { signals: { [idleFree.url]: clean(idleFree, { decision: null }) } });
  assert.deepEqual([parkedOnly.counts.merge, parkedOnly.parked, parkedOnly.actionable], [0, 1, 0]);
  assert.equal(OVERVIEW_IDLE_MS, 3 * 86_400_000);
});

void test('each lane has its own limit before a row is flagged; Review and Answer count working days', () => {
  assert.deepEqual(OVERVIEW_STALE_AFTER, {
    merge: { days: 1, working: false },
    answer: { days: 2, working: true },
    review: { days: 2, working: true },
    fix: { days: 2, working: false },
    waiting: { days: 3, working: false },
  });
  const hours = (n: number) => n * 3_600_000;
  // T0 is Saturday 14 November, 10:00 UTC. A request on Thursday morning has waited under two working days
  // (in any time zone), though over two calendar days.
  const thursday = Date.parse('2026-11-12T09:00:00Z');
  assert.ok(elapsed(thursday, T0, true) < hours(48));
  assert.equal(elapsed(thursday, T0), hours(49));
  assert.equal(isStale('review', thursday, T0), false);
  assert.equal(isStale('answer', thursday, T0), false);
  assert.equal(isStale('fix', thursday, T0), true);
  // From Tuesday, the working days are past two.
  assert.equal(isStale('review', Date.parse('2026-11-10T10:00:00Z'), T0), true);
  // Merge: a day. Waiting on others: three.
  assert.equal(isStale('merge', T0 - hours(23), T0), false);
  assert.equal(isStale('merge', T0 - hours(25), T0), true);
  assert.equal(isStale('waiting', T0 - hours(71), T0), false);
  assert.equal(isStale('waiting', T0 - hours(73), T0), true);
  assert.equal(elapsed(T0, T0 - 1, true), 0, 'a future time has not waited');
});

void test('rows are flagged by their lane limit, Parked merges never, and headings count rows over a week', () => {
  const review = member(1, { requestedReviewers: [LOGIN], createdAt: ago(1.5) });
  const failing = mine(2, { updatedAt: ago(2.5) });
  const oldFailing = mine(3, { updatedAt: ago(9) });
  const parked = mine(4, { updatedAt: ago(8) });
  const waiting = mine(5, { requestedReviewers: ['lena'], createdAt: ago(2) });
  const result = model([review, failing, oldFailing, parked, waiting].map((pr) => item([pr])), {
    signals: {
      [failing.url]: signals(failing, { checks: 'failure' }),
      [oldFailing.url]: signals(oldFailing, { checks: 'failure' }),
      [parked.url]: clean(parked, { decision: null }),
      [waiting.url]: passing(waiting),
    },
  });
  const flag = (name: OverviewLane, n: number) => {
    const state = result.lanes.find((entry) => entry.lane === name);
    return [...(state?.rows ?? []), ...(state?.parked ?? [])].find((row) => row.focus.number === n)?.stale;
  };
  assert.equal(flag('review', 1), false, 'a day and a half is not an outlier');
  assert.equal(flag('fix', 2), true);
  assert.equal(flag('fix', 3), true);
  assert.equal(flag('merge', 4), false, 'parked rows are already set aside');
  assert.equal(flag('waiting', 5), false);
  const fix = result.lanes.find((state) => state.lane === 'fix');
  assert.equal(fix?.overWeek, 1);
  assert.deepEqual(overviewLaneSummary(fix!), ['2 checks failed', '1 over a week']);
  const merge = result.lanes.find((state) => state.lane === 'merge');
  assert.deepEqual(overviewLaneSummary(merge!), ['1 parked'], 'parked rows are not counted as over a week');
  assert.deepEqual(overviewLaneSummary(result.lanes.find((state) => state.lane === 'review')!), []);
});

void test('at real volume, the flag is rare: only outliers carry it', () => {
  // The critique's screenshot: Merge 16 (none approved, idle five to eight days), Review 2, Fix 18, Waiting 5.
  const prs: ReviewMember[] = [];
  const status: Record<string, QueueSignals> = {};
  const add = (pr: ReviewMember, value: QueueSignals) => {
    prs.push(pr);
    status[pr.url] = value;
  };
  for (let i = 0; i < 16; i++) {
    const pr = mine(100 + i, { updatedAt: ago(5 + (i % 4)) });
    add(pr, clean(pr, { decision: null }));
  }
  for (let i = 0; i < 18; i++) {
    const pr = mine(200 + i, { updatedAt: ago(i < 3 ? 0.2 : 10 + (i % 3)) });
    add(pr, signals(pr, { checks: 'failure' }));
  }
  for (let i = 0; i < 5; i++) {
    const pr = mine(300 + i, { requestedReviewers: ['lena'], createdAt: ago(i === 0 ? 10 : 0.1) });
    add(pr, passing(pr));
  }
  const reviews = [member(400, { requestedReviewers: [LOGIN], createdAt: ago(14) }), member(401, { requestedReviewers: [LOGIN], createdAt: ago(0.5) })];
  const result = model([...prs, ...reviews].map((pr) => item([pr])), { signals: status });
  const rows = result.lanes.flatMap((state) => [...state.rows, ...state.parked]);
  assert.equal(rows.length, 41);
  // Before: anything over three days was flagged. Now: only rows past their lane's limit, and never a Parked merge.
  const before = rows.filter((row) => T0 - row.since >= 3 * 86_400_000).length;
  const after = rows.filter((row) => row.stale).length;
  assert.equal(before, 33);
  assert.equal(after, 17);
  assert.equal(result.lanes.find((state) => state.lane === 'merge')?.rows.filter((row) => row.stale).length, 0);
  assert.deepEqual(overviewLaneSummary(result.lanes.find((state) => state.lane === 'fix')!), ['18 checks failed', '15 over a week']);
  assert.deepEqual(overviewLaneSummary(result.lanes.find((state) => state.lane === 'merge')!), ['16 parked']);
});

void test('a reason most rows share moves to the heading; rows keep only how they differ', () => {
  const failing = [1, 2, 3].map((n) => mine(n));
  const conflicted = mine(4);
  const restack = mine(5, { baseBranch: 'feature-9' });
  const merged = mine(9, { merged: true, state: 'closed' });
  const result = model([...failing.map((pr) => item([pr])), item([conflicted]), item([merged, restack])], {
    signals: {
      ...Object.fromEntries(failing.map((pr) => [pr.url, signals(pr, { checks: 'failure' })])),
      [conflicted.url]: passing(conflicted, { mergeable: 'CONFLICTING', mergeState: 'DIRTY' }),
      [restack.url]: passing(restack),
    },
  });
  const fix = result.lanes.find((state) => state.lane === 'fix')!;
  assert.deepEqual(fix.dominant, { reason: 'checks-failed', count: 3 });
  assert.deepEqual(overviewLaneSummary(fix), ['3 checks failed']);
  const shown = Object.fromEntries(fix.rows.map((row) => [row.focus.number, row.shown]));
  assert.deepEqual(shown, { 1: [], 2: [], 3: [], 4: ['conflicts'], 5: ['restack'] });
  // The lane name still implies its own reason, and a lane without a majority keeps every reason.
  assert.deepEqual(rowReasons({ lane: 'review', reasons: ['review-requested', 'updated-since-review'] }), ['updated-since-review']);
  assert.equal(dominantReason('fix', [{ reasons: ['checks-failed'] }, { reasons: ['conflicts'] }]), undefined);
  assert.equal(dominantReason('fix', [{ reasons: ['checks-failed'] }]), undefined, 'one row is not a pattern');
  assert.equal(dominantReason('review', [{ reasons: ['updated-since-review'] }, { reasons: ['updated-since-review'] }]), undefined, 'Review keeps its own words');
  // The row signature follows what the row shows.
  const alone = model([item([failing[0]])], { signals: { [failing[0].url]: signals(failing[0], { checks: 'failure' }) } });
  assert.deepEqual(lane(alone, 'fix')[0].shown, ['checks-failed']);
  assert.notEqual(lane(alone, 'fix')[0].signature, fix.rows.find((row) => row.focus.number === 1)?.signature);
});

void test('repository and PR are one short token; a stack collapses its numbers', () => {
  assert.equal(repoName('klanggames/web-seed-portal'), 'web-seed-portal');
  assert.equal(repoName('solo'), 'solo');
  const pr = mine(1994, { repo: 'klanggames/web-seed-portal' });
  const [single] = lane(model([item([pr])], { signals: { [pr.url]: signals(pr, { checks: 'failure' }) } }), 'fix');
  assert.deepEqual(overviewRef(single), { repo: 'web-seed-portal', number: '#1994', title: 'klanggames/web-seed-portal #1994' });
  const members = [380, 381, 384, 386].map((n, i) => mine(n, { repo: 'klanggames/seed-launcher', baseBranch: i ? `feature-${[380, 381, 384][i - 1]}` : 'main' }));
  const stack = model([item(members)], { signals: Object.fromEntries(members.map((m) => [m.url, signals(m, { checks: 'failure' })])) });
  assert.deepEqual(overviewRef(lane(stack, 'fix')[0]), { repo: 'seed-launcher', number: '#380 +3', title: 'klanggames/seed-launcher #380, #381, #384, #386' });
});

void test('a row describes itself in one sentence, including the reason its heading carries', () => {
  const failing = [1, 2, 3].map((n) => mine(n, { repo: 'klanggames/web-seed-portal', updatedAt: ago(11) }));
  const waiting = mine(4, { requestedReviewers: ['lena'], createdAt: ago(4) });
  const requested = member(5, { requestedReviewers: [LOGIN], createdAt: ago(0.25), author: 'maya' });
  const ready = mine(6);
  const result = model([...[...failing, waiting, requested, ready].map((pr) => item([pr]))], {
    signals: {
      ...Object.fromEntries(failing.map((pr) => [pr.url, signals(pr, { checks: 'failure' })])),
      [waiting.url]: passing(waiting),
      [ready.url]: clean(ready, { decision: 'APPROVED', opinions: [{ id: '1', author: 'lena', state: 'APPROVED' }] }),
    },
  });
  const fix = lane(result, 'fix')[0];
  assert.deepEqual(fix.shown, [], 'the heading carries "checks failed"');
  assert.equal(overviewRowDescription(fix), 'Checks failed, web-seed-portal #1, waiting 11 days, stale');
  assert.equal(overviewRowDescription(lane(result, 'waiting')[0]), 'Awaiting review, r #4, on lena, waiting 4 days, consider a nudge');
  assert.equal(overviewRowDescription(lane(result, 'review')[0]), 'r #5, by maya, waiting 6 hours');
  assert.equal(overviewRowDescription(lane(result, 'merge')[0]), 'Approved by lena, r #6, waiting 1 hour');
  // A stack names its first PR and how many more.
  const members = [380, 381, 384].map((n, i) => mine(n, { repo: 'klanggames/seed-launcher', baseBranch: i ? `feature-${[380, 381][i - 1]}` : 'main', updatedAt: ago(0.5) }));
  const stack = model([item(members)], { signals: Object.fromEntries(members.map((m) => [m.url, signals(m, { checks: 'failure' })])) });
  assert.equal(overviewRowDescription(lane(stack, 'fix')[0]), 'Checks failed, seed-launcher #380 and 2 more, waiting 12 hours');
  assert.deepEqual(['now', '1 m', '5 h', '1 d', '3 w'].map(spokenWaiting), ['just now', '1 minute', '5 hours', '1 day', '3 weeks']);
});

void test('lane count changes are announced briefly; no change says nothing', () => {
  const before = { merge: 2, answer: 0, review: 3, fix: 1, waiting: 4 };
  assert.equal(overviewCountChange(before, { ...before }), '');
  assert.equal(overviewCountChange(before, { ...before, fix: 2, merge: 1 }), 'Merge 1, was 2. Fix 2, was 1.');
});

void test('edge cases: no author, a long repository name, and a thousand PRs', () => {
  // A PR whose author GitHub no longer knows (a deleted account) shows no person rather than an empty chip.
  const ghost = member(1, { requestedReviewers: [LOGIN], author: '' });
  assert.equal(lane(model([item([ghost])]), 'review')[0].person, undefined);
  const long = mine(2, { repo: 'an-organisation-with-a-long-name/a-repository-name-that-goes-on-for-a-while' });
  const [row] = lane(model([item([long])], { signals: { [long.url]: signals(long, { checks: 'failure' }) } }), 'fix');
  assert.equal(overviewRef(row).repo, 'a-repository-name-that-goes-on-for-a-while');
  assert.equal(overviewRef(row).title, 'an-organisation-with-a-long-name/a-repository-name-that-goes-on-for-a-while #2');
  // A thousand PRs build quickly, and every one lands in a lane.
  const many = Array.from({ length: 1000 }, (_, i) => mine(1000 + i, { updatedAt: ago(i % 20) }));
  const status = Object.fromEntries(many.map((pr, i) => [pr.url, i % 2 ? signals(pr, { checks: 'failure' }) : clean(pr, { decision: null })]));
  const started = performance.now();
  const big = model(many.map((pr) => item([pr])), { signals: status });
  const took = performance.now() - started;
  assert.equal(big.counts.fix + big.counts.merge + big.parked, 1000);
  assert.ok(took < 1500, `a thousand PRs took ${Math.round(took)} ms`);
  // Nothing at all: every lane is empty and nothing is counted.
  const none = model([]);
  assert.deepEqual([none.actionable, none.parked, none.keys.length], [0, 0, 0]);
});

void test('the stale label is a word, and Waiting on others asks whether to nudge', () => {
  assert.equal(overviewStaleLabel({ lane: 'waiting', stale: true }), 'Nudge?');
  for (const name of ['merge', 'answer', 'review', 'fix'] as const) assert.equal(overviewStaleLabel({ lane: name, stale: true }), 'Stale');
  assert.equal(overviewStaleLabel({ lane: 'waiting', stale: false }), undefined);
});

void test('one Overview at a time by default: restored tabs, new tabs and Cmd-click', () => {
  const home = { account: LOGIN, filters: DEFAULT_QUEUE_FILTERS, savedView: false, savedQuery: '', viewId: null, muted: false, tab: 'summary' as const, selected: null, scroll: 0 };
  const tab = (id: string, extra: Partial<SavedWorkspaceTab> = {}): SavedWorkspaceTab => ({ id, title: 'Review queue', label: 'Queue', detail: '', section: 'queue', home, ...extra });
  const restore = (tabs: SavedWorkspaceTab[], active = tabs[0].id) => restoreWorkspaceTabs({ version: 1, active, tabs }, LOGIN)!;
  const tools = (state: WorkspaceTabsState) =>
    state.tabs.map((entry) => {
      const saved = entry.initial?.kind === 'restore' ? entry.initial.saved : undefined;
      const tool = saved?.home ? restoredTool({ ...saved.home, item: null }, entry.homeDefault) : entry.homeDefault === 'overview' ? 'overview' : null;
      if (!saved?.home?.subjectId) assert.equal(isOverviewTab(entry), tool === 'overview', `${entry.id}: the tab strip counts what the tab shows`);
      return tool;
    });

  // Three plain queues saved by v0.40.0 (no `overview` field): one Overview, the first, and two queues.
  const legacy = [tab('a'), tab('b'), tab('c')];
  assert.deepEqual(tools(dedupeRestoredOverviews(restore(legacy), 'overview')), ['overview', null, null]);
  // The active tab wins when it is one of them.
  assert.deepEqual(tools(dedupeRestoredOverviews(restore(legacy, 'b'), 'overview')), [null, 'overview', null]);
  // A reader who chose the queue gets no Overview by default.
  assert.deepEqual(tools(dedupeRestoredOverviews(restore(legacy), 'queue')), [null, null, null]);
  // Tabs saved while they showed the Overview keep that name until shown: only the kept one may still say so.
  const titled = [tab('a', { title: 'Overview' }), tab('b', { title: 'Overview' }), tab('c', { title: 'Overview' })];
  assert.deepEqual(dedupeRestoredOverviews(restore(titled, 'c'), 'overview').tabs.map((entry) => entry.title), ['Review queue', 'Review queue', 'Overview']);
  // Two tabs saved with `overview: true`: one stays, the active one, else the first.
  const explicit = [tab('a', { home: { ...home, overview: true } }), tab('b', { home: { ...home, overview: true } }), tab('c')];
  assert.deepEqual(tools(dedupeRestoredOverviews(restore(explicit), 'overview')), ['overview', null, null]);
  assert.deepEqual(tools(dedupeRestoredOverviews(restore(explicit, 'b'), 'overview')), [null, 'overview', null]);
  // A saved Overview wins over a tab that would show it only by default, even the active one.
  assert.deepEqual(tools(dedupeRestoredOverviews(restore([tab('a'), tab('b', { home: { ...home, overview: true } })], 'a'), 'overview')), [null, 'overview']);
  // Named lists and PRs are left alone.
  const lists = [tab('a', { home: { ...home, muted: true } }), tab('b', { home: { ...home, viewId: 'v' } }), tab('c', { home: { ...home, subjectId: 's' } }), tab('d')];
  const listed = dedupeRestoredOverviews(restore(lists), 'overview');
  assert.deepEqual(tools(listed), ['muted', null, null, 'overview']);
  // Tabs never shown, saved as a plain home destination: the same rule, and the choice is saved.
  const plain = [tab('a', { home: undefined }), tab('b', { home: undefined, destination: { kind: 'home' } })];
  const deduped = dedupeRestoredOverviews(restore(plain), 'overview');
  assert.deepEqual(deduped.tabs.map(isOverviewTab), [true, false]);
  assert.deepEqual(saveWorkspaceTabs(deduped).tabs.map((saved) => saved.destination?.section), ['overview', undefined]);
  // The saved choice restores again, with 'overview' now a valid saved section.
  assert.deepEqual(dedupeRestoredOverviews(restore(saveWorkspaceTabs(deduped).tabs), 'overview').tabs.map(isOverviewTab), [true, false]);

  // A new tab: the queue while another tab shows the Overview, the preference when none does.
  const overview = newWorkspaceTab('o', { kind: 'home', section: 'overview' });
  const queue = newWorkspaceTab('q', { kind: 'home', section: 'all' });
  assert.equal(defaultHomeTab([overview, queue], 'overview'), 'queue');
  assert.equal(defaultHomeTab([queue], 'overview'), 'overview');
  assert.equal(defaultHomeTab([], 'queue'), 'queue');
  const shown = newWorkspaceTab('s');
  shown.location = { page: 'home', home: { ...home, overview: true, item: null } };
  assert.equal(defaultHomeTab([shown], 'overview'), 'queue');
  assert.equal(isOverviewTab({ ...newWorkspaceTab('n'), homeDefault: defaultHomeTab([overview], 'overview') }), false);
  assert.equal(isOverviewTab({ ...newWorkspaceTab('n'), homeDefault: defaultHomeTab([queue], 'overview') }), true);
  // Cmd-click or a link asks for the Overview by name: a second one opens on purpose.
  let state = initialWorkspaceTabs(overview);
  state = reduceWorkspaceTabs(state, { type: 'open', tab: { ...newWorkspaceTab('cmd', { kind: 'home', section: 'overview' }), homeDefault: defaultHomeTab(state.tabs, 'overview') }, background: true });
  assert.deepEqual(state.tabs.map(isOverviewTab), [true, true]);
});
