import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewEvidence } from '../lib/review-evidence';
import type { ReviewMember } from '../lib/workbench';
import type { PrChecks, PrCheck } from '../lib/pr-checks';
import type { QueueSignals } from '../lib/queue-signals';
import type { GitHubReviewThread } from '../lib/review-threads';
const member = { url: 'https://github.com/o/r/pull/1', headSha: 'current', number: 1 } as ReviewMember;
const now = 1_000_000;
const check = (status: string, conclusion: string | null, id = 'check:1') =>
  ({ id, name: id, status, conclusion }) as PrCheck;
const checks = (list: PrCheck[]): PrChecks => ({
  url: member.url,
  headSha: member.headSha,
  checkedAt: now,
  checks: list,
});
const signal = (): QueueSignals => ({
  url: member.url,
  headSha: member.headSha,
  checkedAt: now,
  comments: 0,
  checks: { state: 'success', passed: 1, failed: 0, running: 0, skipped: 0, total: 1 },
});
void test('absence of evidence is unknown, never a pass or successful reproduction', () => {
  const value = reviewEvidence(member, { now });
  assert.ok(value.rows.every((row) => row.tone === 'muted'));
  assert.equal(value.rows[0].label, 'Checks not available');
  assert.equal(value.rows[1].label, 'Reviewed commit unknown');
  assert.equal(value.rows[2].label, 'Discussions not loaded');
});
void test('current checks distinguish failure, running, skipped, and no checks', () => {
  const row = reviewEvidence(member, {
    now,
    checks: checks([
      check('completed', 'success'),
      check('completed', 'cancelled', 'check:2'),
      check('in_progress', null),
      check('completed', 'skipped'),
    ]),
  }).rows[0];
  assert.equal(row.label, '1 check needs attention · 1 running · 1 passed · 1 skipped or neutral');
  assert.equal(row.checkId, 'check:2');
  assert.equal(row.tone, 'danger');
  assert.equal(reviewEvidence(member, { now, checks: checks([]) }).rows[0].tone, 'muted');
  assert.equal(reviewEvidence(member, { now, checks: checks([check('completed', 'neutral')]) }).rows[0].tone, 'muted');
});
void test('revision mismatch and stale, partial, or delayed results never look current and green', () => {
  const success = checks([check('completed', 'success')]);
  for (const input of [
    { checks: { ...success, headSha: 'previous' } },
    { checks: { ...success, checkedAt: 1 } },
    { checks: { ...success, warning: 'Partial data' } },
    { checks: success, checkError: 'Rate limited' },
  ]) {
    assert.equal(reviewEvidence(member, { now, ...input }).rows[0].tone, 'muted');
  }
  assert.match(reviewEvidence(member, { now, checks: { ...success, checkedAt: 1 } }).rows[0].label, /^Saved:/);
});
void test('a newer rollup wins over a passing check list from the previous attempt', () => {
  const signals = signal();
  signals.checks = { state: 'pending', passed: 0, failed: 0, running: 1, skipped: 0, total: 1 };
  const value = reviewEvidence(member, {
    now,
    signals,
    checks: { ...checks([check('completed', 'success')]), checkedAt: now - 1 },
  });
  assert.equal(value.rows[0].label, '1 running');
  assert.equal(value.rows[0].tone, 'warning');
});
void test('latest approval is attributed to its actual revision without claiming GitHub dismissed it', () => {
  const signals = {
    ...signal(),
    latestReview: {
      url: member.url + '#pullrequestreview-2',
      state: 'APPROVED',
      author: 'maya',
      submittedAt: '2026-11-01T10:00:00Z',
      headSha: 'previous',
    },
  };
  let row = reviewEvidence(member, { now, signals }).rows[1];
  assert.equal(row.label, 'Latest review on another commit');
  assert.equal(row.tone, 'warning');
  assert.match(row.detail, /does not automatically dismiss/);
  assert.equal(row.href, signals.latestReview.url);
  signals.latestReview.headSha = member.headSha;
  row = reviewEvidence(member, { now, signals }).rows[1];
  assert.equal(row.tone, 'success');
  assert.equal(
    reviewEvidence(member, { now, signals: { ...signals, headSha: 'older' } }).rows[1].label,
    'Reviewed commit unknown'
  );
  assert.equal(
    reviewEvidence(member, { now, signals: { ...signal(), latestReview: null } }).rows[1].label,
    'No submitted reviews'
  );
});
void test('discussion resolution changes update evidence; old-code unresolved threads still count', () => {
  const thread = {
    id: 't1',
    isResolved: false,
    isOutdated: true,
    comments: [{ url: member.url + '#discussion_r1' }],
  } as GitHubReviewThread;
  const discussion = { headSha: member.headSha, baseSha: 'base', checkedAt: now, threads: [thread] };
  let row = reviewEvidence(member, { now, discussion }).rows[2];
  assert.equal(row.label, '1 unresolved discussion');
  assert.match(row.detail, /attached to older code/);
  assert.equal(row.href, thread.comments[0].url);
  row = reviewEvidence(member, { now, discussion: { ...discussion, threads: [{ ...thread, isResolved: true }] } })
    .rows[2];
  assert.equal(row.label, 'All loaded discussions resolved');
  assert.match(reviewEvidence(member, { now, discussion: { ...discussion, headSha: 'old' } }).rows[2].label, /^Saved:/);
});

void test('new sync events are fresh between display clock ticks', () => {
  const value = reviewEvidence(member, {
    now,
    checks: { ...checks([check('completed', 'success')]), checkedAt: now + 25_000 },
    discussion: { headSha: member.headSha, baseSha: 'base', checkedAt: now + 25_000, threads: [] },
  });
  assert.equal(value.rows[0].tone, 'success');
  assert.equal(value.rows[2].label, 'No code discussions');
});

void test('evidence completeness is independent of the snapshot timestamp', () => {
  const signals = signal();
  const discussion = { headSha: member.headSha, baseSha: 'base', checkedAt: now, threads: [] };
  let value = reviewEvidence(member, { now, signals, discussion });
  assert.equal(value.rows[0].hasEvidence, true);
  assert.equal(value.rows[1].checkedAt, now);
  assert.equal(value.rows[1].hasEvidence, false, 'Legacy snapshots lack the reviewed commit');
  assert.equal(value.rows[2].hasEvidence, true);
  signals.latestReview = {
    url: member.url,
    author: 'maya',
    state: 'APPROVED',
    submittedAt: '2026-11-01T10:00:00Z',
    headSha: null,
  };
  assert.equal(reviewEvidence(member, { now, signals }).rows[1].hasEvidence, false);
  signals.latestReview = null;
  value = reviewEvidence(member, { now, signals, discussion });
  assert.ok(
    value.rows.every((row) => row.hasEvidence),
    'Confirmed absence of reviews is known evidence'
  );
  assert.equal(
    reviewEvidence(member, { now, checks: { ...checks([check('completed', 'success')]), warning: 'Partial data' } })
      .rows[0].hasEvidence,
    false
  );
});
