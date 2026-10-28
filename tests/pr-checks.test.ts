import test from 'node:test';
import assert from 'node:assert/strict';
import { createGitHubClientPool } from './cache-test-pool';
import { readCommitChecks } from '../lib/github-checks';
import { readPrChecks, readCheckDetails, readCheckLog, rerunChecks } from '../src/pr-checks-service';
import { checkSummary, checkCounts, orderedChecks, type PrCheck } from '../lib/pr-checks';
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
function harness(overrides: (path: string, init: RequestInit) => Response | undefined = () => undefined) {
  const calls: { path: string; method: string }[] = [];
  const json = (value: unknown, headers?: Record<string, string>) =>
    new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json', ...headers } });
  const pool = createGitHubClientPool({
    minSpacingMs: 0,
    fetch: ((address: string, init: RequestInit) => {
      const p = new URL(address).pathname + new URL(address).search;
      calls.push({ path: p, method: init.method ?? 'GET' });
      const respond = (response: Response) => {
        Object.defineProperty(response, 'url', { value: address });
        return Promise.resolve(response);
      };
      const overridden = overrides(p, init);
      if (overridden) return respond(overridden);
      let data: unknown;
      if (p.includes('/check-runs?')) data = { total_count: 1, check_runs: [run] };
      else if (p.includes('/statuses?')) data = [];
      else if (p === '/graphql') data = { data: { nodes: [{ id: 'CR_1', isRequired: true }] } };
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
        data = { id: 10, run_id: 9, run_attempt: 1, status: 'completed', steps: [] };
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
void test('unknown requirements do not discard usable checks', async () => {
  const h = harness((p) =>
    p === '/graphql'
      ? new Response(JSON.stringify({ message: 'Forbidden' }), {
          status: 403,
          headers: { 'content-type': 'application/json' },
        })
      : undefined
  );
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
  const h = harness(p => p.endsWith('/logs') ? new Response(null, {status:302,headers:{location:'https://logs.blob.core.windows.net/job'}}) : undefined);
  const original = globalThis.fetch;
  let cancelled = false;
  globalThis.fetch = ((_url: unknown, options: RequestInit) => {
    assert.equal(options.headers, undefined);
    assert.equal(options.redirect, 'error');
    return Promise.resolve(new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(String.fromCharCode(27)+'[31mFAIL'+String.fromCharCode(27)+'[0m'+'x'.repeat(2_100_000))); },
      cancel() { cancelled = true; },
    })));
  }) as typeof fetch;
  try {
    const log = await readCheckLog(h.client, input);
    assert.equal(log.truncated, true);
    assert.ok(log.text.startsWith('FAIL'));
    assert.ok(log.text.length <= 2_000_000);
    assert.equal(log.text.includes(String.fromCharCode(27)), false);
    assert.equal(cancelled, true);
  } finally { globalThis.fetch = original; }
});

void test('compact check outcomes explain skipped and neutral results without implying failure', () => {
  const checks = (conclusions: string[]) => conclusions.map(conclusion => ({ name: conclusion, status: 'completed' as const, conclusion, url: '' }));
  assert.equal(checkSummary(checks(['success','success','skipped'])), '2 passed · 1 skipped');
  assert.equal(checkSummary(checks(['success','neutral'])), '1 passed · 1 neutral');
  assert.equal(checkSummary(checks(['success','failure'])), '1 check needs attention');
  assert.equal(checkSummary([]), 'No checks reported');
});
