import test from 'node:test';
import assert from 'node:assert/strict';
import type { Octokit } from '@octokit/rest';
import { getPrMetadata } from '../lib/github';
import { getPrMetadataBatch, prMetadataFromGraph, readMetadataLike, type GraphPrMetadata } from '../lib/pr-metadata-graphql';
import { GITHUB_WRITE_EFFECTS } from '../lib/github-write-refresh';
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
  requested_reviewers: n % 2 ? [{ login: 'zed' }, { login: 'Alice' }, { login: 'renovate[bot]', type: 'Bot' }] : [],
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
    assert.equal(value.metadata.source, 'graphql');
    assert.equal(expected[i].source, 'rest');
    assert.deepEqual({ ...value.metadata, source: undefined }, { ...expected[i], source: undefined }, p.html_url);
  }
  // The mapped details that differ in GraphQL: bots, deleted forks, uppercase enums.
  const meta = (n: number) => (result.get(url(n)) as { metadata: Awaited<ReturnType<typeof getPrMetadata>> }).metadata;
  assert.equal(meta(3).author, 'dependabot[bot]');
  assert.deepEqual(meta(1).requestedReviewers, ['Alice', 'renovate[bot]', 'zed'], 'sorted in both readers');
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

void test('an alias with an error under it, even on a nested field, is read through REST', async () => {
  const prs = [pull(1), pull(6), pull(3)];
  // GitHub nulls a field it could not resolve and names it in `errors`; the rest of the answer stands.
  const partial = fixture(prs, {
    graphql: (query) => {
      const data = answerPrQuery(query, (_o, _r, n) => prs.find((p) => p.number === n)) as Record<string, { pullRequest: Record<string, unknown> }>;
      data.p1.pullRequest.headRepository = null;
      return Promise.reject(
        Object.assign(new Error('Request failed due to following response errors'), {
          data,
          errors: [{ message: 'Resource not accessible', path: ['p1', 'pullRequest', 'headRepository'] }],
        })
      );
    },
  });
  const result = await getPrMetadataBatch(partial.octokit, prs.map((p) => p.html_url));
  assert.equal(partial.counts.rest, 1, 'only the PR with the error');
  const fork = result.get(url(6));
  assert.ok(fork && 'metadata' in fork);
  assert.equal(fork.metadata.headRepo, 'fork/r', 'the REST value, not the nulled one');
  assert.equal(fork.metadata.source, 'rest');
});

void test('Copilot identities map to REST logins, and an unknown one is read through REST', async () => {
  const copilot = pull(11, 'o/r', {
    user: { login: 'Copilot', type: 'Bot' },
    requested_reviewers: [{ login: 'Copilot', type: 'Bot' }, { login: 'alice' }],
  });
  const graph = (login: (rest: string, role: 'author' | 'reviewer') => string) => (query: string) => {
    const data = answerPrQuery(query, () => copilot) as Record<string, { pullRequest: ReturnType<typeof graphPr> }>;
    const pr = data.p0.pullRequest;
    pr.author = { __typename: 'Bot', login: login('Copilot', 'author') };
    pr.reviewRequests.nodes[0] = { requestedReviewer: { __typename: 'Bot', login: login('Copilot', 'reviewer') } };
    return Promise.resolve(data);
  };
  const expected = await getPrMetadata(fixture([copilot]).octokit, 'o', 'r', 11);
  const known = fixture([copilot], { graphql: graph((_, role) => (role === 'author' ? 'copilot-swe-agent' : 'copilot-pull-request-reviewer')) });
  const mapped = (await getPrMetadataBatch(known.octokit, [url(11)])).get(url(11));
  assert.ok(mapped && 'metadata' in mapped);
  assert.equal(known.counts.rest, 0);
  const value = mapped.metadata;
  assert.deepEqual({ ...value, source: undefined }, { ...expected, source: undefined });
  assert.equal(value.author, 'Copilot');
  assert.deepEqual(value.requestedReviewers, ['alice', 'Copilot']);

  const unknown = fixture([copilot], { graphql: graph(() => 'copilot-new-agent') });
  const fallback = (await getPrMetadataBatch(unknown.octokit, [url(11)])).get(url(11));
  assert.ok(fallback && 'metadata' in fallback);
  assert.equal(unknown.counts.rest, 1, 'an unknown Copilot login is not guessed');
  assert.equal(fallback.metadata.author, 'Copilot');
});

