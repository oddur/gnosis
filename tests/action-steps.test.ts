import test from 'node:test';
import assert from 'node:assert/strict';
import { conflictSteps, listSummary, restackSteps, stackMergeSteps } from '../lib/action-steps';
import type { ConflictFile, ConflictSession, RestackPlan } from '../lib/conflict-resolution';
import type { PrActionState, PrMergePlan } from '../lib/pr-actions';

const url = (n: number) => `https://github.com/o/r/pull/${n}`;
function state(n: number): PrActionState {
  return {
    url: url(n),
    number: n,
    title: `Change ${n}`,
    headBranch: `branch-${n}`,
    headSha: `head-${n}`,
    baseSha: `base-${n}`,
    baseBranch: n === 1 ? 'main' : `branch-${n - 1}`,
    state: 'OPEN',
    isDraft: false,
    id: `PR_${n}`,
    account: 'reviewer',
    checkedAt: 0,
    headRepo: 'o/r',
    repository: 'o/r',
    archived: false,
    canWrite: true,
    mergeable: 'MERGEABLE',
    mergeState: 'CLEAN',
    methods: ['SQUASH', 'MERGE'],
    defaultMethod: 'SQUASH',
    autoMerge: null,
    canEnableAuto: true,
    canDisableAuto: true,
    canUpdateBranch: true,
    canChangeDraft: true,
    mergeQueue: false,
    inMergeQueue: false,
    stack: null,
  };
}
function mergePlan(overrides: Partial<PrMergePlan> = {}): PrMergePlan {
  const members = [1, 2, 3].map(state);
  return {
    target: members[2],
    members,
    baseBranch: 'main',
    methods: ['SQUASH', 'MERGE'],
    mergeQueue: false,
    createStack: true,
    ...overrides,
  };
}
const ids = (plan: { steps: { id: string }[] }) => plan.steps.map((s) => s.id);
const statuses = (plan: { steps: { status: string }[] }) => plan.steps.map((s) => s.status);

void test('stack merge: review, method and a single point of no return, in the order the service writes', () => {
  const plan = stackMergeSteps(mergePlan(), { page: 'review', method: 'SQUASH' });
  assert.deepEqual(ids(plan), ['review', 'method', 'merge']);
  assert.deepEqual(statuses(plan), ['current', 'upcoming', 'upcoming']);
  assert.equal(plan.steps[0].label, 'Review 3 PRs');
  assert.equal(plan.steps[0].detail, '#1, #2, #3 → main');
  assert.equal(plan.steps[1].detail, 'Squash and merge');
  assert.match(plan.steps[2].label, /Create a GitHub stack and merge into main/);
  assert.match(plan.steps[2].detail ?? '', /Two GitHub writes/);
  assert.deepEqual(
    plan.steps.map((s) => !!s.pointOfNoReturn),
    [false, false, true]
  );
  assert.ok(
    plan.steps.every((s) => !s.optional),
    'No merge step can be skipped'
  );

  const confirm = stackMergeSteps(mergePlan({ createStack: false }), { page: 'confirm', method: 'MERGE' });
  assert.equal(confirm.current, 2);
  assert.deepEqual(statuses(confirm), ['done', 'done', 'current']);
  assert.equal(confirm.steps[2].label, 'Merge into main');
});

void test('stack merge: a merge queue has no method step; loading, blockers and failures stay in their step', () => {
  const queue = stackMergeSteps(mergePlan({ mergeQueue: true, createStack: false }), {
    page: 'method',
    method: 'SQUASH',
  });
  assert.deepEqual(ids(queue), ['review', 'merge']);
  assert.equal(queue.current, 1, 'A queued merge skips straight to the merge step');
  assert.equal(queue.steps[1].label, 'Add to the main merge queue');

  const loading = stackMergeSteps(undefined, { page: 'review', method: 'SQUASH', loading: true, count: 3 });
  assert.equal(loading.steps[0].label, 'Check revisions and permissions');
  assert.equal(loading.steps[0].status, 'running');

  const blocked = stackMergeSteps(mergePlan({ blockedReason: 'Resolve the stack’s merge conflicts first.' }), {
    page: 'review',
    method: 'SQUASH',
  });
  assert.equal(blocked.steps[0].status, 'blocked');
  assert.match(blocked.steps[0].error ?? '', /merge conflicts/);

  const failed = stackMergeSteps(mergePlan(), {
    page: 'confirm',
    method: 'SQUASH',
    failure: { step: 'merge', message: 'This PR or stack changed since confirmation.' },
  });
  assert.deepEqual(statuses(failed), ['done', 'done', 'failed']);
  assert.equal(failed.steps[2].error, 'This PR or stack changed since confirmation.');
  assert.equal(failed.steps[0].error, undefined);

  const running = stackMergeSteps(mergePlan(), { page: 'confirm', method: 'SQUASH', running: true });
  assert.equal(running.steps[2].status, 'running');
});

function file(name: string, resolved = false): ConflictFile {
  return {
    path: `src/${name}`,
    mode: '100644',
    base: '',
    ours: '',
    theirs: '',
    original: '',
    result: '',
    resolved,
    source: 'manual',
  };
}
function session(overrides: Partial<ConflictSession> = {}): ConflictSession {
  return {
    id: 'a'.repeat(64),
    account: 'reviewer',
    url: url(1),
    title: 'Retry',
    headRepo: 'o/r',
    baseRepo: 'o/r',
    headBranch: 'feature/retry',
    baseBranch: 'develop',
    headSha: 'a'.repeat(40),
    baseSha: 'b'.repeat(40),
    tree: 'c'.repeat(40),
    files: [file('conflicts.go', true), file('retry.go')],
    version: 1,
    status: 'editing',
    preparation: 'conflicts',
    ...overrides,
  };
}

