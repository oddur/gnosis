import test from 'node:test';
import assert from 'node:assert/strict';
import { groupSubjects, type QueueItem, type ReviewMember, type WorkbenchQueue } from '../lib/workbench';
import { contentHash, itemRevision, stampQueue } from '../lib/workbench-revision';
import { normalizeQueueFilters } from '../lib/queue-filters';
import type { ReviewHistoryEntry } from '../lib/types';

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
const item = (n: number): QueueItem => ({
  subject: groupSubjects([member(n)])[0],
  attention: 'other',
  briefing: { key: `k${n}`, status: 'queued', updatedAt: '2026-11-01T00:00:00Z' },
});
const queue = (): WorkbenchQueue => ({
  items: [item(1), item(2)],
  starredItems: [],
  stacks: [],
  readStates: {},
  mutedPrs: [],
  starredPrs: [],
  filters: normalizeQueueFilters(undefined),
  sync: { status: 'idle', checkedAt: 1 },
  warnings: [],
  remaining: 3,
});
const history: ReviewHistoryEntry[] = [
  { id: 'r1', prUrl: member(1).url, prTitle: 'PR 1', author: 'alice', savedAt: '2026-11-01T00:00:00Z', status: 'completed', riskLevel: 'low' },
];

void test('content hashes are stable and short', () => {
  assert.equal(contentHash('queue'), contentHash('queue'));
  assert.notEqual(contentHash('queue'), contentHash('queues'));
});

void test('revisions do not depend on key order or on a briefing clock', () => {
  const a = item(1);
  const reordered = Object.fromEntries(Object.entries(item(1)).reverse()) as unknown as QueueItem;
  reordered.subject = Object.fromEntries(Object.entries(reordered.subject).reverse()) as unknown as QueueItem['subject'];
  assert.equal(itemRevision(a), itemRevision(reordered));
  const later = item(1);
  later.briefing = { key: 'k1', status: 'queued', updatedAt: '2030-01-01T00:00:00Z' };
  assert.equal(itemRevision(a), itemRevision(later), 'An uncached briefing reports the current time on every read');
  const first = stampQueue(queue(), history);
  const second = stampQueue(queue(), structuredClone(history));
  assert.equal(first.revision, second.revision);
  assert.equal(first.historyRevision, second.historyRevision);
  assert.deepEqual(first.parts, second.parts);
  assert.equal(stampQueue(first, history).revision, first.revision, 'Stamping again ignores existing stamps');
});

void test('each part of a snapshot changes its revision', () => {
  const base = stampQueue(queue(), history);
  const changes: [string, (q: WorkbenchQueue) => void, keyof NonNullable<WorkbenchQueue['parts']> | undefined][] = [
    ['item title', (q) => { q.items[0].subject.title = 'Renamed'; }, undefined],
    ['item order', (q) => { q.items.reverse(); }, undefined],
    ['briefing status', (q) => { q.items[0].briefing = { key: 'k1', status: 'ready', updatedAt: '2026-11-01T00:00:00Z' }; }, undefined],
    ['unread', (q) => { q.items[0].unreadUrls = [q.items[0].subject.members[0].url]; }, undefined],
    ['starred items', (q) => { q.starredItems = [q.items[0]]; }, undefined],
    ['stacks', (q) => { q.stacks = [q.items[0].subject]; }, 'stacks'],
    ['read states', (q) => { q.readStates = { [member(1).url]: { unread: ['new'] } as never }; }, 'readStates'],
    ['muted', (q) => { q.mutedPrs = [{ member: member(9), mutedAt: 'now' }]; }, 'mutedPrs'],
    ['starred', (q) => { q.starredPrs = [{ member: member(9), starredAt: 'now' }]; }, 'starredPrs'],
    ['saved views', (q) => { q.savedViews = { views: [], activeId: null } as never; }, 'savedViews'],
    ['filters', (q) => { q.filters = normalizeQueueFilters({ query: 'x' }); }, 'filters'],
    ['sync', (q) => { q.sync = { status: 'checking', checkedAt: 1 }; }, 'sync'],
    ['warnings', (q) => { q.warnings = ['Rate limited']; }, undefined],
    ['remaining', (q) => { q.remaining = 2; }, undefined],
    ['budget', (q) => { q.briefingBudget = { limit: 1 } as never; }, undefined],
  ];
  for (const [name, change, part] of changes) {
    const next = queue();
    change(next);
    const stamped = stampQueue(next, history);
    assert.notEqual(stamped.revision, base.revision, name);
    if (part) assert.notEqual(stamped.parts?.[part], base.parts?.[part], name);
    assert.equal(stamped.historyRevision, base.historyRevision, `${name} leaves saved reviews unchanged`);
  }
  const changedHistory = stampQueue(queue(), [{ ...history[0], status: 'generating' }]);
  assert.equal(changedHistory.revision, base.revision);
  assert.notEqual(changedHistory.historyRevision, base.historyRevision);
});

void test('only changed entries get a new revision', () => {
  const before = stampQueue(queue());
  const next = queue();
  next.items[1].subject.title = 'Changed';
  const after = stampQueue(next);
  assert.equal(after.items[0].revision, before.items[0].revision);
  assert.notEqual(after.items[1].revision, before.items[1].revision);
});
void test('memoizes frozen inputs only', () => {
  let reads = 0;
  const row = (frozen: boolean) => {
    const value = {
      get member() {
        reads++;
        return { url: member(9).url, repo: 'owner/repo', number: 9, title: 'PR 9', author: 'alice', state: 'open' as const, merged: false, isDraft: false };
      },
      mutedAt: 'now',
    };
    return frozen ? Object.freeze([Object.freeze(value)]) : [value];
  };
  const frozen = row(true);
  const first = stampQueue({ ...queue(), mutedPrs: frozen });
  const second = stampQueue({ ...queue(), mutedPrs: frozen });
  assert.equal(first.parts?.mutedPrs, second.parts?.mutedPrs);
  assert.equal(reads, 1, 'A frozen input is hashed once');
  const mutable = row(false);
  stampQueue({ ...queue(), mutedPrs: mutable });
  stampQueue({ ...queue(), mutedPrs: mutable });
  assert.equal(reads, 3, 'A mutable input is hashed on every stamp');
  const frozenHistory = Object.freeze([...history]);
  assert.equal(stampQueue(queue(), frozenHistory).historyRevision, stampQueue(queue(), history).historyRevision);
});

void test('an item revision follows replaced members, and only opted-in callers reuse member hashes', () => {
  const first = item(1);
  const before = itemRevision(first, true);
  assert.equal(itemRevision(first), before, 'reuse does not change the revision value');
  assert.equal(itemRevision({ ...first, subject: { ...first.subject } }, true), before);
  const replaced = { ...first, subject: { ...first.subject, members: first.subject.members.map((m) => ({ ...m, description: `${m.description ?? ''} edited` })) } };
  assert.notEqual(itemRevision(replaced, true), before);
  // Callers that edit members in place must not see a reused hash.
  first.subject.members[0].headSha = 'edited-in-place';
  assert.notEqual(itemRevision(first), before);
});
