import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PR_SORT, normalizePrListSort, sortQueueItems, sortSavedReviews, type PrListSort } from '../lib/pr-list-sort';
import { DEFAULT_QUEUE_FILTERS, activeQueueFilterCount, normalizeQueueFilters, prioritizeBriefings } from '../lib/queue-filters';
import { normalizeViews, applyViewAction, editViewFilters, activeViewFilters, viewIsModified } from '../lib/saved-views';
import type { QueueItem, ReviewMember } from '../lib/workbench';
import type { QueueSignals } from '../lib/queue-signals';
import type { ReviewHistoryEntry } from '../lib/types';
const member = (number: number, patch: Partial<ReviewMember> = {}): ReviewMember => ({
  number, url: `https://github.com/org/repo/pull/${number}`, repo: 'org/repo', title: `PR ${number}`, author: 'alice',
  headSha: `head${number}`, createdAt: '2026-10-01', updatedAt: '2026-10-20', state: 'open', merged: false,
  isDraft: false, additions: 5, deletions: 2, labels: [], requestedReviewers: [], ...patch,
} as ReviewMember);
const item = (id: string, members: ReviewMember[], patch: Partial<QueueItem> = {}): QueueItem => ({
  subject: { id, kind: members.length > 1 ? 'stack' : 'pr', scope: 'single', title: members[0].title, members, edges: [] },
  attention: 'other', ...patch,
} as QueueItem);
const sort = (key: PrListSort['key'], direction: PrListSort['direction'] = 'asc', starredFirst = false): PrListSort => ({ key, direction, starredFirst });
const ids = (items: QueueItem[]) => items.map(item => item.subject.id);
void test('sort settings migrate independently from filters and reject unsupported values', () => {
  assert.deepEqual(normalizePrListSort(null), DEFAULT_PR_SORT);
  assert.deepEqual(normalizePrListSort({ key: 'invalid', direction: 'desc', starredFirst: false }), { ...DEFAULT_PR_SORT, starredFirst: false });
  assert.equal(normalizePrListSort({ key: 'updated' }).direction, 'desc');
  assert.equal(normalizePrListSort({ key: 'unread', direction: 'desc' }).direction, 'asc');
  assert.equal(normalizePrListSort({ key: 'generated' }).key, 'priority');
  assert.equal(normalizePrListSort({ key: 'generated' }, true).key, 'generated');
  assert.equal(activeQueueFilterCount(normalizeQueueFilters({ sort: sort('title') })), 0);
});
void test('stacks use member aggregates and keep dependency order', () => {
  const stack = item('stack', [member(1, { createdAt: '2026-09-01', updatedAt: '2026-10-01', author: 'zoe' }), member(2, { updatedAt: '2026-10-24', author: 'amy', additions: 100 })]);
  const single = item('single', [member(3)]);
  const original = JSON.stringify(stack);
  assert.deepEqual(ids(sortQueueItems([single, stack], sort('updated', 'desc'))), ['stack', 'single']);
  assert.deepEqual(ids(sortQueueItems([single, stack], sort('created'))), ['stack', 'single']);
  assert.deepEqual(ids(sortQueueItems([stack, single], sort('size'))), ['single', 'stack']);
  assert.deepEqual(ids(sortQueueItems([stack, single], sort('author'))), ['single', 'stack']);
  assert.equal(JSON.stringify(stack), original);
});
void test('explicit sorts cross attention groups; stars are optional and missing values stay last both ways', () => {
  const a = item('a', [member(1, { title: 'Zebra', additions: 100 })], { attention: 'updated' });
  const b = item('b', [member(2, { title: 'Apple' })], { starred: true });
  const missing = item('missing', [member(3, { additions: undefined })]);
  assert.deepEqual(ids(sortQueueItems([a, b], sort('title'))), ['b', 'a']);
  assert.deepEqual(ids(sortQueueItems([a, b], sort('size', 'desc', true))), ['b', 'a']);
  assert.deepEqual(ids(sortQueueItems([a, b], sort('size', 'desc'))), ['a', 'b']);
  for (const direction of ['asc', 'desc'] as const) assert.equal(sortQueueItems([missing, a, b], sort('size', direction)).at(-1)?.subject.id, 'missing');
  assert.deepEqual(ids(sortQueueItems([b, a], sort('priority'))), ['a', 'b']);
  assert.deepEqual(ids(sortQueueItems([item('z', [member(7)]), item('a', [member(8)])], sort('priority'))), ['z', 'a']);
});
void test('review status uses matching cached revisions and the earliest member status', () => {
  const rows = [item('unknown', [member(1)]), item('approved', [member(2)]), item('requested', [member(3)]), item('draft', [member(4, { isDraft: true })]), item('merged', [member(5, { merged: true })]), item('closed', [member(6, { state: 'closed' })])];
  const signals = [
    { url: member(1).url, headSha: 'old', readiness: { reviewDecision: 'CHANGES_REQUESTED' } },
    { url: member(2).url, headSha: member(2).headSha, readiness: { reviewDecision: 'APPROVED' } },
    { url: member(3).url, headSha: member(3).headSha, readiness: { reviewDecision: 'REVIEW_REQUIRED' } },
  ] as QueueSignals[];
  const stack = item('stack', [member(7), member(8)]);
  signals.push({ url: member(8).url, headSha: member(8).headSha, readiness: { reviewDecision: 'CHANGES_REQUESTED' } } as QueueSignals);
  assert.deepEqual(ids(sortQueueItems([...rows, stack], sort('status'), signals)), ['stack', 'requested', 'approved', 'draft', 'merged', 'closed', 'unknown']);
});
void test('unread sorts and briefing eligibility share the selected list order', () => {
  const a = item('a', [member(1, { title: 'Apple' })]);
  const z = item('z', [member(2, { title: 'Zebra', author: 'bob' })], { unreadUrls: [member(2).url] });
  assert.deepEqual(ids(sortQueueItems([a, z], sort('unread'))), ['z', 'a']);
  assert.deepEqual(ids(prioritizeBriefings([a, z], { ...DEFAULT_QUEUE_FILTERS, sort: sort('title', 'desc') })), ['z', 'a']);
  assert.deepEqual(ids(prioritizeBriefings([a, z], { ...DEFAULT_QUEUE_FILTERS, author: 'alice', sort: sort('title', 'desc') })), ['a']);
});
void test('saved reviews sort locally, with missing historical metadata last', () => {
  const old = { id: 'old', prTitle: 'Old', prUrl: member(1).url, author: 'amy', savedAt: '2026-09-01', prState: 'merged' } as ReviewHistoryEntry;
  const recent = { ...old, id: 'recent', prTitle: 'Recent', savedAt: '2026-10-01', prState: undefined };
  assert.deepEqual(sortSavedReviews([old, recent], DEFAULT_PR_SORT, new Set()).map(row => row.id), ['recent', 'old']);
  assert.deepEqual(sortSavedReviews([recent, old], sort('generated'), new Set()).map(row => row.id), ['old', 'recent']);
  assert.deepEqual(sortSavedReviews([recent, old], sort('status'), new Set()).map(row => row.id), ['old', 'recent']);
});
void test('saved views preserve independent sorting, update, reset and migration', () => {
  let state = normalizeViews(null, { sort: sort('size', 'desc') });
  state = applyViewAction(state, { type: 'create', name: 'Small PRs' }, () => 'one');
  state = editViewFilters(state, { ...activeViewFilters(state), sort: sort('size') });
  assert.ok(viewIsModified(state.views[0]));
  state = applyViewAction(state, { type: 'reset', id: 'one' }, () => 'unused');
  assert.equal(activeViewFilters(state).sort.direction, 'desc');
  state = editViewFilters(state, { ...activeViewFilters(state), sort: sort('title') });
  state = applyViewAction(state, { type: 'update', id: 'one' }, () => 'unused');
  state = normalizeViews(JSON.parse(JSON.stringify(state)));
  assert.equal(activeViewFilters(state).sort.key, 'title');
  state = applyViewAction(state, { type: 'activate', id: null }, () => 'unused');
  assert.deepEqual(activeViewFilters(state).sort, sort('size', 'desc'));
});
