import test from 'node:test';
import assert from 'node:assert/strict';
import type { Octokit } from '@octokit/rest';
import { getPrMetadata } from '../lib/github';
import { getPrMetadataBatch, withReviewerOrder } from '../lib/pr-metadata-graphql';
import { answerPrQuery, graphPr, queriedPrs, type RestPull } from './fake-pr-graphql';

const url = (n: number, repo = 'o/r') => `https://github.com/${repo}/pull/${n}`;
const pull = (n: number, repo = 'o/r', extra: Partial<RestPull> = {}): RestPull => ({
  number: n,
  title: `PR ${n}`,
  body: n % 2 ? `Body ${n}` : null,
  user: n % 3 ? { login: 'author' } : { login: 'dependabot[bot]', type: 'Bot' },
  assignees: n % 4 ? [] : [{ login: 'assignee' }],
  base: { ref: 'main', sha: `base-${n}`, repo: { full_name: repo, archived: n === 7 } },
  head: { ref: `branch-${n}`, sha: `head-${n}`, repo: n === 5 ? null : { full_name: n === 6 ? 'fork/r' : repo } },
  merged: n === 8,
  state: n === 8 || n === 9 ? 'closed' : 'open',
  created_at: '2026-11-01T00:00:00Z',
  updated_at: `2026-11-${String(10 + (n % 10)).padStart(2, '0')}T00:00:00Z`,
  html_url: url(n, repo),
  labels: n % 2 ? [{ name: 'bug', color: 'd73a4a', description: 'Something is wrong' }, { name: 'plain', color: null, description: null }] : [],
  mergeable: n % 5 === 0 ? null : n % 5 !== 1,
  draft: n === 3,
  commits: n,
  changed_files: n * 2,
  additions: n * 10,
  deletions: n,
  comments: n % 3,
  review_comments: n % 4,
  requested_reviewers: n % 2 ? [{ login: 'alice' }, { login: 'copilot[bot]', type: 'Bot' }] : [],
  requested_teams: n % 2 ? [{ name: 'Platform' }] : [],
  mergeable_state: ['clean', 'blocked', 'dirty', 'unstable', 'behind', 'draft', 'unknown'][n % 7],
  auto_merge: n === 4 ? { merge_method: 'squash' } : null,
  milestone: n === 2 ? { title: 'v1', due_on: '2026-12-01T08:00:00Z' } : null,
  ...extra,
});

function fixture(prs: RestPull[], options: { graphql?: (query: string) => Promise<unknown> } = {}) {
  const counts = { graphql: 0, rest: 0, prsPerQuery: [] as number[] };
  const find = (owner: string, repo: string, number: number) => prs.find((p) => p.html_url === url(number, `${owner}/${repo}`));
  const octokit = {
    graphql: (query: string) => {
      counts.graphql++;
      counts.prsPerQuery.push(queriedPrs(query).length);
      return options.graphql ? options.graphql(query) : Promise.resolve(answerPrQuery(query, find));
    },
    pulls: {
      get: ({ owner, repo, pull_number }: { owner: string; repo: string; pull_number: number }) => {
        counts.rest++;
        const pr = find(owner, repo, pull_number);
        return pr ? Promise.resolve({ data: pr }) : Promise.reject(Object.assign(new Error('Not Found'), { status: 404 }));
      },
    },
  } as unknown as Octokit;
  return { octokit, counts };
}

void test('batched PR metadata equals the REST read field for field, 25 PRs per query', async () => {
  const prs = [...Array.from({ length: 28 }, (_, i) => pull(i + 1)), pull(1, 'other/repo')];
  const rest = fixture(prs);
  const expected = await Promise.all(prs.map((p) => getPrMetadata(rest.octokit, ...(p.html_url.split('/').slice(3, 5) as [string, string]), p.number)));
  assert.equal(rest.counts.rest, 29);

  const batched = fixture(prs);
  const result = await getPrMetadataBatch(batched.octokit, prs.map((p) => p.html_url));
  assert.equal(batched.counts.rest, 0);
  assert.deepEqual(batched.counts.prsPerQuery, [25, 4]);
  for (const [i, p] of prs.entries()) {
    const value = result.get(p.html_url);
    assert.ok(value && 'metadata' in value, p.html_url);
    assert.deepEqual(value.metadata, expected[i], p.html_url);
  }
  // The mapped details that differ in GraphQL: bots, deleted forks, uppercase enums.
  const meta = (n: number) => (result.get(url(n)) as { metadata: Awaited<ReturnType<typeof getPrMetadata>> }).metadata;
  assert.equal(meta(3).author, 'dependabot[bot]');
  assert.deepEqual(meta(1).requestedReviewers, ['alice', 'copilot[bot]']);
  assert.equal(meta(5).headRepo, 'o/r');
  assert.equal(meta(4).autoMerge?.method, 'squash');
  assert.equal(meta(2).mergeableState, 'dirty');
  assert.equal(meta(8).state, 'closed');
  assert.equal(meta(8).merged, true);
});

void test('a PR GraphQL cannot answer exactly, or a failed query, is read through REST', async () => {
  const prs = Array.from({ length: 4 }, (_, i) => pull(i + 1));
  // More than 100 labels: GraphQL returns the first page only.
  const many = fixture(prs, {
    graphql: (query) => {
      const data = answerPrQuery(query, (_o, _r, n) => prs[n - 1]) as Record<string, { pullRequest: ReturnType<typeof graphPr> }>;
      data.p1.pullRequest.labels.totalCount = 101;
      return Promise.resolve(data);
    },
  });
  const result = await getPrMetadataBatch(many.octokit, prs.map((p) => p.html_url));
  assert.equal(many.counts.graphql, 1);
  assert.equal(many.counts.rest, 1, 'only the incomplete PR');
  assert.ok([...result.values()].every((value) => 'metadata' in value));

  const failing = fixture(prs, { graphql: () => Promise.reject(Object.assign(new Error('Bad gateway'), { status: 502 })) });
  const fallback = await getPrMetadataBatch(failing.octokit, prs.map((p) => p.html_url));
  assert.equal(failing.counts.rest, 4);
  assert.ok([...fallback.values()].every((value) => 'metadata' in value));
});

void test('a PR GitHub does not return fails alone, as a 404 would', async () => {
  const prs = [pull(1), pull(2)];
  const f = fixture(prs);
  const result = await getPrMetadataBatch(f.octokit, [url(1), url(99), url(2)]);
  assert.ok('metadata' in (result.get(url(1)) ?? {}));
  assert.ok('metadata' in (result.get(url(2)) ?? {}));
  const missing = result.get(url(99));
  assert.ok(missing && 'error' in missing);
  assert.equal((missing.error as { status?: number }).status, 404);
  assert.equal(f.counts.rest, 0);
});

void test('a saved reviewer order survives a read that lists the same reviewers differently', () => {
  const next = { requestedReviewers: ['b', 'a'], requestedTeams: ['x'] } as Parameters<typeof withReviewerOrder>[0];
  assert.deepEqual(withReviewerOrder(next, { requestedReviewers: ['a', 'b'], requestedTeams: ['x'] }).requestedReviewers, ['a', 'b']);
  assert.deepEqual(withReviewerOrder(next, { requestedReviewers: ['a', 'c'] }).requestedReviewers, ['b', 'a']);
  assert.equal(withReviewerOrder(next, {}), next);
});
