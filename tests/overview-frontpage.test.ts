import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OVERVIEW_TILE_LANES,
  actionGroupOf,
  overviewActionGroups,
  overviewBriefing,
  overviewModel,
  overviewRowDetail,
  overviewStatusRequests,
  overviewTiles,
  type OverviewLane,
  type OverviewLaneState,
  type OverviewModel,
  type OverviewReason,
  type OverviewRow,
} from '../lib/overview';
import { DEFAULT_QUEUE_FILTERS, activeQueueFilterCount, describeQueueFilters, normalizeQueueFilters } from '../lib/queue-filters';
import { groupQueueItems, parseCollapsedGroups, repositoryOf, toggleCollapsedGroup } from '../lib/queue-groups';
import { applyViewAction, normalizeViews, viewIsModified } from '../lib/saved-views';
import { parseSavedQueue, serializeSavedQueue } from '../lib/saved-queue';
import { formatDeepLink, parseDeepLink, targetFromLocation } from '../lib/deep-link';
import type { HomeLocation } from '../lib/navigation-history';
import type { QueueItem, ReviewMember, WorkbenchQueue } from '../lib/workbench';
import type { QueueSignals } from '../lib/queue-signals';
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

/** A lane model with just what the briefing and tiles read: rows with a person and reasons. */
function lanes(spec: Partial<Record<OverviewLane, { person?: string; reasons?: OverviewReason[] }[]>>, parked = 0): Pick<OverviewModel, 'lanes' | 'counts' | 'parked'> {
  const states: OverviewLaneState[] = (['merge', 'answer', 'review', 'fix', 'waiting'] as const).map((lane) => ({
    lane,
    rows: (spec[lane] ?? []).map((row, index) => ({ id: `${lane}|${index}`, lane, person: row.person, reasons: row.reasons ?? [] }) as unknown as OverviewRow),
    parked: lane === 'merge' ? Array.from({ length: parked }, (_, index) => ({ id: `merge|p${index}`, lane }) as unknown as OverviewRow) : [],
    overWeek: 0,
  }));
  return { lanes: states, counts: Object.fromEntries(states.map((state) => [state.lane, state.rows.length])) as OverviewModel['counts'], parked };
}

void test('the briefing names who waits on your reply, counts reviews and merges, and mentions failed checks only when there are any', () => {
  assert.equal(
    overviewBriefing(lanes({ answer: [{ person: 'lena' }], review: [{}, {}], merge: [{}, {}, {}, {}] })),
    'lena is waiting on your reply, and 2 reviews are waiting on you. 4 PRs are approved and ready to merge.'
  );
  assert.equal(
    overviewBriefing(lanes({ merge: [{}], fix: [{ reasons: ['checks-failed'] }, { reasons: ['conflicts'] }, { reasons: ['checks-failed', 'conflicts'] }] })),
    '1 PR is approved and ready to merge, and 2 have failed checks.'
  );
  assert.equal(overviewBriefing(lanes({ fix: [{ reasons: ['checks-failed'] }] })), '1 PR has failed checks.');
  // Fix work without failed checks is still named, without inventing failures.
  assert.equal(overviewBriefing(lanes({ fix: [{ reasons: ['conflicts'] }, { reasons: ['restack'] }] })), '2 PRs need a fix.');
  assert.equal(overviewBriefing(lanes({ merge: [{}, {}], fix: [{ reasons: ['conflicts'] }] })), '2 PRs are approved and ready to merge, and 1 needs a fix.');
  assert.equal(overviewBriefing(lanes({ review: [{}] })), '1 review is waiting on you.');
});

void test('the briefing names at most two people, oldest wait first, and counts PRs when people wait on several', () => {
  assert.equal(overviewBriefing(lanes({ answer: [{ person: 'lena' }, { person: 'sam' }] })), 'lena and sam are waiting on your reply.');
  assert.equal(overviewBriefing(lanes({ answer: [{ person: 'lena' }, { person: 'lena' }] })), 'lena is waiting on your reply on 2 PRs.');
  assert.equal(overviewBriefing(lanes({ answer: [{ person: 'lena' }, { person: 'sam' }, { person: 'lena' }] })), 'lena and sam are waiting on your reply on 3 PRs.');
  assert.equal(
    overviewBriefing(lanes({ answer: [{ person: 'lena' }, { person: 'sam' }, { person: 'maya' }] })),
    'lena, sam and 1 other are waiting on your reply.'
  );
  assert.equal(
    overviewBriefing(lanes({ answer: [{ person: 'lena' }, { person: 'sam' }, { person: 'maya' }, { person: 'ivar' }, {}] })),
    'lena, sam and 2 others are waiting on your reply on 5 PRs.'
  );
  // Nobody known to name: the PRs are counted instead.
  assert.equal(overviewBriefing(lanes({ answer: [{}] })), '1 PR is waiting on your reply.');
  assert.equal(overviewBriefing(lanes({ answer: [{}, {}], review: [{}] })), '2 PRs are waiting on your reply, and 1 review is waiting on you.');
  // A login keeps GitHub's spelling, even at the start of a sentence.
  assert.match(overviewBriefing(lanes({ answer: [{ person: 'zsolt-klang' }] })), /^zsolt-klang is waiting/);
});

