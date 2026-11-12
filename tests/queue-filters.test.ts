import test from 'node:test';
import { normalizeLabelFilter } from '../lib/pr-label-filter';
import assert from 'node:assert/strict';
import {
  activeQueueFilterCount,
  describeQueueFilters,
  DEFAULT_QUEUE_FILTERS,
  matchesQueueFilters,
  matchesTargetBranch,
  normalizeQueueFilters,
  prioritizeBriefings,
  countBriefings,
  tallyBriefings,
  briefingPause,
} from '../lib/queue-filters';
import { groupSubjects, snapshot, type Briefing, type ReviewMember, type QueueItem } from '../lib/workbench';
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
      { ...DEFAULT_QUEUE_FILTERS, author: 'bob', status: 'draft', labels: normalizeLabelFilter('bug'), kind: 'stack' },
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
  assert.equal(matchesQueueFilters(stack, { ...filters, labels: normalizeLabelFilter('bug') }, now, 'alice'), false);
  assert.equal(matchesQueueFilters(stack, filters, now, 'alice'), true);
  assert.equal(stack.subject.members.length, 2);
  assert.deepEqual(prioritizeBriefings([item([member(3, { author: 'bob' })]), stack], filters, now, 'alice'), [stack]);
});

void test('read status and labels must match the same PR, with saved-view migration', () => {
  const read = member(1, { labels: ['bug'] });
  const unread = member(2, { baseBranch: 'pr-1', labels: ['feature'] });
  const stack = { ...item([read, unread]), unreadUrls: [unread.url] };
  const filters = normalizeQueueFilters({ readStatus: 'read', label: 'bug' });
  assert.equal(matchesQueueFilters(stack, filters), true);
  assert.equal(matchesQueueFilters(stack, { ...filters, readStatus: 'unread' }), false);
  assert.equal(matchesQueueFilters(stack, { ...filters, readStatus: 'unread', labels: normalizeLabelFilter('feature') }), true);
  assert.equal(matchesQueueFilters(stack, { ...filters, labels: normalizeLabelFilter('feature') }), false);
  assert.deepEqual(prioritizeBriefings([stack], filters), [stack]);
  assert.deepEqual(prioritizeBriefings([stack], { ...filters, readStatus: 'unread' }), []);
  assert.equal(normalizeQueueFilters({ unreadOnly: true }).readStatus, 'unread');
  assert.equal(normalizeQueueFilters({ unreadOnly: true, readStatus: 'all' }).readStatus, 'all');
  assert.equal(normalizeQueueFilters({ readStatus: 'invalid' }).readStatus, 'all');
  assert.deepEqual(normalizeQueueFilters(JSON.parse(JSON.stringify(filters))), filters);
});

void test('label tags match any or all names on one member, and No labels stays exclusive', () => {
  const stack = item([member(1, { labels: ['bug', 'urgent'] }), member(2, { baseBranch: 'pr-1', labels: ['feature'] })]);
  const filters = normalizeQueueFilters({ labels: { names: ['bug', 'feature'] } });
  assert.equal(matchesQueueFilters(stack, filters), true);
  assert.equal(matchesQueueFilters(stack, { ...filters, labels: { ...filters.labels, match: 'all' } }), false);
  assert.equal(matchesQueueFilters(stack, { ...filters, labels: normalizeLabelFilter({ names: ['BUG', 'urgent'], match: 'all' }) }), true);
  assert.equal(matchesQueueFilters(stack, { ...filters, labels: normalizeLabelFilter({ unlabelled: true }) }), false);
  assert.equal(matchesQueueFilters(item([member(3)]), { ...filters, labels: normalizeLabelFilter({ unlabelled: true }) }), true);
  assert.deepEqual(normalizeLabelFilter({ names: ['bug', 'BUG', '', null, 'feature'], match: 'all' }).names, ['bug', 'feature']);
  assert.deepEqual(normalizeLabelFilter({ names: ['bug'], unlabelled: true }).names, []);
  assert.deepEqual(normalizeLabelFilter({ names: ['all', 'No labels'] }).names, ['all', 'No labels']);
});

