import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_QUEUE_FILTERS,
  matchesQueueFilters,
  normalizeQueueFilters,
  prioritizeBriefings,
} from '../lib/queue-filters';
import { groupSubjects, snapshot, type ReviewMember, type QueueItem } from '../lib/workbench';
const now = Date.parse('2026-10-22T12:00:00Z');
const member = (n: number, patch: Partial<ReviewMember> = {}): ReviewMember => ({
  number: n,
  repo: 'owner/repo',
  baseRepo: 'owner/repo',
  headRepo: 'owner/repo',
  url: `https://github.com/owner/repo/pull/${n}`,
  title: `PR ${n}`,
  description: '',
  author: 'alice',
  role: 'watched',
  baseBranch: 'main',
  headBranch: `pr-${n}`,
  baseSha: 'base',
  headSha: `head-${n}`,
  merged: false,
  state: 'open',
  createdAt: '2026-10-21T12:00:00Z',
  updatedAt: '2026-10-22T10:00:00Z',
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
const item = (members: ReviewMember[]): QueueItem => ({ subject: groupSubjects(members)[0], attention: 'other' });
void test('combined member filters match one open PR and preserve the full stack', () => {
  const stack = item([member(1), member(2, { baseBranch: 'pr-1', author: 'bob', isDraft: true, labels: ['bug'] })]);
  assert.equal(matchesQueueFilters(stack, { ...DEFAULT_QUEUE_FILTERS, author: 'alice', status: 'draft' }, now), false);
  assert.equal(
    matchesQueueFilters(
      stack,
      { ...DEFAULT_QUEUE_FILTERS, author: 'bob', status: 'draft', label: 'bug', kind: 'stack' },
      now
    ),
    true
  );
  assert.equal(stack.subject.members.length, 2);
  stack.subject.members[0].merged = true;
  stack.subject.members[0].state = 'closed';
  assert.equal(matchesQueueFilters(stack, { ...DEFAULT_QUEUE_FILTERS, author: 'alice' }, now), false);
  assert.equal(matchesQueueFilters(stack, { ...DEFAULT_QUEUE_FILTERS, author: 'bob' }, now), true);
});
void test('creation age hides a recently updated backlog and includes the exact cutoff', () => {
  const old = item([member(1, { createdAt: '2020-01-01' })]);
  assert.equal(matchesQueueFilters(old, { ...DEFAULT_QUEUE_FILTERS, createdWithin: 30 }, now), false);
  assert.equal(matchesQueueFilters(old, { ...DEFAULT_QUEUE_FILTERS, updatedWithin: 7 }, now), true);
  const boundary = item([member(2, { createdAt: new Date(now - 7 * 86_400_000).toISOString() })]);
  assert.equal(matchesQueueFilters(boundary, { ...DEFAULT_QUEUE_FILTERS, createdWithin: 7 }, now), true);
});
void test('explanation filters distinguish generated content from freshness and personal review completion', () => {
  const entry = item([member(1)]);
  assert.equal(matchesQueueFilters(entry, { ...DEFAULT_QUEUE_FILTERS, explanation: 'none' }, now), true);
  entry.review = {
    id: 'r',
    prTitle: 'PR',
    prUrl: entry.subject.id,
    author: 'alice',
    riskLevel: 'low',
    savedAt: 'now',
    snapshot: snapshot(entry.subject),
    status: 'completed',
  };
  assert.equal(matchesQueueFilters(entry, { ...DEFAULT_QUEUE_FILTERS, explanation: 'ready' }, now), true);
  entry.subject.members[0].headSha = 'pushed';
  assert.equal(matchesQueueFilters(entry, { ...DEFAULT_QUEUE_FILTERS, explanation: 'outdated' }, now), true);
});
void test('briefing focus respects all filters and retains review priority within each group', () => {
  const a = item([member(1)]),
    b = item([member(2, { author: 'bob' })]),
    c = item([member(3, { author: 'bob' })]);
  assert.deepEqual(prioritizeBriefings([a, b, c], { ...DEFAULT_QUEUE_FILTERS, author: 'bob' }, now), [b, c]);
  assert.deepEqual(
    prioritizeBriefings([a, b, c], { ...DEFAULT_QUEUE_FILTERS, author: 'bob', briefingScope: 'all' }, now),
    [b, c, a]
  );
  assert.deepEqual(prioritizeBriefings([a, b], { ...DEFAULT_QUEUE_FILTERS, author: 'nobody' }, now), []);
});
void test('invalid or older saved filters normalize to supported defaults', () => {
  assert.deepEqual(normalizeQueueFilters(null), DEFAULT_QUEUE_FILTERS);
  assert.deepEqual(
    normalizeQueueFilters({ createdWithin: -10, status: 'merged', author: ['alice'] }),
    DEFAULT_QUEUE_FILTERS
  );
});

void test('retired dependency filters migrate to all stacks, preserving other constraints', () => {
  assert.deepEqual(normalizeQueueFilters({ attention: 'blocking', author: 'alice', createdWithin: 30 }), {
    ...DEFAULT_QUEUE_FILTERS,
    kind: 'stack',
    author: 'alice',
    createdWithin: 30,
  });
  const stack = item([member(1), member(2, { baseBranch: 'pr-1' })]);
  for (const attention of ['requested', 'updated', 'other'] as const) {
    assert.equal(matchesQueueFilters({ ...stack, attention }, { ...DEFAULT_QUEUE_FILTERS, kind: 'stack' }), true);
  }
});

void test('my PRs includes authorship, assignments, and review requests on the same matching open member', () => {
  const filters = { ...DEFAULT_QUEUE_FILTERS, involvement: 'mine' as const };
  for (const patch of [
    { author: 'Alice' },
    { author: 'bob', assignees: ['ALICE'] },
    { author: 'bob', requestedReviewers: ['alice'] },
    { author: 'bob', role: 'review-requested' as const },
  ]) {
    assert.equal(matchesQueueFilters(item([member(1, patch)]), filters, now, 'alice'), true);
  }
  assert.equal(matchesQueueFilters(item([member(1, { author: 'bob' })]), filters, now, 'alice'), false);
  assert.equal(matchesQueueFilters(item([member(1)]), filters, now, null), false);
  assert.equal(matchesQueueFilters(item([member(1, { merged: true, state: 'closed' })]), filters, now, 'alice'), false);
  const stack = item([member(1), member(2, { baseBranch: 'pr-1', author: 'bob', labels: ['bug'] })]);
  assert.equal(matchesQueueFilters(stack, { ...filters, label: 'bug' }, now, 'alice'), false);
  assert.equal(matchesQueueFilters(stack, filters, now, 'alice'), true);
  assert.equal(stack.subject.members.length, 2);
  assert.deepEqual(prioritizeBriefings([item([member(3, { author: 'bob' })]), stack], filters, now, 'alice'), [stack]);
});
