import { githubCacheFor } from '../lib/github-client';
import { createCheckDetailsPreloader } from '../src/check-details-preloader';
import { withGitHubPriority, githubPriority } from '../lib/github-scheduler';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGitHubClientPool } from './cache-test-pool';
import { readCommitChecks } from '../lib/github-checks';
import {
  readPrChecks,
  readCurrentPrChecks,
  readPrChecksBatch,
  readCheckDetails,
  cachedCheckDetails,
  withCachedCheckDetails,
  readCheckLog,
  rerunChecks,
} from '../src/pr-checks-service';
import { CheckHeadChanged } from '../src/pr-checks-graphql';
import { checkSummary, checkCounts, orderedChecks, checkDuration, type PrCheck } from '../lib/pr-checks';
const sha = 'a'.repeat(40),
  url = 'https://github.com/o/r/pull/1';
const input = { url, headSha: sha, id: 'check:1' };
const run = {
  id: 1,
  node_id: 'CR_1',
  name: 'Tests',
  status: 'completed',
  conclusion: 'failure',
  head_sha: sha,
  app: { name: 'GitHub Actions', slug: 'github-actions' },
  html_url: 'https://github.com/o/r/actions/runs/9/job/10',
  output: { title: 'Tests failed', summary: 'One failure', text: '', annotations_count: 1 },
  started_at: '2026-10-27T10:00:00Z',
  completed_at: '2026-10-27T10:02:00Z',
};
function graphResponse(body: string) {
  const query = (JSON.parse(body) as { query: string }).query;
  return Object.fromEntries(
    [...query.matchAll(/p(\d+): repository/g)].map((match) => [
      `p${match[1]}`,
      {
        pullRequest: {
          headRefOid: sha,
          commits: {
            nodes: [
              {
                commit: {
                  oid: sha,
                  statusCheckRollup: {
                    contexts: {
                      nodes: [
                        {
                          __typename: 'CheckRun',
                          id: 'CR_1',
                          databaseId: 1,
                          name: 'Tests',
                          status: 'COMPLETED',
                          conclusion: 'FAILURE',
                          isRequired: true,
                          detailsUrl: run.html_url,
                          url: run.html_url,
                          startedAt: run.started_at,
                          completedAt: run.completed_at,
                          checkSuite: { app: { name: 'GitHub Actions' } },
                        },
                      ],
                      pageInfo: { hasNextPage: false, endCursor: null },
                    },
                  },
                },
              },
            ],
          },
        },
      },
    ])
  );
}
function harness(overrides: (path: string, init: RequestInit) => Response | undefined = () => undefined) {
  const calls: { path: string; method: string; priority: string }[] = [];
  const json = (value: unknown, headers?: Record<string, string>) =>
    new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json', ...headers } });
  const pool = createGitHubClientPool({
    fetch: ((address: string, init: RequestInit) => {
      const p = new URL(address).pathname + new URL(address).search;
      calls.push({ path: p, method: init.method ?? 'GET', priority: githubPriority() });
      const respond = (response: Response) => {
        Object.defineProperty(response, 'url', { value: address });
        return Promise.resolve(response);
      };
      const overridden = overrides(p, init);
      if (overridden) return respond(overridden);
      let data: unknown;
      if (p.includes('/check-runs?')) data = { total_count: 1, check_runs: [run] };
      else if (p.includes('/statuses?')) data = [];
      else if (p === '/graphql') data = { data: graphResponse(typeof init.body === 'string' ? init.body : '') };
      else if (p.includes('/check-runs/1/annotations'))
        data = [
          {
            path: 'src/main.ts',
            start_line: 12,
            end_line: 12,
            annotation_level: 'failure',
            title: 'Type mismatch',
            message: 'Expected string',
          },
        ];
      else if (p === '/repos/o/r/check-runs/1') data = run;
      else if (p === '/repos/o/r/actions/jobs/10')
        data = {
          id: 10,
          run_id: 9,
          run_attempt: 1,
          status: 'completed',
          conclusion: run.conclusion,
          started_at: run.started_at,
          completed_at: run.completed_at,
          steps: [],
        };
      else if (p === '/repos/o/r') data = { permissions: { push: true } };
      else if (p === '/repos/o/r/pulls/1') data = { head: { sha } };
      else if (p === '/repos/o/r/actions/runs/9') data = { head_sha: sha, status: 'completed' };
      else if (p.endsWith('/rerun') || p.endsWith('/rerun-failed-jobs'))
        return respond(new Response(null, { status: 201 }));
      else throw Error(`Unexpected ${p}`);
      return respond(json(data));
    }) as typeof fetch,
  });
  return { client: pool.client('fixture'), pool, calls, json };
}
void test('check lists paginate and keep duplicate job names and only latest external status', async () => {
  const h = harness((p) => {
    if (p.includes('/check-runs?'))
      return new Response(
        JSON.stringify({ total_count: 2, check_runs: [{ ...run, id: p.includes('page=2') ? 2 : 1 }] }),
        {
          headers: {
            'content-type': 'application/json',
            ...(p.includes('page=2')
              ? {}
              : { link: '<https://api.github.com/repos/o/r/commits/' + sha + '/check-runs?page=2>; rel="next"' }),
          },
        }
      );
    if (p.includes('/statuses?'))
      return new Response(
        JSON.stringify([
          { id: 3, context: 'Buildkite', state: 'success' },
          { id: 2, context: 'Buildkite', state: 'failure' },
        ]),
        { headers: { 'content-type': 'application/json' } }
      );
  });
  const result = await readCommitChecks(h.client, 'o', 'r', sha);
  assert.equal(result.checks.length, 3);
  assert.deepEqual(
    result.checks.map((c) => c.id),
    ['check:1', 'check:2', 'status:3']
  );
  assert.equal(result.conclusion, 'failure');
});
void test('requirements are confirmed, cached reads make no requests, and list refresh coalesces', async () => {
  const h = harness();
  assert.equal(await readPrChecks(h.client, input, { cachedOnly: true }), undefined);
  assert.equal(h.calls.length, 0);
  const [a, b] = await Promise.all([readPrChecks(h.client, input), readPrChecks(h.client, input)]);
  assert.equal(a, b);
  assert.equal(a?.checks[0].required, true);
  const count = h.calls.length;
  assert.deepEqual(await readPrChecks(h.client, input), a);
  assert.deepEqual(await readPrChecks(h.client, input, { cachedOnly: true }), a);
  assert.equal(h.calls.length, count);
  assert.equal(await readPrChecks(h.pool.client('another-account'), input, { cachedOnly: true }), undefined);
});
void test('unknown requirements preserve usable partial GraphQL results', async () => {
  const h = harness((p, init) => {
    if (p !== '/graphql') return;
    const data = graphResponse(typeof init.body === 'string' ? init.body : '');
    const node = data.p0.pullRequest.commits.nodes[0].commit.statusCheckRollup.contexts.nodes[0];
    Object.assign(node, { isRequired: null });
    return new Response(
      JSON.stringify({ data, errors: [{ message: 'Unavailable', path: ['p0', 'pullRequest', 'isRequired'] }] }),
      { headers: { 'content-type': 'application/json' } }
    );
  });
  const value = await readPrChecks(h.client, input);
  assert.equal(value?.checks[0].required, null);
  assert.match(value.warning ?? '', /could not confirm/);
});
void test('detail is tied to its commit and includes annotations without downloading logs', async () => {
  const h = harness();
  const detail = await readCheckDetails(h.client, input);
  assert.equal(detail.job?.canRerun, true);
  assert.equal(detail.annotations[0].startLine, 12);
  assert.ok(!h.calls.some((c) => c.path.includes('/logs')));
  await assert.rejects(readCheckDetails(h.client, { ...input, headSha: 'b'.repeat(40) }), /different commit/);
});
void test('job details preserve step timing and replace an outdated queued check state', async () => {
  const step = {
    name: 'Install',
    number: 2,
    status: 'in_progress',
    conclusion: null,
    started_at: run.started_at,
    completed_at: null,
  };
  const h = harness((p) => {
    const value =
      p === '/repos/o/r/check-runs/1'
        ? { ...run, status: 'queued', conclusion: null }
        : p === '/repos/o/r/actions/jobs/10'
          ? {
              id: 10,
              run_id: 9,
              status: 'in_progress',
              conclusion: null,
              started_at: run.started_at,
              completed_at: null,
              steps: [step],
            }
          : undefined;
    return value ? new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } }) : undefined;
  });
  const detail = await readCheckDetails(h.client, input);
  assert.equal(detail.state?.status, 'in_progress');
  assert.equal(detail.state.conclusion, null);
  assert.equal(detail.job?.steps[0].startedAt, step.started_at);
  assert.equal(detail.job.steps[0].completedAt, null);
});
void test('step timing advances only running steps and keeps completed durations fixed', () => {
  const startedAt = '2026-10-31T10:00:00Z';
  const now = Date.parse(startedAt) + 125_000;
  assert.equal(checkDuration({ status: 'in_progress', startedAt }, now), '2m 5s');
  assert.equal(checkDuration({ status: 'in_progress', startedAt }, now + 1000), '2m 6s');
  assert.equal(checkDuration({ status: 'completed', startedAt, completedAt: '2026-10-31T10:00:03Z' }, now), '3s');
  assert.equal(checkDuration({ status: 'in_progress', startedAt }, now + 3_600_000), '1h 2m 5s');
  for (const value of [
    { status: 'pending', startedAt },
    { status: 'completed', startedAt },
    { status: 'in_progress', startedAt: 'invalid' },
    { status: 'in_progress', startedAt: '2026-11-01T00:00:00Z' },
  ])
    assert.equal(checkDuration(value, now), '');
});
void test('reruns reject newer commits or a running workflow and never replay a write', async () => {
  for (const state of ['new-head', 'running']) {
    const h = harness((p) =>
      p === '/repos/o/r/actions/runs/9'
        ? new Response(
            JSON.stringify({
              head_sha: state === 'new-head' ? 'b'.repeat(40) : sha,
              status: state === 'running' ? 'in_progress' : 'completed',
            }),
            { headers: { 'content-type': 'application/json' } }
          )
        : undefined
    );
    await assert.rejects(
      rerunChecks(h.client, { ...input, mode: 'failed' }),
      state === 'running' ? /already queued/ : /New commits/
    );
    assert.ok(!h.calls.some((c) => c.method === 'POST'));
  }
  for (const mode of ['all', 'failed'] as const) {
    const h = harness();
    await rerunChecks(h.client, { ...input, mode });
    assert.equal(h.calls.filter((c) => c.method === 'POST').length, 1);
    assert.ok(h.calls.at(-1)?.path.endsWith(mode === 'all' ? '/rerun' : '/rerun-failed-jobs'));
  }
});
void test('logs reject unrelated signed hosts and do not forward credentials', async () => {
  const h = harness((p) =>
    p.endsWith('/logs')
      ? new Response(null, { status: 302, headers: { location: 'https://evil.example/log' } })
      : undefined
  );
  await assert.rejects(readCheckLog(h.client, input), /Open GitHub/);
});
void test('all terminal attention states rank ahead of running, passed, and neutral checks', () => {
  const checks = ['success', 'neutral', 'failure', 'timed_out', 'cancelled', 'action_required', null].map(
    (conclusion, i) =>
      ({ id: `check:${i}`, name: String(i), status: conclusion ? 'completed' : 'queued', conclusion }) as PrCheck
  );
  assert.deepEqual(checkCounts(checks), { attention: 4, running: 1, passed: 1, skipped: 1 });
  assert.deepEqual(
    orderedChecks(checks, 'attention').map((c) => c.conclusion),
    ['failure', 'timed_out', 'cancelled', 'action_required']
  );
  assert.equal(orderedChecks(checks, 'all')[4].status, 'queued');
});

