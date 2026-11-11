import test from 'node:test';
import assert from 'node:assert/strict';
import { createGitHubClientPool, githubCacheFor } from '../lib/github-client';
import { createPrStatusService, PR_STATUS_MAX_STALE_MS } from '../src/pr-status-service';
import { readPrChecks } from '../src/pr-checks-service';
import { createQueueSignalsService } from '../src/queue-signals-service';
import type { PrChecks } from '../lib/pr-checks';
import type { QueueSignals } from '../lib/queue-signals';
import type { PrMetadata } from '../lib/types';
import { getReviewStatus, summarizeReviews } from '../lib/github';

const url = 'https://github.com/o/r/pull/1';
const head = 'a'.repeat(40);
const otherHead = 'b'.repeat(40);
const savedAt = 1_000_000;
function harness() {
  const calls: string[] = [];
  const pool = createGitHubClientPool({
    fetch: ((input: string, init: RequestInit) => {
      calls.push(`${init.method ?? 'GET'} ${new URL(input).pathname}`);
      return Promise.resolve(
        new Response(JSON.stringify({ id: 1 }), { status: 201, headers: { 'content-type': 'application/json' } })
      );
    }) as typeof fetch,
  });
  const client = pool.client('one');
  const cache = githubCacheFor(client);
  assert.ok(cache);
  return { calls, client, cache };
}
const core = {
  labels: ['bug'],
  isDraft: false,
  baseBranch: 'main',
  commitCount: 2,
  requestedReviewers: ['maya'],
  requestedTeams: [],
  autoMerge: null,
  milestone: null,
  reviewSummary: { approved: 1, changesRequested: 0, commented: 0 },
};
const saved = (headSha = head) => ({ url, headSha, baseSha: 'c'.repeat(40), checkedAt: savedAt, core });
const checks = (headSha: string): PrChecks => ({
  url,
  headSha,
  checkedAt: savedAt,
  checks: [
    {
      id: 'check:1',
      databaseId: 1,
      kind: 'check',
      provider: 'GitHub Actions',
      required: true,
      name: 'test',
      status: 'completed',
      conclusion: 'failure',
      url: null,
      startedAt: null,
      completedAt: null,
    },
  ],
});
const signals = (headSha: string): QueueSignals => ({
  url,
  headSha,
  checkedAt: savedAt,
  comments: 0,
  checks: { state: 'failure', total: 1, passed: 0, failed: 1 },
});
function service(now: () => number) {
  return createPrStatusService({
    metadata: () => Promise.reject(new Error('Saved reads must not contact GitHub')),
    reviews: () => Promise.reject(new Error('Saved reads must not contact GitHub')),
    checks: readPrChecks,
    signals: createQueueSignalsService(now),
    now,
  });
}

void test('cached status is served without requests for the same head', async () => {
  const h = harness();
  h.cache.set(`pr-status:v1:${url}`, saved());
  h.cache.set(`pr-checks:v1:${url}@${head}`, checks(head));
  h.cache.set(`queue-signals:v3:${url}@${head}`, signals(head));
  const status = await service(() => savedAt + 60_000).cached(h.client, url, head);
  assert.equal(h.calls.length, 0);
  assert.ok(status);
  assert.equal(status.stale, true);
  assert.equal(status.mergeable, null);
  assert.equal(status.mergeableState, null);
  assert.equal(status.headSha, head);
  assert.equal(status.checkedAt, savedAt);
  assert.deepEqual(status.labels, ['bug']);
  assert.deepEqual(status.reviewSummary, core.reviewSummary);
  assert.equal(status.ciChecks.length, 1);
  assert.equal(status.ciConclusion, 'failure');
  assert.equal(status.signals?.headSha, head);
});

void test('cached status is refused for another head, after a write, and past 24 hours', async () => {
  const h = harness();
  h.cache.set(`pr-status:v1:${url}`, saved());
  assert.equal(await service(() => savedAt).cached(h.client, url, otherHead), undefined, 'Another head');
  assert.equal(
    await service(() => savedAt + PR_STATUS_MAX_STALE_MS).cached(h.client, url, head),
    undefined,
    'Older than 24 hours'
  );
  assert.ok(await service(() => savedAt + PR_STATUS_MAX_STALE_MS - 1).cached(h.client, url, head));
  await h.client.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
    owner: 'o',
    repo: 'r',
    issue_number: 1,
    body: 'Done',
  });
  assert.deepEqual(h.calls, ['POST /repos/o/r/issues/1/comments']);
  assert.equal(await service(() => savedAt).cached(h.client, url, head), undefined, 'A write marks it stale');
});

