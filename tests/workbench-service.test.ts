import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Octokit } from '@octokit/rest';
import type { ReviewMember } from '../lib/workbench';
import { createWorkbenchService } from '../src/workbench-service';
import type { WorkbenchPreferences } from '../src/workbench-service';
import { createActivityService } from '../src/activity-service';
import { DEFAULT_CLAUDE_MODEL } from '../lib/models';
import type { getProvider } from '../lib/provider';

function setup(generate: () => Promise<string>, auto = true) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gnosis-workbench-unit-'));
  let busy = false;
  const prefs = {
    provider: 'claude',
    model: DEFAULT_CLAUDE_MODEL,
    watchedRepos: [],
    autoBriefings: auto,
    briefingDailyLimit: 1,
  } as WorkbenchPreferences;
  const pr = {
    title: 'Bounded queue',
    body: 'Limit pending work',
    user: { login: 'author' },
    base: { ref: 'main', sha: 'base', repo: { full_name: 'owner/repo' } },
    head: { ref: 'queue', sha: 'head', repo: { full_name: 'owner/repo' } },
    merged: false,
    state: 'open',
    created_at: '2026-10-22',
    updated_at: '2026-10-22',
    html_url: 'https://github.com/owner/repo/pull/1',
    labels: [],
    mergeable: true,
    draft: false,
    commits: 1,
    requested_reviewers: [],
    requested_teams: [],
    mergeable_state: 'clean',
    auto_merge: null,
    milestone: null,
  };
  const client = {
    search: {
      issuesAndPullRequests: async () => ({
        data: {
          items: [
            {
              number: 1,
              title: pr.title,
              html_url: pr.html_url,
              repository_url: 'https://api.github.com/repos/owner/repo',
              user: pr.user,
              updated_at: pr.updated_at,
              draft: false,
            },
          ],
        },
      }),
    },
    pulls: {
      get: async () => ({ data: pr }),
      list: async (args: { head?: string }) => ({ data: args.head ? [] : [pr] }),
      listFiles: async () => ({
        data: [
          {
            filename: 'queue.ts',
            status: 'modified',
            additions: 1,
            deletions: 1,
            patch: '@@ -1 +1 @@\n-before\n+after',
          },
        ],
      }),
    },
  } as unknown as Octokit;
  const provider = (() => ({ generate })) as unknown as typeof getProvider;
  const activities = createActivityService();
  const deps = {
    activities,
    directory: () => directory,
    auth: () => ({ token: 'fixture', login: 'reviewer' }),
    preferences: () => prefs,
    history: () => [],
    busy: () => busy,
    client: () => client,
    provider,
  };
  return {
    service: createWorkbenchService(deps),
    deps,
    prefs,
    pr,
    setBusy: (value: boolean) => {
      busy = value;
    },
    cleanup: () => fs.rmSync(directory, { recursive: true, force: true }),
  };
}
async function settle(service: ReturnType<typeof createWorkbenchService>, status: string) {
  for (let i = 0; i < 100; i++) {
    const q = await service.queue();
    if (q.items[0]?.briefing?.status === status) return q;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('Briefing did not reach ' + status);
}
test('briefings are cached, bounded, and survive a restart', async () => {
  let calls = 0;
  const s = setup(async () => {
    calls++;
    return JSON.stringify({
      summary: 'Bound queue growth.',
      systems: ['Queue'],
      priorities: ['Capacity under cancellation'],
    });
  });
  try {
    await s.service.queue();
    const ready = await settle(s.service, 'ready');
    assert.equal(ready.remaining, 0);
    assert.equal(calls, 1);
    await s.service.queue(true);
    assert.equal(calls, 1);
    const restarted = createWorkbenchService(s.deps);
    await restarted.queue();
    assert.equal((await settle(restarted, 'ready')).items[0].briefing?.summary, 'Bound queue growth.');
    assert.equal(calls, 1);
    s.pr.head.sha = 'new-head';
    const changed = await s.service.queue(true);
    assert.equal(changed.items[0].briefing?.status, 'paused');
    assert.equal(calls, 1);
  } finally {
    s.cleanup();
  }
});
test('foreground work and disabled automation prevent model calls', async () => {
  let calls = 0;
  const s = setup(async () => {
    calls++;
    return '{"summary":"A change"}';
  }, false);
  try {
    await s.service.queue();
    assert.equal(calls, 0);
    s.prefs.autoBriefings = true;
    s.setBusy(true);
    await s.service.queue();
    assert.equal(calls, 0);
    s.setBusy(false);
    await s.service.queue();
    await settle(s.service, 'ready');
    assert.equal(calls, 1);
  } finally {
    s.cleanup();
  }
});
test('provider failures leave the queue usable and consume the bounded attempt', async () => {
  const s = setup(async () => {
    throw new Error('Provider unavailable');
  });
  try {
    await s.service.queue();
    const failed = await settle(s.service, 'failed');
    assert.equal(failed.items.length, 1);
    assert.match(failed.items[0].briefing?.error ?? '', /Provider unavailable/);
    assert.equal(failed.remaining, 0);
  } finally {
    s.cleanup();
  }
});
test('interrupted saved jobs become retryable after restart', async () => {
  const s = setup(async () => '{"summary":"Ready"}', false);
  try {
    await s.service.queue();
    const file = path.join(s.deps.directory(), 'workbench.json');
    const state = JSON.parse(fs.readFileSync(file, 'utf8')) as { briefs: Record<string, unknown> };
    const k = (await s.service.queue()).items[0].briefing?.key;
    assert.ok(k);
    state.briefs[k] = { key: k, status: 'generating', updatedAt: 'now' };
    fs.writeFileSync(file, JSON.stringify(state));
    const restarted = createWorkbenchService(s.deps);
    const q = await restarted.queue();
    assert.equal(q.items[0].briefing?.status, 'failed');
    assert.match(q.items[0].briefing?.error ?? '', /interrupted/);
  } finally {
    s.cleanup();
  }
});

test('a push during generation never caches mixed revisions', async () => {
  const s = setup(async () => {
    s.pr.head.sha = 'pushed-during-generation';
    return '{"summary":"Old context"}';
  });
  try {
    await s.service.queue();
    const q = await settle(s.service, 'failed');
    assert.match(q.items[0].briefing?.error ?? '', /updated during briefing/);
  } finally {
    s.cleanup();
  }
});
test('foreground preemption resumes within the daily attempt budget', async () => {
  let calls = 0;
  const s = setup(async () => {
    calls++;
    if (calls === 1) {
      s.setBusy(true);
      s.service.interrupt();
    }
    return '{"summary":"Resumed"}';
  });
  s.prefs.briefingDailyLimit = 2;
  try {
    await s.service.queue();
    await settle(s.service, 'paused');
    s.setBusy(false);
    await settle(s.service, 'ready');
    assert.equal(calls, 2);
  } finally {
    s.cleanup();
  }
});
test('new children invalidate standalone reviews, but explicit single scope stays isolated', async () => {
  const s = setup(async () => '{"summary":"Ready"}', false);
  try {
    const old = (await s.service.queue()).items[0].subject;
    const child = { ...structuredClone(s.pr), html_url: 'https://github.com/owner/repo/pull/2' };
    child.base.ref = 'queue';
    child.head.ref = 'consumer';
    const client = s.deps.client();
    Object.assign(client.pulls, {
      get: async (args: { pull_number: number }) => ({ data: args.pull_number === 2 ? child : s.pr }),
      list: async (args: { head?: string }) => ({ data: args.head ? [] : [s.pr, child] }),
    });
    await s.service.queue(true);
    assert.equal((await s.service.fresh(old)).members.length, 2);
    assert.equal((await s.service.fresh({ ...old, scope: 'single' })).members.length, 1);
    await assert.rejects(s.service.correct({ parent: child.html_url, child: s.pr.html_url, action: 'link' }), /cycle/);
    // A merged parent cannot be rediscovered from the retargeted child alone.
    s.pr.merged = true;
    s.pr.state = 'closed';
    child.base.ref = 'main';
    await s.service.queue(true);
    Object.assign(client.pulls, {
      get: async (args: { pull_number: number }) => {
        if (args.pull_number === 1) throw new Error('Temporary failure');
        return { data: child };
      },
      list: async (args: { head?: string }) => ({ data: args.head ? [] : [child] }),
    });
    const incomplete = await s.service.queue(true);
    assert.equal(incomplete.items[0].subject.members.length, 2);
    assert.ok(incomplete.items[0].subject.warnings.length);
  } finally {
    s.cleanup();
  }
});
test('removing a watched repository removes its unrelated subjects', async () => {
  const s = setup(async () => '{"summary":"Ready"}', false);
  try {
    Object.assign(s.deps.client().search, { issuesAndPullRequests: async () => ({ data: { items: [] } }) });
    s.prefs.watchedRepos = ['owner/repo'];
    assert.equal((await s.service.queue()).items.length, 1);
    s.prefs.watchedRepos = [];
    assert.equal((await s.service.queue(true)).items.length, 0);
  } finally {
    s.cleanup();
  }
});

test('cached queue remains usable while GitHub refresh is pending', { timeout: 1000 }, async () => {
  const s = setup(async () => '{"summary":"Ready"}', false);
  let release = () => {};
  try {
    await s.service.queue();
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    Object.assign(s.deps.client().pulls, {
      get: async () => {
        await gate;
        return { data: s.pr };
      },
    });
    let connected = false;
    const restarted = createWorkbenchService({
      ...s.deps,
      auth: () => (connected ? s.deps.auth() : { token: 'fixture', login: null }),
    });
    assert.deepEqual(restarted.activity(), []);
    connected = true;
    assert.equal((await restarted.queue()).items.length, 1);
    release();
    await restarted.queue(true);
  } finally {
    release();
    s.cleanup();
  }
});

test('clearing the briefing override routes generation to the selected Codex model', async () => {
  const s = setup(async () => '{"summary":"Ready"}', false);
  const calls: { provider: string; model: string }[] = [];
  s.prefs.provider = 'codex';
  s.prefs.model = 'gpt-6-astra';
  s.prefs.proactiveReviewOverrides = true;
  s.prefs.proactiveProvider = 'claude';
  s.prefs.proactiveModel = 'claude-sonnet-5-5';
  s.prefs.briefingDailyLimit = 2;
  s.deps.provider = ((provider: string) => ({
    generate: (req: { model: string }) => {
      calls.push({ provider, model: req.model });
      return Promise.resolve('{"summary":"Ready"}');
    },
  })) as unknown as typeof getProvider;
  const service = createWorkbenchService(s.deps);
  try {
    await service.queue();
    s.prefs.autoBriefings = true;
    await settle(service, 'ready');
    s.prefs.proactiveReviewOverrides = false;
    await settle(service, 'ready');
    assert.deepEqual(calls, [
      { provider: 'claude', model: 'claude-sonnet-5-5' },
      { provider: 'codex', model: 'gpt-6-astra' },
    ]);
  } finally {
    s.cleanup();
  }
});

test('queued briefings can be cancelled without a model call and retried from activity', async () => {
  let calls = 0;
  const s = setup(async () => {
    calls++;
    return '{"summary":"Ready"}';
  }, false);
  try {
    const id = (await s.service.queue()).items[0].subject.id;
    s.setBusy(true);
    s.prefs.autoBriefings = true;
    assert.equal(s.service.activity()[0].status, 'queued');
    s.service.cancel(id);
    s.setBusy(false);
    assert.equal(s.service.activity()[0].status, 'cancelled');
    await s.service.queue();
    assert.equal(calls, 0);
    s.service.retry(id);
    await settle(s.service, 'ready');
    assert.equal(s.service.activity()[0].status, 'completed');
    assert.equal(calls, 1);
  } finally {
    s.cleanup();
  }
});
test('running briefing cancellation is not reported as a provider failure', async () => {
  const s = setup(async () => {
    s.service.cancel(s.pr.html_url);
    return '{"summary":"Cancelled result"}';
  });
  try {
    await s.service.queue();
    await settle(s.service, 'cancelled');
    assert.equal(s.service.activity()[0].status, 'cancelled');
  } finally {
    s.cleanup();
  }
});

test('Dependabot PRs are ignored by default in personal and watched queues without spending briefing attempts', async () => {
  let calls = 0;
  const s = setup(async () => {
    calls++;
    return '{"summary":"Ready"}';
  });
  s.pr.user.login = 'dependabot[bot]';
  s.prefs.watchedRepos = ['owner/repo'];
  try {
    const queue = await s.service.queue();
    assert.equal(queue.items.length, 0);
    assert.equal(calls, 0);
    assert.equal(queue.remaining, 1);
    assert.deepEqual(s.service.activity(), []);
    s.prefs.ignoreDependabotPrs = false;
    assert.equal((await s.service.queue(true)).items.length, 1);
    await settle(s.service, 'ready');
    assert.equal(calls, 1);
    // Previously cached entries disappear immediately when the setting is enabled.
    s.prefs.ignoreDependabotPrs = true;
    assert.equal((await s.service.queue()).items.length, 0);
    assert.deepEqual(s.service.activity(), []);
  } finally {
    s.cleanup();
  }
});
test('human dependency updates remain visible and keep required Dependabot parents', async () => {
  const s = setup(async () => '{"summary":"Ready"}', false);
  try {
    s.pr.title = 'Bump dependencies using dependabot configuration';
    assert.equal((await s.service.queue()).items.length, 1);
    const parent = { ...structuredClone(s.pr), html_url: 'https://github.com/owner/repo/pull/2' };
    parent.user.login = 'dependabot[bot]';
    parent.head.ref = 'dependency-base';
    s.pr.base.ref = 'dependency-base';
    Object.assign(s.deps.client().pulls, {
      get: async (args: { pull_number: number }) => ({ data: args.pull_number === 2 ? parent : s.pr }),
      list: async (args: { head?: string }) => ({ data: args.head ? [] : [parent, s.pr] }),
    });
    const queue = await s.service.queue(true);
    assert.equal(queue.items.length, 1);
    assert.equal(queue.items[0].subject.members.length, 2);
  } finally {
    s.cleanup();
  }
});

void test('GitHub refresh reports progress once for concurrent callers and leaves cache reads quiet', async () => {
  const s = setup(() => Promise.resolve(''), false);
  let release = () => {};
  let entered = () => {};
  const reading = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reads = 0;
  Object.assign(s.deps.client().pulls, {
    get: async () => {
      reads++;
      entered();
      await gate;
      return { data: s.pr };
    },
  });
  try {
    const first = s.service.queue();
    const concurrent = s.service.queue(true);
    await reading;
    const [task] = s.deps.activities.list();
    assert.equal(task.kind, 'github');
    assert.equal(task.status, 'running');
    assert.equal(task.canCancel, false);
    assert.deepEqual(task.progress, { completed: 0, total: 1, unit: 'PRs' });
    assert.equal(s.deps.activities.list().length, 1);
    release();
    await Promise.all([first, concurrent]);
    assert.equal(reads, 1);
    assert.equal(s.deps.activities.list()[0].detail, 'GitHub information updated');
    await s.deps.activities.act(task.id, 'dismiss');
    await s.service.queue();
    assert.deepEqual(s.deps.activities.list(), []);
    assert.equal(reads, 1);
  } finally {
    release();
    s.cleanup();
  }
});

void test('partial GitHub updates preserve queue warnings and can be retried from Activity', async () => {
  const s = setup(() => Promise.resolve(''), false);
  try {
    await s.service.queue();
    const original = s.deps.client().pulls.list;
    Object.assign(s.deps.client().pulls, {
      list: () => Promise.reject(new Error('Offline')),
    });
    const partial = await s.service.queue(true);
    assert.equal(partial.items.length, 1);
    assert.ok(partial.warnings.length);
    const [task] = s.deps.activities.list();
    assert.equal(task.status, 'completed');
    assert.match(task.detail, /Updated with warnings/);
    assert.deepEqual(task.warnings, partial.warnings);
    assert.equal(task.canRetry, true);
    Object.assign(s.deps.client().pulls, { list: original });
    await s.deps.activities.act(task.id, 'retry');
    assert.equal(s.deps.activities.list()[0].status, 'completed');
    assert.equal(s.deps.activities.list()[0].canRetry, false);
    assert.deepEqual((await s.service.queue()).warnings, []);
  } finally {
    s.cleanup();
  }
});

void test('failed background GitHub updates keep saved results and retry the real refresh', async () => {
  const s = setup(() => Promise.resolve(''), false);
  try {
    await s.service.queue();
    const search = s.deps.client().search.issuesAndPullRequests;
    Object.assign(s.deps.client().search, {
      issuesAndPullRequests: () => Promise.reject(new Error('Network unavailable')),
    });
    const restarted = createWorkbenchService(s.deps);
    assert.equal((await restarted.queue()).items.length, 1);
    await assert.rejects(restarted.queue(true), /Network unavailable/);
    const [task] = s.deps.activities.list();
    assert.equal(task.status, 'failed');
    assert.equal(task.canRetry, true);
    assert.match(task.detail, /Showing your saved queue/);
    const cached = await restarted.queue();
    assert.equal(cached.items.length, 1);
    assert.match(cached.warnings[0], /Network unavailable/);
    Object.assign(s.deps.client().search, { issuesAndPullRequests: search });
    await s.deps.activities.act(task.id, 'retry');
    assert.equal(s.deps.activities.list()[0].status, 'completed');
    assert.deepEqual((await restarted.queue()).warnings, []);
  } finally {
    s.cleanup();
  }
});

void test('signed-out queue reads do not create GitHub activity', async () => {
  const s = setup(() => Promise.resolve(''), false);
  try {
    const service = createWorkbenchService({ ...s.deps, auth: () => ({ token: null, login: null }) });
    assert.deepEqual((await service.queue()).items, []);
    assert.deepEqual(s.deps.activities.list(), []);
  } finally {
    s.cleanup();
  }
});

void test('a GitHub rate limit stops discovery and forced refreshes until the reset', async () => {
  const s = setup(() => Promise.resolve(''), false);
  let reads = 0;
  const reset = Math.floor(Date.now() / 1000) + 1800;
  Object.assign(s.deps.client().pulls, {
    get: () => {
      reads++;
      return Promise.reject(
        Object.assign(new Error('API rate limit exceeded'), {
          status: 403,
          response: { headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) } },
        })
      );
    },
  });
  try {
    await s.service.queue().catch(() => {});
    assert.equal(reads, 1);
    await s.service.queue(true).catch(() => {});
    assert.equal(reads, 1, 'Refresh must not bypass the GitHub cooldown');
    assert.equal(s.deps.activities.list()[0].status, 'paused');
    assert.equal(s.deps.activities.list()[0].canRetry, false);
  } finally {
    s.cleanup();
  }
});