void test('job logs use an unauthenticated bounded download and strip terminal escapes', async () => {
  const h = harness((p) =>
    p.endsWith('/logs')
      ? new Response(null, { status: 302, headers: { location: 'https://logs.blob.core.windows.net/job' } })
      : undefined
  );
  const original = globalThis.fetch;
  let cancelled = false;
  globalThis.fetch = ((_url: unknown, options: RequestInit) => {
    assert.equal(options.headers, undefined);
    assert.equal(options.redirect, 'error');
    return Promise.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                String.fromCharCode(27) + '[31mFAIL' + String.fromCharCode(27) + '[0m' + 'x'.repeat(2_100_000)
              )
            );
          },
          cancel() {
            cancelled = true;
          },
        })
      )
    );
  }) as typeof fetch;
  try {
    const log = await readCheckLog(h.client, input);
    assert.equal(log.truncated, true);
    assert.ok(log.text.startsWith('FAIL'));
    assert.ok(log.text.length <= 2_000_000);
    assert.equal(log.text.includes(String.fromCharCode(27)), false);
    assert.equal(cancelled, true);
  } finally {
    globalThis.fetch = original;
  }
});

void test('compact check outcomes explain skipped and neutral results without implying failure', () => {
  const checks = (conclusions: string[]) =>
    conclusions.map((conclusion) => ({ name: conclusion, status: 'completed' as const, conclusion, url: '' }));
  assert.equal(checkSummary(checks(['success', 'success', 'skipped'])), '2 passed · 1 skipped');
  assert.equal(checkSummary(checks(['success', 'neutral'])), '1 passed · 1 neutral');
  assert.equal(checkSummary(checks(['success', 'failure'])), '1 check needs attention');
  assert.equal(checkSummary([]), 'No checks reported');
});

