import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prReviewStatus, subjectReviewStatuses } from '../lib/pr-review-status';
import { QUEUE_SIGNALS_TTL, type QueueSignals } from '../lib/queue-signals';
import type { ReviewMember, ReviewSubject } from '../lib/workbench';

const now = 1_000_000;
const member = {
  url: 'https://github.com/example/repo/pull/1',
  number: 1,
  headSha: 'head',
  state: 'open',
  merged: false,
  isDraft: false,
} as ReviewMember;
function signals(
  reviewDecision: string | null = 'APPROVED',
  overrides: Partial<NonNullable<QueueSignals['readiness']>> = {}
): QueueSignals {
  return {
    url: member.url,
    headSha: member.headSha,
    checkedAt: now,
    comments: 0,
    checks: { state: 'failure', passed: 0, total: 3 },
    readiness: {
      state: 'OPEN',
      isDraft: false,
      mergeable: 'CONFLICTING',
      mergeState: 'DIRTY',
      reviewDecision,
      baseBranch: 'main',
      baseSha: 'base',
      behindBy: 3,
      mergeQueue: false,
      queueState: null,
      ...overrides,
    },
  };
}
void test('review decision stays visible independently of conflicts, checks and merge blockers', () => {
  for (const [decision, label, tone] of [
    ['APPROVED', 'Approved', 'success'],
    ['CHANGES_REQUESTED', 'Changes requested', 'danger'],
    ['REVIEW_REQUIRED', 'Awaiting review', 'warning'],
  ]) {
    const status = prReviewStatus(member, signals(decision), false, now);
    assert.equal(status.label, label);
    assert.equal(status.tone, tone);
  }
});
void test('null and unrecognized decisions are neutral, not inferred approval or waiting', () => {
  for (const decision of [null, 'NEW_GITHUB_VALUE']) {
    const status = prReviewStatus(member, signals(decision), false, now);
    assert.equal(status.label, 'No review decision');
    assert.equal(status.tone, 'muted');
  }
});
void test('new revisions and other PR snapshots cannot carry an old approval', () => {
  for (const changed of [
    { ...member, headSha: 'new' },
    { ...member, url: 'https://github.com/example/repo/pull/2' },
  ]) {
    const status = prReviewStatus(changed, signals(), true, now);
    assert.equal(status.label, 'Checking review status');
    assert.equal(status.tone, 'muted');
    assert.equal(status.checkedAt, undefined);
    assert.doesNotMatch(status.details, /approved/i);
    assert.equal(prReviewStatus(changed, signals(), false, now).label, 'Review status unavailable');
  }
  const newMember = { ...member, headSha: 'new' };
  assert.equal(prReviewStatus(newMember, { ...signals(), headSha: 'new' }, false, now).label, 'Approved');
});
void test('stale decisions retain their name with explicit qualification and no positive styling', () => {
  const status = prReviewStatus(member, signals(), false, now + QUEUE_SIGNALS_TTL);
  assert.equal(status.label, 'Approved');
  assert.equal(status.stale, true);
  assert.equal(status.tone, 'muted');
  assert.match(status.details, /Out of date.*Refresh status.*Last checked/);
});
void test('lifecycle takes precedence and review decision remains secondary', () => {
  for (const [overrides, label] of [
    [{ isDraft: true }, 'Draft'],
    [{ state: 'MERGED' }, 'Merged'],
    [{ state: 'CLOSED' }, 'Closed'],
  ] as const) {
    const status = prReviewStatus(member, signals('APPROVED', overrides), false, now);
    assert.equal(status.label, label);
    assert.match(status.details, /Last review decision: Approved/);
  }
  assert.equal(prReviewStatus({ ...member, merged: true }, signals(), false, now).label, 'Merged');
  assert.equal(prReviewStatus({ ...member, state: 'closed' }, undefined, false, now).label, 'Closed');
  assert.equal(prReviewStatus({ ...member, isDraft: true }, undefined, true, now).label, 'Draft');
  // A same-revision live signal can clear an old draft flag from discovery.
  assert.equal(prReviewStatus({ ...member, isDraft: true }, signals(), false, now).label, 'Approved');
});
function stack(decisions: (string | null)[]) {
  const members = decisions.map((_, i) => ({ ...member, number: i + 1, url: `${member.url}${i}` }));
  return {
    subject: { id: 'stack', kind: 'stack', title: 'Stack', members, edges: [], warnings: [] } as ReviewSubject,
    values: decisions.map((decision, i) => ({ ...signals(decision), url: members[i].url })),
  };
}
void test('stack breakdown orders changes requested first and retains individual source PRs', () => {
  const { subject, values } = stack(['APPROVED', 'REVIEW_REQUIRED', 'CHANGES_REQUESTED', 'APPROVED']);
  const groups = subjectReviewStatuses(subject, values, false, now);
  assert.deepEqual(
    groups.map((g) => [g.status.label, g.members.length]),
    [
      ['Changes requested', 1],
      ['Awaiting review', 1],
      ['Approved', 2],
    ]
  );
  assert.deepEqual(
    groups[2].members.map((m) => m.number),
    [1, 4]
  );
});
void test('stacks never hide missing, stale, draft or completed members behind approval', () => {
  const { subject, values } = stack(['APPROVED', 'APPROVED', 'APPROVED', 'APPROVED', 'APPROVED']);
  values[1].checkedAt = now - QUEUE_SIGNALS_TTL;
  values[2].headSha = 'old';
  assert.ok(values[3].readiness);
  values[3].readiness.isDraft = true;
  subject.members[4].merged = true;
  const groups = subjectReviewStatuses(subject, values, true, now);
  assert.deepEqual(
    groups.map((g) => [g.status.kind, g.status.stale]),
    [
      ['checking', false],
      ['draft', false],
      ['approved', false],
      ['approved', true],
      ['merged', false],
    ]
  );
  assert.equal(
    groups.reduce((total, g) => total + g.members.length, 0),
    subject.members.length
  );
});
void test('a fully approved stack collapses to one counted status, while all-merged stacks say merged', () => {
  const { subject, values } = stack(['APPROVED', 'APPROVED']);
  const groups = subjectReviewStatuses(subject, values, false, now);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].status.label, 'Approved');
  assert.equal(groups[0].members.length, 2);
  subject.members.forEach((m) => {
    m.merged = true;
  });
  assert.equal(subjectReviewStatuses(subject, values, false, now)[0].status.label, 'Merged');
});