void test('automatic refresh reuses unchanged PRs, detects branch changes, and periodically revalidates', async () => {
  const s = setup(() => Promise.resolve(''), false);
  let now = Date.now();
  let reads = 0,
    lists = 0;
  s.prefs.watchedRepos = ['owner/repo'];
  Object.assign(s.pr.base.repo, { default_branch: 'main' });
  Object.assign(s.deps.client().pulls, {
    get: () => {
      reads++;
      return Promise.resolve({ data: s.pr });
    },
    list: () => {
      lists++;
      return Promise.resolve({ data: [s.pr] });
    },
  });
  const service = createWorkbenchService({ ...s.deps, now: () => now });
  const refresh = async () => {
    now += 5 * 60_000 + 1;
    await service.queue();
    return service.queue(true);
  };
  try {
    await service.queue();
    assert.equal(reads, 1);
    assert.equal(lists, 1, 'Watched-repository results also serve stack discovery');
    await service.queue(true, false);
    assert.equal(reads, 1, 'Checking review freshness must not revalidate every unrelated PR');
    await refresh();
    assert.equal(reads, 1, 'An unchanged PR should not require another metadata request');
    s.pr.head.sha = 'pushed';
    const pushed = await refresh();
    assert.equal(reads, 2);
    assert.equal(pushed.items[0].subject.members[0].headSha, 'pushed');
    s.pr.base.sha = 'new-parent';
    await refresh();
    assert.equal(reads, 3, 'A changed parent invalidates cached metadata even without updated_at changing');
    await refresh();
    await refresh();
    await refresh();
    assert.equal(reads, 4, 'Unchanged metadata is still revalidated after fifteen minutes');
    await service.queue(true);
    assert.equal(reads, 5, 'An explicit refresh revalidates PR details');
  } finally {
    s.cleanup();
  }
});