void test('bulk reruns group failed and cancelled jobs by workflow and exclude running or stale results', async () => {
  const { checkRerunPlan } = await import('../lib/check-rerun-plan');
  const member = { url, headSha: sha, number: 1 } as import('../lib/workbench').ReviewMember;
  const check = (id: number, run: number, conclusion: string | null, extra: Partial<PrCheck> = {}): PrCheck => ({
    id: `check:${id}`,
    databaseId: id,
    kind: 'check',
    provider: 'github-actions',
    name: `Job ${id}`,
    status: conclusion ? 'completed' : 'in_progress',
    conclusion,
    required: false,
    startedAt: '2026-10-31T10:00:00Z',
    completedAt: '2026-10-31T10:01:00Z',
    url: `https://github.com/o/r/actions/runs/${run}/job/${id}`,
    ...extra,
  });
  const snapshot = {
    url,
    headSha: sha,
    checkedAt: Date.now(),
    checks: [
      check(1, 9, 'failure'),
      check(2, 9, 'cancelled'),
      check(3, 9, 'success'),
      check(4, 10, 'failure'),
      check(5, 11, 'cancelled'),
      check(6, 11, null),
      check(7, 12, 'skipped'),
      check(8, 13, 'failure', { provider: 'other' }),
      check(9, 14, 'failure', { url: 'https://github.com/other/repo/actions/runs/14/job/9' }),
    ],
  };
  const plan = checkRerunPlan([member], { [url]: snapshot });
  assert.deepEqual(
    plan.map((p) => [p.names, p.mode]),
    [
      [['Job 1', 'Job 2'], 'all'],
      [['Job 4'], 'failed'],
    ]
  );
  assert.equal(checkRerunPlan([member], { [url]: { ...snapshot, headSha: 'b'.repeat(40) } }).length, 0);
  assert.equal(checkRerunPlan([member], {}).length, 0);
  assert.equal(
    checkRerunPlan([member, { ...member, url: url + '2' }], {
      [url]: snapshot,
      [url + '2']: { ...snapshot, url: url + '2' },
    }).length,
    2
  );
  const later = { ...snapshot, checks: snapshot.checks.map((c) => ({ ...c, completedAt: '2026-10-31T11:01:00Z' })) };
  assert.notEqual(checkRerunPlan([member], { [url]: later })[0].revision, plan[0].revision);
});

