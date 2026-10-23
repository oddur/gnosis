import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrImageService } from '../src/pr-image-service';
import { createGitHubClientPool, githubCacheFor, GitHubBackoffError } from '../lib/github-client';
import { isGitHubImageUrl } from '../lib/github-image';

const attachment = 'https://github.com/user-attachments/assets/01234567-89ab-cdef-0123-456789abcdef';
void test('authenticated images coalesce, reuse memory, isolate credentials, and bypass JSON cache', async () => {
  let calls = 0;
  const pool = createGitHubClientPool({
    minSpacingMs: 0,
    fetch: ((_url: string, init: RequestInit) => {
      calls++;
      assert.ok(new Headers(init.headers).get('authorization'));
      return Promise.resolve(
        new Response(new Uint8Array([137, 80, 78, 71]), { headers: { 'content-type': 'image/png; charset=utf-8' } })
      );
    }) as typeof fetch,
  });
  const load = createPrImageService();
  const a = pool.client('account-a');
  const writes: unknown[] = [];
  const cache = githubCacheFor(a);
  assert.ok(cache);
  cache.set = (...args: unknown[]) => {
    writes.push(args);
  };
  const [first, second] = await Promise.all([load(a, attachment), load(a, attachment)]);
  assert.equal(first, 'data:image/png;base64,iVBORw==');
  assert.equal(second, first);
  assert.equal(await load(a, attachment), first);
  assert.equal(calls, 1);
  assert.equal(writes.length, 0, 'Binary responses and signed redirect URLs never enter the JSON disk cache');
  await load(pool.client('account-b'), attachment);
  assert.equal(calls, 2, 'An account cannot reuse another account’s authenticated images');
});
void test('only GitHub-owned image endpoints can receive authentication', async () => {
  const load = createPrImageService();
  const pool = createGitHubClientPool({
    fetch: () => {
      throw new Error('No request should run');
    },
  });
  for (const url of [
    'https://example.com/image.png',
    'http://github.com/user-attachments/assets/123',
    'https://github.com.evil.test/user-attachments/assets/123',
    'https://github.com/login',
    'https://user:password@raw.githubusercontent.com/o/r/main/a.png',
    'file:///tmp/image.png',
  ]) {
    assert.equal(isGitHubImageUrl(url), false);
    await assert.rejects(load(pool.client('fixture'), url), /not a supported GitHub image URL/);
  }
});
void test('image loading respects shared backoff and rejects non-image responses', async () => {
  let calls = 0;
  const pool = createGitHubClientPool({
    minSpacingMs: 0,
    fetch: (() => {
      calls++;
      return Promise.resolve(new Response('rate limit', { status: 429, headers: { 'retry-after': '60' } }));
    }) as typeof fetch,
  });
  const load = createPrImageService();
  const client = pool.client('fixture');
  await assert.rejects(load(client, attachment), GitHubBackoffError);
  await assert.rejects(load(client, attachment), GitHubBackoffError);
  assert.equal(calls, 1);
  const other = createGitHubClientPool({
    fetch: () => Promise.resolve(new Response('<html>Sign in</html>', { headers: { 'content-type': 'text/html' } })),
  });
  await assert.rejects(load(other.client('fixture'), attachment), /supported image/);
});