void test('with nothing actionable the briefing says so, and mentions Waiting on others when there is any', () => {
  assert.equal(overviewBriefing(lanes({})), 'Nothing needs you right now.');
  assert.equal(overviewBriefing(lanes({ waiting: [{}] })), 'Nothing needs you right now. 1 of your PRs is waiting on others.');
  assert.equal(overviewBriefing(lanes({ waiting: [{}, {}, {}] }, 12)), 'Nothing needs you right now. 3 of your PRs are waiting on others.');
  // Parked merges are not work: they do not make the day busy.
  assert.equal(overviewBriefing(lanes({}, 4)), 'Nothing needs you right now.');
});

void test('the briefing reads the real lanes: approvals, replies and failures from GitHub status', () => {
  const replied = mine(1);
  const requested = member(2, { requestedReviewers: [LOGIN] });
  const ready = mine(3);
  const failing = mine(4);
  const result = overviewModel({
    items: [
      item([replied], { responses: { [replied.url]: { changesRequested: false, unresolvedThreads: 1, awaitingReply: 1, complete: true } } }),
      item([requested]),
      item([ready]),
      item([failing]),
    ],
    signals: (m) =>
      ({
        [replied.url]: { ...signals(replied, { checks: 'success' }), activity: { recent: [{ kind: 'comment', id: 'c1', at: '2026-11-13T10:00:00Z', author: 'lena', automated: false }] } },
        [ready.url]: readySignals(ready),
        [failing.url]: signals(failing, { checks: 'failure' }),
      })[m.url] as QueueSignals | undefined,
    login: LOGIN,
    now: T0,
  });
  assert.equal(overviewBriefing(result), 'lena is waiting on your reply, and 1 review is waiting on you. 1 PR is approved and ready to merge, and 1 has failed checks.');
});

void test('tiles come in reading order with the three oldest rows, the lane count and its heading summary', () => {
  assert.deepEqual([...OVERVIEW_TILE_LANES], ['answer', 'review', 'merge', 'fix']);
  const fixes = Array.from({ length: 5 }, (_, i) => mine(10 + i, { updatedAt: new Date(T0 - (9 - i) * 86_400_000).toISOString() }));
  const free = mine(30);
  const idle = mine(31, { updatedAt: new Date(T0 - 6 * 86_400_000).toISOString() });
  const result = overviewModel({
    items: [...fixes, free, idle].map((pr) => item([pr])),
    signals: (m) =>
      m.url === free.url || m.url === idle.url
        ? signals(m, { checks: 'success', mergeState: 'CLEAN', decision: null })
        : fixes.some((pr) => pr.url === m.url)
          ? signals(m, { checks: 'failure' })
          : undefined,
    login: LOGIN,
    now: T0,
  });
  const tiles = overviewTiles(result);
  assert.deepEqual(tiles.map((tile) => tile.lane), ['answer', 'review', 'merge', 'fix']);
  const fix = tiles[3];
  assert.equal(fix.count, 5);
  assert.deepEqual(fix.rows.map((row) => row.focus.number), [10, 11, 12], 'the three that waited longest');
  assert.deepEqual(fix.summary, ['5 checks failed', '3 over a week']);
  const merge = tiles[2];
  assert.equal(merge.count, 1, 'Ready only');
  assert.deepEqual(merge.summary, ['1 parked']);
  // Empty tiles stay, with a count of 0 and no summary.
  assert.deepEqual([tiles[0].count, tiles[0].rows.length, tiles[0].summary], [0, 0, []]);
  // An item's details, kept for hover and focus: repository and PR, then what the tile does not already say.
  assert.equal(overviewRowDetail(fix.rows[0]), 'r #10 · Checks failed · Stale');
});

