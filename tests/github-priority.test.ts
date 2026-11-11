import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createGitHubScheduler,
  createGitHubWork,
  githubPriority,
  githubPriorityScope,
  joinGitHubWork,
  withGitHubPriority,
} from '../lib/github-scheduler';
import { createGitHubClientPool, GitHubBackoffError } from '../lib/github-client';
import { createPrChangesService } from '../src/pr-changes-service';
import { createSnapshotFileLoader } from '../src/snapshot-file-loader';
import { createPrFileCache } from '../lib/pr-file-cache';
import type { PrChanges } from '../lib/pr-changes';
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
/** Let Octokit's async hooks reach fetch. Fails rather than hangs if the condition never holds. */
async function settle(done: () => boolean) {
  for (let i = 0; i < 50 && !done(); i++) await turn();
  assert.ok(done(), 'Expected requests did not start');
}
// Non-automatic background reads hold background slots without automatic pacing.
const holdBackground = (read: () => Promise<unknown>) => withGitHubPriority('background', read, { automatic: false });
const json = (data: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json', ...headers } });

void test('UI requests always precede queued AI and maintenance work, even after eight turns', async () => {
  const schedule = createGitHubScheduler(),
    gate = deferred(),
    order: string[] = [];
  let active = 0,
    maximum = 0;
  const held = Array.from({ length: 6 }, () =>
    schedule('interactive', async () => {
      active++;
      maximum = Math.max(maximum, active);
      await gate.promise;
      active--;
    })
  );
  const run = (name: string) => {
    active++;
    maximum = Math.max(maximum, active);
    order.push(name);
    active--;
    return Promise.resolve();
  };
  const background = schedule('background', () => run('background'));
  const ai = schedule('foreground', () => run('AI'));
  const ui = Array.from({ length: 12 }, (_, i) => schedule('interactive', () => run(`UI ${i}`)));
  gate.resolve();
  await Promise.all([...held, background, ai, ...ui]);
  assert.deepEqual(order, [...Array.from({ length: 12 }, (_, i) => `UI ${i}`), 'AI', 'background']);
  assert.ok(maximum <= 6, 'No more than six requests run at once');
});

void test('a UI reader promotes a coalesced HTTP request without another download', async () => {
  const gate = deferred(),
    order: string[] = [];
  const pool = createGitHubClientPool({
    fetch: (async (input: string) => {
      const name = new URL(input).pathname;
      order.push(name);
      if (name.startsWith('/block')) await gate.promise;
      return json({ name });
    }) as typeof fetch,
  });
  const client = pool.client('account');
  const blockers = [1, 2].map((i) => holdBackground(() => client.request(`GET /block-${i}`)));
  await settle(() => order.length === 2);
  const other = withGitHubPriority('background', () => client.request('GET /other'));
  const preload = withGitHubPriority('background', () => client.request('GET /wanted'));
  await turn();
  const opened = withGitHubPriority('interactive', () => client.request('GET /wanted'));
  await settle(() => order.length === 3);
  assert.deepEqual(order, ['/block-1', '/block-2', '/wanted'], 'The click starts the download before a slot frees');
  gate.resolve();
  await Promise.all([...blockers, other, preload, opened]);
  assert.deepEqual(order, ['/block-1', '/block-2', '/wanted', '/other']);
});

void test('opening a preloading file promotes its queued request and both sides through the real shared loader', async () => {
  const gate = deferred(),
    calls: string[] = [],
    guards: string[] = [];
  const pool = createGitHubClientPool({
    now: () => 1_000_000,
    fetch: (async (input: string) => {
      const url = new URL(input);
      calls.push(url.pathname + url.search);
      if (url.pathname.startsWith('/block')) {
        await gate.promise;
        return json(
          {},
          {
            'x-ratelimit-resource': 'core',
            'x-ratelimit-remaining': '50',
            'x-ratelimit-limit': '5000',
            'x-ratelimit-reset': '1100',
          }
        );
      }
      return new Response('const value = 1;', { headers: { 'content-type': 'application/octet-stream' } });
    }) as typeof fetch,
  });
  const client = pool.client('account'),
    loader = createSnapshotFileLoader();
  const request = { url: 'https://github.com/o/r/pull/1', path: 'file.ts', baseSha: 'base', headSha: 'head' };
  const file = { path: 'file.ts', status: 'modified' as const, additions: 1, deletions: 1, changeId: 'file' };
  const snapshot: PrChanges = {
    version: 1,
    url: request.url,
    metadata: {
      ...request,
      title: 'PR',
      baseRepo: 'o/r',
      headRepo: 'o/r',
      description: '',
      author: 'dev',
      baseBranch: 'main',
      headBranch: 'feature',
      merged: false,
      state: 'open',
      createdAt: '',
      updatedAt: '',
      labels: [],
      mergeable: true,
      isDraft: false,
      commitCount: 1,
      requestedReviewers: [],
      requestedTeams: [],
      mergeableState: 'clean',
      autoMerge: null,
      milestone: null,
    },
    comparisonBase: 'base',
    fetchedAt: 1,
    files: [file],
  };
  const renderer = createPrFileCache((req, background) =>
    withGitHubPriority(background ? 'background' : 'interactive', () =>
      loader(client, req, snapshot, file, () => {
        guards.push(githubPriority());
        if (githubPriority() === 'background') {
          const error = pool.backoff('account', true, ['core']);
          if (error) throw error;
        }
      })
    )
  );
  const blockers = [1, 2].map((i) => holdBackground(() => client.request(`GET /block-${i}`)));
  await settle(() => calls.length === 2);
  const preload = renderer.read(request, true);
  await turn();
  const opened = renderer.read(request, false);
  await turn();
  gate.resolve();
  const [, , prepared, displayed] = await Promise.all([...blockers, preload, opened]);
  assert.deepEqual(prepared, displayed);
  assert.deepEqual(
    guards,
    ['background', 'interactive'],
    'The second side inherits the click priority after awaiting the first'
  );
  assert.equal(calls.filter((call) => call.includes('/contents/')).length, 2, 'Exactly one download per side');
  assert.equal(renderer.peek(request), displayed);
});

void test('interactive priority cannot bypass GitHub Retry-After', async () => {
  let calls = 0;
  const pool = createGitHubClientPool({
    now: () => 1_000_000,
    fetch: (() => {
      calls++;
      return Promise.resolve(
        new Response(JSON.stringify({ message: 'secondary rate limit' }), {
          status: 429,
          headers: { 'content-type': 'application/json', 'retry-after': '60' },
        })
      );
    }) as typeof fetch,
  });
  const read = () => withGitHubPriority('interactive', () => pool.client('account').request('GET /wanted'));
  await assert.rejects(read(), GitHubBackoffError);
  await assert.rejects(read(), GitHubBackoffError);
  assert.equal(calls, 1);
});

void test('opening Changes promotes the entire shared manifest operation, including later API requests', async () => {
  const gate = deferred(),
    calls: string[] = [];
  const pool = createGitHubClientPool({
    now: () => 1_000_000,
    fetch: (async (input: string) => {
      const path = new URL(input).pathname;
      calls.push(path);
      if (path.startsWith('/block')) {
        await gate.promise;
        return json(
          {},
          {
            'x-ratelimit-resource': 'core',
            'x-ratelimit-remaining': '50',
            'x-ratelimit-limit': '5000',
            'x-ratelimit-reset': '1100',
          }
        );
      }
      if (path.endsWith('/files'))
        return json([
          { filename: 'file.ts', status: 'modified', additions: 1, deletions: 1, patch: '@@ -1 +1 @@\n-old\n+new' },
        ]);
      if (path.includes('/compare/')) return json({ merge_base_commit: { sha: 'base' } });
      return json({
        title: 'PR',
        user: { login: 'dev' },
        state: 'open',
        labels: [],
        changed_files: 1,
        base: { ref: 'main', sha: 'base', repo: { full_name: 'o/r' } },
        head: { ref: 'feature', sha: 'head', repo: { full_name: 'o/r' } },
      });
    }) as typeof fetch,
  });
  const client = pool.client('account'),
    service = createPrChangesService();
  // Hold both background slots, so the preload queues instead of starting and pacing.
  const blockers = [1, 2].map((i) => holdBackground(() => client.request(`GET /block-${i}`)));
  await settle(() => calls.length === 2);
  const read = () =>
    service.manifest(client, 'https://github.com/o/r/pull/1', false, {
      revision: { baseSha: 'base', headSha: 'head' },
    });
  const preload = withGitHubPriority('background', read);
  await turn();
  const opened = withGitHubPriority('interactive', read);
  await turn();
  gate.resolve();
  const [a, b] = await Promise.all([preload, opened]);
  await Promise.all(blockers);
  assert.deepEqual(a, b);
  assert.equal(b.files.length, 1);
  assert.equal(calls.filter((path) => path.endsWith('/files')).length, 1);
  assert.equal(calls.filter((path) => path.includes('/compare/')).length, 1);
  assert.equal(
    calls.filter((path) => path.endsWith('/pulls/1')).length,
    2,
    'Only the before/after consistency checks run'
  );
});

void test('requested-task inputs drain before optional work, even for large stacks', async () => {
  const schedule = createGitHubScheduler(), gate = deferred(), order: string[] = [];
  const running = [1, 2].map(() => schedule('background', () => gate.promise));
  const optional = schedule('background', () => { order.push('history'); return Promise.resolve(); });
  const inputs = Array.from({ length: 24 }, (_, i) =>
    schedule('foreground', () => { order.push(`file ${i}`); return Promise.resolve(); }));
  gate.resolve();
  await Promise.all([...running, optional, ...inputs]);
  assert.deepEqual(order, [...Array.from({ length: 24 }, (_, i) => `file ${i}`), 'history']);
});

void test('required file contents surface rate limits instead of silently omitting source', async () => {
  const { getFileContent } = await import('../lib/github');
  const pool = createGitHubClientPool({
    fetch: (() => Promise.resolve(new Response(JSON.stringify({ message: 'secondary rate limit' }), {
      status: 429, headers: { 'content-type': 'application/json', 'retry-after': '60' },
    }))) as typeof fetch,
  });
  await assert.rejects(getFileContent(pool.client('account'), 'o', 'r', 'file.ts', 'head'), GitHubBackoffError);
});

void test('cancelled optional history leaves the queue without making a GitHub request', async () => {
  const { getFileMetadata } = await import('../lib/github');
  const { startReviewFileMetadata } = await import('../lib/review-preparation');
  const gate = deferred(), calls: string[] = [];
  const pool = createGitHubClientPool({ fetch: (async (input: string) => {
    const path = new URL(input).pathname;
    calls.push(path);
    if (path.startsWith('/block')) await gate.promise;
    return json([]);
  }) as typeof fetch });
  const client = pool.client('account');
  const running = [1, 2].map((i) => holdBackground(() => client.request(`GET /block-${i}`)));
  await settle(() => calls.length === 2);
  const metadata = startReviewFileMetadata({ getFileMetadata: (files, signal) =>
    getFileMetadata(client, 'o', 'r', 1, 'base', files, signal),
  }, [{ filename: 'file.ts', status: 'modified', additions: 1, deletions: 1 }]);
  await turn();
  metadata.finish();
  const ui = withGitHubPriority('interactive', () => client.request('GET /clicked'));
  gate.resolve();
  await Promise.all([...running, ui]);
  await turn();
  assert.deepEqual(calls, ['/block-1', '/block-2', '/clicked']);
});

void test('pacing between file sides completes the preload without restarting downloads', async () => {
  let now = 1_000_000;
  const calls: string[] = [];
  const pool = createGitHubClientPool({ now: () => now, sleep: ms => { now += ms; return Promise.resolve(); },
    fetch: ((url: string) => {
      calls.push(url);
      return Promise.resolve(new Response('const value = 1;', { headers: {
        'content-type': 'application/octet-stream', 'x-ratelimit-resource': 'core',
        'x-ratelimit-remaining': '900', 'x-ratelimit-limit': '5000', 'x-ratelimit-reset': '4600',
      } }));
    }) as typeof fetch,
  });
  const client = pool.client('account'), load = createSnapshotFileLoader();
  const request = { url: 'https://github.com/o/r/pull/1', path: 'file.ts', baseSha: 'base', headSha: 'head' };
  const file = { path: 'file.ts', status: 'modified' as const, additions: 1, deletions: 1, changeId: 'file' };
  const snapshot = { version: 1, url: request.url, metadata: {
    ...request, title: 'PR', description: '', author: 'dev', baseRepo: 'o/r', headRepo: 'o/r',
    baseBranch: 'main', headBranch: 'feature', merged: false, state: 'open', createdAt: '', updatedAt: '',
    labels: [], mergeable: true, isDraft: false, commitCount: 1, requestedReviewers: [], requestedTeams: [],
    mergeableState: 'clean', autoMerge: null, milestone: null,
  },
    comparisonBase: 'base', fetchedAt: 1, files: [file] } as PrChanges;
  const read = () => withGitHubPriority('background', () => load(client, request, snapshot, file));
  const result = await read();
  assert.equal(result.before.kind, 'text');
  assert.equal(result.after.kind, 'text');
  assert.equal(calls.length, 2, 'Exactly one download per side, even across a rate-limit retry');
});

void test('six reads overlap; a seventh waits', async () => {
  const gate = deferred(),
    starts: string[] = [];
  let active = 0,
    maximum = 0;
  const pool = createGitHubClientPool({
    fetch: (async (url: string) => {
      starts.push(new URL(url).pathname);
      active++;
      maximum = Math.max(maximum, active);
      await gate.promise;
      active--;
      return json({});
    }) as typeof fetch,
  });
  const client = pool.client('account');
  const reads = withGitHubPriority('interactive', () =>
    Array.from({ length: 7 }, (_, i) => client.request(`GET /read-${i}`))
  );
  await settle(() => starts.length === 6);
  for (let i = 0; i < 5; i++) await turn();
  assert.equal(starts.length, 6, 'The seventh read waits for a free slot');
  gate.resolve();
  await Promise.all(reads);
  assert.equal(starts.length, 7);
  assert.equal(maximum, 6);
});

void test('background never exceeds two slots and lower tiers never exceed four', async () => {
  const schedule = createGitHubScheduler(),
    gate = deferred(),
    started: string[] = [];
  const hold = (name: string) => () => {
    started.push(name);
    return gate.promise;
  };
  const background = Array.from({ length: 5 }, (_, i) => schedule('background', hold(`background ${i}`)));
  const foreground = Array.from({ length: 5 }, (_, i) => schedule('foreground', hold(`foreground ${i}`)));
  assert.deepEqual(started, ['background 0', 'background 1', 'foreground 0', 'foreground 1']);
  const interactive = Array.from({ length: 3 }, (_, i) => schedule('interactive', hold(`interactive ${i}`)));
  assert.deepEqual(started.slice(4), ['interactive 0', 'interactive 1'], 'Two slots stay free for UI reads');
  gate.resolve();
  await Promise.all([...background, ...foreground, ...interactive]);
  assert.equal(started.length, 13);
});

void test('a promoted queued read starts without waiting for a slot to free', async () => {
  const schedule = createGitHubScheduler(),
    gate = deferred();
  const held = [1, 2].map(() => schedule('background', () => gate.promise));
  let started = false;
  const work = withGitHubPriority('background', () =>
    createGitHubWork(() =>
      schedule(githubPriorityScope(), () => {
        started = true;
        return Promise.resolve('read');
      })
    )
  );
  await turn();
  assert.equal(started, false, 'Both background slots are taken');
  const clicked = withGitHubPriority('interactive', () => joinGitHubWork(work));
  assert.equal(started, true, 'Promotion wakes the queue at once');
  assert.equal(await clicked, 'read');
  gate.resolve();
  await Promise.all(held);
});

void test('writes run alone and in order', async () => {
  const gate = deferred(),
    starts: string[] = [];
  let active = 0;
  const pool = createGitHubClientPool({
    fetch: (async (url: string, init: RequestInit) => {
      const name = new URL(url).pathname;
      starts.push(name);
      active++;
      if (init.method === 'POST') assert.equal(active, 1, `${name} runs alone`);
      if (name.startsWith('/read')) await gate.promise;
      else await turn();
      active--;
      return json({});
    }) as typeof fetch,
  });
  const client = pool.client('account');
  const reads = withGitHubPriority('interactive', () =>
    Array.from({ length: 3 }, (_, i) => client.request(`GET /read-${i}`))
  );
  await settle(() => starts.length === 3);
  const a = client.request('POST /a');
  await turn();
  const x = client.request('GET /x');
  await turn();
  const b = client.request('POST /b');
  for (let i = 0; i < 5; i++) await turn();
  assert.equal(starts.length, 3, 'No write starts while reads are active, and nothing overtakes a queued write');
  gate.resolve();
  await Promise.all([...reads, a, x, b]);
  assert.deepEqual(starts.slice(3), ['/a', '/x', '/b']);
});

void test('a secondary limit during concurrent reads stops queued starts and counts one strike', async () => {
  const now = 1_000_000;
  const gates = new Map<string, { promise: Promise<void>; resolve: () => void }>();
  const calls: string[] = [];
  const pool = createGitHubClientPool({
    now: () => now,
    fetch: (async (url: string) => {
      const name = new URL(url).pathname;
      calls.push(name);
      const gate = deferred();
      gates.set(name, gate);
      await gate.promise;
      if (name === '/read-5') return json({ ok: true });
      return new Response(JSON.stringify({ message: 'secondary rate limit' }), {
        status: 429,
        headers: { 'content-type': 'application/json', 'retry-after': '60' },
      });
    }) as typeof fetch,
  });
  const client = pool.client('account');
  const reads = withGitHubPriority('interactive', () =>
    Array.from({ length: 9 }, (_, i) => client.request(`GET /read-${i}`))
  );
  const results = Promise.allSettled(reads);
  await settle(() => calls.length === 6);
  gates.get('/read-0')?.resolve();
  const queued = await Promise.allSettled(reads.slice(6));
  assert.ok(queued.every((result) => result.status === 'rejected' && result.reason instanceof GitHubBackoffError));
  assert.equal(calls.length, 6, 'Queued reads never reach the network after a secondary limit');
  for (let i = 1; i < 6; i++) gates.get(`/read-${i}`)?.resolve();
  const settled = await results;
  assert.equal(settled[5].status, 'fulfilled', 'A read already in flight still delivers its result');
  assert.ok(settled.filter((result) => result.status === 'rejected').length === 8);
  assert.equal(
    pool.backoff('account')?.retryAt,
    now + 61_000,
    'Failures from one throttling event add one strike, not five'
  );
});

void test('concurrent reads keep the lowest observed budget', async () => {
  const gate = deferred(),
    times: number[] = [];
  let clock = 1_000_000;
  const pool = createGitHubClientPool({
    now: () => clock,
    sleep: (ms) => {
      clock += ms;
      return Promise.resolve();
    },
    fetch: (async (url: string) => {
      times.push(clock);
      const old = url.endsWith('/old');
      if (old) await gate.promise;
      return json(
        {},
        {
          'x-ratelimit-limit': '5000',
          'x-ratelimit-remaining': old ? '1000' : '50',
          'x-ratelimit-reset': '1100',
        }
      );
    }) as typeof fetch,
  });
  const client = pool.client('budget');
  const [old, fresh] = withGitHubPriority('interactive', () => [
    client.request('GET /old'),
    client.request('GET /fresh'),
  ]);
  await fresh;
  gate.resolve();
  await old;
  assert.equal(times.length, 2);
  assert.ok(pool.backoff('budget', true, ['core']), 'Late response must not restore the background reserve');
});
