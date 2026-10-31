import test from 'node:test';
import assert from 'node:assert/strict';
import { createGitHubScheduler, withGitHubPriority, githubPriority } from '../lib/github-scheduler';
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
const json = (data: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json', ...headers } });

void test('UI requests always precede queued AI and maintenance work, even after eight turns', async () => {
  const schedule = createGitHubScheduler(),
    gate = deferred(),
    order: string[] = [];
  let active = 0,
    maximum = 0;
  const first = schedule('background', async () => {
    active++;
    maximum = Math.max(maximum, active);
    await gate.promise;
    active--;
  });
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
  await Promise.all([first, background, ai, ...ui]);
  assert.deepEqual(order, [...Array.from({ length: 12 }, (_, i) => `UI ${i}`), 'AI', 'background']);
  assert.equal(maximum, 1, 'Priority never increases network concurrency');
});

void test('a UI reader promotes a coalesced HTTP request without another download', async () => {
  const gate = deferred(),
    entered = deferred(),
    order: string[] = [];
  const pool = createGitHubClientPool({
    minSpacingMs: 0,
    fetch: (async (input: string) => {
      const name = new URL(input).pathname;
      order.push(name);
      if (name === '/block') {
        entered.resolve();
        await gate.promise;
      }
      return json({ name });
    }) as typeof fetch,
  });
  const client = pool.client('account');
  const first = client.request('GET /block');
  await entered.promise;
  const other = withGitHubPriority('background', () => client.request('GET /other'));
  const preload = withGitHubPriority('background', () => client.request('GET /wanted'));
  await turn();
  const opened = withGitHubPriority('interactive', () => client.request('GET /wanted'));
  await turn();
  gate.resolve();
  await Promise.all([first, other, preload, opened]);
  assert.deepEqual(order, ['/block', '/wanted', '/other']);
});

void test('opening a preloading file promotes its queued request and both sides through the real shared loader', async () => {
  const gate = deferred(),
    entered = deferred(),
    calls: string[] = [],
    guards: string[] = [];
  const pool = createGitHubClientPool({
    now: () => 1_000_000,
    minSpacingMs: 0,
    fetch: (async (input: string) => {
      const url = new URL(input);
      calls.push(url.pathname + url.search);
      if (url.pathname === '/block') {
        entered.resolve();
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
  const first = client.request('GET /block');
  await entered.promise;
  const preload = renderer.read(request, true);
  await turn();
  const opened = renderer.read(request, false);
  await turn();
  gate.resolve();
  const [, prepared, displayed] = await Promise.all([first, preload, opened]);
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
    minSpacingMs: 0,
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
    entered = deferred(),
    calls: string[] = [];
  const pool = createGitHubClientPool({
    now: () => 1_000_000,
    minSpacingMs: 0,
    fetch: (async (input: string) => {
      const path = new URL(input).pathname;
      calls.push(path);
      if (path === '/block') {
        entered.resolve();
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
  const first = client.request('GET /block');
  await entered.promise;
  const read = () =>
    service.manifest(client, 'https://github.com/o/r/pull/1', false, {
      revision: { baseSha: 'base', headSha: 'head' },
    });
  const preload = withGitHubPriority('background', read);
  await turn();
  const opened = withGitHubPriority('interactive', read);
  await turn();
  gate.resolve();
  const [, a, b] = await Promise.all([first, preload, opened]);
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
  const running = schedule('background', () => gate.promise);
  const optional = schedule('background', () => { order.push('history'); return Promise.resolve(); });
  const inputs = Array.from({ length: 24 }, (_, i) =>
    schedule('foreground', () => { order.push(`file ${i}`); return Promise.resolve(); }));
  gate.resolve();
  await Promise.all([running, optional, ...inputs]);
  assert.deepEqual(order, [...Array.from({ length: 24 }, (_, i) => `file ${i}`), 'history']);
});

void test('required file contents surface rate limits instead of silently omitting source', async () => {
  const { getFileContent } = await import('../lib/github');
  const pool = createGitHubClientPool({
    minSpacingMs: 0,
    fetch: (() => Promise.resolve(new Response(JSON.stringify({ message: 'secondary rate limit' }), {
      status: 429, headers: { 'content-type': 'application/json', 'retry-after': '60' },
    }))) as typeof fetch,
  });
  await assert.rejects(getFileContent(pool.client('account'), 'o', 'r', 'file.ts', 'head'), GitHubBackoffError);
});

void test('cancelled optional history leaves the queue without making a GitHub request', async () => {
  const { getFileMetadata } = await import('../lib/github');
  const { startReviewFileMetadata } = await import('../lib/review-preparation');
  const gate = deferred(), entered = deferred(), calls: string[] = [];
  const pool = createGitHubClientPool({ minSpacingMs: 0, fetch: (async (input: string) => {
    const path = new URL(input).pathname;
    calls.push(path);
    if (path === '/block') { entered.resolve(); await gate.promise; }
    return json([]);
  }) as typeof fetch });
  const client = pool.client('account');
  const running = client.request('GET /block');
  await entered.promise;
  const metadata = startReviewFileMetadata({ getFileMetadata: (files, signal) =>
    getFileMetadata(client, 'o', 'r', 1, 'base', files, signal),
  }, [{ filename: 'file.ts', status: 'modified', additions: 1, deletions: 1 }]);
  await turn();
  metadata.finish();
  const ui = withGitHubPriority('interactive', () => client.request('GET /clicked'));
  gate.resolve();
  await Promise.all([running, ui]);
  await turn();
  assert.deepEqual(calls, ['/block', '/clicked']);
});

void test('pacing between file sides completes the preload without restarting downloads', async () => {
  let now = 1_000_000;
  const calls: string[] = [];
  const pool = createGitHubClientPool({ now: () => now, minSpacingMs: 0, sleep: ms => { now += ms; return Promise.resolve(); },
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