void test('a write is checked against the source of its baseline, so a lagging REST count cannot hide it', async () => {
  // GitHub has the new reply (8 review comments); REST's counter still says 7.
  const after = pull(1, 'o/r', { review_comments: 8 });
  const lagging = { ...after, review_comments: 7 };
  const octokit = {
    graphql: (query: string) => Promise.resolve(answerPrQuery(query, () => after)),
    pulls: { get: () => Promise.resolve({ data: lagging }) },
  } as unknown as Octokit;
  const rest = () => getPrMetadata(octokit, 'o', 'r', 1, true);
  const replySeen = GITHUB_WRITE_EFFECTS['thread-reply'].seen;
  const deleteSeen = GITHUB_WRITE_EFFECTS['comment-delete'].seen;
  assert.ok(replySeen && deleteSeen);
  // The baseline came from GraphQL (7 before the reply): the probe reads GraphQL too and sees 8.
  const graphBaseline = { ...(await rest()), reviewCommentCount: 7, source: 'graphql' as const };
  const probe = await readMetadataLike(octokit, url(1), graphBaseline, rest);
  assert.equal(probe.reviewCommentCount, 8);
  assert.ok(replySeen({ metadata: probe }, { before: { metadata: graphBaseline } }));
  // Mixing sources would compare GraphQL's 7 with REST's lagging 7 and miss the reply.
  assert.ok(!replySeen({ metadata: await rest() }, { before: { metadata: graphBaseline } }));
  // A REST baseline is probed through REST.
  const restBaseline = { ...(await rest()), reviewCommentCount: 6 };
  assert.equal((await readMetadataLike(octokit, url(1), restBaseline, rest)).source, 'rest');
  // A delete settles the same way: GraphQL 8 before, 7 after.
  const deleted = { ...graphBaseline, reviewCommentCount: 8 };
  assert.ok(deleteSeen({ metadata: { ...probe, reviewCommentCount: 7 } }, { before: { metadata: deleted } }));
});

void test('a REST update spread over a GraphQL copy makes the write refresh probe REST', async () => {
  const pr = pull(1);
  let graphql = 0,
    rest = 0;
  const octokit = {
    graphql: (query: string) => {
      graphql++;
      return Promise.resolve(answerPrQuery(query, () => pr));
    },
    pulls: {
      get: () => {
        rest++;
        return Promise.resolve({ data: pr });
      },
    },
  } as unknown as Octokit;
  const fromGraph = (await getPrMetadataBatch(octokit, [url(1)])).get(url(1));
  assert.ok(fromGraph && 'metadata' in fromGraph);
  // A member from discovery (GraphQL), then a sync update read through REST.
  const member = { ...fromGraph.metadata, role: 'watched' };
  const synced = { ...member, ...(await getPrMetadata(octokit, 'o', 'r', 1, true)) };
  assert.equal(synced.source, 'rest', 'the REST copy does not keep the GraphQL tag');
  graphql = rest = 0;
  await readMetadataLike(octokit, url(1), synced, () => getPrMetadata(octokit, 'o', 'r', 1, true));
  assert.deepEqual({ graphql, rest }, { graphql: 0, rest: 1 });
});

void test('an assignee GraphQL leaves out sends the PR to REST', async () => {
  // Checked on public Copilot-agent PRs: `assignees` lists Copilot as REST does. Another actor it leaves out shows
  // only as a larger `assignedActors` count.
  const pr = pull(4, 'o/r', { assignees: [{ login: 'alice' }, { login: 'Copilot' }] });
  const ok = fixture([pr]);
  const read = (await getPrMetadataBatch(ok.octokit, [url(4)])).get(url(4));
  assert.ok(read && 'metadata' in read);
  assert.deepEqual(read.metadata.assignees, ['alice', 'Copilot']);
  assert.equal(ok.counts.rest, 0);
  const missing = fixture([pr], {
    graphql: (query) => {
      const data = answerPrQuery(query, () => pr) as Record<string, { pullRequest: ReturnType<typeof graphPr> }>;
      data.p0.pullRequest.assignedActors = { totalCount: 3 };
      return Promise.resolve(data);
    },
  });
  await getPrMetadataBatch(missing.octokit, [url(4)]);
  assert.equal(missing.counts.rest, 1);
});