void test('a paused refresh keeps saved results and resumes after the server deadline', async () => {
  const s = setup(() => Promise.resolve(''), false);
  let now = Date.now();
  const service = createWorkbenchService({ ...s.deps, now: () => now });
  let limited = false;
  const original = s.deps.client().pulls.get;
  Object.assign(s.deps.client().pulls, {
    get: (...args: Parameters<typeof original>) =>
      limited
        ? Promise.reject(
            Object.assign(new Error('Secondary rate limit'), {
              status: 429,
              response: { headers: { 'retry-after': '120' } },
            })
          )
        : original(...args),
  });
  try {
    await service.queue();
    limited = true;
    assert.equal((await service.queue(true)).items.length, 1);
    assert.equal(s.deps.activities.list()[0].status, 'paused');
    limited = false;
    now += 121_001;
    await service.queue();
    const resumed = await service.queue(true);
    assert.equal(s.deps.activities.list()[0].status, 'completed');
    assert.deepEqual(resumed.warnings, []);
  } finally {
    s.cleanup();
  }
});

void test('briefings use persisted filters without fetching GitHub again, with an optional outside-filter fallback', async () => {
  const s = setup(() => Promise.resolve(''), false);
  const child = { ...structuredClone(s.pr), html_url: 'https://github.com/owner/repo/pull/2', title: 'Bob change' };
  child.head.ref = 'bob-change';
  child.user.login = 'bob';
  let reads = 0;
  const generated: string[] = [];
  Object.assign(s.deps.client().pulls, {
    get: (args: { pull_number: number }) => {
      reads++;
      return Promise.resolve({ data: args.pull_number === 2 ? child : s.pr });
    },
    list: (args: { head?: string }) => Promise.resolve({ data: args.head ? [] : [s.pr, child] }),
  });
  s.prefs.watchedRepos = ['owner/repo'];
  s.prefs.briefingDailyLimit = 3;
  s.deps.provider = (() => ({
    generate: (req: { content: string }) => {
      const evidence = JSON.parse(req.content) as { members: { pr: string }[] };
      generated.push(evidence.members[0].pr);
      return Promise.resolve('{"summary":"Ready"}');
    },
  })) as unknown as typeof getProvider;
  const service = createWorkbenchService(s.deps);
  const waitFor = async (count: number) => {
    for (let i = 0; i < 100; i++) {
      const q = await service.queue();
      if (q.items.filter((item) => item.briefing?.status === 'ready').length === count) return q;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('Briefings did not finish');
  };
  try {
    await service.queue();
    const before = reads;
    service.setFilters({ author: 'bob' });
    assert.equal(reads, before, 'Changing filters must not fetch GitHub');
    s.prefs.autoBriefings = true;
    const ready = await waitFor(1);
    assert.deepEqual(generated, [child.html_url]);
    assert.equal(ready.items.find((i) => i.subject.members[0].author === 'author')?.briefing?.pauseReason, 'filter');
    assert.equal(
      service.activity().some((task) => task.title === s.pr.title),
      false
    );
    s.prefs.autoBriefings = false;
    const restarted = createWorkbenchService(s.deps);
    assert.equal((await restarted.queue(true)).filters?.author, 'bob');
    s.prefs.autoBriefings = true;
    service.setFilters({ author: 'bob', briefingScope: 'all' });
    await waitFor(2);
    assert.deepEqual(generated, [child.html_url, s.pr.html_url]);
  } finally {
    s.cleanup();
  }
});

void test('filter changes preserve a running briefing and apply to the next automatic task', async () => {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started = () => {};
  const generating = new Promise<void>((resolve) => {
    started = resolve;
  });
  const s = setup(async () => {
    started();
    await gate;
    return '{"summary":"Finished current work"}';
  }, false);
  try {
    await s.service.queue();
    s.prefs.autoBriefings = true;
    await s.service.queue();
    await generating;
    s.service.setFilters({ author: 'nobody' });
    release();
    const q = await settle(s.service, 'ready');
    assert.equal(q.items[0].briefing?.summary, 'Finished current work');
    assert.equal(q.remaining, 0);
  } finally {
    release();
    s.cleanup();
  }
});

void test('recent successful discovery survives restart, including empty queues, and stale data refreshes in background', async () => {
  const s = setup(() => Promise.resolve(''), false);
  let now = 1_000_000;
  let searches = 0;
  let empty = false;
  let release: (() => void) | undefined;
  let gate: Promise<void> | undefined;
  const search = s.deps.client().search.issuesAndPullRequests;
  Object.assign(s.deps.client().search, {
    issuesAndPullRequests: async (...args: Parameters<typeof search>) => {
      searches++;
      await gate;
      return empty ? { data: { items: [] } } : search(...args);
    },
  });
  const deps = { ...s.deps, now: () => now };
  try {
    await createWorkbenchService(deps).queue();
    const count = searches;
    await s.deps.activities.act('github:reviewer', 'dismiss');
    const restart = createWorkbenchService(deps);
    assert.equal((await restart.queue()).items.length, 1);
    assert.equal(searches, count);
    assert.equal(s.deps.activities.list().length, 0, 'A fresh restart creates no GitHub refresh activity');
    now += 5 * 60_000 + 1;
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const updated = createWorkbenchService(deps);
    assert.equal((await updated.queue()).items.length, 1);
    assert.equal(s.deps.activities.list()[0].status, 'running');
    release?.();
    gate = undefined;
    await updated.queue(true);
    assert.ok(searches > count);
    empty = true;
    await updated.queue(true);
    const emptyCount = searches;
    assert.equal((await createWorkbenchService(deps).queue()).items.length, 0);
    assert.equal(searches, emptyCount, 'An empty but fresh queue also survives restart');
  } finally {
    release?.();
    s.cleanup();
  }
});

void test('changed discovery settings and explicit refresh bypass saved freshness', async () => {
  const s = setup(() => Promise.resolve(''), false);
  let calls = 0;
  const search = s.deps.client().search.issuesAndPullRequests;
  Object.assign(s.deps.client().search, {
    issuesAndPullRequests: (...args: Parameters<typeof search>) => {
      calls++;
      return search(...args);
    },
  });
  try {
    await s.service.queue();
    const initial = calls;
    const restart = createWorkbenchService(s.deps);
    await restart.queue(true);
    assert.ok(calls > initial);
    let previous = calls;
    s.prefs.watchedRepos = ['owner/repo'];
    const watched = createWorkbenchService(s.deps);
    await watched.queue();
    assert.ok(calls > previous);
    await watched.queue(true);
    previous = calls;
    s.prefs.ignoreDependabotPrs = false;
    const changed = createWorkbenchService(s.deps);
    await changed.queue();
    assert.ok(calls > previous);
    await changed.queue(true);
    previous = calls;
    const credentialChange = createWorkbenchService({
      ...s.deps,
      auth: () => ({ token: 'new-credential', login: 'reviewer' }),
    });
    await credentialChange.queue();
    assert.ok(calls > previous);
    await credentialChange.queue(true);
  } finally {
    s.cleanup();
  }
});

void test('large discoveries eventually update PRs beyond the first 150 without rereading completed details', async () => {
  const s = setup(() => Promise.resolve(''), false);
  const prs = Array.from({ length: 151 }, (_, i) => ({
    ...structuredClone(s.pr),
    html_url: `https://github.com/owner/${i < 80 ? 'repo' : 'second'}/pull/${i + 1}`,
    head: { ...s.pr.head, ref: `branch-${i}`, repo: { full_name: `owner/${i < 80 ? 'repo' : 'second'}` } },
    base: { ...s.pr.base, repo: { full_name: `owner/${i < 80 ? 'repo' : 'second'}`, default_branch: 'main' } },
  }));
  const reads: number[] = [];
  s.prefs.watchedRepos = ['owner/repo', 'owner/second'];
  Object.assign(s.deps.client().pulls, {
    get: ({ pull_number }: { pull_number: number }) => {
      reads.push(pull_number);
      return Promise.resolve({ data: prs[pull_number - 1] });
    },
    list: ({ repo }: { repo: string }) =>
      Promise.resolve({ data: prs.filter((pr) => pr.base.repo.full_name === `owner/${repo}`) }),
  });
  try {
    await s.service.queue();
    await s.service.queue(true, false);
    const q = await s.service.queue(true, false);
    assert.equal(q.items.length, 151);
    assert.equal(reads.filter((n) => n === 1).length, 1);
    assert.equal(reads.filter((n) => n === 151).length, 1);
    assert.ok(!q.warnings.some((w) => /150/.test(w)));
  } finally {
    s.cleanup();
  }
});

void test('rate-limited discovery retains completed details across restart and resumes unfinished PRs', async () => {
  const s = setup(() => Promise.resolve(''), false);
  let now = Date.now();
  let limited = true;
  const reads: number[] = [];
  const prs = Array.from({ length: 6 }, (_, i) => ({
    ...structuredClone(s.pr),
    html_url: `https://github.com/owner/repo/pull/${i + 1}`,
    head: { ...s.pr.head, ref: `branch-${i}` },
    base: { ...s.pr.base, repo: { ...s.pr.base.repo, default_branch: 'main' } },
  }));
  s.prefs.watchedRepos = ['owner/repo'];
  Object.assign(s.deps.client().pulls, {
    get: ({ pull_number }: { pull_number: number }) => {
      reads.push(pull_number);
      if (limited && pull_number === 6)
        return Promise.reject(
          Object.assign(new Error('Secondary rate limit'), {
            status: 429,
            response: { headers: { 'retry-after': '120' } },
          })
        );
      return Promise.resolve({ data: prs[pull_number - 1] });
    },
    list: () => Promise.resolve({ data: prs }),
  });
  try {
    const service = createWorkbenchService({ ...s.deps, now: () => now });
    await service.queue();
    assert.equal(s.deps.activities.list()[0].status, 'paused');
    limited = false;
    now += 121_001;
    const restarted = createWorkbenchService({ ...s.deps, now: () => now });
    const q = await restarted.queue();
    assert.equal(q.items.length, 6);
    assert.deepEqual(reads, [1, 2, 3, 4, 5, 6, 6]);
    assert.equal(s.deps.activities.list()[0].status, 'completed');
  } finally {
    s.cleanup();
  }
});

void test('a failed batch drains its successful reads before checkpointing and cannot reuse progress for another credential', async () => {
  const s = setup(() => Promise.resolve(''), false);
  let now = Date.now();
  let limited = true;
  let token = 'checkpoint-first-token';
  const reads: number[] = [];
  const prs = Array.from({ length: 2 }, (_, i) => ({
    ...structuredClone(s.pr),
    html_url: `https://github.com/owner/repo/pull/${i + 1}`,
    head: { ...s.pr.head, ref: `branch-${i}` },
    base: { ...s.pr.base, repo: { ...s.pr.base.repo, default_branch: 'main' } },
  }));
  s.prefs.watchedRepos = ['owner/repo'];
  Object.assign(s.deps.client().pulls, {
    get: async ({ pull_number }: { pull_number: number }) => {
      reads.push(pull_number);
      if (limited && pull_number === 1)
        throw Object.assign(new Error('Secondary rate limit'), {
          status: 429,
          response: { headers: { 'retry-after': '120' } },
        });
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { data: prs[pull_number - 1] };
    },
    list: () => Promise.resolve({ data: prs }),
  });
  const deps = { ...s.deps, now: () => now, auth: () => ({ token, login: 'reviewer' }) };
  try {
    await createWorkbenchService(deps).queue();
    const file = path.join(s.deps.directory(), 'workbench.json');
    const saved = fs.readFileSync(file, 'utf8');
    limited = false;
    now += 121_001;
    const q = await createWorkbenchService(deps).queue();
    assert.equal(q.items.length, 2);
    assert.deepEqual(reads, [1, 2, 1], 'A successful read in the failed batch must be retained');
    fs.writeFileSync(file, saved);
    token = 'checkpoint-other-token';
    reads.length = 0;
    await createWorkbenchService(deps).queue();
    assert.deepEqual(reads, [1, 2], 'Another credential must not reuse the checkpoint');
  } finally {
    s.cleanup();
  }
});

void test('discovery exhausts personal search and watched repository pages without truncation warnings', async () => {
  const s = setup(() => Promise.resolve(''), false);
  const prs = Array.from({ length: 205 }, (_, i) => ({
    ...structuredClone(s.pr),
    html_url: `https://github.com/owner/repo/pull/${i + 1}`,
    head: { ...s.pr.head, ref: `branch-${i}` },
    base: { ...s.pr.base, repo: { ...s.pr.base.repo, default_branch: 'main' } },
  }));
  const pages: number[] = [];
  s.prefs.watchedRepos = ['owner/repo'];
  Object.assign(s.deps.client().search, {
    issuesAndPullRequests: ({ page = 1 }: { page?: number }) =>
      Promise.resolve({
        data: {
          total_count: 105,
          incomplete_results: false,
          items: prs.slice((page - 1) * 100, Math.min(page * 100, 105)).map((pr, i) => ({
            number: (page - 1) * 100 + i + 1,
            title: pr.title,
            html_url: pr.html_url,
            repository_url: 'https://api.github.com/repos/owner/repo',
            user: pr.user,
            updated_at: pr.updated_at,
          })),
        },
      }),
  });
  Object.assign(s.deps.client().pulls, {
    get: ({ pull_number }: { pull_number: number }) => Promise.resolve({ data: prs[pull_number - 1] }),
    list: ({ page = 1 }: { page?: number }) => {
      pages.push(page);
      return Promise.resolve({ data: prs.slice((page - 1) * 100, page * 100) });
    },
  });
  try {
    const q = await s.service.queue();
    assert.equal(q.items.length, 205);
    assert.deepEqual(pages, [1, 2, 3], 'Stack discovery must reuse the complete repository listing');
    assert.deepEqual(q.warnings, []);
  } finally {
    s.cleanup();
  }
});

void test('search and repository pagination resume saved pages after rate limits and restarts', async () => {
  const s = setup(() => Promise.resolve(''), false);
  let now = Date.now();
  const deps = { ...s.deps, now: () => now };
  const prs = Array.from({ length: 101 }, (_, i) => ({
    ...structuredClone(s.pr),
    html_url: `https://github.com/owner/repo/pull/${i + 1}`,
    head: { ...s.pr.head, ref: `branch-${i}` },
    base: { ...s.pr.base, repo: { ...s.pr.base.repo, default_branch: 'main' } },
  }));
  let phase = 0;
  const calls: string[] = [];
  const limited = () =>
    Object.assign(new Error('Secondary rate limit'), {
      status: 429,
      response: { headers: { 'retry-after': '120' } },
    });
  s.prefs.watchedRepos = ['owner/repo'];
  Object.assign(s.deps.client().search, {
    issuesAndPullRequests: ({ page = 1, q }: { page?: number; q: string }) => {
      if (q.includes('review-requested:') || q.includes('assignee:'))
        return Promise.resolve({ data: { items: [], total_count: 0 } });
      calls.push(`search:${page}`);
      if (phase === 0 && page === 2) return Promise.reject(limited());
      return Promise.resolve({
        data: {
          total_count: 101,
          items: prs.slice((page - 1) * 100, page * 100).map((pr) => ({
            number: Number(pr.html_url.split('/').at(-1)),
            title: pr.title,
            html_url: pr.html_url,
            repository_url: 'https://api.github.com/repos/owner/repo',
            user: pr.user,
            updated_at: pr.updated_at,
          })),
        },
      });
    },
  });
  Object.assign(s.deps.client().pulls, {
    get: ({ pull_number }: { pull_number: number }) => Promise.resolve({ data: prs[pull_number - 1] }),
    list: ({ page = 1 }: { page?: number }) => {
      calls.push(`repo:${page}`);
      if (phase === 1 && page === 2) return Promise.reject(limited());
      return Promise.resolve({ data: prs.slice((page - 1) * 100, page * 100) });
    },
  });
  try {
    await createWorkbenchService(deps).queue();
    assert.equal(s.deps.activities.list()[0].status, 'paused');
    phase = 1;
    now += 121_001;
    await createWorkbenchService(deps).queue();
    assert.equal(s.deps.activities.list()[0].status, 'paused');
    phase = 2;
    now += 121_001;
    const q = await createWorkbenchService(deps).queue();
    assert.equal(q.items.length, 101);
    assert.deepEqual(q.warnings, []);
    assert.deepEqual(calls, ['search:1', 'search:2', 'search:2', 'repo:1', 'repo:2', 'repo:2']);
  } finally {
    s.cleanup();
  }
});

void test('personal discovery splits searches above GitHub’s 1000-result ceiling and drains every window', async () => {
  const { createDiscoveryListings } = await import('../lib/github-discovery');
  const s = setup(() => Promise.resolve(''), false);
  const calls: string[] = [];
  const prs = Array.from({ length: 1001 }, (_, i) => ({
    number: i + 1,
    title: 'A change',
    html_url: `https://github.com/owner/repo/pull/${i + 1}`,
    repository_url: 'https://api.github.com/repos/owner/repo',
    user: { login: 'author' },
    updated_at: new Date((i + 1) * 1000).toISOString(),
  }));
  Object.assign(s.deps.client().search, {
    issuesAndPullRequests: ({ page, q }: { page: number; q: string }) => {
      calls.push(q);
      if (q.includes('review-requested:')) return Promise.resolve({ data: { items: [], total_count: 0 } });
      const range = /created:(\S+)\.\.(\S+)/.exec(q);
      assert.ok(range);
      const from = Date.parse(range[1]) / 1000,
        to = Date.parse(range[2]) / 1000;
      const matches = prs.filter((pr) => pr.number >= from && pr.number <= to);
      assert.ok(page <= 10, 'Never request an inaccessible search page');
      return Promise.resolve({
        data: {
          total_count: matches.length,
          incomplete_results: false,
          items: matches.slice((page - 1) * 100, page * 100),
        },
      });
    },
  });
  try {
    const listing = createDiscoveryListings(
      s.deps.client(),
      { searches: {}, repos: {} },
      {
        login: 'reviewer',
        now: 2000_000,
        beforeRead: () => {},
        save: () => {},
        progress: () => {},
      }
    );
    const found = await listing.personal();
    assert.equal(found.length, 1001);
    assert.equal(new Set(found.map((pr) => pr.url)).size, 1001);
    assert.ok(calls.some((q) => q.includes('1970-01-01T00:16:41Z')));
  } finally {
    s.cleanup();
  }
});

void test('stack discovery finds a connected PR on later pages without adding unrelated PRs', async () => {
  const s = setup(() => Promise.resolve(''), false);
  const prs = Array.from({ length: 101 }, (_, i) => ({
    ...structuredClone(s.pr),
    html_url: `https://github.com/owner/repo/pull/${i + 1}`,
    head: { ...s.pr.head, ref: i === 0 ? 'queue' : `branch-${i}` },
    base: { ...s.pr.base, ref: i === 100 ? 'queue' : 'main', repo: { ...s.pr.base.repo, default_branch: 'main' } },
  }));
  Object.assign(s.deps.client().pulls, {
    get: ({ pull_number }: { pull_number: number }) => Promise.resolve({ data: prs[pull_number - 1] }),
    list: ({ page = 1 }: { page?: number }) => Promise.resolve({ data: prs.slice((page - 1) * 100, page * 100) }),
  });
  try {
    const q = await s.service.queue();
    assert.equal(q.items.length, 1);
    assert.deepEqual(
      q.items[0].subject.members.map((m) => m.number),
      [1, 101]
    );
    assert.deepEqual(q.warnings, []);
  } finally {
    s.cleanup();
  }
});

void test('incomplete GitHub search pages remain retryable instead of being saved as complete', async () => {
  const { createDiscoveryListings } = await import('../lib/github-discovery');
  const state = { searches: {}, repos: {} };
  const s = setup(() => Promise.resolve(''), false);
  let incomplete = true;
  const pages: number[] = [];
  Object.assign(s.deps.client().search, {
    issuesAndPullRequests: ({ page }: { page: number }) => {
      pages.push(page);
      return Promise.resolve({ data: { items: [], total_count: 0, incomplete_results: incomplete } });
    },
  });
  const options = { login: 'reviewer', now: Date.now(), beforeRead: () => {}, save: () => {}, progress: () => {} };
  try {
    await assert.rejects(createDiscoveryListings(s.deps.client(), state, options).personal(), /incomplete search/);
    incomplete = false;
    assert.deepEqual(await createDiscoveryListings(s.deps.client(), state, options).personal(), []);
    assert.deepEqual(pages, [1, 1, 1]);
  } finally {
    s.cleanup();
  }
});

void test('my PR filter reduces discovery reads, retains connected stacks and cached full-queue results, and persists', async () => {
  const s = setup(() => Promise.resolve(''), false);
  let now = Date.now();
  const prs = Array.from({ length: 105 }, (_, i) => ({
    ...structuredClone(s.pr),
    html_url: `https://github.com/owner/repo/pull/${i + 1}`,
    user: { login: i === 0 ? 'reviewer' : 'someone-else' },
    assignees: i === 1 ? [{ login: 'reviewer' }] : [],
    requested_reviewers: i === 2 ? [{ login: 'reviewer' }] : [],
    head: { ...s.pr.head, ref: `branch-${i}` },
    base: { ...s.pr.base, ref: i === 3 ? 'branch-0' : 'main', repo: { ...s.pr.base.repo, default_branch: 'main' } },
  }));
  const reads: number[] = [],
    repos: string[] = [],
    searches: string[] = [];
  s.prefs.watchedRepos = ['owner/repo', 'owner/unrelated'];
  Object.assign(s.deps.client().search, {
    issuesAndPullRequests: ({ q }: { q: string }) => {
      searches.push(q);
      const pr = prs[q.includes('assignee:') ? 1 : q.includes('review-requested:') ? 2 : 0];
      return Promise.resolve({
        data: {
          total_count: 1,
          items: [
            {
              number: Number(pr.html_url.split('/').at(-1)),
              title: pr.title,
              html_url: pr.html_url,
              repository_url: 'https://api.github.com/repos/owner/repo',
              user: pr.user,
              updated_at: pr.updated_at,
            },
          ],
        },
      });
    },
  });
  Object.assign(s.deps.client().pulls, {
    get: ({ pull_number }: { pull_number: number }) => {
      reads.push(pull_number);
      return Promise.resolve({ data: prs[pull_number - 1] });
    },
    list: ({ repo, page = 1 }: { repo: string; page?: number }) => {
      repos.push(repo);
      return Promise.resolve({ data: repo === 'unrelated' ? [] : prs.slice((page - 1) * 100, page * 100) });
    },
  });
  const deps = { ...s.deps, now: () => now };
  const service = createWorkbenchService(deps);
  try {
    const full = await service.queue();
    assert.equal(reads.length, 105);
    reads.length = repos.length = searches.length = 0;
    now += 16 * 60_000;
    service.setFilters({ involvement: 'mine' });
    const focused = await service.queue(true, false);
    const { matchesQueueFilters } = await import('../lib/queue-filters');
    const { DEFAULT_QUEUE_FILTERS } = await import('../lib/queue-filters');
    const mine = focused.items.filter((item) =>
      matchesQueueFilters(item, { ...DEFAULT_QUEUE_FILTERS, involvement: 'mine' }, now, 'reviewer')
    );
    assert.deepEqual(
      [...reads].sort((a, b) => a - b),
      [1, 2, 3, 4]
    );
    assert.ok(!repos.includes('unrelated'));
    assert.ok(searches.some((q) => q.includes('assignee:reviewer')));
    assert.equal(mine.length, 3);
    assert.equal(mine.find((item) => item.subject.kind === 'stack')?.subject.members.length, 2);
    assert.equal(focused.items.length, full.items.length, 'Unrelated cached subjects remain available');
    const restarted = createWorkbenchService(deps);
    assert.equal((await restarted.queue()).filters?.involvement, 'mine');
    assert.equal(reads.length, 4, 'A fresh personal discovery survives restart');
    restarted.setFilters({ involvement: 'all' });
    const restored = await restarted.queue(true, false);
    assert.equal(restored.items.length, full.items.length);
    assert.ok(repos.includes('unrelated'), 'Clearing the filter resumes full discovery');
    assert.equal(new Set(reads).size, 105);
  } finally {
    s.cleanup();
  }
});

void test('switching to my PRs stops an in-flight full discovery before it reads further pages', async () => {
  const s = setup(() => Promise.resolve(''), false);
  let release = () => {},
    entered = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reading = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let first = true;
  const repos: string[] = [];
  s.pr.user.login = 'reviewer';
  Object.assign(s.pr.base.repo, { default_branch: 'main' });
  s.prefs.watchedRepos = ['owner/unrelated', 'owner/another'];
  Object.assign(s.deps.client().pulls, {
    list: async ({ repo }: { repo: string }) => {
      repos.push(repo);
      if (first) {
        first = false;
        entered();
        await gate;
      }
      return { data: repo === 'repo' ? [s.pr] : [] };
    },
  });
  try {
    const old = s.service.queue();
    await reading;
    s.service.setFilters({ involvement: 'mine' });
    release();
    await old;
    assert.deepEqual(repos, ['unrelated']);
    const q = await s.service.queue(true, false);
    assert.equal(q.items.length, 1);
    assert.deepEqual(repos, ['unrelated', 'repo']);
    assert.deepEqual(q.warnings, []);
  } finally {
    release();
    s.cleanup();
  }
});

void test('saved-view counts use saved filters and switching views shares discovery without extra GitHub reads', async () => {
  const s = setup(() => Promise.resolve(''), false);
  let reads = 0;
  const original = s.deps.client().pulls.get;
  Object.assign(s.deps.client().pulls, {
    get: (...args: Parameters<typeof original>) => {
      reads++;
      return original(...args);
    },
  });
  try {
    await s.service.queue();
    const initial = reads;
    const created = s.service.viewAction({ type: 'create', name: 'All PRs' });
    const id = created.savedViews?.activeId;
    assert.ok(id);
    const modified = s.service.setFilters({ author: 'nobody' });
    assert.equal(modified.savedViews?.counts[id], 1, 'Count uses the saved filters, not the empty draft');
    const second = s.service.viewAction({ type: 'create', name: 'Nobody' });
    assert.equal(second.savedViews?.counts[second.savedViews.activeId ?? ''], 0);
    s.service.viewAction({ type: 'activate', id });
    assert.equal((await s.service.queue()).filters?.author, 'nobody');
    const restarted = createWorkbenchService(s.deps);
    const restored = await restarted.queue();
    assert.equal(restored.savedViews?.activeId, id);
    assert.equal(restored.filters?.author, 'nobody');
    assert.equal(reads, initial, 'Managing/counting/switching same-scope views must not refetch GitHub');
    const reset = restarted.viewAction({ type: 'reset', id });
    assert.equal(reset.filters?.author, 'all');
    restarted.viewAction({ type: 'delete', id });
    assert.equal((await restarted.queue()).items.length, 1, 'Deleting a view preserves cached PRs');
  } finally {
    s.cleanup();
  }
});

void test('a fresh shared full queue covers switching into and out of a personal saved view', async () => {
  const s = setup(() => Promise.resolve(''), false);
  let searches = 0;
  const original = s.deps.client().search.issuesAndPullRequests;
  Object.assign(s.deps.client().search, {
    issuesAndPullRequests: (...args: Parameters<typeof original>) => {
      searches++;
      return original(...args);
    },
  });
  try {
    await s.service.queue();
    const full = s.service.viewAction({ type: 'create', name: 'Everything' }).savedViews?.activeId;
    assert.ok(full);
    s.service.setFilters({ involvement: 'mine' });
    const mine = s.service.viewAction({ type: 'create', name: 'My PRs' }).savedViews?.activeId;
    assert.ok(mine);
    // Restore the full view's saved definition, preserving the personal view.
    s.service.viewAction({ type: 'reset', id: full });
    const initial = searches;
    await s.service.queue();
    s.service.viewAction({ type: 'activate', id: full });
    await s.service.queue();
    s.service.viewAction({ type: 'activate', id: mine });
    await s.service.queue();
    assert.equal(searches, initial, 'Personal/full switching reuses the shared fresh discovery');
  } finally {
    s.cleanup();
  }
});

void test('PR label colors and descriptions persist alongside filter-compatible names without extra reads', async () => {
  const s = setup(() => Promise.resolve(''), false);
  Object.assign(s.pr, {
    labels: [
      { name: 'bug', color: 'd73a4a', description: 'Something is not working' },
      { name: 'unsafe-color', color: 'url(example)', description: null },
      'legacy',
    ],
  });
  let reads = 0;
  const original = s.deps.client().pulls.get;
  Object.assign(s.deps.client().pulls, {
    get: (...args: Parameters<typeof original>) => {
      reads++;
      return original(...args);
    },
  });
  try {
    const q = await s.service.queue();
    const member = q.items[0].subject.members[0];
    assert.deepEqual(member.labels, ['bug', 'unsafe-color', 'legacy']);
    assert.equal(member.labelDetails?.[0].color, 'd73a4a');
    assert.equal(member.labelDetails?.[0].description, 'Something is not working');
    assert.equal(member.labelDetails?.[1].color, undefined);
    assert.equal(member.labelDetails?.[2].color, undefined);
    const restarted = createWorkbenchService(s.deps);
    assert.equal((await restarted.queue()).items[0].subject.members[0].labelDetails?.[0].color, 'd73a4a');
    assert.equal(reads, 1);
  } finally {
    s.cleanup();
  }
});

void test('repository listings hydrate legacy label badges without refetching cached PR details', async () => {
  const s = setup(() => Promise.resolve(''), false);
  let now = Date.now();
  const deps = { ...s.deps, now: () => now };
  try {
    await createWorkbenchService(deps).queue();
    const filename = path.join(s.deps.directory(), 'workbench.json');
    const saved = JSON.parse(fs.readFileSync(filename, 'utf8')) as { subjects: { members: ReviewMember[] }[] };
    const legacy = saved.subjects[0].members[0];
    legacy.labels = ['visual-proof-done'];
    delete legacy.labelDetails;
    fs.writeFileSync(filename, JSON.stringify(saved));
    Object.assign(s.pr, {
      labels: [{ name: 'visual-proof-done', color: '3E2CC5', description: 'Visual proof recorded' }],
    });
    let reads = 0;
    Object.assign(s.deps.client().pulls, {
      get: () => {
        reads++;
        return Promise.resolve({ data: s.pr });
      },
    });
    now += 6 * 60_000;
    const service = createWorkbenchService(deps);
    const q = await service.queue(true, false);
    assert.deepEqual(q.items[0].subject.members[0].labelDetails, [
      { name: 'visual-proof-done', color: '3E2CC5', description: 'Visual proof recorded' },
    ]);
    assert.equal(reads, 0, 'The already-required repository listing supplies label details');
    const restarted = createWorkbenchService(deps);
    assert.equal((await restarted.queue()).items[0].subject.members[0].labelDetails?.[0].color, '3E2CC5');
    Object.assign(s.pr, { labels: [] });
    now += 6 * 60_000;
    const cleared = await restarted.queue(true, false);
    assert.deepEqual(cleared.items[0].subject.members[0].labels, []);
    assert.deepEqual(cleared.items[0].subject.members[0].labelDetails, []);
    assert.equal(reads, 0);
  } finally {
    s.cleanup();
  }
});
