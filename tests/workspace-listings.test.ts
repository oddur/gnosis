import test from 'node:test';
import assert from 'node:assert/strict';
import { snapshot, groupSubjects, type ReviewMember, type QueueItem, type WorkbenchQueue } from '../lib/workbench';
import { normalizeQueueFilters } from '../lib/queue-filters';
import { emptyReadVersions } from '../lib/pr-read-state';
import { countWorkspaceListing, workspaceListingRequest } from '../lib/workspace-listings';
import { newWorkspaceTab } from '../lib/workspace-tabs';
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

void test('counts unique matching PRs, including stack members, without unread context siblings', () => {
  const stack = item([member(1), member(2, { baseBranch: 'pr-1', author: 'bob' })]);
  stack.unreadUrls = [stack.subject.members[1].url];
  const queue: WorkbenchQueue = { items: [stack, item([member(1)])], warnings: [], remaining: 0 };
  const request = { kind: 'queue' as const, query: '', filters: normalizeQueueFilters({ author: 'alice' }) };
  assert.deepEqual(countWorkspaceListing(request, queue, [], 'alice'), { count: 1, unread: false });
  assert.deepEqual(
    countWorkspaceListing({ ...request, filters: normalizeQueueFilters(undefined) }, queue, [], 'alice'),
    {
      count: 2,
      unread: true,
    }
  );
  assert.deepEqual(
    countWorkspaceListing(
      { ...request, filters: normalizeQueueFilters({ kind: 'stack', readStatus: 'unread' }) },
      queue,
      [],
      'alice'
    ),
    { count: 1, unread: true }
  );
});
void test('read state changes update unread-only counts and empty listings show zero', () => {
  const pr = item([member(1)]);
  pr.unreadUrls = [member(1).url];
  const queue: WorkbenchQueue = {
    items: [pr],
    readStates: {
      [member(1).url]: { url: member(1).url, headSha: 'head-1', versions: emptyReadVersions(), unread: [] },
    },
    warnings: [],
    remaining: 0,
  };
  const request = { kind: 'queue' as const, query: '', filters: normalizeQueueFilters({ readStatus: 'unread' }) };
  assert.deepEqual(countWorkspaceListing(request, queue, [], 'alice'), { count: 0, unread: false });
  assert.deepEqual(
    countWorkspaceListing({ ...request, filters: normalizeQueueFilters(undefined) }, queue, [], 'alice'),
    {
      count: 1,
      unread: false,
    }
  );
});
void test('saved view destinations work before mounting and respect target branch filters', () => {
  const filters = normalizeQueueFilters({ targetBranch: 'release/*' });
  const queue: WorkbenchQueue = {
    items: [item([member(1)]), item([member(2, { baseBranch: 'release/1' })])],
    warnings: [],
    remaining: 0,
    savedViews: {
      views: [{ id: 'hotfix', name: 'Hot fixes', filters, draft: filters }],
      activeId: null,
      queueDraft: normalizeQueueFilters(undefined),
      counts: {},
    },
  };
  const request = workspaceListingRequest(newWorkspaceTab('a', { kind: 'home', viewId: 'hotfix' }));
  assert.ok(request);
  assert.deepEqual(countWorkspaceListing(request, queue, [], 'alice'), { count: 1, unread: false });
  assert.equal(workspaceListingRequest(newWorkspaceTab('pr', { kind: 'home', url: member(1).url })), undefined);
  assert.equal(workspaceListingRequest(newWorkspaceTab('review', { kind: 'review', reviewId: 'saved' })), undefined);
});
void test('starred history remains countable while ordinary queues exclude merged PRs', () => {
  const pr = item([member(1, { merged: true, state: 'closed' })]);
  pr.starredUrls = [member(1).url];
  const queue: WorkbenchQueue = { items: [pr], starredItems: [pr], warnings: [], remaining: 0 };
  assert.deepEqual(countWorkspaceListing({ destination: { kind: 'home', section: 'starred' } }, queue, [], 'alice'), {
    count: 1,
    unread: false,
  });
  assert.deepEqual(countWorkspaceListing({ destination: { kind: 'home', section: 'all' } }, queue, [], 'alice'), {
    count: 0,
    unread: false,
  });
});

void test('explanation freshness is checked against the whole stack snapshot', () => {
  const stack = item([member(1), member(2, { baseBranch: 'pr-1' })]);
  stack.review = {
    id: 'r',
    prTitle: 'Stack',
    prUrl: member(1).url,
    author: 'alice',
    riskLevel: 'low',
    savedAt: 'now',
    snapshot: snapshot(stack.subject),
    status: 'completed',
  };
  const queue: WorkbenchQueue = { items: [stack], warnings: [], remaining: 0 };
  const request = { kind: 'queue' as const, query: '', filters: normalizeQueueFilters({ explanation: 'ready' }) };
  assert.deepEqual(countWorkspaceListing(request, queue, [], 'alice'), { count: 2, unread: false });
  stack.subject.members[1].headSha = 'new-commit';
  assert.deepEqual(countWorkspaceListing(request, queue, [], 'alice'), { count: 0, unread: false });
});
