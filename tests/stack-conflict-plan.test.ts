import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ATTENTION_LABEL, attentionItems } from '../lib/attention';
import { menubarRow } from '../lib/menubar-state';
import { FIX_LABEL, rebaseWords } from '../lib/morning';
import { mergedParent, stackConflictPlan } from '../lib/stack-conflict-plan';
import type { QueueSignals } from '../lib/queue-signals';
import type { QueueItem, ReviewMember, ReviewSubject } from '../lib/workbench';
import { LOGIN, T0, mine, signals } from './notification-fixtures';

/** A stack from the bottom up: each PR targets the head branch of the one before it. */
function stack(members: ReviewMember[]): ReviewSubject {
  return {
    id: `stack-${members[0].number}`,
    kind: 'stack',
    title: members[0].title,
    members,
    edges: members.slice(1).map((child, i) => ({ parent: members[i].url, child: child.url, evidence: 'branch' as const })),
    warnings: [],
  };
}
const conflicted = (pr: ReviewMember) => signals(pr, { mergeable: 'CONFLICTING', mergeState: 'DIRTY' });
const clear = (pr: ReviewMember) => signals(pr, { mergeable: 'MERGEABLE', mergeState: 'CLEAN' });
const lookup = (values: QueueSignals[]) => (member: ReviewMember) => values.find((value) => value.url === member.url);

void test('the plan names the lowest conflicting PR, then moves up once it is resolved', () => {
  const a = mine(101);
  const b = mine(102, { baseBranch: 'feature-101' });
  const c = mine(103, { baseBranch: 'feature-102' });
  // Members out of order: the plan follows the dependency order, not the list.
  const subject = stack([a, b, c]);
  subject.members = [c, a, b];
  const plan = stackConflictPlan(subject, lookup([clear(a), conflicted(b), conflicted(c)]));
  assert.equal(plan?.step.kind, 'conflicts');
  assert.equal(plan?.step.member.number, 102);
  assert.equal(plan?.step.text, '2 PRs in this stack conflict. Resolve from the bottom up.');
  assert.deepEqual(plan?.conflicting.map((member) => member.number), [102, 103]);
  // #102 was resolved and pushed: its new head reads clear, and the plan names #103.
  const next = stackConflictPlan(subject, lookup([clear(a), clear(b), conflicted(c)]));
  assert.equal(next?.step.member.number, 103);
  assert.equal(next?.step.text, '#103 has merge conflicts.');
  assert.equal(stackConflictPlan(subject, lookup([clear(a), clear(b), clear(c)])), undefined);
  // Status for an older head says nothing about the new one.
  assert.equal(stackConflictPlan(subject, lookup([conflicted({ ...a, headSha: 'old' })])), undefined);
});

void test('a PR whose parent merged has to move only while it targets the merged branch', () => {
  const parent = mine(101, { merged: true, state: 'closed' });
  const child = mine(102, { baseBranch: 'feature-101' });
  const subject = stack([parent, child]);
  const found = mergedParent(subject, child);
  assert.deepEqual([found?.parent.number, found?.onto], [101, 'main']);
  // On main, conflicting for any reason: not a move until an ancestry read shows it still carries the parent's
  // commits (tests/stack-ancestry.test.ts).
  const moved = { ...child, baseBranch: 'main' };
  assert.equal(mergedParent(stack([parent, moved]), moved), undefined);
  // The PR's own base decides, never a status read's: every surface reads the same (#468).
  const status = clear(child);
  const readiness = status.readiness && { ...status.readiness, baseBranch: 'main' };
  const plan468 = stackConflictPlan(subject, lookup([{ ...status, readiness }]));
  assert.equal(plan468?.step.kind, 'move');
  // Move first, then resolve: a PR that targets the merged branch and conflicts is a move.
  const plan = stackConflictPlan(subject, lookup([conflicted(child)]));
  assert.equal(plan?.step.kind, 'move');
  assert.equal(plan?.step.text, '#101 merged. #102 needs to move onto main.');
});

