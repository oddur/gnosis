import { test } from 'node:test';
import assert from 'node:assert/strict';
import { itemWithLifecycle, newerLifecycle, withLifecycle, type PrLifecycle } from '../lib/pr-lifecycle';
import { resolveWorkspace } from '../lib/stack-workspace';
import { mergePrStatus } from '../lib/merge-pr-status';
import type { QueueItem, ReviewMember } from '../lib/workbench';
import type { PrStatus } from '../lib/types';

// The shape of klanggames/seed#36206: queued while open, merged later with the same head.
const url = 'https://github.com/klanggames/seed/pull/36206';
const member = (overrides: Partial<ReviewMember> = {}): ReviewMember => ({
  url, number: 36206, repo: 'klanggames/seed', headRepo: 'klanggames/seed', baseRepo: 'klanggames/seed', role: 'review-requested',
  title: 'Seed change', description: '', author: 'author', baseBranch: 'main', headBranch: 'topic',
  baseSha: 'b'.repeat(40), headSha: 'a'.repeat(40), merged: false, state: 'open',
  createdAt: '2026-11-13T10:00:00Z', updatedAt: '2026-11-13T12:00:00Z', labels: [], mergeable: true,
  isDraft: false, commitCount: 1, requestedReviewers: [], requestedTeams: [], mergeableState: 'clean',
  autoMerge: null, milestone: null, ...overrides,
});
const itemOf = (m: ReviewMember): QueueItem => ({
  attention: 'requested', subject: { id: m.url, kind: 'pr', scope: 'single', title: m.title, members: [m], edges: [], warnings: [] },
});
const merged: PrLifecycle = { state: 'closed', merged: true, updatedAt: '2026-11-14T09:06:42Z' };
const closed: PrLifecycle = { state: 'closed', merged: false, updatedAt: '2026-11-14T09:06:42Z' };

void test('a PR queued as open and then read as merged renders as merged', () => {
  const opened = itemOf(member());
  // Merged PRs leave the queue, so resolving the opened item finds nothing newer and keeps the open copy.
  const source = resolveWorkspace(opened, []);
  assert.equal(source.subject.members[0].state, 'open');
  const shown = itemWithLifecycle(source, (u) => (u === url ? merged : undefined));
  assert.equal(shown.subject.members[0].merged, true);
  assert.equal(shown.subject.members[0].state, 'closed');
  assert.equal(shown.subject.members[0].headSha, 'a'.repeat(40), 'A merge keeps the head; nothing else changes');
  assert.equal(itemWithLifecycle(source, () => closed).subject.members[0].merged, false);
  assert.equal(itemWithLifecycle(source, () => closed).subject.members[0].state, 'closed');
});

void test('a PR restored from a stale tab updates once the status read reports it merged', () => {
  // A saved tab or navigation entry holds the whole item as it was when it was opened.
  const restored = JSON.parse(JSON.stringify(itemOf(member({ updatedAt: '2026-11-13T08:00:00Z' })))) as QueueItem;
  const shown = itemWithLifecycle(restored, () => merged);
  assert.equal(shown.subject.members[0].merged, true);
  assert.equal(shown.subject.members[0].updatedAt, merged.updatedAt);
});

void test('an older status never reopens a newer merged copy, and unchanged items keep their identity', () => {
  const item = itemOf(member({ merged: true, state: 'closed', updatedAt: merged.updatedAt }));
  assert.equal(itemWithLifecycle(item, () => ({ state: 'open', merged: false, updatedAt: '2026-11-13T12:00:00Z' })), item);
  assert.equal(itemWithLifecycle(item, () => merged), item);
  assert.equal(itemWithLifecycle(item, () => undefined), item);
  // On a tie, the merged report wins: reopening a PR updates it.
  const tie = member({ updatedAt: merged.updatedAt });
  assert.equal(withLifecycle(tie, merged).merged, true);
  assert.equal(newerLifecycle({ ...merged, state: 'open', merged: false }, merged), merged);
});

void test('a stack context updates with its members', () => {
  const stack = itemOf(member());
  const focused: QueueItem = { ...stack, parentStack: { ...stack.subject, id: 'stack', kind: 'stack' } };
  const shown = itemWithLifecycle(focused, () => merged);
  assert.equal(shown.parentStack?.members[0].merged, true);
});

void test('the status lifecycle survives later partial updates and late saved copies', () => {
  const base: PrStatus = {
    labels: [], mergeable: null, isDraft: false, ciChecks: [], ciConclusion: 'neutral',
    reviewSummary: { approved: 0, commented: 0, changesRequested: 0 }, baseBranch: 'main', commitCount: 1,
    requestedReviewers: [], requestedTeams: [], mergeableState: null, autoMerge: null, milestone: null,
  };
  const fresh = { ...base, lifecycle: merged };
  assert.equal(mergePrStatus(fresh, base).lifecycle, merged, 'A read without a lifecycle keeps the known one');
  assert.equal(mergePrStatus(fresh, { ...base, lifecycle: { state: 'open', merged: false, updatedAt: '2026-11-13T00:00:00Z' } }).lifecycle, merged);
  assert.equal(mergePrStatus(fresh, { ...base, stale: true, lifecycle: { state: 'open', merged: false, updatedAt: '2026-11-15T00:00:00Z' } }).lifecycle, merged);
});