void test('groupBy is normalized, defaults to none, and is not a filter', () => {
  assert.equal(DEFAULT_QUEUE_FILTERS.groupBy, 'none');
  assert.equal(normalizeQueueFilters({}).groupBy, 'none', 'filters saved before grouping are unchanged');
  assert.equal(normalizeQueueFilters({ groupBy: 'action' }).groupBy, 'action');
  assert.equal(normalizeQueueFilters({ groupBy: 'repository' }).groupBy, 'repository');
  assert.equal(normalizeQueueFilters({ groupBy: 'author' }).groupBy, 'none');
  assert.equal(normalizeQueueFilters({ groupBy: 3 }).groupBy, 'none');
  const grouped = normalizeQueueFilters({ groupBy: 'action' });
  assert.equal(activeQueueFilterCount(grouped), 0, 'grouping, like sort, is not counted as a filter');
  assert.deepEqual(describeQueueFilters(grouped), []);
});

void test('saved views and the saved queue keep their grouping', () => {
  let state = normalizeViews({ views: [{ id: 'a', name: 'Mine', filters: { groupBy: 'repository' } }, { id: 'b', name: 'Old', filters: { involvement: 'mine' } }], activeId: 'a' });
  assert.equal(state.views[0].filters.groupBy, 'repository');
  assert.equal(state.views[1].filters.groupBy, 'none', 'a view saved before grouping is unchanged');
  assert.equal(viewIsModified(state.views[1]), false);
  // Changing the grouping is an edit to the view, saved with Update like a sort.
  state = { ...state, views: state.views.map((view) => (view.id === 'b' ? { ...view, draft: { ...view.draft, groupBy: 'action' as const } } : view)) };
  assert.equal(viewIsModified(state.views[1]), true);
  state = applyViewAction(state, { type: 'update', id: 'b' }, () => 'x');
  assert.equal(normalizeViews(JSON.parse(JSON.stringify(state))).views[1].filters.groupBy, 'action');
  // The queue copy saved for the next launch carries the filters as they were.
  const queue = { items: [item([member(1)])], filters: normalizeQueueFilters({ groupBy: 'action' }) } as unknown as WorkbenchQueue;
  const saved = parseSavedQueue(serializeSavedQueue(queue, LOGIN, T0), T0);
  assert.equal(normalizeQueueFilters(saved?.queue.filters).groupBy, 'action');
});

void test('deep links carry the grouping as group=…, and links without it are unchanged', () => {
  assert.deepEqual(parseDeepLink('gnosis://queue?group=action', ['gnosis']), { target: { kind: 'queue', filters: { group: 'action' } } });
  assert.deepEqual(parseDeepLink('gnosis://queue?lane=fix&group=repository', ['gnosis']), { target: { kind: 'queue', filters: { lane: 'fix', group: 'repository' } } });
  assert.ok('error' in parseDeepLink('gnosis://queue?group=none', ['gnosis']), 'none is the absence of the parameter');
  assert.ok('error' in parseDeepLink('gnosis://queue?group=author', ['gnosis']));
  assert.equal(formatDeepLink({ kind: 'queue', filters: { group: 'action' } }), 'gnosis://queue?group=action');
  for (const link of ['gnosis://queue?group=action', 'gnosis://queue?repo=o/r&group=repository', 'gnosis://queue?section=requested'])
    assert.equal(formatDeepLink((parseDeepLink(link, ['gnosis']) as { target: Parameters<typeof formatDeepLink>[0] }).target), link);
  const home: HomeLocation = { account: LOGIN, filters: DEFAULT_QUEUE_FILTERS, savedView: false, savedQuery: '', viewId: null, muted: false, item: null, tab: 'summary', selected: null, scroll: 0 };
  assert.deepEqual(targetFromLocation({ page: 'home', home: { ...home, filters: { ...DEFAULT_QUEUE_FILTERS, groupBy: 'action' } } }), { kind: 'queue', filters: { group: 'action' } });
  assert.deepEqual(targetFromLocation({ page: 'home', home }), { kind: 'queue' }, 'ungrouped lists say nothing about grouping');
});

