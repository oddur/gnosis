import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ago, mergeBlockers, plainText, primaryAction, runSummary, stepDigest, suggestDepth, type SessionStep } from '../lib/guided-session';
import type { QueueSignals } from '../lib/queue-signals';
import type { ReviewMember } from '../lib/workbench';

/** A guided session (#596): the digest, the blockers, the depth and the run's end (lib/guided-session.ts). */

const NOW = Date.parse('2026-11-27T12:00:00Z');
const member = (over: Partial<ReviewMember> = {}) =>
  ({ url: 'https://github.com/o/r/pull/1', number: 1, title: 'Fix retry backoff', author: 'sam', repo: 'o/r', isDraft: false, baseBranch: 'main', additions: 30, deletions: 8, changedFileCount: 2, commitCount: 3, ...over }) as ReviewMember;
const signals = (over: Partial<QueueSignals> = {}, readiness: Partial<NonNullable<QueueSignals['readiness']>> = {}) =>
  ({
    url: member().url,
    headSha: 'h',
    checkedAt: NOW,
    comments: 0,
    checks: { state: 'success', passed: 4, failed: 0, running: 0, total: 4 },
    readiness: { state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', mergeState: 'CLEAN', reviewDecision: 'APPROVED', baseBranch: 'main', baseSha: 'b', behindBy: 0, mergeQueue: false, queueState: null, ...readiness },
    ...over,
  }) as QueueSignals;
const step = (kind: SessionStep['kind'], over: Partial<ReviewMember> = {}) => ({ kind, member: member(over) });

void test('blockers: each cause with its action and owner, most unblocking first', () => {
  assert.deepEqual(mergeBlockers(member(), signals(), 'me'), [], 'A clean, approved, passing PR has none');
  const blocked = mergeBlockers(
    member(),
    signals({ checks: { state: 'failure', passed: 9, failed: 3, total: 12 }, threads: { unresolved: ['a', 'b'], complete: true } }, { mergeable: 'CONFLICTING', mergeState: 'BLOCKED', reviewDecision: 'REVIEW_REQUIRED' }),
    'me'
  );
  assert.deepEqual(blocked.map((b) => [b.action.kind, b.cause, b.owner]), [
    ['resolve-conflicts', 'Conflicts with main', 'anyone'],
    ['rerun-failed', '3 of 12 checks failing', 'anyone'],
    ['review', 'Needs an approving review', 'me'],
    ['show-threads', '2 unresolved threads', 'anyone'],
  ]);
  const behind = mergeBlockers(member(), signals({}, { mergeState: 'BEHIND', behindBy: 4 }), 'me');
  assert.deepEqual(behind.map((b) => b.cause), ['Behind main by 4 commits']);
  const own = mergeBlockers(member({ author: 'me' }), signals({}, { reviewDecision: 'CHANGES_REQUESTED' }), 'me');
  assert.deepEqual(own.map((b) => [b.action.kind, b.owner]), [['reply', 'me']], 'On my own PR, a change request is mine to answer');
  const unknown = mergeBlockers(member(), signals({}, { mergeState: 'BLOCKED' }), 'me');
  assert.deepEqual(unknown.map((b) => b.action.kind), ['open-on-github'], 'Blocked with no cause Gnosis can see: the merge box');
  assert.deepEqual(mergeBlockers(member(), undefined, 'me'), [], 'Not read yet: none, and the step says so');
});

void test('depth: summary or deep review, with the rule that chose it', () => {
  assert.deepEqual(suggestDepth(step('rereview'), 14), { depth: 'summary', reason: 'Small update to code you reviewed (14 lines).' });
  assert.equal(suggestDepth(step('rereview'), 120).depth, 'deep');
  assert.equal(suggestDepth(step('rereview'), undefined).depth, 'deep', 'An update of unknown size is read in full');
  assert.match(suggestDepth(step('review'), undefined).reason, /^First review: you haven't read this PR yet \(38 lines\)\.$/);
  for (const kind of ['merge', 'fix', 'reply', 'changes', 'decide'] as const) assert.equal(suggestDepth(step(kind), undefined).depth, 'summary', kind);
});

void test('digest: your last review, then what came after it, from GitHub data only', () => {
  const reviewed = signals({ mine: { url: member().url, author: 'me', state: 'APPROVED', submittedAt: '2026-11-26T12:00:00Z', headSha: 'old' }, checks: { state: 'failure', passed: 3, failed: 1, total: 4 } });
  const since = [
    { type: 'checks-red' as const, key: 'k', url: member().url, at: NOW - 2 * 3_600_000 },
    { type: 'checks-red' as const, key: 'old', url: member().url, at: Date.parse('2026-11-25T12:00:00Z') },
  ];
  const digest = stepDigest({ step: step('rereview'), signals: reviewed, login: 'me', now: NOW, since, rereviewLines: 14, reply: { author: 'lena', text: 'Can we cap the **backoff**?' } });
  assert.equal(digest.lead, 'You approved yesterday. Since then:');
  assert.deepEqual(digest.lines.map((line) => [line.tone, line.text, line.quote]), [
    ['attention', 'lena replied', 'Can we cap the backoff?'],
    ['neutral', '14 lines changed since your review', undefined],
    ['danger', '1 of 4 checks failing since 2 hours ago', undefined],
  ]);
  assert.equal(stepDigest({ step: step('review'), signals: signals(), login: 'me', now: NOW, since: [] }).lines[0].text, '3 commits · +30 −8 in 2 files');
  assert.equal(stepDigest({ step: step('fix', { author: 'me' }), signals: signals(), login: 'me', now: NOW, since: [] }).lead, 'Your PR.');
  assert.equal(stepDigest({ step: step('rereview'), signals: signals(), login: 'me', now: NOW, since: [] }).lead, 'Updated since your review:', 'A re-review whose review Gnosis has not read');
});

void test('the primary action and the run summary', () => {
  assert.equal(primaryAction({ kind: 'merge' }, [], 'summary'), 'Merge');
  assert.equal(primaryAction({ kind: 'review' }, [], 'deep'), 'Start review');
  assert.equal(primaryAction({ kind: 'rereview' }, [], 'summary'), 'Review the update');
  const steps = [1, 2, 3].map((n) => ({ id: `s${n}`, member: member({ number: n, title: `PR ${n}` }) }));
  const summary = runSummary(steps, { s1: 'done', s2: 'skipped' });
  assert.equal(summary.done, 1);
  assert.deepEqual(summary.lines.map((line) => line.text), ['Moved: #1 PR 1', 'Skipped: #2 PR 2', 'Still on your list: #3 PR 3']);
});

void test('plain text and ages', () => {
  assert.equal(plainText('> quoted\n**bold** and `code` and [a link](https://x)'), 'quoted bold and code and a link');
  assert.equal(ago(NOW - 30_000, NOW), 'just now');
  assert.equal(ago(NOW - 5 * 60_000, NOW), '5 minutes ago');
  assert.equal(ago(NOW - 26 * 3_600_000, NOW), 'yesterday');
});
