import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attentionItems } from '../lib/attention';
import { menubarRow } from '../lib/menubar-state';
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

void test('a PR whose parent merged has to move while it targets the merged branch or conflicts', () => {
  const parent = mine(101, { merged: true, state: 'closed' });
  const child = mine(102, { baseBranch: 'feature-101' });
  const subject = stack([parent, child]);
  // Still targets the merged branch.
  assert.deepEqual(
    (({ parent, ...rest }) => ({ parent: parent.number, ...rest }))(mergedParent(subject, child, clear(child))!),
    { parent: 101, onto: 'main', targetsParent: true, conflicts: false }
  );
  // GitHub moved it onto main: a squash-merged parent leaves it conflicting, and it still has to move.
  const moved = { ...child, baseBranch: 'main' };
  const squashed = stack([parent, moved]);
  assert.equal(mergedParent(squashed, moved, conflicted(moved))?.conflicts, true);
  // Moved and clear: nothing to do, so the row clears.
  assert.equal(mergedParent(squashed, moved, clear(moved)), undefined);
  // The fresh base branch wins over the saved one.
  assert.equal(mergedParent(subject, child, { ...clear(child), readiness: { ...clear(child).readiness!, baseBranch: 'main' } }), undefined);
  const plan = stackConflictPlan(subject, lookup([clear(child)]));
  assert.equal(plan?.step.kind, 'move');
  assert.equal(plan?.step.text, '#101 merged. #102 needs to move onto main.');
});

void test('"parent merged" is derived as an attention row on your PR, with one action', () => {
  const parent = mine(101, { merged: true, state: 'closed' });
  const child = mine(102, { baseBranch: 'feature-101' });
  const item: QueueItem = { subject: stack([parent, child]), attention: 'other' };
  const rows = (value: QueueSignals) =>
    attentionItems({ items: [item], signals: () => value, login: LOGIN, enabled: () => true, now: T0 });
  const [row] = rows(clear(child));
  assert.deepEqual(row.kinds, ['restack']);
  assert.equal(row.group, 'fix');
  assert.equal(row.detail, '#101 merged. #102 needs to move onto main.');
  assert.deepEqual(row.target, { kind: 'pr', pr: { host: 'github.com', owner: 'o', repo: 'r', number: 102 }, tab: 'summary' });
  assert.deepEqual(menubarRow(row, LOGIN).labels, ['#101 merged. #102 needs to move onto main.']);
  // Moved onto main and conflicting: the action opens Resolve conflicts.
  item.subject = stack([parent, { ...child, baseBranch: 'main' }]);
  const [moving] = rows(conflicted({ ...child, baseBranch: 'main' }));
  assert.deepEqual(moving.kinds, ['conflicts', 'restack']);
  assert.deepEqual(moving.target, { kind: 'conflicts', pr: { host: 'github.com', owner: 'o', repo: 'r', number: 102 } });
  // Someone else's PR is not yours to move.
  item.subject = stack([parent, { ...child, author: 'maya', role: 'review-requested' }]);
  assert.deepEqual(rows(clear(child)), []);
});
