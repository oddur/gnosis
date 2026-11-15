import test from 'node:test';
import assert from 'node:assert/strict';
import { createGitHubClientPool } from './cache-test-pool';
import { checkCounts, currentChecks, type PrCheck } from '../lib/pr-checks';
import { readPrChecks } from '../src/pr-checks-service';
import { createQueueSignalsService, hasSupersededRuns } from '../src/queue-signals-service';
import { checkSignals } from '../lib/queue-signals';
import { mergeReadiness } from '../lib/merge-readiness';
import { memberAttention } from '../lib/attention';
import { deriveEvents } from '../lib/notification-events';
import {
  attentionSourceSummary,
  actionsNeedAttention,
  externalCheckGroups,
  hiddenFailureNotice,
} from '../lib/workflow-external';
import {
  expectedCurrent,
  supersededChecks,
  supersededRollupNodes,
  supersededSuiteNodes,
  supersededWorkflowRuns,
} from './fixtures/superseded-runs';

const sha = 'c'.repeat(40);
const url = 'https://github.com/acme/widgets/pull/7';

function check(id: number, name: string, conclusion: string, extra: Partial<PrCheck> = {}): PrCheck {
  return {
    id: `check:${id}`,
    databaseId: id,
    kind: 'check',
    name,
    provider: 'GitHub Actions',
    required: false,
    status: 'completed',
    conclusion,
    url: `https://github.com/acme/widgets/actions/runs/${extra.workflowRun?.id ?? 1}/job/${id}`,
    startedAt: null,
    completedAt: null,
    ...extra,
  };
}
const run = (id: number, workflowId: number, event = 'pull_request') => ({ workflowRun: { id, workflowId, event } });

void test('only the newest run of each workflow counts; older concurrency-cancelled rounds are superseded', () => {
  const raw = supersededChecks();
  const before = checkCounts(raw);
  assert.ok(before.attention >= 2, 'The raw rollup includes cancelled and failed jobs of superseded runs');
  const { checks, superseded } = currentChecks(raw);
  const expected = expectedCurrent();
  assert.equal(checks.length, expected.total);
  assert.equal(superseded.length, raw.length - expected.total);
  assert.deepEqual(checkCounts(checks), {
    attention: 0,
    running: 0,
    passed: expected.passed,
    skipped: expected.skipped,
  });
  assert.ok(!checks.some((c) => c.name.endsWith(' Result') && c.conclusion === 'failure'));
  // Two-round and one-round workflows keep their newest run.
  assert.ok(checks.some((c) => c.name === 'Detect API changes' && c.conclusion === 'success'));
  assert.ok(checks.some((c) => c.name === 'Draft notes'));
  // Order is preserved, and a clean list is returned as is.
  assert.deepEqual(
    checks,
    raw.filter((c) => checks.includes(c))
  );
  assert.equal(currentChecks(checks).checks, checks);
});

void test('re-run attempts: the newest check run of a job in one workflow run wins, whatever its outcome', () => {
  const passedThenFailed = [
    check(10, 'Unit tests', 'success', run(500, 1)),
    check(11, 'Lint', 'success', run(500, 1)),
    check(12, 'Unit tests', 'failure', run(500, 1)),
  ];
  const { checks, superseded } = currentChecks(passedThenFailed);
  assert.deepEqual(
    checks.map((c) => c.id),
    ['check:11', 'check:12']
  );
  assert.deepEqual(
    superseded.map((c) => c.id),
    ['check:10']
  );
  assert.equal(checkCounts(checks).attention, 1, 'A failed re-run is not hidden by the earlier pass');
  // Without workflow run data (an older snapshot or no Actions access), the job URL still groups attempts.
  const fromUrls = currentChecks([
    check(20, 'Unit tests', 'failure', { url: 'https://github.com/acme/widgets/actions/runs/600/job/20' }),
    check(21, 'Unit tests', 'success', { url: 'https://github.com/acme/widgets/actions/runs/600/job/21' }),
    check(22, 'Unit tests', 'failure', { url: 'https://github.com/acme/widgets/actions/runs/601/job/22' }),
  ]);
  assert.deepEqual(
    fromUrls.checks.map((c) => c.id),
    ['check:21', 'check:22'],
    'Unknown workflows never replace each other'
  );
});