void test('stack checks share one GraphQL request with requirements and no REST reads', async () => {
  const h = harness();
  const inputs = Array.from({ length: 4 }, (_, i) => ({ url: `https://github.com/o/r/pull/${i + 1}`, headSha: sha }));
  const [results, shared] = await Promise.all([
    readPrChecksBatch(h.client, inputs, { force: true }),
    readPrChecks(h.client, inputs[0], { force: true }),
  ]);
  assert.equal(results.length, 4);
  assert.ok(results.every((value) => value.checks[0].required));
  assert.deepEqual(shared, results[0]);
  assert.equal(h.calls.filter((c) => c.path !== '/graphql').length, 0, 'Check lists must not spend the REST budget');
  assert.equal(h.calls.filter((c) => c.path === '/graphql').length, 1);
});

void test('GraphQL check pages retain every check, external status, and required flag', async () => {
  let pages = 0;
  const h = harness((p, init) => {
    if (p !== '/graphql') return;
    pages++;
    const data = graphResponse(typeof init.body === 'string' ? init.body : '');
    const connection = data.p0.pullRequest.commits.nodes[0].commit.statusCheckRollup.contexts;
    if (pages === 1) Object.assign(connection.pageInfo, { hasNextPage: true, endCursor: 'next' });
    else {
      assert.match(typeof init.body === 'string' ? init.body : '', /next/);
      Object.assign(connection, {
        nodes: [
          {
            __typename: 'StatusContext',
            id: 'SC_2',
            context: 'External CI',
            state: 'PENDING',
            isRequired: false,
            creator: null,
            createdAt: run.started_at,
            updatedAt: run.completed_at,
            targetUrl: 'https://ci.example/result',
            description: 'Queued',
          },
        ],
      });
    }
    return new Response(JSON.stringify({ data }), { headers: { 'content-type': 'application/json' } });
  });
  const result = await readPrChecks(h.client, input);
  assert.equal(pages, 2);
  assert.equal(result?.checks.length, 2);
  assert.equal(result.checks[0].required, true);
  assert.equal(result.checks[1].kind, 'status');
  assert.equal(result.checks[1].status, 'in_progress');
  assert.equal(result.checks[1].required, false);
});