void test('label selections count as one filter and describe Any, All and No labels accurately', () => {
  assert.equal(activeQueueFilterCount(normalizeQueueFilters({})), 0);
  assert.equal(activeQueueFilterCount(normalizeQueueFilters({ labels: { names: [], match: 'all' } })), 0);
  const filters = normalizeQueueFilters({ labels: { names: ['bug', 'feature'], match: 'all' } });
  assert.equal(activeQueueFilterCount(filters), 1);
  assert.deepEqual(describeQueueFilters(filters), [{ key: 'labels', label: 'Labels (all): bug, feature' }]);
  assert.deepEqual(describeQueueFilters(normalizeQueueFilters({ labels: { unlabelled: true } })), [{ key: 'labels', label: 'No labels' }]);
});

void test('target branch patterns match whole, case-sensitive names with literal punctuation', () => {
  for (const [branch, pattern, expected] of [
    ['release/1.2', 'release/*', true],
    ['release/1.2/hotfix', 'release/*', true],
    ['release', 'release/*', false],
    ['feature/release/1.2', 'release/*', false],
    ['Release/1.2', 'release/*', false],
    ['main', 'main', true],
    ['main-next', 'main', false],
    ['release/1.2', 'release/?.?', true],
    ['release/11.2', 'release/?.?', false],
    ['release/1.2', 'release/1.2', true],
    ['release/1x2', 'release/1.2', false],
    ['fix/(api)+', 'fix/(api)+', true],
    ['fix/api', 'fix/(api)+', false],
    ['release/1/hotfix', '*/*fix', true],
    ['ab', '*ab*ab', false],
    ['anything', '**', true],
    ['main', '  ', true],
    ['main', ' main ', true],
    ['a'.repeat(300), '*a'.repeat(100) + 'b', false],
  ] as const) assert.equal(matchesTargetBranch(branch, pattern), expected, `${branch} / ${pattern}`);
});

void test('target branch combines on the same PR, preserves stacks, and limits automatic briefings', () => {
  const stack = item([member(1, { baseBranch: 'release/1.2' }), member(2, { baseBranch: 'pr-1', author: 'bob' })]);
  const other = item([member(3, { headBranch: 'release/1.2', baseBranch: 'main' })]);
  const filters = normalizeQueueFilters({ targetBranch: 'release/*' });
  assert.equal(matchesQueueFilters(stack, filters), true);
  assert.equal(matchesQueueFilters(other, filters), false, 'Match the target, not the source branch');
  assert.equal(matchesQueueFilters(stack, { ...filters, author: 'bob' }), false);
  assert.deepEqual(prioritizeBriefings([other, stack], filters), [stack]);
  assert.equal(stack.subject.members.length, 2);
  stack.subject.members[0].state = 'closed';
  assert.equal(matchesQueueFilters(stack, filters), false);
});

void test('target branch defaults, normalization and removable filter description', () => {
  assert.equal(normalizeQueueFilters({}).targetBranch, '');
  assert.equal(normalizeQueueFilters({ targetBranch: ['main'] }).targetBranch, '');
  const filters = normalizeQueueFilters({ targetBranch: ' release/* ' });
  assert.equal(filters.targetBranch, 'release/*');
  assert.equal(activeQueueFilterCount(filters), 1);
  assert.deepEqual(describeQueueFilters(filters), [{ key: 'targetBranch', label: 'Target branch: release/*' }]);
  assert.equal(activeQueueFilterCount({ ...filters, targetBranch: '' }), 0);
});

void test('needs my response matches one authored open stack member and survives saved filters', () => {
  const filters = normalizeQueueFilters({ involvement: 'response', labels: normalizeLabelFilter('bug') });
  assert.equal(filters.involvement, 'response');
  assert.ok(describeQueueFilters(filters).some(value => value.label === 'Needs my response'));
  const a = member(1, { labels: ['bug'] });
  const b = member(2, { baseBranch: 'pr-1', author: 'bob' });
  const stack = item([a, b]);
  stack.responses = { [b.url]: { changesRequested: true, unresolvedThreads: 0, complete: true } };
  assert.equal(matchesQueueFilters(stack, filters, now, 'alice'), false, 'Cannot borrow feedback from another author');
  const response = { changesRequested: false, unresolvedThreads: 1, complete: true };
  stack.responses[a.url] = response;
  assert.equal(matchesQueueFilters(stack, filters, now, 'ALICE'), true);
  assert.equal(matchesQueueFilters(stack, filters, now, null), false);
  assert.equal(matchesQueueFilters(stack, { ...filters, author: 'bob' }, now, 'alice'), false);
  assert.deepEqual(prioritizeBriefings([stack], filters, now, 'alice'), [stack]);
  response.unresolvedThreads = 0;
  assert.deepEqual(prioritizeBriefings([stack], filters, now, 'alice'), []);
  response.changesRequested = true;
  a.state = 'closed'; a.merged = true;
  stack.starredUrls = [a.url];
  assert.equal(matchesQueueFilters(stack, { ...filters, starredOnly: true }, now, 'alice'), false);
});

