import assert from 'node:assert/strict';
import test from 'node:test';
import { conflictFileAction, describeConflictError } from '../lib/conflict-flow';

void test('each file state has one next action; Mark reviewed waits for the result to be shown', () => {
  const base = { otherFilesPending: true };
  assert.equal(conflictFileAction({ ...base, stage: 'conflicted', resultShown: true }), 'next-conflict');
  assert.equal(conflictFileAction({ ...base, stage: 'resolved', resultShown: false }), 'review-result');
  assert.equal(conflictFileAction({ ...base, stage: 'resolved', resultShown: true }), 'mark-reviewed');
  assert.equal(conflictFileAction({ ...base, stage: 'reviewed', resultShown: true }), 'next-file');
  assert.equal(conflictFileAction({ stage: 'reviewed', resultShown: true, otherFilesPending: false }), 'confirm');
  assert.equal(conflictFileAction({ stage: undefined, resultShown: false, otherFilesPending: false }), 'none');
});

void test('errors use plain copy and keep the raw output for Details', () => {
  const ctx = { stage: 'push' as const, headBranch: 'feature/retry', baseBranch: 'main' };
  const lease = describeConflictError(
    "Error invoking remote method 'conflict-resolution': Error: Git could not complete this operation. ! [rejected] feature/retry (stale info)",
    ctx
  );
  assert.equal(lease.title, 'Someone pushed to feature/retry after you started.');
  assert.match(lease.body, /^Nothing was pushed\. Your resolutions are saved\./);
  assert.equal(lease.recovery, 'load-latest');
  assert.match(lease.details ?? '', /stale info/);
  assert.equal(
    describeConflictError(
      'The PR or its base branch changed. Reopen the workspace and start a new resolution before publishing.',
      ctx
    ).recovery,
    'load-latest'
  );
  const protectedBranch = describeConflictError(
    'Git could not complete this operation. remote: error: GH006: Protected branch update failed',
    ctx
  );
  assert.match(protectedBranch.title, /Branch protection/);
  const network = describeConflictError('Git could not complete this operation. fatal: unable to access', ctx);
  assert.equal(network.recovery, 'check-again', 'A push is never resent; the user reads the branch again');
  const unknown = describeConflictError('Git could not complete this operation. fatal: something odd', ctx);
  assert.equal(unknown.recovery, 'check-again');
  assert.doesNotMatch(unknown.title + unknown.body, /fatal|Git could not/);
  const prepare = describeConflictError('Git could not complete this operation. fatal: bad object', {
    stage: 'prepare',
  });
  assert.equal(prepare.title, 'Gnosis couldn’t prepare this merge.');
  assert.equal(prepare.recovery, 'retry');
  assert.equal(
    describeConflictError('Select an unresolved text file.', { stage: 'other' }).title,
    'Select an unresolved text file.'
  );
});