void test('stale CI comes only from same-head snapshots', async () => {
  const h = harness();
  h.cache.set(`pr-status:v1:${url}`, saved());
  h.cache.set(`pr-checks:v1:${url}@${otherHead}`, checks(otherHead));
  h.cache.set(`queue-signals:v3:${url}@${otherHead}`, signals(otherHead));
  const status = await service(() => savedAt).cached(h.client, url, head);
  assert.ok(status);
  assert.deepEqual(status.ciChecks, []);
  assert.equal(status.ciConclusion, 'neutral');
  assert.equal(status.signals, undefined);
  assert.equal(status.checkSnapshot, undefined);
  assert.equal(h.calls.length, 0);
});

void test('concurrent status reads share one fetch and an account change discards the save', async () => {
  const h = harness();
  let reads = 0;
  let release!: () => void;
  const metadata = {
    headSha: head,
    baseSha: 'c'.repeat(40),
    mergeable: true,
    mergeableState: 'clean',
    ...core,
  } as unknown as PrMetadata;
  const status = createPrStatusService({
    metadata: () => {
      reads++;
      return new Promise((resolve) => {
        release = () => resolve(metadata);
      });
    },
    reviews: () => Promise.resolve(core.reviewSummary),
    checks: () => Promise.resolve(undefined),
    signals: () => Promise.resolve([]),
    now: () => savedAt,
  });
  const first = status.read(h.client, url);
  const second = status.read(h.client, url);
  await new Promise((resolve) => setImmediate(resolve));
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(reads, 1);
  assert.deepEqual(a, b);
  assert.equal(a.status.mergeable, true);
  assert.equal(a.status.stale, undefined);
  assert.ok(await status.cached(h.client, url, head), 'A completed read saves the core');

  h.cache.clear();
  const third = status.read(h.client, url);
  await new Promise((resolve) => setImmediate(resolve));
  h.cache.clear();
  release();
  await third;
  assert.equal(reads, 2);
  assert.equal(h.cache.get(`pr-status:v1:${url}`, (v): v is unknown => true), undefined);
  assert.equal(await status.cached(h.client, url, head), undefined);
});

/** A status service whose four reads record their start order and wait for `release`. */
function speculation(reportedHead: string) {
  const h = harness();
  const started: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const metadata = { headSha: reportedHead, baseSha: 'c'.repeat(40), mergeable: true, mergeableState: 'clean', ...core };
  const status = createPrStatusService({
    metadata: async () => {
      started.push('metadata');
      await gate;
      return metadata as unknown as PrMetadata;
    },
    reviews: () => {
      started.push('reviews');
      return Promise.resolve(core.reviewSummary);
    },
    checks: (_client, target) => {
      started.push(`checks:${target.headSha}`);
      return Promise.resolve(checks(target.headSha));
    },
    signals: (_client, requests) => {
      started.push(`signals:${requests[0].headSha}`);
      return Promise.resolve([signals(requests[0].headSha)]);
    },
    now: () => savedAt,
  });
  return { h, started, release, status };
}

void test('starts checks and signals with the expected head', async () => {
  const { h, started, release, status } = speculation(head);
  const read = status.read(h.client, url, false, head);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started.sort(), ['checks:' + head, 'metadata', 'reviews', 'signals:' + head].sort());
  release();
  const result = await read;
  assert.equal(started.length, 4, 'An unchanged head needs no second stage');
  assert.equal(result.status.headSha, head);
  assert.equal(result.status.checkSnapshot?.headSha, head);
  assert.equal(result.status.signals?.headSha, head);
});

void test('discards speculative results when the head moved', async () => {
  const { h, started, release, status } = speculation(otherHead);
  const read = status.read(h.client, url, false, head);
  await new Promise((resolve) => setImmediate(resolve));
  release();
  const result = await read;
  assert.deepEqual(started.slice(4).sort(), [`checks:${otherHead}`, `signals:${otherHead}`]);
  assert.equal(result.status.headSha, otherHead);
  assert.equal(result.status.checkSnapshot?.headSha, otherHead, 'Checks are never labelled with the old head');
  assert.equal(result.status.signals?.headSha, otherHead);
});

