import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGitHubClientPool } from '../lib/github-client';
import { createQueueSignalsService } from '../src/queue-signals-service';
import { QUEUE_SIGNALS_TTL } from '../lib/queue-signals';
const request = { url: 'https://github.com/example/repo/pull/1', headSha: 'abc123' };
function harness() {
  let now = 1_000_000,
    calls = 0,
    fail = false;
  let response: unknown = {
    p0: {
      pullRequest: {
        headRefOid: 'abc123',
        state: 'OPEN',
        isDraft: false,
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'BEHIND',
        reviewDecision: 'APPROVED',
        baseRefName: 'feature/base',
        baseRefOid: 'base123',
        baseRef: { compare: { behindBy: 3 } },
        mergeQueue: null,
        mergeQueueEntry: null,
        comments: { totalCount: 4 },
        commits: {
          nodes: [
            {
              commit: {
                statusCheckRollup: {
                  state: 'SUCCESS',
                  contexts: {
                    totalCount: 130,
                    checkRunCountsByState: [{ state: 'SUCCESS', count: 125 }],
                    statusContextCountsByState: [{ state: 'SUCCESS', count: 5 }],
                  },
                },
              },
            },
          ],
        },
      },
    },
  };
  const queries: string[] = [];
  const pool = createGitHubClientPool({
    now: () => now,
    minSpacingMs: 0,
    fetch: ((_url, init) => {
      calls++;
      queries.push(typeof init?.body === 'string' ? init.body : '');
      return Promise.resolve(
        new Response(JSON.stringify(fail ? { message: 'rate limited' } : { data: response }), {
          status: fail ? 429 : 200,
          headers: { 'content-type': 'application/json', ...(fail ? { 'retry-after': '600' } : {}) },
        })
      );
    }) as typeof fetch,
  });
  return {
    get: createQueueSignalsService(() => now),
    client: pool.client('fixture'),
    other: () => pool.client('other'),
    calls: () => calls,
    queries,
    advance: (ms = QUEUE_SIGNALS_TTL + 1) => {
      now += ms;
    },
    fail: () => {
      fail = true;
    },
    respond: (value: unknown) => {
      response = value;
    },
  };
}
void test('queue reads coalesce, cache across service instances, and count over 100 checks including commit statuses', async () => {
  const h = harness();
  const [a, b] = await Promise.all([h.get(h.client, [request]), h.get(h.client, [request])]);
  assert.deepEqual(a, b);
  assert.deepEqual(a[0].checks, { state: 'success', passed: 130, skipped: 0, total: 130, failed: 0, running: 0 });
  assert.equal(a[0].comments, 4);
  assert.equal(a[0].readiness?.mergeState, 'BEHIND');
  assert.equal(a[0].readiness.behindBy, 3);
  assert.match(h.queries[0], /mergeStateStatus reviewDecision/);
  assert.equal(h.calls(), 1);
  await h.get(h.client, [request]);
  assert.equal(h.calls(), 1);
  const restarted = createQueueSignalsService(() => 1_000_000);
  await restarted(h.client, [request]);
  assert.equal(h.calls(), 1);
  await h.get(h.other(), [request]);
  assert.equal(h.calls(), 2, 'Credentials do not share snapshots');
});
void test('cached-only reads never request GitHub, including stale snapshots; explicit refresh bypasses freshness', async () => {
  const h = harness();
  assert.deepEqual(await h.get(h.client, [request], { cachedOnly: true }), []);
  assert.equal(h.calls(), 0);
  const original = await h.get(h.client, [request]);
  await h.get(h.client, [request], { force: true });
  assert.equal(h.calls(), 2);
  h.advance();
  assert.deepEqual(await h.get(h.client, [request], { cachedOnly: true }), original);
  assert.equal(h.calls(), 2);
  h.fail();
  await h.get(h.client, [request], { force: true });
  const calls = h.calls();
  await h.get(h.client, [request], { force: true });
  assert.equal(h.calls(), calls, 'Explicit refresh still respects the retry deadline');
});
void test('visible rows use one batch and snapshots never cross commit revisions', async () => {
  const h = harness();
  const next = { ...request, url: 'https://github.com/example/other/pull/2', headSha: 'def456' };
  const values = await h.get(h.client, [request, next]);
  assert.equal(values.length, 1);
  assert.match(h.queries[0], /p0:/);
  assert.match(h.queries[0], /p1:/);
  assert.equal(h.calls(), 1);
  assert.deepEqual(await h.get(h.client, [{ ...request, headSha: 'newsha' }]), []);
  await assert.rejects(
    h.get(
      h.client,
      Array.from({ length: 26 }, () => request)
    )
  );
  await assert.rejects(h.get(h.client, [{ ...request, url: 'https://evil.example/pull/1' }]));
});
void test('rate limiting preserves dated snapshots without retry traffic', async () => {
  const h = harness();
  const [original] = await h.get(h.client, [request]);
  h.advance();
  h.fail();
  assert.deepEqual(await h.get(h.client, [request]), [original]);
  assert.equal(h.calls(), 2);
  await h.get(h.client, [request]);
  assert.equal(h.calls(), 2);
  h.advance();
  await h.get(h.client, [request]);
  assert.equal(h.calls(), 2, 'Shared Retry-After gate outlasts the service cooldown');
});
void test('a PR with no check rollup is neutral, never reported as passing', async () => {
  const h = harness();
  h.respond({ p0: { pullRequest: { headRefOid: 'abc123', comments: { totalCount: 0 }, commits: { nodes: [] } } } });
  assert.deepEqual((await h.get(h.client, [request]))[0].checks, { state: 'neutral', passed: 0, skipped: 0, total: 0, failed: 0, running: 0 });
});

void test('skipped checks are separate from successful checks', async () => {
  const h = harness();
  h.respond({
    p0: {
      pullRequest: {
        headRefOid: 'abc123',
        comments: { totalCount: 0 },
        commits: {
          nodes: [
            {
              commit: {
                statusCheckRollup: {
                  state: 'SUCCESS',
                  contexts: {
                    totalCount: 3,
                    checkRunCountsByState: [
                      { state: 'SUCCESS', count: 1 },
                      { state: 'SKIPPED', count: 1 },
                      { state: 'NEUTRAL', count: 1 },
                    ],
                    statusContextCountsByState: [],
                  },
                },
              },
            },
          ],
        },
      },
    },
  });
  assert.deepEqual((await h.get(h.client, [request]))[0].checks, { state: 'success', passed: 1, skipped: 2, total: 3, failed: 0, running: 0 });
});

void test('active PR statuses refresh sooner and share their result with visible queue rows', async () => {
  const h = harness();
  await h.get(h.client, [request]);
  h.advance(30_000);
  await h.get(h.client, [request]);
  assert.equal(h.calls(), 1, 'The queue keeps its two-minute cadence');
  await h.get(h.client, [request], { active: true });
  assert.equal(h.calls(), 2, 'The active PR refreshes after thirty seconds');
  await h.get(h.client, [request]);
  assert.equal(h.calls(), 2, 'The queue reuses the active PR refresh');
});

void test('a head mismatch signals a targeted metadata refresh without publishing checks for the wrong revision', async () => {
  const h = harness();
  const changed: string[] = [];
  const read = createQueueSignalsService(() => 1_000_000, (_client, url, sha) => changed.push(`${url}@${sha}`));
  assert.deepEqual(await read(h.client, [{ ...request, headSha: 'oldsha' }]), []);
  assert.deepEqual(changed, [`${request.url}@abc123`]);
});
