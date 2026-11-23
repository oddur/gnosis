/* eslint-disable @typescript-eslint/require-await -- Async API test doubles. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Octokit } from '@octokit/rest';
import { createPrActionsService, PrMergeFailure } from '../src/pr-actions-service';
import { createPrMergeMonitor } from '../src/pr-merge-monitor';
import { createActivityService } from '../src/activity-service';
import { GitHubBackoffError } from '../lib/github-client';
import { singleMergePlan, workflowPermissionReason, type PrActionRequest } from '../lib/pr-actions';
const url = (n: number) => `https://github.com/o/r/pull/${n}`;
function fixture(native = false) {
  let nativeStack = native,
    stackBaseBranch = 'main',
    account = 'reviewer',
    calls = 0;
  const writes: { query: string; params: Record<string, unknown> }[] = [];
  const prs = [1, 2, 3].map((n) => ({
    url: url(n),
    number: n,
    title: `Change ${n}`,
    id: `PR_${n}`,
    headRefName: `branch-${n}`,
    headRefOid: `head-${n}`,
    baseRefName: n === 1 ? 'main' : `branch-${n - 1}`,
    baseRefOid: `base-${n}`,
    baseRef: { target: { oid: `base-${n}` } } as { target: { oid: string } } | null,
    state: 'OPEN',
    isDraft: false,
    headRepository: { nameWithOwner: 'o/r' },
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    viewerCanEnableAutoMerge: true,
    viewerCanDisableAutoMerge: true,
    viewerCanUpdateBranch: true,
    viewerDidAuthor: false,
    autoMergeRequest: null as null | { mergeMethod: string },
    mergeQueue: null as null | { id: string },
    isInMergeQueue: false,
  }));
  const repo = {
    nameWithOwner: 'o/r',
    isArchived: false,
    viewerPermission: 'WRITE',
    viewerDefaultMergeMethod: 'SQUASH',
    mergeCommitAllowed: true,
    squashMergeAllowed: true,
    rebaseMergeAllowed: true,
  };
  const client = {
    graphql: async (query: string, params: Record<string, unknown>) => {
      if (query.startsWith('query')) {
        calls++;
        const answer = (number: unknown) => {
          const pr = prs.find((p) => p.number === number);
          return pr
            ? {
                ...pr,
                stack: nativeStack
                  ? {
                      number: 8,
                      baseRefName: stackBaseBranch,
                      entries: { totalCount: 3, nodes: prs.map((p, i) => ({ position: i + 1, pullRequest: { ...p } })) },
                    }
                  : null,
              }
            : null;
        };
        // A stack read aliases each PR as `pN: pullRequest(number:N)`.
        const aliases = [...query.matchAll(/(p\d+): pullRequest\(number:(\d+)\)/g)];
        if (aliases.length) {
          const data = {
            viewer: { login: account },
            repository: { ...repo, ...Object.fromEntries(aliases.map(([, alias, n]) => [alias, answer(Number(n))])) },
          };
          // As GitHub does: a missing PR nulls its alias and names it in `errors`; the rest of the answer stands.
          const missing = aliases.filter(([, , n]) => !answer(Number(n)));
          if (missing.length)
            throw Object.assign(new Error('Request failed due to following response errors'), {
              data,
              errors: missing.map(([, alias, n]) => ({
                type: 'NOT_FOUND',
                path: ['repository', alias],
                message: `Could not resolve to a PullRequest with the number of ${n}.`,
              })),
            });
          return data;
        }
        const pullRequest = answer(params.number);
        if (!pullRequest) throw new Error('Unknown fixture PR');
        return { viewer: { login: account }, repository: { ...repo, pullRequest } };
      }
      writes.push({ query, params });
      if (query.includes('MarkPullRequestReadyForReviewInput'))
        return { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } };
      if (query.includes('ConvertPullRequestToDraftInput'))
        return { convertPullRequestToDraft: { pullRequest: { isDraft: true } } };
      if (query.includes('MergePullRequestInput')) return { mergePullRequest: { pullRequest: { merged: true } } };
      if (query.includes('EnqueuePullRequestInput'))
        return { enqueuePullRequest: { mergeQueueEntry: { id: 'queue-1' } } };
      if (query.includes('EnablePullRequestAutoMergeInput'))
        return { enablePullRequestAutoMerge: { pullRequest: { id: 'PR_1' } } };
      if (query.includes('DisablePullRequestAutoMergeInput'))
        return { disablePullRequestAutoMerge: { pullRequest: { id: 'PR_1' } } };
      return { updatePullRequestBranch: { pullRequest: { headRefOid: 'updated-head' } } };
    },
    request: async (query: string, params: Record<string, unknown>) => {
      writes.push({ query, params });
      if (query.startsWith('POST')) {
        nativeStack = true;
        return { data: {} };
      }
      return { data: { status: 'pending', details: { uuid: 'operation-1' } } };
    },
  } as unknown as Octokit;
  const service = createPrActionsService();
  const request = async (n = 1, kind: PrActionRequest['kind'] = 'merge'): Promise<PrActionRequest> => {
    const state = await service.read(client, url(n));
    return {
      account: 'reviewer',
      kind,
      url: url(n),
      method: 'SQUASH',
      revisions: (kind === 'merge' ? singleMergePlan(state).members : [state]).map((m) => ({
        url: m.url,
        headSha: m.headSha,
        baseSha: m.baseSha,
        baseBranch: m.baseBranch,
      })),
    };
  };
  return {
    service,
    client,
    prs,
    repo,
    writes,
    request,
    setAccount: (s: string) => {
      account = s;
    },
    setStackBase: (s: string) => {
      stackBaseBranch = s;
    },
    reads: () => calls,
  };
}
void test('capability reads coalesce and cache; merges recheck and pin the head', async () => {
  const f = fixture();
  await Promise.all([f.service.read(f.client, url(1)), f.service.read(f.client, url(1))]);
  assert.equal(f.reads(), 1);
  const req = await f.request();
  await f.service.act(f.client, { ...req, commitTitle: 'Ship the queue', commitBody: 'Preserves ordering.' });
  assert.equal(f.reads(), 2);
  assert.equal(f.writes.length, 1);
  assert.match(f.writes[0].query, /MergePullRequestInput/);
  assert.deepEqual(f.writes[0].params.input, {
    pullRequestId: 'PR_1',
    expectedHeadOid: 'head-1',
    mergeMethod: 'SQUASH',
    commitHeadline: 'Ship the queue',
    commitBody: 'Preserves ordering.',
  });
});
void test('reject changed head, base, account, permissions, draft and disallowed merge methods before writing', async () => {
  for (const change of ['head', 'base', 'branch', 'account', 'permissions', 'draft', 'method', 'rules']) {
    const f = fixture(),
      req = await f.request();
    if (change === 'head') f.prs[0].headRefOid = 'new-head';
    if (change === 'base') f.prs[0].baseRef = { target: { oid: 'new-base' } };
    if (change === 'branch') f.prs[0].baseRefName = 'release';
    if (change === 'account') f.setAccount('someone-else');
    if (change === 'permissions') f.repo.viewerPermission = 'READ';
    if (change === 'draft') f.prs[0].isDraft = true;
    if (change === 'method') f.repo.squashMergeAllowed = false;
    if (change === 'rules') f.prs[0].mergeStateStatus = 'BLOCKED';
    await assert.rejects(f.service.act(f.client, req));
    assert.equal(f.writes.length, 0, change);
  }
});
void test('both branch update methods pin the confirmed SHA and enforce permission', async () => {
  for (const [kind, method] of [
    ['update-merge', 'MERGE'],
    ['update-rebase', 'REBASE'],
  ] as const) {
    const f = fixture();
    await f.service.act(f.client, await f.request(1, kind));
    assert.deepEqual(f.writes[0].params.input, {
      pullRequestId: 'PR_1',
      expectedHeadOid: 'head-1',
      updateMethod: method,
    });
    f.prs[0].viewerCanUpdateBranch = false;
    await assert.rejects(f.service.act(f.client, await f.request(1, kind)), /cannot be updated/);
    assert.equal(f.writes.length, 1);
  }
});
void test('mergeable optional failing checks and hooks defer final enforcement to GitHub', async () => {
  for (const mergeState of ['UNSTABLE', 'HAS_HOOKS']) {
    const f = fixture();
    f.prs[0].mergeStateStatus = mergeState;
    assert.equal((await f.service.act(f.client, await f.request())).status, 'merged');
    assert.equal(f.writes.length, 1);
  }
});
void test('BLOCKED with every visible requirement met keeps Merge available, and a refusal from GitHub is reported once', async () => {
  const blocked = (f: ReturnType<typeof fixture>, reviewDecision: string | null, rollup: string | null) =>
    Object.assign(f.prs[0], {
      mergeStateStatus: 'BLOCKED',
      reviewDecision,
      commits: { nodes: [{ commit: { statusCheckRollup: rollup === null ? null : { state: rollup } } }] },
    });
  // klanggames/seed#35392 to a repo-only sign-in: BLOCKED, no review decision, checks passed.
  const f = fixture();
  blocked(f, null, 'SUCCESS');
  const state = await f.service.read(f.client, url(1), true);
  assert.equal(singleMergePlan(state).blockedReason, undefined);
  assert.equal((await f.service.act(f.client, await f.request())).status, 'merged');
  // GitHub refuses a merge its rules do not allow; its reason reaches the dialog and nothing is retried.
  const refused = fixture();
  blocked(refused, 'APPROVED', null);
  const original = refused.client.graphql;
  let attempts = 0;
  refused.client.graphql = (async (query: string, params: Record<string, unknown>) => {
    if (query.includes('MergePullRequestInput')) {
      attempts++;
      throw new Error('Repository rule violations found\n\nReview from code owner required.');
    }
    return original(query, params);
  }) as typeof refused.client.graphql;
  await assert.rejects(refused.service.act(refused.client, await refused.request()), /Repository rule violations found/);
  assert.equal(attempts, 1);
  // Anything Gnosis can see that blocks still disables Merge.
  for (const [decision, rollup] of [['REVIEW_REQUIRED', 'SUCCESS'], ['CHANGES_REQUESTED', 'SUCCESS'], [null, 'FAILURE'], [null, 'PENDING']] as const) {
    const g = fixture();
    blocked(g, decision, rollup);
    assert.match(singleMergePlan(await g.service.read(g.client, url(1), true)).blockedReason ?? '', /not confirmed/, `${decision} ${rollup}`);
  }
});
void test('a PR that changes workflow files: Merge and rebase need the workflow permission, merge-commit updates do not', () => {
  const met = { mergeable: 'MERGEABLE', mergeState: 'BLOCKED', reviewDecision: null, checkState: 'SUCCESS', stack: null };
  const files = ['.github/workflows/seed_job_seed_api.yaml'];
  assert.equal(
    workflowPermissionReason(met, 'merge', true, files),
    'Needs the workflow permission. Sign in again, or merge on GitHub.'
  );
  assert.equal(
    workflowPermissionReason(met, 'update-rebase', true, files),
    'Needs the workflow permission. Sign in again, or update the branch on GitHub.'
  );
  assert.equal(workflowPermissionReason(met, 'merge', false, files), undefined, 'With workflow: GitHub decides');
  assert.equal(workflowPermissionReason(met, 'merge', true, []), undefined, 'No workflow files');
  assert.equal(workflowPermissionReason(met, 'merge', true, undefined), undefined, 'Paths unknown: GitHub decides');
  assert.equal(workflowPermissionReason(met, 'update-rebase', true, undefined), undefined);
  // GitHub answered CLEAN: nothing to explain. A visible blocker keeps mergeBlockedReason's answer.
  assert.equal(workflowPermissionReason({ ...met, mergeState: 'CLEAN' }, 'merge', true, files), undefined);
  assert.equal(workflowPermissionReason({ ...met, reviewDecision: 'REVIEW_REQUIRED' }, 'merge', true, files), undefined);
});
void test('an unconfirmed merge response never reports success or retries the write', async () => {
  for (const response of [{}, { mergePullRequest: null }, { mergePullRequest: { pullRequest: { merged: false } } }]) {
    const f = fixture(),
      req = await f.request();
    const original = f.client.graphql;
    let writes = 0;
    f.client.graphql = (async (query: string, params: Record<string, unknown>) => {
      if (query.startsWith('mutation')) {
        writes++;
        return response;
      }
      return original(query, params);
    }) as typeof f.client.graphql;
    await assert.rejects(f.service.act(f.client, req), /did not confirm.*Check its status/);
    assert.equal(writes, 1);
  }
});
void test('auto-merge supports enable and disable, but native stacks stay unsupported', async () => {
  const f = fixture();
  await f.service.act(f.client, await f.request(1, 'enable-auto'));
  assert.match(f.writes[0].query, /EnablePullRequestAutoMergeInput/);
  f.prs[0].autoMergeRequest = { mergeMethod: 'SQUASH' };
  await f.service.act(f.client, await f.request(1, 'disable-auto'));
  assert.match(f.writes[1].query, /DisablePullRequestAutoMergeInput/);
  const native = fixture(true);
  await assert.rejects(
    native.service.act(native.client, await native.request(2, 'enable-auto')),
    /does not support auto-merge/
  );
  assert.equal(native.writes.length, 0);
});
void test('native stack merge is one atomic request with explicit prefix and revision guard', async () => {
  const f = fixture(true),
    req = await f.request(2);
  assert.deepEqual(
    req.revisions.map((r) => r.url),
    [url(1), url(2)]
  );
  const result = await f.service.act(f.client, req);
  assert.equal(result.status, 'pending');
  assert.equal(result.operation?.uuid, 'operation-1');
  assert.equal(f.writes.length, 1);
  assert.match(f.writes[0].query, /merge-async$/);
  assert.equal(f.writes[0].params.sha, 'head-2');
  assert.equal(f.writes[0].params.merge_action, 'direct_merge');
  const wrong = fixture(true);
  const w = await wrong.request(2);
  w.revisions = w.revisions.slice(1);
  await assert.rejects(wrong.service.act(wrong.client, w), /changed since confirmation/);
  assert.equal(wrong.writes.length, 0);
});
void test('whole stack must include exact native membership and detects movement of lower PRs', async () => {
  const f = fixture(true);
  assert.ok((await f.service.stackPlan(f.client, [url(2), url(3)])).blockedReason);
  const req = await f.request(3);
  f.prs[0].headRefOid = 'new-lower-head';
  await assert.rejects(f.service.act(f.client, req), /changed since confirmation/);
  assert.equal(f.writes.length, 0);
});
void test('register a linear Gnosis stack only with explicit confirmation, then merge atomically', async () => {
  const f = fixture(),
    plan = await f.service.stackPlan(f.client, [url(1), url(2), url(3)]);
  assert.equal(plan.createStack, true);
  assert.equal(plan.blockedReason, undefined);
  const req: PrActionRequest = {
    account: 'reviewer',
    kind: 'merge',
    url: url(3),
    method: 'SQUASH',
    createStack: true,
    revisions: plan.members,
  };
  const denied = fixture();
  await assert.rejects(denied.service.act(denied.client, { ...req, createStack: false }), /changed since confirmation/);
  assert.equal(denied.writes.length, 0);
  await f.service.act(f.client, req);
  assert.equal(f.writes.length, 2);
  assert.deepEqual(f.writes[0].params.pull_requests, [1, 2, 3]);
  assert.match(f.writes[1].query, /merge-async$/);
});
void test('a stack plan reads every member in one query, with the same states as single reads', async () => {
  const f = fixture(true);
  const plan = await f.service.stackPlan(f.client, [url(1), url(2), url(3)]);
  assert.equal(f.reads(), 1, 'one aliased query instead of one per member');
  const single = fixture(true);
  for (const [i, member] of plan.members.entries())
    assert.deepEqual(
      { ...member, checkedAt: 0 },
      { ...(await single.service.read(single.client, url(i + 1), true)), checkedAt: 0 }
    );
  // Cached members are reused; a forced plan reads again, still once.
  await f.service.stackPlan(f.client, [url(1), url(2), url(3)]);
  assert.equal(f.reads(), 1);
  await f.service.stackPlan(f.client, [url(1), url(2), url(3)], true);
  assert.equal(f.reads(), 2);
  // A member GitHub does not return fails the plan with GitHub's error for it.
  await assert.rejects(f.service.stackPlan(f.client, [url(1), url(4)], true), /number of 4/);
});
void test('one PR GitHub cannot read fails alone in a stack read', async () => {
  const f = fixture(true);
  const reads = f.service.readMany(f.client, [url(1), url(4), url(2)], true);
  const [one, missing, two] = await Promise.allSettled(reads);
  assert.equal(f.reads(), 1);
  assert.equal(one.status === 'fulfilled' && one.value.number, 1);
  assert.equal(two.status === 'fulfilled' && two.value.number, 2);
  assert.ok(missing.status === 'rejected');
  assert.match(String(missing.reason), /number of 4/);
});
void test('merging a new stack reads its members once before the write and once after', async () => {
  const f = fixture(),
    plan = await f.service.stackPlan(f.client, [url(1), url(2), url(3)]);
  const before = f.reads();
  await f.service.act(f.client, {
    account: 'reviewer',
    kind: 'merge',
    url: url(3),
    method: 'SQUASH',
    createStack: true,
    revisions: plan.members,
  });
  // Before: the target, then each member in turn (4), then the target after creating the stack (5).
  assert.equal(f.reads() - before, 2);
});
void test('a stack read that fails without saying where reads each member by itself', async () => {
  const f = fixture(true);
  const original = f.client.graphql;
  let aliased = 0;
  f.client.graphql = (async (query: string, params: Record<string, unknown>) => {
    if (/p\d+: pullRequest/.test(query)) {
      aliased++;
      throw Object.assign(new Error('Something went wrong while executing your query. This may be the result of a timeout'), { status: 502 });
    }
    return original(query, params);
  }) as typeof f.client.graphql;
  const states = await Promise.all(f.service.readMany(f.client, [url(1), url(2), url(3)], true));
  assert.deepEqual(states.map((s) => s.number), [1, 2, 3]);
  assert.equal(aliased, 1);
  assert.equal(f.reads(), 3, 'then one query per member');
});
void test('PR action states carry fork permissions for conflict updates', async () => {
  const f = fixture();
  f.prs[0].headRepository = { nameWithOwner: 'fork/r', viewerPermission: 'READ' } as typeof f.prs[0]['headRepository'];
  (f.prs[0] as typeof f.prs[0] & { maintainerCanModify: boolean }).maintainerCanModify = true;
  const state = await f.service.read(f.client, url(1), true);
  assert.equal(state.headRepoCanWrite, false);
  assert.equal(state.maintainerCanModify, true);
  const older = await f.service.read(f.client, url(2), true);
  assert.equal(older.headRepoCanWrite, undefined, 'a response without the field leaves the REST check in place');
});
void test('refuse non-linear and cross-repository grouped stacks', async () => {
  const f = fixture();
  f.prs[1].baseRefName = 'main';
  assert.match((await f.service.stackPlan(f.client, [url(1), url(2)])).blockedReason ?? '', /linear chain/);
  f.prs[1].baseRefName = 'branch-1';
  f.prs[1].headRepository = { nameWithOwner: 'fork/r' };
  assert.match((await f.service.stackPlan(f.client, [url(1), url(2)], true)).blockedReason ?? '', /same repository/);
});
void test('stack creation cannot silently change the confirmed destination or merge requirements', async () => {
  for (const change of ['branch', 'destination', 'permissions', 'draft', 'method', 'queue']) {
    const f = fixture(),
      plan = await f.service.stackPlan(f.client, [url(1), url(2), url(3)]);
    const req: PrActionRequest = {
      account: 'reviewer',
      kind: 'merge',
      url: url(3),
      method: 'SQUASH',
      createStack: true,
      revisions: plan.members,
    };
    const original = f.client.request;
    f.client.request = (async (route: string, params: Record<string, unknown>) => {
      const response = await original(route, params);
      if (route.startsWith('POST')) {
        if (change === 'branch') f.prs[0].baseRefName = 'release'; // Same SHA, different destination.
        if (change === 'destination') f.setStackBase('release');
        if (change === 'permissions') f.repo.viewerPermission = 'READ';
        if (change === 'draft') f.prs[0].isDraft = true;
        if (change === 'method') f.repo.squashMergeAllowed = false;
        if (change === 'queue') f.prs[0].mergeQueue = { id: 'queue' };
      }
      return response;
    }) as typeof f.client.request;
    await assert.rejects(f.service.act(f.client, req), /stack was created.*changed/, change);
    assert.equal(f.writes.length, 1, change);
    assert.match(f.writes[0].query, /^POST/);
  }
});
void test('merge queue uses queue action without custom method or message', async () => {
  const f = fixture(true);
  f.prs[0].mergeQueue = { id: 'queue' };
  const result = await f.service.act(f.client, await f.request(3));
  assert.equal(result.status, 'pending');
  assert.equal(f.writes[0].params.merge_action, 'merge_queue');
  assert.equal(f.writes[0].params.merge_method, undefined);
  const single = fixture();
  single.prs[0].mergeQueue = { id: 'queue' };
  assert.equal((await single.service.act(single.client, await single.request())).status, 'enqueued');
  assert.match(single.writes[0].query, /EnqueuePullRequestInput/);
});
void test('write errors are never replayed; duplicate in-flight actions reject', async () => {
  const f = fixture(),
    req = await f.request();
  let attempts = 0;
  const firstRead = f.client.graphql;
  f.client.graphql = (async (query: string, params: Record<string, unknown>) => {
    if (query.startsWith('mutation')) {
      attempts++;
      throw Error('Network unavailable');
    }
    return firstRead(query, params);
  }) as typeof f.client.graphql;
  await assert.rejects(f.service.act(f.client, req));
  assert.equal(attempts, 1);
  const slow = fixture(),
    r = await slow.request();
  let finish: () => void = () => {};
  let started: () => void = () => {};
  const mutationStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const original = slow.client.graphql;
  slow.client.graphql = (async (query: string, options: Record<string, unknown>) => {
    if (query.startsWith('mutation'))
      await new Promise<void>((resolve) => {
        finish = resolve;
        started();
      });
    return original(query, options);
  }) as typeof slow.client.graphql;
  const running = slow.service.act(slow.client, r);
  await mutationStarted;
  await assert.rejects(slow.service.act(slow.client, r), /already in progress/);
  finish();
  await running;
  assert.equal(slow.writes.length, 1);
});
void test('accepted stack polling persists across restart, isolates accounts and obeys backoff', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gnosis-merge-test-'));
  let clock = 1000,
    login = 'reviewer',
    polls = 0,
    mode = 'limit';
  const activities = createActivityService(() => clock),
    client = {} as Octokit;
  const deps = {
    directory: () => directory,
    auth: () => ({ login, client }),
    activity: activities,
    now: () => clock,
    poll: async () => {
      polls++;
      if (mode === 'limit') throw new GitHubBackoffError(61_000);
      return { status: 'merged' as const, message: 'Merged on GitHub.' };
    },
    changed: async () => {},
  };
  try {
    createPrMergeMonitor(deps).track(login, 'Merge stack', {
      url: url(3),
      uuid: 'operation-1',
      members: [url(1), url(2), url(3)],
    });
    const resumed = createPrMergeMonitor(deps);
    login = 'someone-else';
    resumed.tick();
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(polls, 0);
    login = 'reviewer';
    resumed.tick();
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(polls, 1);
    assert.equal(activities.list()[0].status, 'paused');
    clock = 60_000;
    resumed.tick();
    assert.equal(polls, 1);
    clock = 61_001;
    mode = 'merged';
    resumed.tick();
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(polls, 2);
    assert.equal(activities.list()[0].status, 'completed');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, 'pending-pr-merges.json'), 'utf8')), []);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
void test('terminal atomic merge rejection ends monitoring without resubmitting', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gnosis-merge-test-'));
  const activities = createActivityService();
  let polls = 0;
  try {
    const monitor = createPrMergeMonitor({
      directory: () => directory,
      auth: () => ({ login: 'reviewer', client: {} as Octokit }),
      activity: activities,
      poll: async () => {
        polls++;
        throw new PrMergeFailure('Required approval missing. Nothing was merged.');
      },
      changed: async () => {},
    });
    monitor.track('reviewer', 'Merge stack', { url: url(3), uuid: 'op-1', members: [url(3)] });
    monitor.tick();
    await new Promise((r) => setTimeout(r, 5));
    monitor.tick();
    assert.equal(polls, 1);
    assert.equal(activities.list()[0].status, 'failed');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

void test('draft status changes support authors without write access and affect only the selected stacked PR', async () => {
  for (const kind of ['mark-ready', 'convert-draft'] as const) {
    const f = fixture(true);
    f.repo.viewerPermission = 'READ';
    f.prs[1].viewerDidAuthor = true;
    f.prs[1].isDraft = kind === 'mark-ready';
    const result = await f.service.act(f.client, await f.request(2, kind));
    assert.equal(result.status, 'completed');
    assert.equal(f.writes.length, 1);
    assert.deepEqual(f.writes[0].params.input, { pullRequestId: 'PR_2' });
    assert.match(
      f.writes[0].query,
      kind === 'mark-ready' ? /MarkPullRequestReadyForReviewInput/ : /ConvertPullRequestToDraftInput/
    );
  }
});
void test('draft changes enforce current permissions, state and revision without replaying writes', async () => {
  for (const change of ['permission', 'closed', 'archived', 'head', 'account', 'already-draft']) {
    const f = fixture(),
      req = await f.request(1, 'convert-draft');
    if (change === 'permission') f.repo.viewerPermission = 'READ';
    if (change === 'closed') f.prs[0].state = 'CLOSED';
    if (change === 'archived') f.repo.isArchived = true;
    if (change === 'head') f.prs[0].headRefOid = 'new-head';
    if (change === 'account') f.setAccount('other');
    if (change === 'already-draft') f.prs[0].isDraft = true;
    await assert.rejects(f.service.act(f.client, req));
    assert.equal(f.writes.length, 0, change);
  }
  const ready = fixture();
  await assert.rejects(ready.service.act(ready.client, await ready.request(1, 'mark-ready')), /already ready/);
  assert.equal(ready.writes.length, 0);
});
void test('draft mutations require a confirmed result and never replay GitHub errors', async () => {
  for (const mode of ['missing', 'wrong-status', 'denied']) {
    const f = fixture(),
      req = await f.request(1, 'convert-draft'),
      original = f.client.graphql;
    let writes = 0;
    f.client.graphql = (async (query: string, params: Record<string, unknown>) => {
      if (!query.startsWith('mutation')) return original(query, params);
      writes++;
      if (mode === 'denied') throw Error('GitHub rejected draft conversion');
      return mode === 'missing' ? {} : { convertPullRequestToDraft: { pullRequest: { isDraft: false } } };
    }) as typeof f.client.graphql;
    await assert.rejects(f.service.act(f.client, req), /did not confirm|rejected draft/);
    assert.equal(writes, 1);
  }
});

void test('branch updates stop before a write when fresh GitHub state reports conflicts', async () => {
  for (const kind of ['update-merge', 'update-rebase'] as const) {
    for (const conflict of ['CONFLICTING', 'DIRTY']) {
      const f = fixture(),
        req = await f.request(1, kind);
      // GitHub may still grant permission to update despite an unmergeable branch.
      if (conflict === 'CONFLICTING') f.prs[0].mergeable = 'CONFLICTING';
      else f.prs[0].mergeStateStatus = 'DIRTY';
      await assert.rejects(f.service.act(f.client, req), /Resolve merge conflicts/);
      assert.equal(f.writes.length, 0);
    }
  }
});

void test('branch actions pin the live base branch tip, not the PR base snapshot', async () => {
  const f = fixture();
  f.prs[0].baseRefOid = 'old-base-already-in-pr';
  f.prs[0].baseRef = { target: { oid: 'current-main' } };
  const state = await f.service.read(f.client, url(1), true);
  assert.equal(state.baseSha, 'current-main');
});

void test('mark all ready skips ready PRs, guards writes, and reports partial failures', async () => {
  const { markPrsReady } = await import('../lib/mark-prs-ready');
  const f = fixture(true);
  f.prs[0].isDraft = true;
  f.prs[2].isDraft = true;
  const members = f.prs.map((pr) => ({ url: pr.url, number: pr.number })) as import('../lib/workbench').ReviewMember[];
  const ready: string[] = [];
  let fail = true;
  const before = f.reads();
  const deps = {
    read: (url: string, force: boolean) => f.service.read(f.client, url, force),
    readMany: (urls: string[], force: boolean) => f.service.readMany(f.client, urls, force),
    act: async (request: PrActionRequest) => {
      if (request.url === url(3) && fail) throw Error('Rate limit reached');
      return f.service.act(f.client, request);
    },
    active: () => true,
    ready: (url: string) => {
      ready.push(url);
    },
  };
  const first = await markPrsReady(members, 'reviewer', deps);
  assert.deepEqual(first.completed, [url(1), url(2)]);
  assert.equal(first.failure?.member.number, 3);
  assert.equal(f.writes.length, 1, 'Already-ready PRs do not receive a mutation');
  // One stack read, then #1's write recheck (#3's write fails before it reads). Before: 3 member reads, then 1.
  assert.equal(f.reads() - before, 2);
  fail = false;
  const second = await markPrsReady(
    members.filter((m) => !ready.includes(m.url)),
    'reviewer',
    deps
  );
  assert.equal(second.failure, undefined);
  assert.deepEqual(
    f.writes.map((write) => write.params.input),
    [{ pullRequestId: 'PR_1' }, { pullRequestId: 'PR_3' }]
  );
});

void test('bulk draft changes stop before writing after an account switch or navigation', async () => {
  const { markPrsReady } = await import('../lib/mark-prs-ready');
  const f = fixture();
  f.prs[0].isDraft = true;
  const members = [{ url: url(1), number: 1 }] as import('../lib/workbench').ReviewMember[];
  const deps = {
    read: (url: string, force: boolean) => f.service.read(f.client, url, force),
    act: (request: PrActionRequest) => f.service.act(f.client, request),
    active: () => true,
    ready: () => {},
  };
  const result = await markPrsReady(members, 'other-account', deps);
  assert.match(result.failure?.message ?? '', /account changed/);
  const navigated = await markPrsReady(members, 'reviewer', { ...deps, active: () => false });
  assert.deepEqual(navigated.completed, []);
  assert.equal(f.writes.length, 0);
});
/** The PR header's Reopen and Delete branch (#542), on a fixture PR changed by `change` before it is read. */
interface BranchFacts { tip: string | null; defaultBranch: string; protectedBranch: boolean; ruleset: boolean; basePrs: number; refuse: boolean }
function finishedFixture(change: (pr: ReturnType<typeof fixture>['prs'][number] & Record<string, unknown>) => void, facts: Partial<BranchFacts> = {}) {
  const f = fixture();
  const branch: BranchFacts = { tip: 'head-1', defaultBranch: 'main', protectedBranch: false, ruleset: false, basePrs: 0, refuse: false, ...facts };
  const pr = f.prs[0] as ReturnType<typeof fixture>['prs'][number] & Record<string, unknown>;
  pr.state = 'MERGED';
  pr.headRef = { id: 'REF_1' };
  pr.headRepository = { nameWithOwner: 'o/r', viewerPermission: 'WRITE', defaultBranchRef: { name: branch.defaultBranch } } as typeof pr.headRepository;
  change(pr);
  const graphql = f.client.graphql.bind(f.client) as (query: string, params: Record<string, unknown>) => Promise<unknown>;
  let reopened = 'OPEN';
  const reads: Record<string, unknown>[] = [];
  Object.assign(f.client, {
    graphql: async (query: string, params: Record<string, unknown>) => {
      if (query.includes('ref(qualifiedName')) {
        reads.push(params);
        return {
          repository: {
            id: 'REPO_1',
            defaultBranchRef: { name: branch.defaultBranch },
            ref: branch.tip === null ? null : { target: { oid: branch.tip }, branchProtectionRule: branch.protectedBranch ? { id: 'BPR_1' } : null, refUpdateRule: branch.ruleset ? { pattern: '*' } : null },
            pullRequests: { totalCount: branch.basePrs },
          },
        };
      }
      if (query.includes('UpdateRefsInput')) {
        f.writes.push({ query, params });
        // GitHub refuses the update when the branch no longer points at `beforeOid`.
        const update = (params.input as { refUpdates: { beforeOid: string }[] }).refUpdates[0];
        if (branch.refuse || update.beforeOid !== branch.tip) throw new Error('Ref update rejected: expected head did not match.');
        return { updateRefs: { clientMutationId: null } };
      }
      if (!query.includes('ReopenPullRequestInput')) return graphql(query, params);
      f.writes.push({ query, params });
      return { reopenPullRequest: { pullRequest: { state: reopened } } };
    },
  });
  return { ...f, reads, refuseReopen: () => { reopened = 'CLOSED'; } };
}
void test('reopen: a closed PR with its branch, by its author or someone with triage, confirmed by GitHub', async () => {
  const f = finishedFixture((pr) => { pr.state = 'CLOSED'; });
  const result = await f.service.act(f.client, await f.request(1, 'reopen'));
  assert.equal(result.message, 'Reopened #1.');
  assert.match(f.writes[0].query, /reopenPullRequest/);
  assert.deepEqual(f.writes[0].params.input, { pullRequestId: 'PR_1' });
  for (const [change, reason] of [
    [(pr: Record<string, unknown>) => { pr.state = 'OPEN'; }, /already open/],
    [(pr: Record<string, unknown>) => { pr.state = 'MERGED'; }, /merged PR cannot be reopened/],
    [(pr: Record<string, unknown>) => { pr.state = 'CLOSED'; pr.headRef = null; }, /branch is deleted/],
  ] as const) {
    const g = finishedFixture(change);
    await assert.rejects(g.service.act(g.client, await g.request(1, 'reopen')), reason);
    assert.equal(g.writes.length, 0);
  }
  const reader = finishedFixture((pr) => { pr.state = 'CLOSED'; });
  reader.repo.viewerPermission = 'READ';
  await assert.rejects(reader.service.act(reader.client, await reader.request(1, 'reopen')), /triage or write permission/);
  assert.equal(reader.writes.length, 0);
  const triager = finishedFixture((pr) => { pr.state = 'CLOSED'; });
  triager.repo.viewerPermission = 'TRIAGE';
  assert.equal((await triager.service.act(triager.client, await triager.request(1, 'reopen'))).message, 'Reopened #1.');
  const unconfirmed = finishedFixture((pr) => { pr.state = 'CLOSED'; });
  unconfirmed.refuseReopen();
  await assert.rejects(unconfirmed.service.act(unconfirmed.client, await unconfirmed.request(1, 'reopen')), /did not confirm/);
});
void test('delete branch: one atomic ref update from the PR’s last commit, never a default, protected or base branch', async () => {
  const f = finishedFixture(() => {});
  assert.equal((await f.service.read(f.client, url(1))).headBranchExists, true);
  const result = await f.service.act(f.client, await f.request(1, 'delete-branch'));
  assert.equal(result.message, 'Deleted branch-1.');
  assert.equal(f.writes.length, 1, 'One write, with no separate check before it');
  assert.match(f.writes[0].query, /updateRefs/);
  assert.deepEqual(f.writes[0].params.input, {
    repositoryId: 'REPO_1',
    refUpdates: [{ name: 'refs/heads/branch-1', beforeOid: 'head-1', afterOid: '0'.repeat(40) }],
  });
  assert.deepEqual(f.reads[0], { owner: 'o', repo: 'r', ref: 'refs/heads/branch-1', branch: 'branch-1' });
  // The base branch moving on does not refuse it: only the head counts.
  const moving = finishedFixture(() => {});
  const request = await moving.request(1, 'delete-branch');
  moving.prs[0].baseRef = { target: { oid: 'main-moved-on' } };
  assert.equal((await moving.service.act(moving.client, request)).message, 'Deleted branch-1.');
  // GitHub refuses the update when commits were pushed after the PR closed: nothing is deleted.
  const pushed = finishedFixture(() => {}, { tip: 'pushed-later' });
  await assert.rejects(pushed.service.act(pushed.client, await pushed.request(1, 'delete-branch')), /may have commits this PR does not/);
  for (const [facts, reason, change] of [
    [{ defaultBranch: 'branch-1' }, /default branch/, undefined],
    [{ protectedBranch: true }, /protected or covered by a ruleset/, undefined],
    [{ ruleset: true }, /protected or covered by a ruleset/, undefined],
    [{ basePrs: 2 }, /base of another open PR/, undefined],
    [{ tip: null }, /already deleted/, undefined],
    [{}, /Merge or close this PR/, (pr: Record<string, unknown>) => { pr.state = 'OPEN'; }],
    [{}, /already deleted/, (pr: Record<string, unknown>) => { pr.headRef = null; }],
    [{}, /write permission to the branch/, (pr: Record<string, unknown>) => { pr.headRepository = { nameWithOwner: 'o/r', viewerPermission: 'READ' }; }],
    [{}, /no longer exists/, (pr: Record<string, unknown>) => { pr.headRepository = null; }],
  ] as const) {
    const g = finishedFixture(change ?? (() => {}), facts);
    await assert.rejects(g.service.act(g.client, await g.request(1, 'delete-branch')), reason);
    assert.equal(g.writes.length, 0, String(reason));
  }
  // The default branch is refused before the confirmation, too.
  const main = finishedFixture(() => {}, { defaultBranch: 'branch-1' });
  assert.equal((await main.service.read(main.client, url(1))).headIsDefaultBranch, true);
});
void test('a packaged build blocks reload, view source and print, but not Cmd+Shift+U for Update (#542)', async () => {
  const { blocksPackagedShortcut } = await import('../lib/packaged-keys');
  const key = (k: string, extra: Partial<Pick<KeyboardEvent, 'ctrlKey' | 'metaKey' | 'shiftKey'>> = {}) =>
    blocksPackagedShortcut({ key: k, ctrlKey: false, metaKey: true, shiftKey: false, ...extra });
  assert.equal(key('r'), true);
  assert.equal(key('u'), true);
  assert.equal(key('p'), true);
  // macOS reports Cmd+Shift+U as "u"; elsewhere it is "U". Either way it reaches the header.
  assert.equal(key('u', { shiftKey: true }), false);
  assert.equal(key('U', { shiftKey: true }), false);
  assert.equal(key('u', { metaKey: false, ctrlKey: true, shiftKey: true }), false);
  assert.equal(key('u', { metaKey: false }), false, 'Without Cmd or Ctrl nothing is blocked');
});