void test('a failed speculative read does not fail a moved-head status', async () => {
  const h = harness();
  const status = createPrStatusService({
    metadata: () => Promise.resolve({ headSha: otherHead, baseSha: 'c'.repeat(40), ...core } as unknown as PrMetadata),
    reviews: () => Promise.resolve(core.reviewSummary),
    checks: (_client, target) => Promise.resolve(checks(target.headSha)),
    signals: (_client, requests) =>
      requests[0].headSha === head ? Promise.reject(new Error('old head')) : Promise.resolve([signals(otherHead)]),
    now: () => savedAt,
  });
  const result = await status.read(h.client, url, false, head);
  assert.equal(result.status.signals?.headSha, otherHead);
});

const pullUrl = (n: number) => `https://github.com/o/r/pull/${n}`;
const pull = (overrides: Record<string, unknown> = {}) => ({
  headRefOid: head,
  baseRefOid: 'c'.repeat(40),
  isDraft: true,
  baseRefName: 'release',
  commits: { totalCount: 7 },
  labels: { nodes: [{ name: 'bug' }, { name: 'ui' }] },
  reviewRequests: {
    nodes: [
      { requestedReviewer: { __typename: 'User', login: 'maya' } },
      { requestedReviewer: { __typename: 'Bot', login: 'helper' } },
      { requestedReviewer: { __typename: 'Team', name: 'Platform' } },
    ],
  },
  autoMergeRequest: { mergeMethod: 'SQUASH' },
  milestone: { title: 'v2', dueOn: null },
  reviews: {
    nodes: [
      { state: 'CHANGES_REQUESTED', author: { login: 'ana' } },
      { state: 'APPROVED', author: { login: 'ana' } },
      { state: 'COMMENTED', author: { login: 'li' } },
    ],
  },
  ...overrides,
});
/** Answers each aliased PR from `respond`, optionally after `gate`. */
function preloadHarness(respond: (alias: number) => unknown, gate?: Promise<void>) {
  const queries: string[] = [];
  const pool = createGitHubClientPool({
    fetch: (async (_input: string, init: RequestInit) => {
      const body = JSON.parse(typeof init.body === 'string' ? init.body : '{}') as { query: string };
      queries.push(body.query);
      if (gate) await gate;
      const aliases = [...body.query.matchAll(/\bp(\d+): repository/g)].map((match) => Number(match[1]));
      const data = Object.fromEntries(aliases.map((i) => [`p${i}`, { pullRequest: respond(i) }]));
      return new Response(JSON.stringify({ data: { rateLimit: { cost: 1 }, ...data } }), {
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch,
  });
  const client = pool.client('one');
  const cache = githubCacheFor(client);
  assert.ok(cache);
  return { queries, client, cache };
}

void test('preload saves cores from one query for 25 PRs', async () => {
  const h = preloadHarness(() => pull());
  const status = service(() => savedAt);
  const targets = Array.from({ length: 25 }, (_, i) => ({ url: pullUrl(i + 1), headSha: head }));
  assert.equal((await status.preload(h.client, targets)).length, 25);
  assert.equal(h.queries.length, 1);
  assert.match(h.queries[0], /commits \{ totalCount \}/);
  await assert.rejects(status.preload(h.client, [...targets, { url: pullUrl(26), headSha: head }]));
  h.cache.set(`pr-checks:v1:${pullUrl(25)}@${head}`, { ...checks(head), url: pullUrl(25) });
  h.cache.set(`queue-signals:v3:${pullUrl(25)}@${head}`, { ...signals(head), url: pullUrl(25) });
  const saved = await status.cached(h.client, pullUrl(25), head);
  assert.ok(saved);
  assert.deepEqual(
    {
      labels: saved.labels,
      isDraft: saved.isDraft,
      baseBranch: saved.baseBranch,
      commitCount: saved.commitCount,
      requestedReviewers: saved.requestedReviewers,
      requestedTeams: saved.requestedTeams,
      autoMerge: saved.autoMerge,
      milestone: saved.milestone,
      reviewSummary: saved.reviewSummary,
    },
    {
      labels: ['bug', 'ui'],
      isDraft: true,
      baseBranch: 'release',
      commitCount: 7,
      requestedReviewers: ['maya', 'helper'],
      requestedTeams: ['Platform'],
      autoMerge: { method: 'squash' },
      milestone: { title: 'v2', dueOn: null },
      reviewSummary: { approved: 1, changesRequested: 0, commented: 1 },
    }
  );
  assert.equal(saved.mergeable, null, 'A preloaded copy never reports mergeability');
  assert.equal(saved.ciConclusion, 'failure');
  assert.deepEqual(status.saved(h.client, pullUrl(25)), {
    headSha: head,
    baseSha: 'c'.repeat(40),
    checkedAt: savedAt,
    revalidate: false,
  });
});

void test('preload skips a head mismatch', async () => {
  const h = preloadHarness((i) => (i === 0 ? pull({ headRefOid: otherHead }) : i === 1 ? null : pull()));
  const status = service(() => savedAt);
  const saved = await status.preload(h.client, [1, 2, 3].map((n) => ({ url: pullUrl(n), headSha: head })));
  assert.deepEqual(saved, [pullUrl(3)]);
  assert.equal(status.saved(h.client, pullUrl(1)), undefined, 'A copy for another head is never saved');
  assert.equal(status.saved(h.client, pullUrl(2)), undefined);
});

void test('preload never overwrites a newer copy or saves after a write', async () => {
  const h = preloadHarness(() => pull());
  h.cache.set(`pr-status:v1:${pullUrl(1)}`, { ...saved(), url: pullUrl(1), checkedAt: savedAt + 1 });
  assert.deepEqual(await service(() => savedAt).preload(h.client, [{ url: pullUrl(1), headSha: head }]), []);
  assert.equal(service(() => savedAt).saved(h.client, pullUrl(1))?.checkedAt, savedAt + 1);

  let release!: () => void;
  const gated = preloadHarness(
    () => pull(),
    new Promise<void>((resolve) => (release = resolve))
  );
  const status = service(() => savedAt);
  const loading = status.preload(gated.client, [{ url: pullUrl(1), headSha: head }]);
  await new Promise((resolve) => setImmediate(resolve));
  // A write invalidates the account's cache while the query is in flight.
  gated.cache.invalidate(() => false);
  release();
  assert.deepEqual(await loading, []);
  assert.equal(status.saved(gated.client, pullUrl(1)), undefined);
});

void test('cached waits briefly for an in-flight preload', async () => {
  let release!: () => void;
  const h = preloadHarness(
    () => pull(),
    new Promise<void>((resolve) => (release = resolve))
  );
  const status = service(() => savedAt);
  const loading = status.preload(h.client, [{ url: pullUrl(1), headSha: head }]);
  const opened = status.cached(h.client, pullUrl(1), head);
  setTimeout(release, 20);
  assert.ok(await opened, 'A click during a hover prefetch opens from the new saved copy');
  await loading;

  const stuck = preloadHarness(() => pull(), new Promise<void>(() => {}));
  void status.preload(stuck.client, [{ url: pullUrl(1), headSha: head }]);
  const started = Date.now();
  assert.equal(await status.cached(stuck.client, pullUrl(1), head), undefined);
  const waited = Date.now() - started;
  assert.ok(waited >= 240 && waited < 1000, `Waited ${waited} ms`);
});

void test('summarizeReviews matches the REST reduction', async () => {
  const reviews = [
    { user: { login: 'ana' }, state: 'CHANGES_REQUESTED' },
    { user: { login: 'ana' }, state: 'APPROVED' },
    { user: { login: 'ana' }, state: 'DISMISSED' },
    { user: { login: 'li' }, state: 'COMMENTED' },
    { user: { login: 'li' }, state: 'PENDING' },
    { user: { login: 'kai' }, state: 'CHANGES_REQUESTED' },
    { user: null, state: 'APPROVED' },
  ];
  const octokit = { pulls: { listReviews: () => Promise.resolve({ data: reviews }) } } as unknown as Parameters<
    typeof getReviewStatus
  >[0];
  const rest = await getReviewStatus(octokit, 'o', 'r', 1);
  assert.deepEqual(rest, { approved: 2, changesRequested: 1, commented: 1 });
  assert.deepEqual(
    summarizeReviews(reviews.map((review) => ({ login: review.user?.login ?? 'unknown', state: review.state }))),
    rest
  );
});