void test('a merged long-lived branch that is still there is not a stack parent; a deleted branch always is (#468)', () => {
  // A develop → main release PR merged, and a feature PR targets develop: it does not have to move.
  const release = mine(100, { merged: true, state: 'closed', headBranch: 'develop' });
  const feature = mine(102, { baseBranch: 'develop' });
  assert.equal(mergedParent(stack([release, feature]), feature), undefined);
  for (const branch of ['main', 'master', 'develop', 'dev', 'trunk', 'next', 'stable', 'staging', 'production', 'release']) {
    const pr = { ...feature, baseBranch: branch };
    assert.equal(mergedParent(stack([{ ...release, headBranch: branch }, pr]), pr), undefined, branch);
    // Deleted after the merge: a stack parent whatever its name (main into main is no stack at all).
    if (branch !== 'main') assert.ok(mergedParent(stack([{ ...release, headBranch: branch, headRefDeleted: true }, pr]), pr), branch);
  }
  // Short-lived names that only look like release branches are stack parents.
  for (const branch of ['hotfix/login', 'release-notes-fix', 'release/2026.11']) {
    const pr = { ...feature, baseBranch: branch };
    assert.ok(mergedParent(stack([{ ...release, headBranch: branch }, pr]), pr), branch);
  }
});

void test('a parent is ignored when nothing proves the PR still has to move (#527 review)', () => {
  const parent = mine(101, { merged: true, state: 'closed' });
  const child = mine(102, { baseBranch: 'feature-101', createdAt: '2026-11-01T00:00:00Z' });
  // A deleted fork's merged PR: its head repository is unknown.
  assert.equal(mergedParent(stack([{ ...parent, headRepoUnknown: true }, child]), child), undefined);
  // Merged into the PR's own base, or from a branch into itself.
  const onMain = { ...child, baseBranch: 'main' };
  assert.equal(mergedParent(stack([{ ...parent, headBranch: 'main' }, onMain]), onMain), undefined);
  assert.equal(mergedParent(stack([{ ...parent, headBranch: 'feature-101', baseBranch: 'feature-101' }, child]), child), undefined);
  // The branch lives on: only a parent that merged after the PR was opened counts, and an unknown time doesn't.
  const lives = { ...parent, headRefDeleted: false };
  assert.equal(mergedParent(stack([{ ...lives, mergedAt: '2026-10-01T00:00:00Z' }, child]), child), undefined);
  assert.equal(mergedParent(stack([lives, child]), child), undefined);
  assert.ok(mergedParent(stack([{ ...lives, mergedAt: '2026-11-02T00:00:00Z' }, child]), child));
  // A comment on the merged parent changes nothing: the time is when it merged.
  assert.ok(mergedParent(stack([{ ...lives, mergedAt: '2026-11-02T00:00:00Z', updatedAt: '2026-12-01T00:00:00Z' }, child]), child));
});

void test('"parent merged" is derived as an attention row on your PR, with one wording', () => {
  const parent = mine(101, { merged: true, state: 'closed' });
  const child = mine(102, { baseBranch: 'feature-101' });
  const item: QueueItem = { subject: stack([parent, child]), attention: 'other' };
  const rows = (value: QueueSignals) =>
    attentionItems({ items: [item], signals: () => value, login: LOGIN, enabled: () => true, now: T0 });
  const [row] = rows(clear(child));
  assert.deepEqual(row.kinds, ['restack']);
  assert.equal(row.group, 'fix');
  assert.equal(row.detail, 'Parent #101 merged');
  assert.equal(ATTENTION_LABEL.restack, FIX_LABEL.restack, 'One label everywhere');
  assert.deepEqual(row.target, { kind: 'pr', pr: { host: 'github.com', owner: 'o', repo: 'r', number: 102 }, tab: 'summary' });
  assert.deepEqual(menubarRow(row, LOGIN).labels, ['Parent #101 merged']);
  assert.equal(rebaseWords(item.subject, child), 'needs to move onto main after #101 merged');
  // Moved onto main, with no ancestry answer: the row clears, even when the PR conflicts.
  item.subject = stack([parent, { ...child, baseBranch: 'main' }]);
  assert.deepEqual(rows(conflicted({ ...child, baseBranch: 'main' }))[0].kinds, ['conflicts']);
  // Someone else's PR is not yours to move.
  item.subject = stack([parent, { ...child, author: 'maya', role: 'review-requested' }]);
  assert.deepEqual(rows(clear(child)), []);
});