void test('same-name jobs in runs of different workflows or events all count', () => {
  const checks = [
    check(1, 'build (linux)', 'failure', run(700, 1)),
    check(2, 'build (linux)', 'success', run(701, 2)),
    check(3, 'build (linux)', 'success', run(702, 1, 'push')),
    check(4, 'build (macos)', 'success', run(700, 1)),
    check(5, 'build (linux)', 'success', { provider: 'Depot Checks', url: 'https://depot.example/jobs/5' }),
    check(6, 'build (linux)', 'success', { provider: 'Depot Checks', url: 'https://depot.example/jobs/6' }),
    { ...check(7, 'ci/legacy', 'failure'), id: 'status:7', kind: 'status' as const, provider: 'Legacy CI', url: null },
  ];
  const result = currentChecks(checks);
  assert.equal(result.checks.length, checks.length, 'Nothing is superseded');
  assert.equal(result.superseded.length, 0);
  // A newer run of workflow 1 for pull_request replaces only workflow 1's pull_request jobs.
  const rerun = currentChecks([...checks, check(8, 'build (linux)', 'success', run(703, 1))]);
  assert.deepEqual(
    rerun.superseded.map((c) => c.id),
    ['check:1', 'check:4']
  );
});

void test('the GraphQL snapshot drops superseded runs, so List, Graph and the tab badge agree', async () => {
  const queries: string[] = [];
  const pool = createGitHubClientPool({
    fetch: ((address: string, init: RequestInit) => {
      const body = typeof init.body === 'string' ? init.body : '';
      queries.push(body);
      assert.equal(new URL(address).pathname, '/graphql');
      const data = {
        p0: {
          pullRequest: {
            headRefOid: sha,
            commits: {
              nodes: [
                {
                  commit: {
                    oid: sha,
                    statusCheckRollup: {
                      contexts: { nodes: supersededRollupNodes(), pageInfo: { hasNextPage: false, endCursor: null } },
                    },
                  },
                },
              ],
            },
          },
        },
      };
      return Promise.resolve(
        new Response(JSON.stringify({ data }), { headers: { 'content-type': 'application/json' } })
      );
    }) as typeof fetch,
  });
  const client = pool.client('superseded-checks');
  const snapshot = await readPrChecks(client, { url, headSha: sha });
  assert.ok(snapshot);
  assert.match(queries[0], /workflowRun \{ databaseId event workflow \{ databaseId \} \}/);
  const expected = expectedCurrent();
  assert.equal(snapshot.checks.length, expected.total);
  assert.equal(checkCounts(snapshot.checks).attention, 0, 'Checks tab badge is 0');
  assert.ok(snapshot.checks.every((c) => c.workflowRun?.event === 'pull_request'));
  // Graph: the workflow list holds the newest runs, so no job is left for "Other GitHub Actions jobs".
  const runs = supersededWorkflowRuns(sha);
  assert.deepEqual(externalCheckGroups(snapshot, runs), []);
  assert.equal(actionsNeedAttention(snapshot, runs), false);
  assert.deepEqual(
    runs.map((r) => r.supersededRuns ?? 0),
    [2, 2, 2, 1, 0]
  );
  // Before the fix every superseded job landed in the unlisted group.
  const unfiltered = externalCheckGroups({ ...snapshot, checks: supersededChecks() }, runs);
  assert.deepEqual(
    unfiltered.map((g) => [g.name, g.source]),
    [['Other GitHub Actions jobs', 'unlisted']]
  );
  // The queue counts from the same list.
  assert.deepEqual(checkSignals(snapshot.checks), {
    state: 'success',
    passed: expected.passed,
    failed: 0,
    running: 0,
    skipped: expected.skipped,
    total: expected.total,
  });
});

void test('summary copy never calls Actions jobs outside GitHub Actions', () => {
  const raw = supersededChecks();
  const unlisted = externalCheckGroups({ url, headSha: sha, checkedAt: 0, checks: raw }, supersededWorkflowRuns(sha));
  const attention = unlisted[0].counts.attention;
  assert.equal(attentionSourceSummary(unlisted, attention), 'All are in workflow runs not listed here');
  assert.doesNotMatch(hiddenFailureNotice(unlisted), /outside GitHub Actions/);
  const depot = check(90, 'Server check', 'failure', {
    provider: 'Depot Checks',
    url: 'https://depot.example/jobs/90',
  });
  const mixed = externalCheckGroups(
    { url, headSha: sha, checkedAt: 0, checks: [...raw, depot] },
    supersededWorkflowRuns(sha)
  );
  assert.equal(
    attentionSourceSummary(mixed, attention + 1),
    `1 is outside GitHub Actions · ${attention} are in workflow runs not listed here`
  );
  assert.match(hiddenFailureNotice(mixed), /1 failed in Depot Checks, outside GitHub Actions/);
  const external = externalCheckGroups({ url, headSha: sha, checkedAt: 0, checks: [depot] }, []);
  assert.equal(attentionSourceSummary(external, 1), 'It is outside GitHub Actions');
});

