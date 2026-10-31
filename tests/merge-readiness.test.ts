import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeReadiness, subjectReadiness } from '../lib/merge-readiness';
import { QUEUE_SIGNALS_TTL, type QueueSignals } from '../lib/queue-signals';
import type { ReviewMember, ReviewSubject } from '../lib/workbench';

const now = 1_000_000;
const member = {
  url: 'https://github.com/example/repo/pull/1',
  number: 1,
  headSha: 'head',
  merged: false,
  state: 'open',
  isDraft: false,
  baseBranch: 'feature/base',
} as ReviewMember;
function signals(overrides: Partial<NonNullable<QueueSignals['readiness']>> = {}): QueueSignals {
  return {
    url: member.url,
    headSha: member.headSha,
    checkedAt: now,
    comments: 0,
    checks: { state: 'success', total: 5, passed: 5 },
    readiness: {
      state: 'OPEN',
      isDraft: false,
      mergeable: 'MERGEABLE',
      mergeState: 'CLEAN',
      reviewDecision: 'APPROVED',
      baseBranch: member.baseBranch,
      baseSha: 'base',
      behindBy: 0,
      mergeQueue: false,
      queueState: null,
      ...overrides,
    },
  };
}
void test('clean conflict-free GitHub policy state is required for readiness; passing checks alone are insufficient', () => {
  assert.equal(mergeReadiness(member, signals(), now).ready, true);
  for (const mergeState of ['BLOCKED', 'UNKNOWN', 'HAS_HOOKS', 'UNSTABLE', 'NEW_STATE']) {
    assert.equal(mergeReadiness(member, signals({ mergeState }), now).ready, false, mergeState);
  }
  assert.equal(mergeReadiness(member, { ...signals(), readiness: undefined }, now).label, 'Readiness unknown');
  assert.equal(mergeReadiness(member, signals({ mergeable: 'UNKNOWN' }), now).ready, false);
});
void test('required base update, conflicts and optional updates are distinct and name the PR base branch', () => {
  const required = mergeReadiness(member, signals({ mergeState: 'BEHIND', behindBy: 4 }), now);
  assert.equal(required.label, 'Update required to merge');
  assert.match(required.details.join(' '), /Rebase onto feature\/base, or merge feature\/base/);
  assert.equal(mergeReadiness(member, signals({ mergeable: 'CONFLICTING' }), now).label, 'Merge conflicts');
  const optional = mergeReadiness(member, signals({ behindBy: 4 }), now);
  assert.equal(optional.ready, true);
  assert.match(optional.details.join(' '), /updating is optional/);
  const blocked = mergeReadiness(member, signals({ behindBy: 4, mergeState: 'BLOCKED' }), now);
  assert.doesNotMatch(blocked.details.join(' '), /optional/);
});
void test('all known blockers remain visible even when branch updates take priority', () => {
  const value = signals({ mergeState: 'BEHIND', isDraft: true, reviewDecision: 'REVIEW_REQUIRED' });
  value.checks.state = 'failure';
  const result = mergeReadiness(member, value, now);
  assert.equal(result.ready, false);
  assert.match(result.details.join(' '), /ready for review/);
  assert.match(result.details.join(' '), /Required approvals/);
  assert.match(result.details.join(' '), /checks are failing/);
  assert.equal(mergeReadiness(member, signals({ reviewDecision: 'CHANGES_REQUESTED' }), now).ready, false);
});
void test('stale, missing and different-revision snapshots cannot produce a green merge claim', () => {
  const stale = mergeReadiness(member, signals(), now + QUEUE_SIGNALS_TTL);
  assert.equal(stale.ready, false);
  assert.equal(stale.tone, 'muted');
  assert.equal(stale.label, 'Readiness out of date');
  assert.equal(mergeReadiness({ ...member, headSha: 'new' }, signals(), now).label, 'Readiness unknown');
  assert.equal(mergeReadiness(member, undefined, now).ready, false);
});
void test('merge queues are distinguished from direct merging and terminal PRs are never ready', () => {
  assert.equal(mergeReadiness({ ...member, merged: true }, signals(), now).label, 'Merged');
  assert.equal(mergeReadiness({ ...member, state: 'closed' }, signals(), now).ready, false);
  assert.equal(mergeReadiness(member, signals({ mergeQueue: true }), now).label, 'Ready for merge queue');
  assert.equal(
    mergeReadiness(member, signals({ mergeQueue: true, queueState: 'QUEUED' }), now).label,
    'In merge queue'
  );
  for (const state of ['MERGED', 'CLOSED']) assert.equal(mergeReadiness(member, signals({ state }), now).ready, false);
});
void test('stacks name only the next dependency-eligible PR and never promise the whole stack can merge', () => {
  const child = { ...member, url: 'https://github.com/example/repo/pull/2', number: 2, headSha: 'child' };
  const subject: ReviewSubject = {
    id: 'stack',
    kind: 'stack',
    title: 'Stack',
    members: [member, child],
    edges: [{ parent: member.url, child: child.url, evidence: 'branch' }],
    warnings: [],
  };
  const childSignals = { ...signals(), url: child.url, headSha: child.headSha };
  const draftChild = { ...childSignals, readiness: { ...childSignals.readiness!, isDraft: true } };
  const partial = subjectReadiness(subject, [signals(), draftChild], now);
  assert.equal(partial.blockedCount, 1);
  assert.doesNotMatch(partial.label, /blocked/);
  const blockedBase = signals({ mergeState: 'BEHIND' });
  assert.equal(subjectReadiness(subject, [blockedBase, childSignals], now).ready, false);
  assert.match(subjectReadiness(subject, [signals(), childSignals], now).label, /Next: #1/);
  assert.match(subjectReadiness(subject, [signals({ state: 'MERGED' }), childSignals], now).label, /Next: #2/);
  assert.equal(subjectReadiness(subject, [signals({ state: 'CLOSED' }), childSignals], now).ready, false);
  assert.equal(subjectReadiness(subject, [], now).label, 'Stack readiness unknown');
});

void test('stack summary leads with blockers even when its base PR can merge', async () => {
  const { stackMergeStatus } = await import('../lib/stack-merge-status');
  const child = { ...member, url: member.url + '2', number: 2 };
  const subject = { kind: 'stack', members: [member, child], edges: [] } as unknown as ReviewSubject;
  const result = stackMergeStatus(subject, [signals(), { ...signals({ isDraft: true }), url: child.url }], {}, now);
  assert.equal(result.summary.ready, false);
  assert.equal(result.summary.label, 'Cannot merge stack · 1 PR is blocked');
  assert.equal(result.entries[1].category, 'blocked');
});

void test('stack presentation separates optional failures, unknown evidence and queued merges', async () => {
  const { stackMergeStatus, stackMergeMessage } = await import('../lib/stack-merge-status');
  const subject = { kind: 'stack', members: [member], edges: [] } as unknown as ReviewSubject;
  const warning = stackMergeStatus(subject, [{ ...signals(), checks: { state: 'failure', total: 1, passed: 0 } }], {}, now);
  assert.equal(warning.entries[0].category, 'warning');
  assert.equal(warning.summary.ready, true);
  assert.match(stackMergeMessage(warning.entries[0]).details[0], /do not block/);
  const queued = stackMergeStatus(subject, [signals({ queueState: 'QUEUED' })], {}, now);
  assert.equal(queued.entries[0].category, 'waiting');
  assert.equal(queued.blocked, 0);
  const unstable = stackMergeStatus(subject, [signals({ mergeState: 'UNSTABLE' })], {}, now);
  assert.equal(unstable.entries[0].category, 'unconfirmed');
  assert.equal(unstable.summary.ready, false);
  const stale = stackMergeStatus(subject, [signals({ mergeState: 'DIRTY' })], {}, now + QUEUE_SIGNALS_TTL);
  assert.equal(stale.blocked, 0);
  assert.equal(stale.unconfirmed, 1);
  assert.equal(stackMergeMessage(stale.entries[0]).details.length, 1);
  assert.match(stackMergeMessage(stale.entries[0]).details[0], /Last reported/);
  assert.equal(stackMergeStatus(subject, [{ ...signals(), headSha: 'old' }], {}, now).entries[0].category, 'unconfirmed');
});

void test('check evidence must be fresh and belong to the displayed head', async () => {
  const { stackMergeStatus, stackMergeMessage } = await import('../lib/stack-merge-status');
  const subject = { kind: 'stack', members: [member], edges: [] } as unknown as ReviewSubject;
  const value = { url: member.url, headSha: member.headSha, checkedAt: now, checks: [
    { id: 'build', name: 'Build', status: 'completed', conclusion: 'cancelled', required: false },
  ] } as import('../lib/pr-checks').PrChecks;
  const fresh = stackMergeStatus(subject, [signals()], { [member.url]: value }, now);
  assert.equal(fresh.entries[0].category, 'warning');
  assert.equal(stackMergeMessage(fresh.entries[0]).title, 'Optional checks did not pass');
  for (const invalid of [{ ...value, headSha: 'old' }, { ...value, checkedAt: now - QUEUE_SIGNALS_TTL }]) {
    const result = stackMergeStatus(subject, [signals()], { [member.url]: invalid }, now);
    assert.equal(result.entries[0].category, 'ready');
    assert.equal(result.entries[0].failedChecks.length, 0);
  }
});

void test('stack hierarchy orders dependencies and refuses false linear chains', async () => {
  const { stackDependencyOrder } = await import('../lib/stack-overview');
  const child = { ...member, url: member.url + '2', number: 2 };
  const tip = { ...member, url: member.url + '3', number: 3 };
  const subject = { kind: 'stack', members: [tip, member, child], edges: [
    { parent: member.url, child: child.url, evidence: 'branch' },
    { parent: child.url, child: tip.url, evidence: 'branch' },
  ] } as ReviewSubject;
  assert.deepEqual(stackDependencyOrder(subject).members.map(m => m.number), [1, 2, 3]);
  assert.equal(stackDependencyOrder(subject).linear, true);
  assert.equal(stackDependencyOrder({ ...subject, edges: [subject.edges[0], { ...subject.edges[1], parent: member.url }] }).linear, false);
  assert.equal(stackDependencyOrder({ ...subject, edges: [...subject.edges, { parent: tip.url, child: member.url, evidence: 'manual' }] }).linear, false);
  assert.equal(stackDependencyOrder({ ...subject, edges: [] }).linear, false);
});

void test('stack next action names the actual target and does not reuse stale conflicts', async () => {
  const { stackMergeStatus } = await import('../lib/stack-merge-status');
  const { stackNextStep, stackMergeTarget } = await import('../lib/stack-overview');
  const base = { ...member, headBranch: 'feature/base', headRepo: 'example/repo', baseRepo: 'example/repo', baseBranch: 'main' };
  const child = { ...base, url: member.url + '2', number: 2, baseBranch: 'feature/base', headBranch: 'feature/child' };
  const subject = { kind: 'stack', members: [child, base], edges: [{ parent: base.url, child: child.url, evidence: 'branch' }] } as ReviewSubject;
  const conflict = { ...signals({ mergeState: 'DIRTY', baseBranch: 'feature/base' }), url: child.url };
  assert.equal(stackMergeTarget(subject, child, conflict, now).parent?.number, 1);
  assert.ok(conflict.readiness);
  assert.equal(stackMergeTarget(subject, child, { ...conflict, readiness: { ...conflict.readiness, baseBranch: 'main' } }, now).parent, undefined, 'Retargeted PR conflicts with main, not its historical parent');
  const status = stackMergeStatus(subject, [signals({ baseBranch: 'main' }), conflict], {}, now);
  assert.equal(stackNextStep(subject, status)?.entry.member.number, 2);
  assert.equal(stackNextStep(subject, status)?.action, 'resolve');
  assert.equal(stackNextStep(subject, stackMergeStatus(subject, [conflict], {}, now + QUEUE_SIGNALS_TTL))?.action, 'refresh');
});

void test('stack labels distinguish current check results without overriding merge eligibility', async () => {
  const { stackMergeLabel } = await import('../lib/stack-overview');
  const failed = { ...signals({ mergeState: 'BLOCKED' }), checks: { state: 'failure' as const, total: 1, passed: 0 } };
  assert.equal(stackMergeLabel(member, failed, now).label, 'Checks failing');
  assert.equal(stackMergeLabel(member, { ...failed, checks: { state: 'pending', total: 1, passed: 0 } }, now).label, 'Checks running');
  assert.equal(stackMergeLabel(member, { ...failed, readiness: signals().readiness }, now).label, 'Ready', 'Optional failures cannot override GitHub eligibility');
  assert.equal(stackMergeLabel(member, failed, now + QUEUE_SIGNALS_TTL).label, 'Status needs refresh');
  assert.equal(stackMergeLabel(member, undefined, now, true).label, 'Checking…');
  assert.equal(stackMergeLabel(member, undefined, now, false).label, 'Not checked');
});
