import test from 'node:test';
import assert from 'node:assert/strict';
import { focusStackPr, resolveWorkspace, matchingStackMembers } from '../lib/stack-workspace';
import { DEFAULT_QUEUE_FILTERS } from '../lib/queue-filters';
import { queueDocuments, searchDocuments } from '../lib/command-search';
import type { QueueItem, ReviewMember } from '../lib/workbench';
const members = [1, 2].map(n => ({ url: `https://github.com/acme/core/pull/${n}`, number: n, repo: 'acme/core', title: `Change ${n}`, author: n === 1 ? 'alice' : 'bob', labels: [], description: '', baseBranch: 'main', headBranch: `feature-${n}`, state: 'open', merged: false, role: 'watched', headRepo: 'acme/core', baseRepo: 'acme/core', baseSha: 'base', headSha: `head-${n}`, createdAt: '2026-10-27', updatedAt: '2026-10-27', isDraft: false, commitCount: 1, requestedReviewers: [], requestedTeams: [], mergeable: null, mergeableState: null, autoMerge: null, milestone: null } as ReviewMember));
const stack: QueueItem = { attention: 'other', subject: { id: 'stack:1', kind: 'stack', title: 'Whole change', members, edges: [], warnings: [] }, unreadUrls: members.map(m => m.url) };
test('entering a PR keeps its own identity and retains its parent without inheriting stack explanation', () => {
  const pr = focusStackPr(stack, members[1]);
  assert.equal(pr.subject.id, members[1].url);
  assert.equal(pr.subject.scope, 'single');
  assert.equal(pr.parentStack?.id, stack.subject.id);
  assert.equal(pr.review, undefined);
  assert.deepEqual(pr.unreadUrls, [members[1].url]);
  const latest = { ...stack, subject: { ...stack.subject, title: 'Renamed', members: members.map(m => ({ ...m, headSha: 'new' })) } };
  const restored = resolveWorkspace(pr, [latest]);
  assert.equal(restored.subject.members.length, 1);
  assert.equal(restored.subject.members[0].headSha, 'new');
  assert.equal(restored.parentStack?.title, 'Renamed');
});
test('queue filters identify member matches without removing stack context', () => {
  assert.deepEqual(matchingStackMembers(stack, { ...DEFAULT_QUEUE_FILTERS, author: 'bob' }), [members[1].url]);
  assert.equal(stack.subject.members.length, 2);
});
test('exact PR search opens that PR within its stack', () => {
  const docs = queueDocuments({ items: [stack], remaining: 0, warnings: [] });
  const member = docs.find(d => d.id === `subject:${members[1].url}`)!;
  assert.equal(member.kind, 'pr');
  assert.equal(member.groupId, stack.subject.id);
  assert.equal(member.destination.kind, 'home');
  if (member.destination.kind === 'home') {
    assert.equal(member.destination.subject?.subject.scope, 'single');
    assert.equal(member.destination.subject?.parentStack?.id, stack.subject.id);
  }
  assert.equal(searchDocuments(docs, '#2')[0].document.id, member.id);
});

test('retained completed stacks remain searchable outside the active queue', () => {
  const completed = { ...stack.subject, members: members.map(m => ({ ...m, state: 'closed' as const, merged: true })) };
  const docs = queueDocuments({ items: [], stacks: [completed], warnings: [], remaining: 0 });
  const result = searchDocuments(docs, '#2')[0];
  assert.equal(result.document.state, 'Merged');
  assert.equal(result.document.destination.kind, 'home');
  if (result.document.destination.kind === 'home') assert.equal(result.document.destination.subject?.parentStack?.id, completed.id);
});
