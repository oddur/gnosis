import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergePrStatus } from '../lib/merge-pr-status';
import type { PrStatus } from '../lib/types';
const status = (headSha: string, checkedAt: number, state: 'success' | 'failure'): PrStatus => ({
  signals: {
    url: 'https://github.com/a/b/pull/1',
    headSha,
    checkedAt,
    comments: 0,
    checks: { state, total: 1, passed: state === 'success' ? 1 : 0 },
  },
  checkSnapshot: { url: 'https://github.com/a/b/pull/1', headSha, checkedAt, checks: [] },
  labels: [],
  mergeable: true,
  isDraft: false,
  ciChecks: [],
  ciConclusion: state,
  reviewSummary: { approved: 0, commented: 0, changesRequested: 0 },
  baseBranch: 'main',
  commitCount: 1,
  requestedReviewers: [],
  requestedTeams: [],
  mergeableState: 'clean',
  autoMerge: null,
  milestone: null,
});
void test('a late summary response cannot undo pushed check results', () => {
  const fresh = status('a', 200, 'failure');
  const merged = mergePrStatus(fresh, status('a', 100, 'success'));
  assert.equal(merged.ciConclusion, 'failure');
  assert.equal(merged.checkSnapshot?.checkedAt, 200);
  assert.equal(mergePrStatus(fresh, status('a', 300, 'success')).ciConclusion, 'success');
});
void test('never carry checks across head revisions', () => {
  const merged = mergePrStatus(status('a', 200, 'failure'), status('b', 100, 'success'));
  assert.equal(merged.signals?.headSha, 'b');
  assert.equal(merged.checkSnapshot?.headSha, 'b');
});
