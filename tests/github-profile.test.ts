import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Octokit } from '@octokit/rest';
import { createGitHubProfileService } from '../src/github-profile-service';
import { githubAvatarUrl, isGitHubLogin } from '../lib/github-profile';
void test('profile hovers coalesce, reuse the daily cache, and isolate accounts', async () => {
  let now = 1000,
    calls = 0;
  const data = { login: 'maya', name: 'Maya', bio: 'Builds queues', company: null, location: 'Berlin', type: 'User' };
  const client = {
    users: {
      getByUsername: () => {
        calls++;
        return Promise.resolve({ data });
      },
    },
  } as unknown as Octokit;
  const get = createGitHubProfileService(() => now);
  assert.equal(calls, 0);
  const [a, b] = await Promise.all([get(client, 'maya'), get(client, 'Maya')]);
  assert.deepEqual(a, b);
  assert.equal(calls, 1);
  await get(client, 'maya');
  assert.equal(calls, 1);
  await get({ users: client.users } as Octokit, 'maya');
  assert.equal(calls, 2);
  now += 24 * 60 * 60_000 + 1;
  await get(client, 'maya');
  assert.equal(calls, 3);
});
void test('failed hovers back off, stale profiles survive errors, and bots need no API read', async () => {
  let now = 1000,
    calls = 0,
    fail = true;
  const client = {
    users: {
      getByUsername: () => {
        calls++;
        if (fail) throw new Error('rate limited');
        return Promise.resolve({ data: { login: 'maya', name: 'Maya', type: 'User' } });
      },
    },
  } as unknown as Octokit;
  const get = createGitHubProfileService(() => now);
  await assert.rejects(get(client, 'maya'));
  await assert.rejects(get(client, 'maya'));
  assert.equal(calls, 1);
  now += 120_001;
  fail = false;
  assert.equal((await get(client, 'maya')).name, 'Maya');
  now += 24 * 60 * 60_000 + 1;
  fail = true;
  assert.equal((await get(client, 'maya')).name, 'Maya');
  assert.equal(calls, 3);
  assert.equal((await get(client, 'dependabot[bot]')).type, 'Bot');
  assert.equal(calls, 3);
  await assert.rejects(get(client, '../bad'));
  assert.equal(calls, 3);
  assert.equal(isGitHubLogin('unknown'), false);
  assert.equal(isGitHubLogin('a@example.com'), false);
  assert.equal(githubAvatarUrl('dependabot[bot]'), 'https://github.com/dependabot.png?size=64');
});