void test('queue signals, attention and merge readiness ignore superseded runs', async () => {
  const requests: string[] = [];
  let superseded = true;
  const pool = createGitHubClientPool({
    fetch: ((_address: string, init: RequestInit) => {
      const body = typeof init.body === 'string' ? init.body : '';
      requests.push(body);
      const commit = body.includes('statusCheckRollup { state contexts')
        ? {
            checkSuites: { nodes: superseded ? supersededSuiteNodes() : supersededSuiteNodes().slice(-1) },
            // GitHub's rollup counts every check run on the commit, superseded ones included.
            statusCheckRollup: {
              state: 'FAILURE',
              contexts: {
                totalCount: supersededChecks().length,
                checkRunCountsByState: Object.entries(
                  supersededChecks().reduce<Record<string, number>>((counts, c) => {
                    const state = (c.conclusion ?? 'pending').toUpperCase();
                    counts[state] = (counts[state] ?? 0) + 1;
                    return counts;
                  }, {})
                ).map(([state, count]) => ({ state, count })),
                statusContextCountsByState: [],
              },
            },
          }
        : {
            oid: sha,
            statusCheckRollup: {
              contexts: { nodes: supersededRollupNodes(), pageInfo: { hasNextPage: false, endCursor: null } },
            },
          };
      const data = {
        p0: {
          pullRequest: {
            headRefOid: sha,
            state: 'OPEN',
            isDraft: false,
            mergeable: 'MERGEABLE',
            mergeStateStatus: 'CLEAN',
            reviewDecision: 'APPROVED',
            baseRefName: 'main',
            baseRefOid: 'b'.repeat(40),
            baseRef: { compare: { behindBy: 0 } },
            mergeQueue: null,
            mergeQueueEntry: null,
            comments: { totalCount: 0, nodes: [] },
            reviews: { nodes: [] },
            commits: { nodes: [{ commit }] },
          },
        },
      };
      return Promise.resolve(
        new Response(JSON.stringify({ data }), { headers: { 'content-type': 'application/json' } })
      );
    }) as typeof fetch,
  });
  const client = pool.client('superseded-signals');
  const now = Date.now();
  const get = createQueueSignalsService(() => now);
  const [signals] = await get(client, [{ url, headSha: sha }]);
  assert.match(requests[0], /checkSuites\(first:100\)/);
  assert.equal(requests.length, 2, 'Superseded runs make the queue read the current check list once');
  const expected = expectedCurrent();
  assert.deepEqual(signals.checks, {
    state: 'success',
    passed: expected.passed,
    failed: 0,
    running: 0,
    skipped: expected.skipped,
    total: expected.total,
  });
  const member = { url, headSha: sha, merged: false, state: 'open' as const, isDraft: false, baseBranch: 'main' };
  const readiness = mergeReadiness(member, signals, now);
  assert.equal(readiness.ready, true, readiness.label);
  assert.ok(!readiness.details.some((d) => d.includes('failing')));
  const kinds = memberAttention(
    { ...member, author: 'octo', baseSha: 'b'.repeat(40), requestedReviewers: [] },
    signals,
    'octo'
  );
  assert.equal(kinds['checks-failed'], undefined, 'No "checks failed" attention or menu bar item');
  assert.ok(kinds['ready-to-merge']);
  // The queue row label (QueueMetadata) reads these counts: "12/12", never "N failed".
  assert.equal(signals.checks.passed + signals.checks.skipped, signals.checks.total);
  // Notifications: from a known basis, the PR raises "ready to merge" and never "checks failed".
  const observed = {
    ...member,
    author: 'octo',
    baseSha: 'b'.repeat(40),
    requestedReviewers: [],
    title: 'Widgets',
    repo: 'acme/widgets',
    number: 7,
  };
  const { events } = deriveEvents(
    { headSha: sha, kinds: {}, requests: 0, teamRequests: 0, team: false, review: null, observedAt: now - 1 },
    { member: observed, signals },
    { login: 'octo', now, initialized: true }
  );
  assert.deepEqual(
    events.map((event) => event.type),
    ['ready-to-merge']
  );

  // A single run per workflow keeps GitHub's rollup and costs no extra request. Here the rollup's FAILURE is
  // trusted, which is exactly what made superseded runs raise "checks failed" before.
  superseded = false;
  const clean = createQueueSignalsService(() => now);
  const before = requests.length;
  const [rollup] = await clean(client, [{ url, headSha: sha }], { force: true });
  assert.equal(requests.length, before + 1);
  assert.equal(rollup.checks.state, 'failure');
  assert.ok(memberAttention(observed, rollup, 'octo')['checks-failed']);
});

void test('superseded detection needs two runs of one workflow and event', () => {
  const suite = (id: number, workflow: number, event = 'pull_request') => ({
    workflowRun: { databaseId: id, event, workflow: { databaseId: workflow } },
  });
  assert.equal(
    hasSupersededRuns([suite(1, 10), suite(2, 11), suite(3, 10, 'push'), null, { workflowRun: null }]),
    false
  );
  assert.equal(hasSupersededRuns([suite(1, 10), suite(1, 10)]), false, 'Repeated suite of one run');
  assert.equal(hasSupersededRuns([suite(1, 10), suite(2, 10)]), true);
  assert.equal(hasSupersededRuns(supersededSuiteNodes()), true);
});