void test('conflicts: one plan from start to end; resolving includes review, then one confirmation pushes', () => {
  const editing = conflictSteps(session());
  assert.deepEqual(ids(editing), ['resolve', 'push']);
  assert.equal(editing.steps[0].label, 'Resolve 2 files');
  assert.equal(editing.steps[0].detail, '1 of 2 reviewed');
  assert.equal(editing.steps[1].label, 'Confirm and push to feature/retry');
  assert.equal(editing.steps[1].pointOfNoReturn, true);
  assert.equal(editing.current, 0);
  const confirming = conflictSteps(session(), { confirming: true });
  assert.deepEqual(statuses(confirming), ['done', 'current']);
  // Marking files reviewed changes the detail, never the number of steps.
  assert.equal(conflictSteps(session({ files: [file('a', true), file('b', true)] })).steps.length, 2);

  const failed = conflictSteps(session(), {
    confirming: true,
    failure: { step: 'push', message: 'Git could not complete this operation.' },
  });
  assert.equal(failed.steps[1].status, 'failed');

  const withDependents = conflictSteps(session({ dependents: [url(2), url(3)] }));
  assert.deepEqual(ids(withDependents), ['resolve', 'push', 'restack']);
  assert.equal(withDependents.steps[2].optional, true);
  const published = conflictSteps(session({ dependents: [url(2)], status: 'published' }));
  assert.deepEqual(statuses(published), ['done', 'done', 'current']);
  assert.deepEqual(statuses(conflictSteps(session({ status: 'published' }))), ['done', 'done']);

  const clean = conflictSteps(session({ files: [], preparation: 'clean-merge' }));
  assert.equal(clean.steps[0].label, 'No conflicts to resolve');
  assert.deepEqual(statuses(clean), ['done', 'current']);
  const upToDate = conflictSteps(session({ files: [], preparation: 'up-to-date', dependents: [url(2)] }));
  assert.deepEqual(statuses(upToDate), ['done', 'skipped', 'skipped']);
});

function restack(overrides: Partial<RestackPlan> = {}): RestackPlan {
  return {
    token: 'e'.repeat(64),
    status: 'prepared',
    rootSha: 'd'.repeat(40),
    expected: [],
    branches: [2, 3].map((n) => ({
      url: url(n),
      title: `Change ${n}`,
      repo: 'o/r',
      branch: `branch-${n}`,
      baseBranch: 'feature/retry',
      baseRepo: 'o/r',
      oldSha: 'a'.repeat(40),
      newSha: 'f'.repeat(40),
      baseSha: 'b'.repeat(40),
      commits: 6,
      reused: 0,
      patch: '',
      files: [],
    })),
    ...overrides,
  };
}

void test('restack: rebase (skippable), conflicts only when Git pauses, review, then an atomic push', () => {
  const published = session({ status: 'published', commitSha: 'd'.repeat(40), dependents: [url(2), url(3)] });
  const start = restackSteps(published, {});
  assert.deepEqual(ids(start), ['rebase', 'review', 'push']);
  assert.equal(start.steps[0].label, 'Rebase 2 dependent PRs onto feature/retry');
  assert.equal(start.steps[0].optional, true, 'Restacking can be skipped before it starts');
  assert.equal(start.steps[2].pointOfNoReturn, true);

  const prepared = restackSteps({ ...published, restack: restack() }, {});
  assert.equal(prepared.steps[0].optional, false);
  assert.match(prepared.steps[0].detail ?? '', /12 commits/);
  assert.equal(prepared.steps[prepared.current].id, 'review');

  const blocked = restackSteps(
    {
      ...published,
      restack: restack({
        status: 'blocked',
        branches: [],
        blocked: {
          url: url(2),
          title: 'Change 2',
          reason: 'Paused',
          paths: ['src/conflicts.go', 'src/retry.go'],
          files: [file('conflicts.go'), file('retry.go')],
          reused: 0,
        },
      }),
    },
    {}
  );
  assert.deepEqual(ids(blocked), ['rebase', 'resolve', 'review', 'push']);
  assert.equal(blocked.steps[1].label, 'Resolve 2 conflicts in #2');
  assert.equal(blocked.steps[1].detail, 'conflicts.go, retry.go');
  assert.deepEqual(statuses(blocked), ['paused', 'current', 'upcoming', 'upcoming']);

  const resumed = restackSteps({ ...published, restack: restack() }, { paused: true, confirming: true });
  assert.deepEqual(ids(resumed), ['rebase', 'resolve', 'review', 'push']);
  assert.equal(resumed.current, 3);

  const pushFailed = restackSteps(
    { ...published, restack: restack() },
    { confirming: true, failure: { step: 'push', message: 'Lease rejected' } }
  );
  assert.equal(pushFailed.steps[2].status, 'failed');
  assert.equal(pushFailed.steps[1].status, 'done');

  const done = restackSteps({ ...published, restack: restack({ status: 'published' }) }, {});
  assert.ok(done.steps.every((s) => s.status === 'done'));
});

void test('long lists name a few items and count the rest', () => {
  assert.equal(listSummary(['a', 'b']), 'a, b');
  assert.equal(listSummary(['a', 'b', 'c', 'd', 'e']), 'a, b, c and 2 more');
});