void test('a rate limit stops the metadata batch instead of falling back to REST', async () => {
  const prs = Array.from({ length: 6 }, (_, i) => pull(i + 1));
  const limit = () =>
    Object.assign(new Error('API rate limit exceeded'), {
      status: 403,
      response: { headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.ceil(Date.now() / 1000) + 60) } },
    });
  const graphLimited = fixture(prs, { graphql: () => Promise.reject(limit()) });
  await assert.rejects(getPrMetadataBatch(graphLimited.octokit, prs.map((p) => p.html_url)), /rate limit|requests can resume/i);
  assert.equal(graphLimited.counts.rest, 0, 'no REST reads after a GraphQL rate limit');

  // The REST fallback stops at its first rate limit; the PRs it did not reach report that limit.
  let restReads = 0;
  const failing = fixture(prs, { graphql: () => Promise.reject(Object.assign(new Error('Bad gateway'), { status: 502 })) });
  const octokit = Object.assign(Object.create(failing.octokit) as Octokit, {
    pulls: {
      get: () => {
        restReads++;
        return Promise.reject(limit());
      },
    },
  });
  const result = await getPrMetadataBatch(octokit, prs.map((p) => p.html_url));
  assert.ok(restReads <= 5, `at most one wave of REST reads ran (${restReads})`);
  assert.ok([...result.values()].every((value) => 'error' in value));
});

void test('a probe GraphQL cannot answer exactly is inconclusive against a GraphQL baseline', async () => {
  // More than 100 labels: GraphQL hands this PR to REST, whose counter happens to read lower (a lag) or higher.
  const pr = pull(1);
  let restCount = 6;
  const octokit = {
    graphql: (query: string) => {
      const data = answerPrQuery(query, () => pr) as Record<string, { pullRequest: ReturnType<typeof graphPr> }>;
      data.p0.pullRequest.labels.totalCount = 101;
      return Promise.resolve(data);
    },
    pulls: { get: () => Promise.resolve({ data: { ...pr, review_comments: restCount } }) },
  } as unknown as Octokit;
  const rest = () => getPrMetadata(octokit, 'o', 'r', 1, true);
  const baseline = { ...(await rest()), reviewCommentCount: 7, source: 'graphql' as const };
  const probe = await readMetadataLike(octokit, url(1), baseline, rest);
  assert.equal(probe.source, 'rest');
  const deleteSeen = GITHUB_WRITE_EFFECTS['comment-delete'].seen;
  const replySeen = GITHUB_WRITE_EFFECTS['thread-reply'].seen;
  assert.ok(deleteSeen && replySeen);
  // REST's 6 < GraphQL's 7 would look like a delete, but it is only REST lagging: not settled.
  assert.ok(!deleteSeen({ metadata: probe }, { before: { metadata: baseline } }));
  restCount = 9;
  assert.ok(!replySeen({ metadata: await readMetadataLike(octokit, url(1), baseline, rest) }, { before: { metadata: baseline } }));
  // Same-source copies still settle.
  assert.ok(replySeen({ metadata: { ...baseline, reviewCommentCount: 8 } }, { before: { metadata: baseline } }));
});

void test('a missing PR, as GitHub answers it (null plus NOT_FOUND at the field), is a 404 without a REST read', async () => {
  const prs = [pull(1)];
  const f = fixture(prs, {
    graphql: (query) => {
      const data = answerPrQuery(query, (_o, _r, n) => prs.find((p) => p.number === n));
      // The shape of a live answer for a PR number that does not exist.
      return Promise.reject(
        Object.assign(new Error('Could not resolve to a PullRequest with the number of 99.'), {
          data,
          errors: [{ type: 'NOT_FOUND', path: ['p1', 'pullRequest'], message: 'Could not resolve to a PullRequest with the number of 99.' }],
        })
      );
    },
  });
  const result = await getPrMetadataBatch(f.octokit, [url(1), url(99)]);
  const missing = result.get(url(99));
  assert.ok(missing && 'error' in missing);
  assert.equal((missing.error as { status?: number }).status, 404);
  assert.ok('metadata' in (result.get(url(1)) ?? {}));
  assert.equal(f.counts.rest, 0, 'the missing PR costs no REST read');
});

void test('a deleted head branch reads as headRefDeleted from GraphQL; unknown stays absent (#468)', () => {
  const merged = graphPr(pull(8)) as unknown as GraphPrMetadata;
  assert.equal(prMetadataFromGraph({ ...merged, headRef: null })?.headRefDeleted, true);
  assert.equal(prMetadataFromGraph({ ...merged, headRef: { id: 'ref' } })?.headRefDeleted, false);
  assert.equal(prMetadataFromGraph(merged)?.headRefDeleted, undefined);
});
