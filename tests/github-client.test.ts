import { githubCachedResponses } from '../lib/github-client';
import { flushCaches, closeCaches } from './cache-test-pool';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createGitHubClientPool,
  githubRateLimit,
  GitHubBackoffError,
  fetchGitHubLogin,
  githubCacheFor,
} from './cache-test-pool';
import { withGitHubPriority } from '../lib/github-scheduler';

function harness(respond: (url: string, headers: Headers) => Response) {
  let now = 1_000_000;
  const calls: string[] = [];
  const pool = createGitHubClientPool({
    now: () => now,
    minSpacingMs: 0,
    fetch: ((url: string, init: RequestInit) => {
      calls.push(url);
      return Promise.resolve(respond(url, new Headers(init.headers)));
    }) as typeof fetch,
  });
  return {
    pool,
    calls,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

void test('unavailable reads cool down across callers, including forced refresh, without blocking other PRs', async () => {
  let unavailable = true;
  const h = harness(url => url.includes('/pulls/1') && unavailable
    ? json({ message: 'Service Unavailable' }, 503, { 'retry-after': '60' })
    : json({ ok: true }));
  const client = h.pool.client('one');
  for (let i = 0; i < 12; i++)
    await assert.rejects(client.request('GET /repos/o/r/pulls/1', { headers: { 'cache-control': 'no-cache' } }));
  assert.equal(h.calls.length, 1, 'A failing read must not be sent on every mount or refresh');
  await client.request('GET /repos/o/r/pulls/2');
  assert.equal(h.calls.length, 2, 'Other PRs remain usable');
  await assert.rejects(h.pool.client('two').request('GET /repos/o/r/pulls/1'));
  assert.equal(h.calls.length, 3, 'Cooldowns are account scoped');
  h.advance(60_000);
  await assert.rejects(client.request('GET /repos/o/r/pulls/1'));
  assert.equal(h.calls.length, 3, 'Honor Retry-After with a clock-skew cushion');
  h.advance(1001);
  unavailable = false;
  assert.equal((await client.request('GET /repos/o/r/pulls/1')).status, 200);
});

void test('repeated server failures back off progressively and successful reads reset the cooldown', async () => {
  let status = 502;
  const h = harness(() => json({ message: 'Bad Gateway' }, status));
  const client = h.pool.client('one');
  const read = () => client.request('GET /repos/o/r/pulls/1', { headers: { 'cache-control': 'no-cache' } });
  await assert.rejects(read());
  h.advance(30_000);
  await assert.rejects(read());
  h.advance(30_000);
  await assert.rejects(read());
  assert.equal(h.calls.length, 2, 'Second failure gets a longer cooldown');
  h.advance(30_000);
  status = 200;
  await read();
  status = 504;
  await assert.rejects(read());
  h.advance(30_000);
  status = 200;
  await read();
  assert.equal(h.calls.length, 5, 'Successful reads reset successive failure counts');
});

void test('all consumers share authenticated requests and a primary cooldown, including queued requests', async () => {
  let limited = true;
  const h = harness((_url, headers) => {
    assert.equal(headers.get('authorization'), 'token fixture');
    return limited
      ? json({ message: 'API rate limit exceeded' }, 403, {
          'x-ratelimit-remaining': '0',
          'x-ratelimit-limit': '5000',
          'x-ratelimit-reset': '1100',
        })
      : json({ login: 'reviewer' });
  });
  const a = h.pool.client('fixture'),
    b = h.pool.client('fixture');
  assert.equal(a, b);
  const results = await Promise.allSettled([a.users.getAuthenticated(), b.repos.get({ owner: 'o', repo: 'r' })]);
  assert.ok(results.every((r) => r.status === 'rejected' && r.reason instanceof GitHubBackoffError));
  assert.equal(h.calls.length, 1);
  await assert.rejects(b.users.getAuthenticated(), GitHubBackoffError);
  assert.equal(h.calls.length, 1);
  h.advance(101_001);
  limited = false;
  assert.equal((await b.users.getAuthenticated()).data.login, 'reviewer');
  assert.equal(h.calls.length, 2);
});

void test('secondary limits honor Retry-After and escalate repeated throttling without replaying writes', async () => {
  const h = harness(() => json({ message: 'You have exceeded a secondary rate limit' }, 429, { 'retry-after': '120' }));
  const client = h.pool.client('fixture');
  await assert.rejects(
    client.issues.createComment({ owner: 'o', repo: 'r', issue_number: 1, body: 'Comment' }),
    GitHubBackoffError
  );
  assert.equal(h.calls.length, 1);
  h.advance(120_000);
  await assert.rejects(client.users.getAuthenticated(), GitHubBackoffError);
  assert.equal(h.calls.length, 1, 'The server deadline includes a clock-skew cushion');
  h.advance(1001);
  await assert.rejects(client.users.getAuthenticated(), GitHubBackoffError);
  assert.equal(h.calls.length, 2);
  assert.ok((h.pool.backoff('fixture')?.retryAt ?? 0) >= 1_241_001);
});

void test('plain permission errors are not cooldowns, and HTTP-date Retry-After is respected', async () => {
  const h = harness(() => json({ message: 'Resource not accessible' }, 403));
  await assert.rejects(h.pool.client('fixture').users.getAuthenticated(), /Resource not accessible/);
  assert.equal(h.pool.backoff('fixture'), undefined);
  const error = { status: 429, response: { headers: { 'retry-after': new Date(1_120_000).toUTCString() } } };
  assert.equal(githubRateLimit(error, 1_000_000)?.retryAt, 1_121_000);
});

void test('conditional reads reuse 304 bodies, coalesce callers, and isolate accounts and representations', async () => {
  const h = harness((_url, headers) =>
    headers.has('if-none-match')
      ? new Response(null, { status: 304, headers: { etag: '"v1"' } })
      : json({ value: headers.get('authorization'), accept: headers.get('accept') }, 200, { etag: '"v1"' })
  );
  const client = h.pool.client('one');
  const [a, b] = await Promise.all([client.request('GET /test'), client.request('GET /test')]);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(a.data, b.data);
  h.advance(60_001);
  assert.deepEqual((await client.request('GET /test')).data, a.data);
  await h.pool.client('two').request('GET /test');
  const diff = await client.request('GET /test', { headers: { accept: 'application/vnd.github.diff' } });
  assert.equal((diff.data as { accept: string }).accept, 'application/vnd.github.diff');
  assert.equal(h.calls.length, 4);
  await client.request('POST /test', { data: {} });
  const reread = await client.request('GET /test');
  assert.deepEqual(reread.data, a.data);
  assert.equal(h.calls.length, 6);
});

void test('successful last-quota responses stop later requests; background refresh reserves foreground budget', async () => {
  const h = harness(() =>
    json({}, 200, { 'x-ratelimit-remaining': '50', 'x-ratelimit-limit': '5000', 'x-ratelimit-reset': '1100' })
  );
  await h.pool.client('fixture').request('GET /test');
  assert.match(h.pool.backoff('fixture', true)?.reason ?? '', /preserve your API allowance/);
  assert.equal(h.pool.backoff('fixture'), undefined);
  const empty = harness(() =>
    json({}, 200, { 'x-ratelimit-remaining': '0', 'x-ratelimit-limit': '5000', 'x-ratelimit-reset': '1100' })
  );
  await empty.pool.client('fixture').request('GET /test');
  await assert.rejects(empty.pool.client('fixture').request('GET /another'), GitHubBackoffError);
  assert.equal(empty.calls.length, 1);
  assert.match(empty.pool.backoff('fixture', true)?.reason ?? '', /API limit was reached/);
});

void test('cooldowns and verified usernames survive restart without storing credentials', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gnosis-github-budget-'));
  const file = path.join(dir, 'budget.json');
  try {
    const h = harness(() =>
      json({ message: 'API rate limit exceeded' }, 403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1100' })
    );
    await flushCaches();
    await h.pool.setStorage(file);
    h.pool.rememberLogin('secret-token', 'reviewer');
    await assert.rejects(h.pool.client('secret-token').users.getAuthenticated(), GitHubBackoffError);
    assert.equal(fs.readFileSync(file, 'utf8').includes('secret-token'), false);
    const restart = harness(() => json({ login: 'reviewer' }));
    await flushCaches();
    await restart.pool.setStorage(file);
    assert.equal(restart.pool.savedLogin('secret-token'), 'reviewer');
    await assert.rejects(restart.pool.client('secret-token').users.getAuthenticated(), GitHubBackoffError);
    assert.equal(restart.calls.length, 0);
    assert.equal(restart.pool.savedLogin('different-token'), undefined);
  } finally {
    await closeCaches();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

void test('failed username lookups never become an authenticated unknown account', async () => {
  const h = harness(() =>
    json({ message: 'API rate limit exceeded' }, 403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1100' })
  );
  await assert.rejects(fetchGitHubLogin('fixture', h.pool), GitHubBackoffError);
  assert.equal(h.pool.savedLogin('fixture'), undefined);
  const invalid = harness(() => json({ message: 'Bad credentials' }, 401));
  await assert.rejects(fetchGitHubLogin('fixture', invalid.pool), /Bad credentials/);
  assert.equal(invalid.pool.savedLogin('fixture'), undefined);
  const valid = harness(() => json({ login: 'reviewer' }));
  assert.equal(await fetchGitHubLogin('fixture', valid.pool), 'reviewer');
  assert.equal(valid.pool.savedLogin('fixture'), 'reviewer');
});

void test('GraphQL reads retain REST cache and HTTP-200 rate limits enter the shared cooldown', async () => {
  let limited = false;
  const h = harness((url, headers) => {
    if (url.endsWith('/graphql'))
      return limited
        ? json({ errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }] }, 200, {
            'x-ratelimit-resource': 'graphql',
            'x-ratelimit-remaining': '0',
            'x-ratelimit-reset': '1100',
          })
        : json({ data: { viewer: { login: 'me' } } });
    return headers.has('if-none-match')
      ? new Response(null, { status: 304 })
      : json({ value: 'cached' }, 200, { etag: '"v1"' });
  });
  const client = h.pool.client('one');
  await client.request('GET /test');
  await client.request('POST /graphql', { query: 'query { viewer { login } }' });
  assert.deepEqual((await client.request('GET /test')).data, { value: 'cached' });
  limited = true;
  await assert.rejects(client.request('POST /graphql', { query: 'query { viewer { login } }' }), GitHubBackoffError);
  const count = h.calls.length;
  await assert.rejects(client.request('POST /graphql', { query: 'query { viewer { login } }' }), GitHubBackoffError);
  assert.equal(h.calls.length, count);
});

void test('fresh responses survive restart; stale responses revalidate and refresh their saved age', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gnosis-github-cache-'));
  const file = path.join(dir, 'budget.json');
  const respond = (_url: string, headers: Headers) =>
    headers.has('if-none-match')
      ? new Response(null, { status: 304, headers: { etag: '"v1"', 'cache-control': 'private, max-age=60' } })
      : json({ value: 'saved' }, 200, { etag: '"v1"', 'cache-control': 'private, max-age=60' });
  try {
    const original = harness(respond);
    await flushCaches();
    await original.pool.setStorage(file);
    await original.pool.client('secret-token').request('GET /test');
    await flushCaches();
    const content =
      fs.readFileSync(path.join(dir, 'github-cache.sqlite'), 'utf8') +
      fs.readFileSync(path.join(dir, 'github-cache.sqlite-wal'), 'utf8');
    assert.equal(content.includes('secret-token'), false);
    assert.equal(content.includes('authorization'), false);
    // Windows exposes only the writable bit, not POSIX owner/group permissions.
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(path.join(dir, 'github-cache.sqlite')).mode & 0o777, 0o600);
    }
    const restart = harness(respond);
    await flushCaches();
    await restart.pool.setStorage(file);
    const client = restart.pool.client('secret-token');
    const first = await client.request('GET /test');
    assert.deepEqual(first.data, { value: 'saved' });
    assert.equal(restart.calls.length, 0);
    (first.data as { value: string }).value = 'modified';
    assert.deepEqual((await client.request('GET /test')).data, { value: 'saved' });
    restart.advance(60_001);
    assert.deepEqual((await client.request('GET /test')).data, { value: 'saved' });
    assert.equal(restart.calls.length, 1);
    const again = harness(respond);
    again.advance(60_001);
    await flushCaches();
    await again.pool.setStorage(file);
    await again.pool.client('secret-token').request('GET /test');
    assert.equal(again.calls.length, 0, 'A 304 refreshes the persisted freshness window');
    await again.pool.client('another-token').request('GET /test');
    assert.equal(again.calls.length, 1, 'Credentials never share saved response data');
    await again.pool
      .client('secret-token')
      .request('GET /test', { headers: { accept: 'application/vnd.github.diff' } });
    await again.pool.client('secret-token').request('GET /test', { headers: { 'x-github-api-version': '2099-01-01' } });
    assert.equal(again.calls.length, 3, 'Representations and API versions have separate cache entries');
  } finally {
    await closeCaches();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

void test('explicit refresh bypasses fresh reads and writes and sign-out invalidate persisted responses', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gnosis-github-invalidate-'));
  const file = path.join(dir, 'budget.json');
  try {
    let value = 1;
    const h = harness(() => json({ value }, 200, { etag: '"v1"' }));
    await flushCaches();
    await h.pool.setStorage(file);
    const client = h.pool.client('one');
    await client.request('GET /test');
    value = 2;
    assert.deepEqual((await client.request('GET /test', { headers: { 'cache-control': 'no-cache' } })).data, {
      value: 2,
    });
    assert.equal(h.calls.length, 2);
    value = 3;
    githubCacheFor(client)?.revalidate();
    assert.deepEqual((await client.request('GET /test')).data, { value: 3 });
    assert.equal(h.calls.length, 3, 'Queue refresh can invalidate freshness while retaining validators');
    await client.request('POST /test', { data: {} });
    const restart = harness(() => json({ value: 3 }, 200, { etag: '"v2"' }));
    await flushCaches();
    await restart.pool.setStorage(file);
    assert.deepEqual((await restart.pool.client('one').request('GET /test')).data, { value: 3 });
    assert.equal(restart.calls.length, 1);
    restart.pool.forget('one');
    const signedIn = harness(() => json({ value: 4 }));
    await flushCaches();
    await signedIn.pool.setStorage(file);
    assert.deepEqual((await signedIn.pool.client('one').request('GET /test')).data, { value: 4 });
    assert.equal(signedIn.calls.length, 1);
  } finally {
    await closeCaches();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

void test('cache respects no-store, revalidation, expiry, and permissions errors without stale fallback', async () => {
  const noStore = harness(() => json({}, 200, { etag: '"private"', 'cache-control': 'no-store' }));
  await noStore.pool.client('one').request('GET /test');
  await noStore.pool.client('one').request('GET /test');
  assert.equal(noStore.calls.length, 2);
  let allowed = true;
  const h = harness(() =>
    allowed ? json({}, 200, { etag: '"v1"', 'cache-control': 'no-cache' }) : json({ message: 'Forbidden' }, 403)
  );
  const client = h.pool.client('one');
  await client.request('GET /test');
  await client.request('GET /test');
  assert.equal(h.calls.length, 2);
  allowed = false;
  await assert.rejects(client.request('GET /test'), /Forbidden/);
  await assert.rejects(client.request('GET /test'), /Forbidden/);
});

void test('fresh cached data remains readable during backoff without sending requests', async () => {
  const h = harness((url) =>
    url.endsWith('/limited')
      ? json({ message: 'Rate limit exceeded' }, 429, { 'retry-after': '120' })
      : json({ value: 'saved' }, 200, { etag: '"v1"' })
  );
  const client = h.pool.client('one');
  await client.request('GET /test');
  await assert.rejects(client.request('GET /limited'), GitHubBackoffError);
  assert.deepEqual((await client.request('GET /test')).data, { value: 'saved' });
  assert.equal(h.calls.length, 2);
  await assert.rejects(client.request('GET /test', { headers: { 'cache-control': 'no-cache' } }), GitHubBackoffError);
  assert.equal(h.calls.length, 2);
});

void test('corrupt persisted responses are ignored and oversized responses are not retained', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gnosis-github-corrupt-'));
  const file = path.join(dir, 'budget.json');
  try {
    fs.writeFileSync(path.join(dir, 'github-cache.json'), '{invalid');
    const h = harness(() => json({ value: 'x'.repeat(1_000_001) }, 200, { etag: '"large"' }));
    await flushCaches();
    await h.pool.setStorage(file);
    await h.pool.client('one').request('GET /test');
    await h.pool.client('one').request('GET /test');
    assert.equal(h.calls.length, 2);
    assert.deepEqual(githubCachedResponses(h.pool.client('one')), []);
  } finally {
    await closeCaches();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

void test('cache entry count is bounded and validators expire after a week', async () => {
  const h = harness((_url, headers) => {
    assert.equal(headers.has('if-none-match'), false);
    return json({ value: 'saved' }, 200, { etag: '"v1"' });
  });
  const client = h.pool.client('one');
  for (let i = 0; i < 2001; i++) await client.request(`GET /entry/${i}`);
  await client.request('GET /entry/2000');
  assert.equal(h.calls.length, 2001);
  await client.request('GET /entry/0');
  assert.equal(h.calls.length, 2002, 'The oldest entry was evicted');
  h.advance(7 * 24 * 60 * 60_000);
  await client.request('GET /entry/2000');
  assert.equal(h.calls.length, 2003, 'Old validators are not retained indefinitely');
});

void test('sign-out prevents an already-running read from repopulating the persisted cache', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gnosis-github-inflight-'));
  const file = path.join(dir, 'budget.json');
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const pool = createGitHubClientPool({
    minSpacingMs: 0,
    fetch: (async () => {
      started();
      await gate;
      return json({ value: 'old' }, 200, { etag: '"v1"' });
    }) as typeof fetch,
  });
  try {
    await flushCaches();
    await pool.setStorage(file);
    const pending = pool.client('one').request('GET /test');
    await entered;
    pool.forget('one');
    release();
    await pending;
    const restart = harness(() => json({ value: 'new' }));
    await flushCaches();
    await restart.pool.setStorage(file);
    assert.deepEqual((await restart.pool.client('one').request('GET /test')).data, { value: 'new' });
    assert.equal(restart.calls.length, 1);
  } finally {
    release();
    await closeCaches();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

void test('failed writes invalidate cached reads without being replayed', async () => {
  let value = 1;
  const h = harness((url) =>
    url.endsWith('/write') ? json({ message: 'Service unavailable' }, 503) : json({ value }, 200, { etag: '"v1"' })
  );
  const client = h.pool.client('one');
  await client.request('GET /test');
  value = 2;
  await assert.rejects(client.request('POST /write', { data: {} }), /Service unavailable/);
  assert.deepEqual((await client.request('GET /test')).data, { value: 2 });
  assert.equal(h.calls.length, 3);
});

void test('fresh cache hits bypass a blocked network request', async () => {
  let release!: () => void;
  let started!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const pool = createGitHubClientPool({
    minSpacingMs: 0,
    fetch: (async (url: string) => {
      if (url.endsWith('/slow')) {
        started();
        await barrier;
      }
      return json({ value: 'saved' });
    }) as typeof fetch,
  });
  const client = pool.client('fixture');
  await client.request('GET /cached');
  const slow = client.request('GET /slow');
  await entered;
  let served = false;
  const cached = client.request('GET /cached').then(() => {
    served = true;
  });
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(served, true, 'Fresh local reads must not wait for network work');
  } finally {
    release();
    await Promise.all([slow, cached]);
  }
});

void test('comment writes invalidate their PR without evicting unrelated PRs', async () => {
  const h = harness(() => json({ value: 'saved' }));
  const client = h.pool.client('fixture');
  await client.request('GET /repos/o/r/pulls/1');
  await client.request('GET /repos/o/r/pulls/2');
  await client.request('POST /repos/o/r/issues/1/comments', { body: 'Comment' });
  await client.request('GET /repos/o/r/pulls/2');
  assert.equal(h.calls.length, 3, 'Unrelated PR stays fresh');
  await client.request('GET /repos/o/r/pulls/1');
  assert.equal(h.calls.length, 4, 'Written PR is revalidated');
});

void test('foreground requests overtake queued background reads while network access remains serial', async () => {
  const order: string[] = [];
  let release!: () => void;
  let entered!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const pool = createGitHubClientPool({
    minSpacingMs: 0,
    fetch: (async (url: string) => {
      const path = new URL(url).pathname;
      order.push(path);
      if (path === '/first') {
        entered();
        await blocked;
      }
      return json({});
    }) as typeof fetch,
  });
  const client = pool.client('fixture');
  const first = withGitHubPriority('background', () => client.request('GET /first'));
  await started;
  const second = withGitHubPriority('background', () => client.request('GET /second'));
  const foreground = client.request('GET /foreground');
  // Let Octokit's async hooks enqueue both requests before releasing the network.
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ['/first']);
  release();
  await Promise.all([first, second, foreground]);
  assert.deepEqual(order, ['/first', '/foreground', '/second']);
});

void test('background budget reservations are enforced by the shared scheduler', async () => {
  const h = harness(() =>
    json({}, 200, {
      'x-ratelimit-resource': 'core',
      'x-ratelimit-remaining': '50',
      'x-ratelimit-limit': '5000',
      'x-ratelimit-reset': '1100',
    })
  );
  const client = h.pool.client('fixture');
  await client.request('GET /budget');
  await assert.rejects(
    withGitHubPriority('background', () => client.request('GET /background')),
    GitHubBackoffError
  );
  await client.request('GET /foreground');
  assert.equal(h.calls.length, 2);
});

void test('primary limits pause their own resource without blocking other GitHub APIs', async () => {
  const h = harness((url) =>
    url.includes('/search/')
      ? json({ message: 'API rate limit exceeded' }, 403, {
          'x-ratelimit-resource': 'search',
          'x-ratelimit-remaining': '0',
          'x-ratelimit-limit': '30',
          'x-ratelimit-reset': '1100',
        })
      : json({ value: 'available' })
  );
  const client = h.pool.client('fixture');
  await assert.rejects(client.request('GET /search/issues'), GitHubBackoffError);
  assert.deepEqual((await client.request('GET /repos/o/r/pulls/1')).data, { value: 'available' });
  await assert.rejects(client.request('GET /search/issues'), GitHubBackoffError);
  assert.equal(h.calls.length, 2);
});

void test('preloads pace early without blocking cached or interactive reads', async () => {
  let now = 1_000_000;
  const calls: string[] = [];
  let release!: () => void;
  const pool = createGitHubClientPool({ now: () => now, minSpacingMs: 0,
    sleep: ms => new Promise<void>(resolve => { release = () => { now += ms; resolve(); }; }),
    fetch: ((url: string) => {
      calls.push(url);
      return Promise.resolve(json({ ok: true }, 200, { 'x-ratelimit-resource': 'core', 'x-ratelimit-remaining': '4000',
        'x-ratelimit-limit': '5000', 'x-ratelimit-reset': '4600' }));
    }) as typeof fetch,
  });
  const client = pool.client('one');
  await withGitHubPriority('background', () => client.request('GET /first-preload'));
  let completed = false;
  const waiting = withGitHubPriority('background', () => client.request('GET /second-preload')).then(() => { completed = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 1, 'Preloads must pace before the low-budget threshold');
  await withGitHubPriority('background', () => client.request('GET /first-preload'));
  assert.equal(calls.length, 1, 'Cached reads remain immediate');
  await client.request('GET /user-request');
  assert.equal(calls.length, 2, 'The scheduler is free for interactive work during pacing');
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- the pending request changes this flag
  for (let i = 0; i < 30 && !completed; i++) {
    release();
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(completed, true, 'The same background request resumes without being restarted by its caller');
  await waiting;
  assert.equal(calls.length, 3);
});

void test('a click promotes a paced preload and cancellation stops a waiting request', async () => {
  let wake!: () => void;
  const calls: string[] = [];
  const pool = createGitHubClientPool({ now: () => 1_000_000, minSpacingMs: 0,
    sleep: () => new Promise<void>(resolve => { wake = resolve; }),
    fetch: ((url: string) => {
      calls.push(url);
      return Promise.resolve(json({}, 200, { 'x-ratelimit-resource': 'core', 'x-ratelimit-remaining': '4000',
        'x-ratelimit-limit': '5000', 'x-ratelimit-reset': '4600' }));
    }) as typeof fetch,
  });
  const client = pool.client('one');
  await withGitHubPriority('background', () => client.request('GET /seed'));
  const preload = withGitHubPriority('background', () => client.request('GET /wanted'));
  await new Promise(resolve => setImmediate(resolve));
  const clicked = withGitHubPriority('interactive', () => client.request('GET /wanted'));
  await new Promise(resolve => setImmediate(resolve));
  wake();
  await Promise.all([preload, clicked]);
  assert.equal(calls.length, 2, 'Promotion bypasses speculative pacing and shares the download');
  const controller = new AbortController();
  const waiting = withGitHubPriority('background', () => client.request('GET /cancelled', { request: { signal: controller.signal } }));
  const cancelled = assert.rejects(waiting, /cancelled/);
  await new Promise(resolve => setImmediate(resolve));
  controller.abort(new Error('cancelled'));
  wake();
  await cancelled;
  assert.equal(calls.length, 2, 'No request after cancellation');
});

void test('background work preserves ten percent of the standard REST allowance', async () => {
  const h = harness(() => json({}, 200, { 'x-ratelimit-resource': 'core', 'x-ratelimit-remaining': '500',
    'x-ratelimit-limit': '5000', 'x-ratelimit-reset': '4600' }));
  const client = h.pool.client('one');
  await client.request('GET /seed');
  assert.ok(h.pool.backoff('one', true, ['core']));
  await assert.rejects(withGitHubPriority('background', () => client.request('GET /background')), GitHubBackoffError);
  await client.request('GET /user-request');
  assert.equal(h.calls.length, 2);
});
