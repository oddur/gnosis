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
    base: { ref: 'main', sha: 'base', repo: { full_name: 'owner/repo', archived: false } },
    head: { ref: 'queue', sha: 'head', repo: { full_name: 'owner/repo', archived: false } },
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
    const focused = s.service.subject(child.html_url);
    assert.ok(focused, 'a PR inside a stack must resolve when starting its own explanation');
    assert.equal(focused.scope, 'single');
    assert.deepEqual(focused.members.map(member => member.url), [child.html_url]);
    assert.equal((await s.service.fresh(focused)).members.length, 1);
    const wholeStack = (await s.service.queue()).items[0].subject;
    assert.equal(s.service.subject(wholeStack.id)?.members.length, 2);
    assert.equal(s.service.subject('missing-stack'), undefined);
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
    assert.equal(reads, 3, 'Unchanged metadata does not expire into a full detail sweep');
    await service.queue(true);
    assert.equal(reads, 4, 'An explicit refresh revalidates PR details');
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

void test('automatic briefings follow the saved sort without another discovery request', async () => {
  const s = setup(() => Promise.resolve(''), false);
  const child = { ...structuredClone(s.pr), html_url: 'https://github.com/owner/repo/pull/2', title: 'ZZZ last title' };
  child.head.ref = 'second-change';
  const generated: string[] = [];
  let reads = 0;
  Object.assign(s.deps.client().pulls, {
    get: (args: { pull_number: number }) => { reads++; return Promise.resolve({ data: args.pull_number === 2 ? child : s.pr }); },
    list: (args: { head?: string }) => Promise.resolve({ data: args.head ? [] : [s.pr, child] }),
  });
  s.prefs.watchedRepos = ['owner/repo'];
  s.prefs.briefingDailyLimit = 3;
  s.deps.provider = (() => ({ generate: (req: { content: string }) => {
    generated.push((JSON.parse(req.content) as { members: { pr: string }[] }).members[0].pr);
    return Promise.resolve('{"summary":"Ready"}');
  } })) as unknown as typeof getProvider;
  const service = createWorkbenchService(s.deps);
  try {
    await service.queue();
    const before = reads;
    service.setFilters({ sort: { key: 'title', direction: 'desc', starredFirst: false } });
    assert.equal(reads, before, 'Sorting must not rediscover GitHub PRs');
    s.prefs.autoBriefings = true;
    for (let i = 0; i < 100 && generated.length < 2; i++) {
      await service.queue();
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.deepEqual(generated, [child.html_url, s.pr.html_url]);
  } finally { s.cleanup(); }
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
    s.service.setFilters({ author: 'nobody', sort: { key: 'title', direction: 'desc', starredFirst: false } });
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
    assert.equal(s.deps.activities.list().length, 0, 'Routine sync stays out of Activity');
    assert.equal(updated.snapshot().sync?.status, 'checking');
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
    await restarted.queue();
    const q = await restarted.queue(true, false);
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
    const resumed = createWorkbenchService(deps);
    const q = await resumed.queue(true, false);
    assert.equal(q.items.length, 2);
    assert.deepEqual(reads, [1, 2, 1], 'A successful read in the failed batch must be retained');
    fs.writeFileSync(file, saved);
    token = 'checkpoint-other-token';
    reads.length = 0;
    await createWorkbenchService(deps).queue(true, false);
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
    assert.ok(new Set(calls).size > 2, 'Search windows split until every result is accessible');
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
      [4]
    );
    assert.ok(!repos.includes('unrelated'));
    assert.ok(searches.some((q) => q.includes('assignee:reviewer')));
    assert.equal(mine.length, 3);
    assert.equal(mine.find((item) => item.subject.kind === 'stack')?.subject.members.length, 2);
    assert.equal(focused.items.length, full.items.length, 'Unrelated cached subjects remain available');
    const restarted = createWorkbenchService(deps);
    assert.equal((await restarted.queue()).filters?.involvement, 'mine');
    assert.equal(reads.length, 1, 'A fresh personal discovery survives restart');
    restarted.setFilters({ involvement: 'all' });
    const restored = await restarted.queue(true, false);
    assert.equal(restored.items.length, full.items.length);
    assert.ok(repos.includes('unrelated'), 'Clearing the filter resumes full discovery');
    assert.equal(new Set(reads).size, 1, 'Widening the queue reuses unchanged details');
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
    const modified = s.service.setFilters({ author: 'nobody', sort: { key: 'title', direction: 'desc', starredFirst: false } });
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
    for (const involvement of ['review', 'authored'] as const) {
      s.service.setFilters({ involvement });
      await s.service.queue();
    }
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

void test('explicit briefing starts outside automatic filters without enabling automatic work', async () => {
  let calls=0;
  const s=setup(()=>{calls++;return Promise.resolve(JSON.stringify({summary:'Explicit briefing',systems:[],priorities:[]}));},false);
  try {
    const q=await s.service.queue();
    s.service.setFilters({query:'not a match',briefingScope:'matches'});
    s.service.retry(q.items[0].subject.id,true);
    await settle(s.service,'ready');
    assert.equal(calls,1);
    assert.equal(s.prefs.autoBriefings,false);
    assert.throws(()=>s.service.retry(q.items[0].subject.id,true),/daily briefing limit/);
  } finally {s.cleanup();}
});


void test('archived watched repositories stop after one listing page without reading PR details', async () => {
  const s = setup(() => Promise.reject(new Error('No briefing should start')));
  s.prefs.watchedRepos = ['owner/repo'];
  s.pr.base.repo.archived = true;
  const queries: string[] = [];
  Object.assign(s.deps.client().search, {
    issuesAndPullRequests: ({ q }: { q: string }) => {
      queries.push(q);
      return Promise.resolve({ data: { items: [], total_count: 0 } });
    },
  });
  let pages = 0, details = 0;
  Object.assign(s.deps.client().pulls, {
    list: () => { pages++; return Promise.resolve({ data: Array.from({length: 100}, () => s.pr) }); },
    get: () => { details++; throw new Error('Archived PR details should not be fetched'); },
  });
  try {
    const queue = await s.service.queue();
    assert.deepEqual(queue.items, []);
    assert.deepEqual(queue.warnings, []);
    assert.equal(pages, 1, 'Do not page through an archived backlog');
    assert.equal(details, 0);
    assert.ok(queries.length === 3 && queries.every(q => q.includes('archived:false')));
    assert.deepEqual(s.service.activity(), []);
  } finally { s.cleanup(); }
});

void test('archive changes evict cached and starred work, persist, and reverse on unarchive without PR timestamp changes', async () => {
  const s = setup(() => Promise.resolve(''), false);
  s.prefs.watchedRepos = ['owner/repo'];
  const search = s.deps.client().search.issuesAndPullRequests;
  try {
    const first = await s.service.queue();
    assert.equal(first.items.length, 1);
    s.service.starPrs({ members: first.items[0].subject.members, starred: true });
    s.pr.base.repo.archived = true;
    Object.assign(s.deps.client().search, { issuesAndPullRequests: () => Promise.resolve({ data: { items: [], total_count: 0 } }) });
    const archived = await s.service.queue(true);
    assert.deepEqual(archived.items, []);
    assert.deepEqual(archived.starredItems, []);
    assert.deepEqual(archived.warnings, []);
    const restarted = createWorkbenchService(s.deps);
    assert.deepEqual(restarted.cached().items, []);
    assert.deepEqual(restarted.cached().starredItems, []);
    const { createStarredPrStore } = await import('../src/starred-pr-store');
    assert.equal(createStarredPrStore(s.deps.directory).load('reviewer').length, 1, 'Keep the bookmark on disk');
    s.pr.base.repo.archived = false;
    Object.assign(s.deps.client().search, { issuesAndPullRequests: search });
    const restored = await restarted.queue(true);
    assert.equal(restored.items.length, 1);
    assert.equal(restored.starredItems?.length, 1);
  } finally { s.cleanup(); }
});

void test('an archived source fork does not hide a PR targeting an active repository', async () => {
  const s = setup(() => Promise.resolve(''), false);
  s.pr.head.repo.archived = true;
  try {
    const queue = await s.service.queue();
    assert.equal(queue.items.length, 1);
    assert.equal(queue.items[0].subject.members[0].repoArchived, false);
    s.pr.base.repo.archived = true;
    const archived = await s.service.queue(true);
    assert.deepEqual(archived.items, [], 'PR metadata also rejects archived targets when search is stale');
  } finally { s.cleanup(); }
});

void test('415 unchanged PRs require no repeated detail reads and repository deltas stop at the update boundary', async () => {
  const s = setup(() => Promise.resolve(''), false);
  let now = Date.parse('2026-10-24T12:00:00Z');
  const prs = Array.from({ length: 415 }, (_, i) => ({
    ...structuredClone(s.pr), number: i + 1, html_url: `https://github.com/owner/repo/pull/${i + 1}`,
    head: { ...s.pr.head, ref: `branch-${i}`, sha: `head-${i}` },
    base: { ...s.pr.base, repo: { ...s.pr.base.repo, default_branch: 'main' } },
  }));
  let reads = 0, lists = 0;
  s.prefs.watchedRepos = ['owner/repo'];
  Object.assign(s.deps.client().search, { issuesAndPullRequests: () => Promise.resolve({ data: { items: [], total_count: 0 } }) });
  Object.assign(s.deps.client().pulls, {
    get: ({ pull_number }: { pull_number: number }) => { reads++; return Promise.resolve({ data: prs[pull_number - 1] }); },
    list: ({ page = 1, sort }: { page?: number; sort?: string }) => {
      lists++;
      const ordered = sort === 'updated' ? [...prs].sort((a, b) => b.updated_at.localeCompare(a.updated_at)) : prs;
      return Promise.resolve({ data: ordered.slice((page - 1) * 100, page * 100) });
    },
  });
  const deps = { ...s.deps, now: () => now };
  try {
    const service = createWorkbenchService(deps);
    await service.queue(true, false);
    assert.equal(reads, 415); assert.equal(lists, 5);
    reads = lists = 0;
    now += 16 * 60_000;
    const restarted = createWorkbenchService(deps);
    await restarted.queue(true, false);
    assert.equal(reads, 0, 'Time alone must not trigger another 415 detail requests');
    assert.equal(lists, 1, 'Stop after the first page of older updates');
    prs[200].title = 'Changed title';
    prs[200].updated_at = new Date(now).toISOString();
    prs[200].head.sha = 'new-head';
    now += 2 * 60_000;
    const changed = await restarted.queue(true, false);
    assert.equal(reads, 1);
    assert.equal(changed.items.find(i => i.subject.members[0].number === 201)?.subject.title, 'Changed title');
    prs[200].state = 'closed';
    prs[200].updated_at = new Date(now).toISOString();
    now += 2 * 60_000;
    assert.equal((await restarted.queue(true, false)).items.length, 414, 'A closure removes the open PR from the retained index');
    now += 31 * 60_000;
    lists = 0;
    await restarted.queue(true, false);
    assert.equal(lists, 5, 'Periodic full reconciliation still examines the whole repository');
  } finally { s.cleanup(); }
});

void test('completed batches become visible before the rest of discovery finishes', async () => {
  const s = setup(() => Promise.resolve(''), false);
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const prs = Array.from({ length: 6 }, (_, i) => ({
    ...structuredClone(s.pr), html_url: `https://github.com/owner/repo/pull/${i + 1}`,
    head: { ...s.pr.head, ref: `branch-${i}` },
    base: { ...s.pr.base, repo: { ...s.pr.base.repo, default_branch: 'main' } },
  }));
  s.prefs.watchedRepos = ['owner/repo'];
  Object.assign(s.deps.client().pulls, {
    list: () => Promise.resolve({ data: prs }),
    get: async ({ pull_number }: { pull_number: number }) => {
      if (pull_number === 6) { entered(); await blocked; }
      return { data: prs[pull_number - 1] };
    },
  });
  const pending = s.service.queue();
  try {
    await started;
    assert.equal(s.service.snapshot().items.length, 5, 'Useful work is published while the next batch is waiting');
    assert.equal(s.service.snapshot().sync?.status, 'checking');
  } finally { release(); await pending; s.cleanup(); }
});

void test('routine sync does not recreate Activity or repeat completed task notifications', async () => {
  const s = setup(() => Promise.resolve(''), false);
  let now = Date.now(), finishes = 0;
  const finish = s.deps.activities.finish.bind(s.deps.activities);
  s.deps.activities.finish = (...args) => { finishes++; finish(...args); };
  const service = createWorkbenchService({ ...s.deps, now: () => now });
  try {
    await service.queue(true, false);
    assert.equal(finishes, 1);
    now += 2 * 60_000 + 1;
    await service.queue(true, false);
    assert.equal(finishes, 1, 'A quiet check must not touch the previous completed task');
    assert.equal(service.snapshot().sync?.status, 'idle');
    await s.deps.activities.act('github:reviewer', 'dismiss');
    now += 2 * 60_000 + 1;
    await service.queue(true, false);
    assert.equal(s.deps.activities.list().length, 0);
    await service.queue(true);
    assert.equal(s.deps.activities.list()[0].status, 'completed', 'Manual refresh remains in Activity');
  } finally { s.cleanup(); }
});

void test('briefings pause during API backoff without spending an AI attempt before generation', async () => {
  let generated = 0;
  const s = setup(() => { generated++; return Promise.resolve('{"summary":"Ready","systems":[],"priorities":[]}'); });
  let now = Date.now(), limited = true;
  const listFiles = s.deps.client().pulls.listFiles;
  Object.assign(s.deps.client().pulls, {
    listFiles: (...args: Parameters<typeof listFiles>) => limited
      ? Promise.reject(Object.assign(new Error('Secondary rate limit'), { status: 429, response: { headers: { 'retry-after': '120' } } }))
      : listFiles(...args),
  });
  const service = createWorkbenchService({ ...s.deps, now: () => now });
  try {
    await service.queue();
    await settle(service, 'paused');
    assert.equal(generated, 0);
    assert.equal(service.snapshot().remaining, 1);
    limited = false;
    now += 121_001;
    await service.queue(true, false);
    await settle(service, 'ready');
    assert.equal(generated, 1);
  } finally { s.cleanup(); }
});

void test('upgrading an existing queue retains verified details instead of rehydrating every PR', async () => {
  const s = setup(() => Promise.resolve(''), false);
  try {
    await s.service.queue(true, false);
    const file = path.join(s.deps.directory(), 'workbench.json');
    const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    const { createHash } = await import('node:crypto');
    saved.discoveryKey = createHash('sha256').update(JSON.stringify([
      'pr-inactivity-v1', 30, [], 'fixture', [], true, 'all',
    ])).digest('hex');
    delete saved.credentialKey;
    delete saved.listings;
    fs.writeFileSync(file, JSON.stringify(saved));
    let reads = 0;
    Object.assign(s.deps.client().pulls, { get: () => { reads++; return Promise.resolve({ data: s.pr }); } });
    await createWorkbenchService(s.deps).queue(true, false);
    assert.equal(reads, 0, 'The old scope fingerprint verifies that this credential populated the saved details');
  } finally { s.cleanup(); }
});

test('normal discovery detects new reviews on read PRs hidden by the unread filter without refetching unchanged activity', async () => {
  const s = setup(() => Promise.resolve('unused'), false);
  let calls = 0;
  let now = Date.parse('2026-10-26T12:00:00Z');
  let review = { id: 'old-review', at: '2026-10-25T00:00:00Z', author: 'author' };
  const service = createWorkbenchService({ ...s.deps, now: () => now,
    signals: async (_client, requests) => {
      calls++;
      return requests.map(request => ({ ...request, checkedAt: now, comments: 0, activity: { review }, checks: { state: 'success', total: 1, passed: 1 } }));
    },
  });
  try {
    const first = await service.queue(true);
    assert.deepEqual(first.items[0].unreadUrls, []);
    assert.equal(calls, 1);
    service.setFilters({ readStatus: 'unread' });
    now += 6 * 60_000;
    await service.queue(false);
    // Discovery runs in the background when cached data exists.
    for (let i = 0; i < 30 && service.snapshot().sync?.status === 'checking'; i++) await new Promise(r => setTimeout(r, 5));
    assert.equal(calls, 1, 'unchanged PRs do not cause more activity queries');
    review = { id: 'new-review', at: '2026-10-26T12:07:00Z', author: 'author' };
    s.pr.updated_at = review.at;
    now = Date.parse('2026-10-26T12:08:00Z');
    const updated = await service.queue(true);
    assert.deepEqual(updated.items[0].unreadUrls, [s.pr.html_url]);
    assert.deepEqual(updated.readStates?.[s.pr.html_url]?.unread, ['reviews']);
    assert.equal(calls, 2);
  } finally { s.cleanup(); }
});

test('activity polling reads preferences once per projection and builds the queue once', async () => {
  const s = setup(async () => { throw new Error('Daily limit must prevent generation'); }, false);
  try {
    await s.service.queue();
    const file = path.join(s.deps.directory(), 'workbench.json');
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    const subject = saved.subjects[0];
    saved.subjects = Array.from({ length: 100 }, (_, i) => ({ ...subject, id: `subject-${i}`,
      members: subject.members.map((m: ReviewMember) => ({ ...m, url: `https://github.com/owner/repo/pull/${i + 1}`, number: i + 1 })) }));
    fs.writeFileSync(file, JSON.stringify(saved));
    let preferences = 0, history = 0;
    const service = createWorkbenchService({ ...s.deps,
      preferences: () => { preferences++; return { ...s.prefs, autoBriefings: true, briefingDailyLimit: 0 }; },
      history: () => { history++; return []; },
    });
    service.activity();
    preferences = 0; history = 0;
    service.activity();
    assert.equal(history, 1, 'one activity poll must not build three full queues');
    assert.ok(preferences <= 10, `read preferences ${preferences} times for 100 PRs`);
  } finally { s.cleanup(); }
});

test('unchanged PR metadata does not rewrite the queue file', async (t) => {
  const s = setup(async () => '', false);
  try {
    const queue = await s.service.queue();
    const metadata = queue.items[0].subject.members[0];
    const writes = t.mock.method(fs, 'writeFileSync');
    s.service.updatePrMetadata(metadata);
    assert.equal(writes.mock.callCount(), 0);
    s.service.updatePrMetadata({ ...metadata, title: 'Updated title' });
    assert.equal(s.service.snapshot().items[0].subject.title, 'Updated title');
    assert.ok(writes.mock.callCount() > 0);
    assert.equal(s.service.snapshot().items[0].subject.members[0].title, 'Updated title');
  } finally { t.mock.restoreAll(); s.cleanup(); }
});

test('the real queue and unread store recover from SQLite without consulting legacy files', async () => {
  const { createAppDataStore } = await import('../src/app-data-store');
  const s = setup(async () => '', false);
  let storage = createAppDataStore();
  try {
    await s.service.queue();
    await storage.open(s.deps.directory());
    let service = createWorkbenchService({ ...s.deps, storage });
    const member = service.snapshot().items[0].subject.members[0];
    service.updatePrMetadata({ ...member, headSha: 'sqlite-head' });
    await storage.close();
    fs.writeFileSync(path.join(s.deps.directory(),'workbench.json'),'legacy data is no longer read');
    storage = createAppDataStore(); await storage.open(s.deps.directory());
    service = createWorkbenchService({ ...s.deps, storage });
    const restored = service.snapshot();
    assert.equal(restored.items[0].subject.members[0].headSha,'sqlite-head');
    assert.ok(restored.readStates?.[member.url]?.unread.includes('commits'));
  } finally { await storage.close(); s.cleanup(); }
});

void test('PR badge previews read saved metadata and briefings without discovery or generation', async () => {
  let generated=0;
  const s=setup(()=>{generated++;return Promise.resolve(JSON.stringify({summary:'Bound queue growth.',systems:['Queue'],priorities:[]}));});
  try {
    await s.service.queue();await settle(s.service,'ready');
    const restarted=createWorkbenchService({...s.deps,client:()=>{throw Error('Preview must not contact GitHub');},provider:()=>{throw Error('Preview must not generate text');}});
    const preview=restarted.prPreview(s.pr.html_url);
    assert.equal(preview?.member.title,'Bounded queue');
    assert.equal(preview?.briefing?.summary,'Bound queue growth.');
    assert.equal(preview?.stack,undefined);
    assert.equal(preview && 'description' in preview.member,false);
    assert.equal(restarted.prPreview('https://github.com/owner/repo/pull/999'),null);
    assert.equal(generated,1);
    const signedOut=createWorkbenchService({...s.deps,auth:()=>({token:null,login:null})});
    assert.equal(signedOut.prPreview(s.pr.html_url),null);
  } finally {s.cleanup();}
});

void test('PR badge previews do not enqueue missing briefings', async()=>{
  const s=setup(()=>Promise.reject(Error('Must not generate')),false);
  try {
    await s.service.queue();
    const before=s.service.activity();
    assert.equal(s.service.prPreview(s.pr.html_url)?.briefing,undefined);
    assert.deepEqual(s.service.activity(),before);
  }finally{s.cleanup();}
});

test('stack names persist locally, preserve explanations, reset, and stay account scoped', async () => {
  const s = setup(async () => '{}', false);
  try {
    const queue = await s.service.queue(true);
    const original = queue.items[0].subject;
    const file = path.join(s.deps.directory(), 'workbench.json');
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    saved.subjects[0] = { ...original, id: 'stack:' + original.id, kind: 'stack' };
    fs.writeFileSync(file, JSON.stringify(saved));
    const service = createWorkbenchService(s.deps);
    const id = saved.subjects[0].id;
    const before = service.cached().items[0].briefing?.key;
    const renamed = service.renameStack(id, '  Queue redesign  ');
    assert.equal(renamed.items[0].subject.title, 'Queue redesign');
    assert.equal(service.cached().items[0].briefing?.key, before);
    const restarted = createWorkbenchService(s.deps);
    assert.equal(restarted.snapshot().items[0].subject.name, 'Queue redesign');
    assert.equal(restarted.renameStack(id, '').items[0].subject.title, original.title);
    assert.throws(() => service.renameStack(id, 'x'.repeat(121)), /120/);
    assert.throws(() => service.renameStack(id, 'Wrong account', 'someone-else'), /account changed/);
    const other = createWorkbenchService({ ...s.deps, auth: () => ({ login: 'someone-else', token: 'fixture' }) });
    assert.throws(() => other.renameStack(id, 'No'), /no longer available/);
  } finally { s.cleanup(); }
});

test('absent stacks leave the active queue but retain local identity across discovery and restart', async () => {
  const s = setup(async () => '{}', false);
  try {
    await s.service.queue(true);
    const file = path.join(s.deps.directory(), 'workbench.json');
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    const subject = saved.subjects[0];
    subject.id = 'stack:' + subject.id;
    subject.kind = 'stack';
    fs.writeFileSync(file, JSON.stringify(saved));
    const client = s.deps.client();
    client.search.issuesAndPullRequests = (async () => ({ data: { items: [] } })) as unknown as typeof client.search.issuesAndPullRequests;
    client.pulls.list = (async () => ({ data: [] })) as unknown as typeof client.pulls.list;
    const service = createWorkbenchService(s.deps);
    service.renameStack(subject.id, 'Saved stack');
    const queue = await service.queue(true);
    assert.equal(queue.items.length, 0);
    assert.equal(queue.stacks?.[0].title, 'Saved stack');
    const restarted = createWorkbenchService(s.deps);
    assert.equal(restarted.snapshot().items.length, 0);
    assert.equal(restarted.snapshot().stacks?.[0].id, subject.id);
  } finally { s.cleanup(); }
});
