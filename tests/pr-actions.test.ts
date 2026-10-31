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
import { singleMergePlan, type PrActionRequest } from '../lib/pr-actions';
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
        const pr = prs.find((p) => p.number === params.number);
        if (!pr) throw new Error('Unknown fixture PR');
        return {
          viewer: { login: account },
          repository: {
            ...repo,
            pullRequest: {
              ...pr,
              stack: nativeStack
                ? {
                    number: 8,
                    baseRefName: stackBaseBranch,
                    entries: { totalCount: 3, nodes: prs.map((p, i) => ({ position: i + 1, pullRequest: { ...p } })) },
                  }
                : null,
            },
          },
        };
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
  const deps = {
    read: (url: string, force: boolean) => f.service.read(f.client, url, force),
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
