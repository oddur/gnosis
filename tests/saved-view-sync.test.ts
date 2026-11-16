import test from 'node:test';
import assert from 'node:assert/strict';
import { sectionPatch, viewTopMembers, VIEW_TOP_ROWS } from '../lib/saved-view-sync';
import { DEFAULT_QUEUE_FILTERS, normalizeQueueFilters } from '../lib/queue-filters';
import { openRows } from '../lib/pr-open-targets';
import { createRowIntent } from '../lib/row-intent';
import { groupSubjects, type QueueItem, type ReviewMember } from '../lib/workbench';

const now = Date.parse('2026-10-22T12:00:00Z');
const member = (n: number, patch: Partial<ReviewMember> = {}): ReviewMember => ({
  number: n,
  repo: 'owner/repo',
  baseRepo: 'owner/repo',
  headRepo: 'owner/repo',
  url: `https://github.com/owner/repo/pull/${n}`,
  title: `PR ${String(n).padStart(2, '0')}`,
  description: '',
  author: 'alice',
  role: 'watched',
  baseBranch: 'main',
  headBranch: `pr-${n}`,
  baseSha: 'b'.repeat(40),
  headSha: String(n % 10).repeat(40),
  merged: false,
  state: 'open',
  createdAt: '2026-10-21T12:00:00Z',
  updatedAt: `2026-10-22T${String(n % 24).padStart(2, '0')}:00:00Z`,
  labels: [],
  mergeable: true,
  isDraft: false,
  commitCount: 1,
  requestedReviewers: [],
  requestedTeams: [],
  mergeableState: 'clean',
  autoMerge: null,
  milestone: null,
  ...patch,
});
const item = (members: ReviewMember[], attention: QueueItem['attention'] = 'other', starred = false): QueueItem => ({
  subject: groupSubjects(members)[0],
  attention,
  ...(starred ? { starred, starredUrls: members.map((m) => m.url) } : {}),
});
const urls = (members: { url: string }[]) => members.map((m) => m.url.replace('https://github.com/owner/repo/pull/', '#'));

void test("a view's top rows: its filters and sort over the current queue, at most one screenful", () => {
  const queue = {
    items: [
      item([member(1, { author: 'bob' })], 'requested'),
      item([member(2)], 'requested'),
      item([member(3, { author: 'bob' })], 'updated'),
      item([member(4, { author: 'bob', isDraft: true })], 'other'),
    ],
  };
  const bob = normalizeQueueFilters({ author: 'bob', sort: { key: 'title', direction: 'asc', starredFirst: false } });
  assert.deepEqual(urls(viewTopMembers(queue, bob, { now })), ['#1', '#3', '#4']);
  assert.deepEqual(
    urls(viewTopMembers(queue, { ...bob, sort: { key: 'title', direction: 'desc', starredFirst: false } }, { now })),
    ['#4', '#3', '#1'],
    'The view sorts as it would show'
  );
  assert.deepEqual(urls(viewTopMembers(queue, { ...bob, attention: 'requested' }, { now })), ['#1']);
  assert.deepEqual(viewTopMembers(queue, { ...bob, author: 'nobody' }, { now }), [], 'An empty view has nothing to read');

  const many = { items: Array.from({ length: 40 }, (_, i) => item([member(i + 1)])) };
  assert.equal(viewTopMembers(many, DEFAULT_QUEUE_FILTERS, { now }).length, VIEW_TOP_ROWS);
  assert.equal(viewTopMembers(many, DEFAULT_QUEUE_FILTERS, { now, limit: 3 }).length, 3);
});

void test('stacks count each PR toward the cap, and a starred view reads the starred list', () => {
  const stack = item([member(1), member(2, { baseBranch: 'pr-1' }), member(3, { baseBranch: 'pr-2' })]);
  const queue = {
    items: [stack, item([member(4)]), item([member(5)])],
    starredItems: [item([member(9)], 'other', true)],
  };
  const filters = normalizeQueueFilters({ sort: { key: 'title', direction: 'asc', starredFirst: false } });
  assert.deepEqual(urls(viewTopMembers(queue, filters, { now, limit: 4 })), ['#1', '#2', '#3', '#4']);
  assert.deepEqual(urls(viewTopMembers(queue, { ...filters, starredOnly: true }, { now })), ['#9']);
});

void test('sidebar sections apply over the queue filters, as clicking them does', () => {
  assert.deepEqual(sectionPatch('requested', { involvement: 'mine' }), {
    starredOnly: false,
    attention: 'requested',
    involvement: 'mine',
    kind: 'all',
  });
  assert.deepEqual(sectionPatch('stacks', { involvement: 'response' }), {
    starredOnly: false,
    attention: 'all',
    involvement: 'all',
    kind: 'stack',
  });
  assert.equal(sectionPatch('response', { involvement: 'all' }).involvement, 'response');
  assert.equal(sectionPatch('starred', { involvement: 'all' }).starredOnly, true);
  const queue = { items: [item([member(1)], 'requested'), item([member(2)], 'updated')] };
  assert.deepEqual(urls(viewTopMembers(queue, { ...DEFAULT_QUEUE_FILTERS, ...sectionPatch('updated', DEFAULT_QUEUE_FILTERS) }, { now })), ['#2']);
});

void test('hover targets: valid revisions only, at the tier after visible rows', () => {
  const members = [member(1), member(2, { headSha: 'short' }), member(3)];
  const { targets } = openRows([{ id: 'view:x', members }], { unread: members.map((m) => m.url) });
  assert.deepEqual(urls(targets), ['#1', '#3'], 'Local or incomplete records have nothing to prepare');
  assert.ok(targets.every((target) => target.tier === 2));
});

void test('resting on a view fires once; a quick sweep fires nothing; leaving clears', async () => {
  const fired: string[] = [];
  let cleared = 0;
  const intent = createRowIntent({ delayMs: 20, fire: (id) => fired.push(id), clear: () => cleared++ });
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  for (const id of ['view:a', 'section:all', 'view:b']) {
    intent.enter(id);
    await sleep(5);
  }
  intent.leave();
  await sleep(40);
  assert.deepEqual(fired, [], 'A fast sweep prepares nothing');
  intent.enter('view:a');
  await sleep(40);
  intent.enter('view:a');
  await sleep(40);
  assert.deepEqual(fired, ['view:a'], 'Resting prepares once');
  intent.leave();
  assert.equal(cleared, 1);
});
