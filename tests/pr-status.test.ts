import test from 'node:test';
import assert from 'node:assert/strict';
import { createGitHubClientPool, githubCacheFor } from '../lib/github-client';
import { createPrStatusService, PR_STATUS_MAX_STALE_MS } from '../src/pr-status-service';
import { readPrChecks } from '../src/pr-checks-service';
import { createQueueSignalsService } from '../src/queue-signals-service';
import type { PrChecks } from '../lib/pr-checks';
import type { QueueSignals } from '../lib/queue-signals';
import type { PrMetadata } from '../lib/types';

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