void test('head changes and page failures never overwrite a complete cached snapshot', async () => {
  let scenario = 'ok';
  let page = 0;
  const h = harness((p, init) => {
    if (p !== '/graphql') return;
    const data = graphResponse(typeof init.body === 'string' ? init.body : '');
    if (scenario === 'new-head') data.p0.pullRequest.headRefOid = 'b'.repeat(40);
    if (scenario === 'pagination') {
      if (page++)
        return new Response(JSON.stringify({ message: 'Offline' }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        });
      Object.assign(data.p0.pullRequest.commits.nodes[0].commit.statusCheckRollup.contexts.pageInfo, {
        hasNextPage: true,
        endCursor: 'next',
      });
    }
    return new Response(JSON.stringify({ data }), { headers: { 'content-type': 'application/json' } });
  });
  const original = await readPrChecks(h.client, input);
  scenario = 'new-head';
  await assert.rejects(readPrChecks(h.client, input, { force: true }), /New commits/);
  assert.deepEqual(await readPrChecks(h.client, input, { cachedOnly: true }), original);
  scenario = 'pagination';
  await assert.rejects(readPrChecks(h.client, input, { force: true }), /Offline/);
  assert.deepEqual(await readPrChecks(h.client, input, { cachedOnly: true }), original);
});

void test('uses the supplied head without a metadata read', async () => {
  const h = harness();
  const heads: boolean[] = [];
  const value = await readCurrentPrChecks(h.client, { url, headSha: sha }, {}, (fresh) => {
    heads.push(fresh);
    return Promise.resolve(sha);
  });
  assert.equal(value?.headSha, sha);
  assert.deepEqual(heads, [], 'The checks query verifies the head itself');
  assert.deepEqual(
    h.calls.map((call) => call.path),
    ['/graphql']
  );
});

void test('falls back on CheckHeadChanged', async () => {
  const moved = 'b'.repeat(40);
  const h = harness((p, init) => {
    if (p !== '/graphql') return;
    const body = typeof init.body === 'string' ? init.body : '';
    const data = graphResponse(body);
    // GitHub's PR has moved to `moved`; its only commit is `moved`.
    data.p0.pullRequest.headRefOid = moved;
    data.p0.pullRequest.commits.nodes[0].commit.oid = moved;
    return new Response(JSON.stringify({ data }), { headers: { 'content-type': 'application/json' } });
  });
  await assert.rejects(readPrChecks(h.client, { url, headSha: sha }), CheckHeadChanged);
  const heads: boolean[] = [];
  const value = await readCurrentPrChecks(h.client, { url, headSha: sha }, {}, (fresh) => {
    heads.push(fresh);
    return Promise.resolve(moved);
  });
  assert.deepEqual(heads, [true], 'A moved head reads fresh metadata');
  assert.equal(value?.headSha, moved, 'The result is labelled with the head it describes');
  const forced: boolean[] = [];
  await readCurrentPrChecks(h.client, { url, headSha: sha }, { force: true }, (fresh) => {
    forced.push(fresh);
    return Promise.resolve(moved);
  });
  assert.deepEqual(forced, [true], 'A forced read keeps the metadata-first path');
});

