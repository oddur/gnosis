import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGitHubClientPool, githubRateLimit, GitHubBackoffError, fetchGitHubLogin } from '../lib/github-client';

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
  assert.ok(h.pool.backoff('fixture', true));
  assert.equal(h.pool.backoff('fixture'), undefined);
  const empty = harness(() =>
    json({}, 200, { 'x-ratelimit-remaining': '0', 'x-ratelimit-limit': '5000', 'x-ratelimit-reset': '1100' })
  );
  await empty.pool.client('fixture').request('GET /test');
  await assert.rejects(empty.pool.client('fixture').request('GET /another'), GitHubBackoffError);
  assert.equal(empty.calls.length, 1);
});

void test('cooldowns and verified usernames survive restart without storing credentials or response bodies', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gnosis-github-budget-'));
  const file = path.join(dir, 'budget.json');
  try {
    const h = harness(() =>
      json({ message: 'API rate limit exceeded' }, 403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1100' })
    );
    h.pool.setStorage(file);
    h.pool.rememberLogin('secret-token', 'reviewer');
    await assert.rejects(h.pool.client('secret-token').users.getAuthenticated(), GitHubBackoffError);
    assert.equal(fs.readFileSync(file, 'utf8').includes('secret-token'), false);
    const restart = harness(() => json({ login: 'reviewer' }));
    restart.pool.setStorage(file);
    assert.equal(restart.pool.savedLogin('secret-token'), 'reviewer');
    await assert.rejects(restart.pool.client('secret-token').users.getAuthenticated(), GitHubBackoffError);
    assert.equal(restart.calls.length, 0);
    assert.equal(restart.pool.savedLogin('different-token'), undefined);
  } finally {
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