const briefed = (n: number, briefing?: Partial<Briefing>, patch: Partial<ReviewMember> = {}): QueueItem => ({
  ...item([member(n, patch)]),
  briefing: briefing && { key: `b${n}`, status: 'ready', updatedAt: 'now', ...briefing },
});
void test('briefing counts cover every state and name the reasons for paused briefings', () => {
  const entries = [
    briefed(1, { status: 'ready' }),
    briefed(2, { status: 'ready' }),
    briefed(3, { status: 'generating' }),
    briefed(4, { status: 'queued' }),
    briefed(5, { status: 'paused', pauseReason: 'limit' }),
    briefed(6, { status: 'paused', pauseReason: 'filter' }),
    // Snapshots without a reason still report the daily limit from the detail text.
    briefed(7, { status: 'paused', pauseDetail: 'Overall daily automatic briefing limit reached. Resets at midnight.' }),
    briefed(8, { status: 'paused', pauseDetail: 'Automatic briefings are off for owner/repo. You can generate a briefing manually.' }),
    briefed(9, { status: 'paused' }),
    briefed(10, { status: 'failed', error: 'boom' }),
    briefed(11, { status: 'cancelled' }),
    briefed(12),
  ];
  assert.deepEqual(tallyBriefings(entries), {
    all: 12,
    generating: 1,
    queued: 1,
    ready: 2,
    paused: 5,
    failed: 1,
    pauses: { limit: 2, filter: 1, manual: 1, waiting: 1 },
  });
  assert.equal(briefingPause({ key: 'x', status: 'paused', pauseReason: 'manual', pauseDetail: 'limit reached', updatedAt: 'now' }), 'manual');
});
void test('briefing counts apply every other filter, so each count is what its chip shows', () => {
  const entries = [
    briefed(1, { status: 'ready' }),
    briefed(2, { status: 'generating' }, { author: 'bob' }),
    briefed(3, { status: 'generating' }),
    briefed(4, { status: 'paused', pauseReason: 'limit' }),
  ];
  const alice = { ...DEFAULT_QUEUE_FILTERS, author: 'alice' };
  const counts = countBriefings(entries, alice, now);
  assert.equal(counts.all, 3);
  assert.equal(counts.generating, 1);
  // A briefing filter never changes its own counts.
  assert.deepEqual(countBriefings(entries, { ...alice, briefing: 'paused' }, now), counts);
  for (const state of ['generating', 'ready', 'paused'] as const) {
    const shown = entries.filter((entry) => matchesQueueFilters(entry, { ...alice, briefing: state }, now));
    assert.equal(shown.length, counts[state], state);
    assert.ok(shown.every((entry) => entry.briefing?.status === state));
  }
  assert.equal(matchesQueueFilters(briefed(5, { status: 'cancelled' }), { ...DEFAULT_QUEUE_FILTERS, briefing: 'failed' }, now), false);
  assert.equal(matchesQueueFilters(briefed(6), { ...DEFAULT_QUEUE_FILTERS, briefing: 'all' }, now), true);
});
void test('the briefing filter is a saved, removable queue filter that never decides which briefing runs', () => {
  assert.equal(normalizeQueueFilters({}).briefing, 'all');
  assert.equal(normalizeQueueFilters({ briefing: 'paused' }).briefing, 'paused');
  assert.equal(normalizeQueueFilters({ briefing: 'cancelled' }).briefing, 'all');
  const filters = { ...DEFAULT_QUEUE_FILTERS, briefing: 'ready' as const };
  assert.equal(activeQueueFilterCount(filters), 1);
  assert.deepEqual(describeQueueFilters(filters), [{ key: 'briefing', label: 'Briefing: ready' }]);
  const queued = briefed(1, { status: 'queued' });
  const ready = briefed(2, { status: 'ready' });
  // Filtering the list to ready briefings must not skip the queued briefing that runs next.
  assert.deepEqual(prioritizeBriefings([queued, ready], filters, now).map((entry) => entry.subject.id), [queued.subject.id, ready.subject.id]);
});