void test('completed detail cache is revision/account scoped, coalesces reads, and invalidates reruns', async () => {
  const h = harness();
  const snapshot = (await readPrChecks(h.client, input))!;
  const before = h.calls.length;
  const [a, b] = await Promise.all([readCheckDetails(h.client, input), readCheckDetails(h.client, input)]);
  assert.deepEqual(a, b);
  assert.equal(h.calls.filter((c) => c.path === '/repos/o/r/check-runs/1').length, 1);
  assert.ok(h.calls.length > before);
  const count = h.calls.length;
  assert.deepEqual(await readCheckDetails(h.client, input), a);
  assert.equal(h.calls.length, count, 'A completed cached job needs no request');
  assert.deepEqual(withCachedCheckDetails(h.client, snapshot).details?.[input.id], a);
  assert.equal(cachedCheckDetails(h.pool.client('another-account'), input), undefined);
  assert.equal(cachedCheckDetails(h.client, { ...input, headSha: 'b'.repeat(40) }), undefined);
  const changed = {
    ...snapshot,
    checks: snapshot.checks.map((check) => ({
      ...check,
      status: 'queued' as const,
      conclusion: null,
      startedAt: null,
      completedAt: null,
    })),
  };
  githubCacheFor(h.client)!.set(`pr-checks:v1:${url}@${sha}`, changed);
  assert.equal(cachedCheckDetails(h.client, input), undefined, 'Same-ID rerun must not reuse a previous attempt');
  await readCheckDetails(h.client, input);
  assert.equal(h.calls.filter((c) => c.path === '/repos/o/r/check-runs/1').length, 2);
  await rerunChecks(h.client, { ...input, mode: 'failed' });
  assert.equal(cachedCheckDetails(h.client, input), undefined);
});

void test('running details keep a stale copy but refresh; force bypasses completed entries', async () => {
  const h = harness();
  const snapshot = (await readPrChecks(h.client, input))!;
  const value = await readCheckDetails(h.client, input);
  const count = h.calls.length;
  await readCheckDetails(h.client, input, { force: true });
  assert.ok(h.calls.length > count);
  const running = { ...snapshot.checks[0], status: 'in_progress' as const, conclusion: null, completedAt: null };
  githubCacheFor(h.client)!.set(`pr-checks:v1:${url}@${sha}`, { ...snapshot, checks: [running] });
  githubCacheFor(h.client)!.set(`check-details:v1:${url}@${sha}:check:1`, {
    value: { ...value, state: running },
    version: JSON.stringify([running.status, running.conclusion, running.startedAt, running.completedAt]),
    checkedAt: Date.now() - 30_000,
  });
  assert.ok(cachedCheckDetails(h.client, input), 'Keep stale data for immediate display');
  assert.equal(cachedCheckDetails(h.client, input, running, true), undefined);
  assert.ok(!h.calls.some((c) => c.path.includes('/logs')));
});

void test('interactive check detail reads promote a background preload and share its requests', async () => {
  const h = harness();
  const snapshot = (await readPrChecks(h.client, input))!;
  const low = withGitHubPriority('background', () => readCheckDetails(h.client, input));
  const high = withGitHubPriority('interactive', () => readCheckDetails(h.client, input));
  assert.deepEqual(await low, await high);
  assert.equal(h.calls.filter((c) => c.path === '/repos/o/r/check-runs/1').length, 1);
  assert.ok(withCachedCheckDetails(h.client, snapshot).details?.[input.id]);
  assert.equal(
    h.calls.find((c) => c.path.includes('/annotations'))?.priority,
    'interactive',
    'Joining user request promotes the remaining API calls'
  );
});