void test('Action groups follow the Overview lanes, in its order, with Parked and Other, and hide empty groups', () => {
  const replied = mine(1);
  const requested = member(2, { requestedReviewers: [LOGIN] });
  const ready = mine(3);
  const failing = mine(4);
  const waiting = mine(5, { requestedReviewers: ['sam'] });
  const idle = mine(6, { updatedAt: new Date(T0 - 6 * 86_400_000).toISOString() });
  const unrelated = member(7);
  // Changes requested and failing checks: Answer comes first.
  const both = mine(8);
  const items = [
    item([replied], { responses: { [replied.url]: { changesRequested: false, unresolvedThreads: 1, awaitingReply: 1, complete: true } } }),
    item([requested]),
    item([ready]),
    item([failing]),
    item([waiting]),
    item([idle]),
    item([unrelated]),
    item([both]),
  ];
  const status: Record<string, QueueSignals> = {
    [replied.url]: signals(replied, { checks: 'success' }),
    [ready.url]: readySignals(ready),
    [failing.url]: signals(failing, { checks: 'failure' }),
    [waiting.url]: signals(waiting, { checks: 'success' }),
    [idle.url]: signals(idle, { checks: 'success', mergeState: 'CLEAN', decision: null }),
    [both.url]: signals(both, { checks: 'failure', review: { id: '1', author: 'maya', state: 'CHANGES_REQUESTED' } }),
  };
  const result = overviewModel({ items, signals: (m) => status[m.url], login: LOGIN, now: T0 });
  const groups = overviewActionGroups(result);
  assert.deepEqual(items.map((entry) => actionGroupOf(entry, groups)), ['answer', 'review', 'merge', 'fix', 'waiting', 'parked', 'other', 'answer']);
  // Sorted entries keep their order inside each group; groups follow the Overview.
  const grouping = groupQueueItems([...items].reverse(), 'action', { actionGroups: groups });
  assert.deepEqual(grouping?.groups.map((group) => [group.label, group.count]), [['Answer', 2], ['Review', 1], ['Merge', 1], ['Fix', 1], ['Waiting on others', 1], ['Parked', 1], ['Other', 1]]);
  assert.deepEqual(grouping?.items.slice(0, 2).map((entry) => entry.subject.members[0].number), [8, 1], 'the sort holds within a group');
  // Empty groups are hidden: with only Review and Other entries, only those two groups.
  assert.deepEqual(groupQueueItems([items[1], items[6]], 'action', { actionGroups: groups })?.groups.map((group) => group.key), ['action:review', 'action:other']);
  // Before the lanes are known, everything is Other.
  assert.deepEqual(groupQueueItems(items, 'action')?.groups.map((group) => group.label), ['Other']);
  assert.equal(groupQueueItems(items, 'none'), undefined, 'None leaves the list as it was');
});

void test('a stack goes to the first group any of its PRs is in', () => {
  const base = mine(1);
  const top = mine(2);
  const stack = item([base, top]);
  assert.equal(actionGroupOf(stack, { [top.url]: 'fix' }), 'fix');
  assert.equal(actionGroupOf(stack, { [top.url]: 'fix', [base.url]: 'answer' }), 'answer');
  assert.equal(actionGroupOf(stack, {}), 'other');
});

void test('Repository groups go alphabetically, ignoring case, and collapsed groups keep their heading and count', () => {
  const entries = [
    item([member(1, { repo: 'klang/engine', url: 'https://github.com/klang/engine/pull/1' })]),
    item([member(2, { repo: 'Acme/web', url: 'https://github.com/Acme/web/pull/2' })]),
    item([member(3, { repo: 'klang/cli', url: 'https://github.com/klang/cli/pull/3' })]),
    item([member(4, { repo: 'klang/engine', url: 'https://github.com/klang/engine/pull/4' })]),
  ];
  const grouping = groupQueueItems(entries, 'repository');
  assert.deepEqual(grouping?.groups.map((group) => [group.label, group.count]), [['Acme/web', 1], ['klang/cli', 1], ['klang/engine', 2]]);
  assert.deepEqual(grouping?.items.map((entry) => entry.subject.members[0].number), [2, 3, 1, 4]);
  const collapsed = groupQueueItems(entries, 'repository', { collapsed: new Set(['repository:klang/engine']) });
  assert.deepEqual(collapsed?.groups.map((group) => [group.key, group.count, group.collapsed]), [['repository:acme/web', 1, false], ['repository:klang/cli', 1, false], ['repository:klang/engine', 2, true]]);
  assert.deepEqual(collapsed?.items.map((entry) => entry.subject.members[0].number), [2, 3], 'collapsed entries leave the list, so j/k skip them');
  assert.equal(collapsed?.groupOf.get(entries[0].subject.id), undefined);
  // A merged stack base does not decide the repository.
  assert.equal(repositoryOf(item([member(5, { repo: 'a/old', merged: true, state: 'closed' }), member(6, { repo: 'a/new' })])), 'a/new');
});

