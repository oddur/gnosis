import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Octokit } from '@octokit/rest';
import { createWorkbenchService } from '../src/workbench-service';
import type { WorkbenchPreferences } from '../src/workbench-service';
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
  const deps = {
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