void test('preloader prioritizes failed and cancelled jobs and stops obsolete work on navigation or backoff', async () => {
  const h = harness();
  const snapshot = (await readPrChecks(h.client, input))!;
  const check = snapshot.checks[0];
  const data = {
    ...snapshot,
    checks: [
      { ...check, id: 'check:10', conclusion: 'success' },
      { ...check, id: 'check:11', conclusion: 'failure' },
      { ...check, id: 'check:12', conclusion: 'cancelled' },
      { ...check, id: 'check:13', status: 'in_progress' as const, conclusion: null },
    ],
  };
  let enabled = true,
    release!: () => void;
  const done = new Set<string>(),
    order: string[] = [],
    published: string[] = [];
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const loader = createCheckDetailsPreloader({
    canRun: () => enabled,
    fresh: (_s, c) => done.has(c.id),
    read: async (_s, c) => {
      order.push(c.id);
      if (order.length === 1) await gate;
      done.add(c.id);
      return undefined;
    },
    publish: (s) => {
      published.push(s.url);
    },
  });
  loader.setTargets([input]);
  loader.observe(data);
  const first = loader.tick();
  assert.deepEqual(order, ['check:11']);
  enabled = false;
  release();
  await first;
  assert.deepEqual(order, ['check:11'], 'Background allowance pause prevents the next job');
  enabled = true;
  await loader.tick();
  assert.deepEqual(order, ['check:11', 'check:12', 'check:13', 'check:10']);
  assert.equal(published.length, 4);
  done.clear();
  order.length = 0;
  loader.setTargets([]);
  await loader.tick();
  assert.deepEqual(order, [], 'Leaving the subject discards queued preloads');
});

void test('completed check details survive SQLite restart without network reads', async () => {
  const fs = await import('node:fs/promises'),
    os = await import('node:os'),
    path = await import('node:path');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gnosis-check-cache-'));
  const first = harness(),
    second = harness();
  try {
    await first.pool.setStorage(path.join(dir, 'budget.json'));
    await readPrChecks(first.client, input);
    const detail = await readCheckDetails(first.client, input);
    await first.pool.closeStorage();
    await second.pool.setStorage(path.join(dir, 'budget.json'));
    const snapshot = await readPrChecks(second.client, input, { cachedOnly: true });
    assert.ok(snapshot);
    assert.deepEqual(withCachedCheckDetails(second.client, snapshot).details?.[input.id], detail);
    assert.deepEqual(await readCheckDetails(second.client, input), detail);
    assert.equal(second.calls.length, 0);
  } finally {
    await first.pool.closeStorage();
    await second.pool.closeStorage();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

void test('clearing cache during a check read cannot restore the cleared entry', async () => {
  const h = harness();
  await readPrChecks(h.client, input);
  const reading = readCheckDetails(h.client, input);
  githubCacheFor(h.client)!.clear();
  await reading;
  assert.equal(cachedCheckDetails(h.client, input), undefined);
});

void test('leaving a PR while a preload is running prevents further jobs and stale publication', async () => {
  const h = harness(),
    snapshot = (await readPrChecks(h.client, input))!;
  let release!: () => void,
    reads = 0,
    publishes = 0;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const loader = createCheckDetailsPreloader({
    canRun: () => true,
    fresh: () => false,
    read: async () => {
      reads++;
      await gate;
      return undefined;
    },
    publish: () => {
      publishes++;
    },
  });
  loader.setTargets([input]);
  loader.observe({ ...snapshot, checks: [...snapshot.checks, { ...snapshot.checks[0], id: 'check:2' }] });
  const work = loader.tick();
  loader.clear();
  release();
  await work;
  assert.equal(reads, 1);
  assert.equal(publishes, 0);
});

void test('completed preloads do not redownload endlessly when a large stack evicts cache entries', async () => {
  const h = harness(),
    snapshot = (await readPrChecks(h.client, input))!;
  let reads = 0;
  const loader = createCheckDetailsPreloader({
    canRun: () => true,
    fresh: () => false,
    read: async () => {
      reads++;
      return { ...input, state: snapshot.checks[0], title: '', summary: '', text: '', annotations: [] };
    },
    publish() {},
  });
  loader.setTargets([input]);
  loader.observe(snapshot);
  await loader.tick();
  await loader.tick();
  assert.equal(reads, 1);
  loader.observe({
    ...snapshot,
    checkedAt: snapshot.checkedAt + 1,
    checks: snapshot.checks.map((c) => ({ ...c, completedAt: '2026-11-04T00:00:00Z' })),
  });
  await loader.tick();
  assert.equal(reads, 2, 'A changed attempt still loads');
});