void test('collapsed groups are remembered per view and parsed defensively', () => {
  let saved = toggleCollapsedGroup({}, 'view:a', 'action:parked');
  saved = toggleCollapsedGroup(saved, 'section:all', 'action:other');
  assert.deepEqual(saved, { 'view:a': ['action:parked'], 'section:all': ['action:other'] });
  assert.deepEqual(toggleCollapsedGroup(saved, 'view:a', 'action:parked'), { 'section:all': ['action:other'] });
  assert.deepEqual(toggleCollapsedGroup(saved, 'section:all', 'action:other', true), { 'view:a': ['action:parked'] }, 'a tile opens its group');
  assert.deepEqual(toggleCollapsedGroup(saved, 'section:all', 'action:fix', true), saved);
  assert.deepEqual(parseCollapsedGroups(JSON.stringify(saved)), saved);
  assert.deepEqual(parseCollapsedGroups('{"view:a":["x",3,"x"],"bad":"y"}'), { 'view:a': ['x'] });
  assert.deepEqual(parseCollapsedGroups('not json'), {});
  assert.deepEqual(parseCollapsedGroups(null), {});
});

void test('the Overview requests status for every PR that can appear in a lane, your own first', () => {
  const replied = member(1);
  const requested = member(2, { requestedReviewers: [LOGIN] });
  const team = member(3, { role: 'review-requested' });
  const reviewed = member(4);
  const ready = mine(5);
  const failing = mine(6);
  const waiting = mine(7, { requestedReviewers: ['sam'] });
  const idle = mine(8, { updatedAt: new Date(T0 - 6 * 86_400_000).toISOString() });
  const answer = mine(9);
  const unrelated = member(10);
  const snoozed = mine(11);
  const muted = mine(12);
  const closed = mine(13, { state: 'closed' });
  const stackBase = mine(14);
  const stackTop = mine(15);
  const items = [
    item([replied], { responses: { [replied.url]: { changesRequested: false, unresolvedThreads: 1, awaitingReply: 1, complete: true } } }),
    item([requested]),
    item([team]),
    item([reviewed], { attention: 'updated' }),
    item([ready]),
    item([failing]),
    item([waiting]),
    item([idle]),
    item([answer]),
    item([unrelated]),
    item([snoozed], { snoozedUrls: [snoozed.url] }),
    item([muted]),
    item([closed]),
    item([stackBase, stackTop]),
  ];
  const status: Record<string, QueueSignals> = {
    [ready.url]: readySignals(ready),
    [failing.url]: signals(failing, { checks: 'failure' }),
    [waiting.url]: signals(waiting, { checks: 'success' }),
    [idle.url]: signals(idle, { checks: 'success', mergeState: 'CLEAN', decision: null }),
    [answer.url]: signals(answer, { checks: 'success', review: { id: '1', author: 'maya', state: 'CHANGES_REQUESTED' } }),
    [stackBase.url]: signals(stackBase, { checks: 'failure' }),
    [stackTop.url]: readySignals(stackTop),
  };
  const excluded = new Set([muted.url]);
  const requests = overviewStatusRequests(items, LOGIN, { teamRequests: true, excluded });
  const urls = new Set(requests.map((request) => request.url));
  // Every row in every lane, Parked included, with status known and with it unknown.
  for (const known of [true, false]) {
    const model = overviewModel({ items, signals: (m) => (known ? status[m.url] : undefined), login: LOGIN, now: T0, teamRequests: true, excluded });
    const candidates = model.lanes.flatMap((lane) => [...lane.rows, ...lane.parked]).flatMap((row) => row.entries.map((entry) => entry.member.url));
    assert.ok(candidates.length > 0);
    for (const url of candidates) assert.ok(urls.has(url), `${url} is requested`);
    for (const lane of Object.values(model.urls)) for (const url of lane) assert.ok(urls.has(url), `${url} is requested`);
  }
  // Your own PRs come first, each revision once, with the head the snapshot holds.
  assert.deepEqual(requests.map((request) => Number(request.url.split('/').at(-1))), [5, 6, 7, 8, 9, 14, 15, 1, 2, 3, 4]);
  assert.deepEqual(requests[0], { url: ready.url, headSha: ready.headSha });
  // Unrelated, snoozed, muted and closed PRs are not read; team requests only when they count.
  for (const pr of [unrelated, snoozed, muted, closed]) assert.ok(!urls.has(pr.url), `${pr.number} is not requested`);
  assert.ok(!overviewStatusRequests(items, LOGIN, { excluded }).some((request) => request.url === team.url));
  assert.deepEqual(overviewStatusRequests(items, ''), []);
});
