/**
 * Do the Overview's visible-priority status reads starve discovery's background PR reads? Measured on the real client
 * pool and scheduler (lib/github-client.ts, lib/github-scheduler.ts) in virtual time, with a synthetic GitHub.
 *
 * - Discovery: one full pass over 270 PRs, five `GET /repos/…/pulls/N` reads at a time, at background automatic
 *   priority, as src/workbench-service.ts `discover` reads them.
 * - The Overview, shown: 270 PRs of status in 25-PR GraphQL reads, one at a time, at foreground automatic priority
 *   (`{ active: true }`, src/main.ts `get-queue-signals`), again whenever a sweep finds status past its 2-minute
 *   time-to-live (lib/use-queue-signals.ts). Plus the backend watch's visible signals reads, one batch at a time.
 * - A stress case: four Overview read chains back to back, with no time-to-live, to fill every lower-tier slot.
 *
 * Finding: no starvation. The status reads use the GraphQL allowance and discovery the REST one, and each resource is
 * paced on its own; the scheduler keeps two slots for background work within the four lower-tier slots, and a paced
 * read releases its slot while it waits. Discovery's pass takes the same time with or without the Overview, set by
 * the automatic REST pace: 20% of 5,000 requests an hour is one read every 3.6 s, so 270 reads take about 16 minutes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGitHubClientPool } from '../lib/github-client';
import { createGitHubWork, withGitHubPriority } from '../lib/github-scheduler';
import { automaticLimit, automaticWindow } from '../lib/github-budget';

const PRS = 270;
const START = Date.parse('2026-11-18T09:00:00Z');

/** A clock that only moves when every task is waiting on it. */
function virtualTime() {
  let time = START;
  const timers: { at: number; resolve: () => void }[] = [];
  const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
  return {
    now: () => time,
    sleep: (ms: number) => new Promise<void>((resolve) => { timers.push({ at: time + Math.max(0, ms), resolve }); }),
    async run(done: () => boolean) {
      while (!done()) {
        await turn();
        if (done()) break;
        timers.sort((a, b) => a.at - b.at);
        const next = timers.shift();
        assert.ok(next, 'Every task waits on something');
        time = Math.max(time, next.at);
        next.resolve();
      }
    },
  };
}

function simulate(load: 'none' | 'overview' | 'stress') {
  const clock = virtualTime();
  const reset = Math.floor(START / 1000) + 3600;
  const remaining: Record<string, number> = { core: 5000, graphql: 5000 };
  const started: Record<string, number> = { core: 0, graphql: 0 };
  const pool = createGitHubClientPool({
    now: clock.now,
    sleep: clock.sleep,
    fetch: (async (input: string | URL | Request) => {
      const graphql = new URL(String(input)).pathname === '/graphql';
      const resource = graphql ? 'graphql' : 'core';
      started[resource]++;
      // A 25-PR status query is slow; a PR read is quick. About 2 GraphQL points per status query.
      await clock.sleep(graphql ? 1500 : 300);
      remaining[resource] -= graphql ? 2 : 1;
      return new Response(JSON.stringify(graphql ? { data: { rateLimit: { cost: 2 } } } : { number: 1 }), {
        headers: {
          'content-type': 'application/json',
          'x-ratelimit-resource': resource,
          'x-ratelimit-remaining': String(remaining[resource]),
          'x-ratelimit-limit': '5000',
          'x-ratelimit-reset': String(reset),
        },
      });
    }) as typeof fetch,
  });
  const client = pool.client('fixture-token');
  let finished: number | undefined;
  const batchTimes: number[] = [];
  // Discovery's pass: batches of five, the next batch after the last answer, as `discover` does.
  const discovery = withGitHubPriority('background', () => createGitHubWork(async () => {
    for (let i = 0; i < PRS; i += 5) {
      const begun = clock.now();
      await Promise.allSettled(Array.from({ length: Math.min(5, PRS - i) }, (_, j) => client.request(`GET /repos/o/r/pulls/${i + j + 1}`)));
      batchTimes.push(clock.now() - begun);
    }
    finished = clock.now();
  })).promise;
  let stop = false;
  let statusReads = 0;
  const statusRead = () => withGitHubPriority('foreground', () => client.graphql('query { rateLimit { cost } p0: repository(owner:"o",name:"r") { id } }'), { automatic: true })
    .then(() => { statusReads++; }, () => { statusReads++; });
  const chains: Promise<void>[] = [];
  if (load === 'overview') {
    // The Overview's sweep: every 30 s, re-read status older than 2 minutes, in 25-PR chunks, one at a time.
    chains.push((async () => {
      let answered = -Infinity;
      while (!stop) {
        if (clock.now() - answered >= 120_000) {
          for (let i = 0; i < PRS && !stop; i += 25) await statusRead();
          answered = clock.now();
        }
        await clock.sleep(30_000);
      }
    })());
    // The backend watch's visible signals: one 25-PR batch at a time, each PR again after 2 minutes.
    chains.push((async () => {
      while (!stop) {
        for (let i = 0; i < PRS && !stop; i += 25) await statusRead();
        await clock.sleep(120_000);
      }
    })());
  }
  if (load === 'stress')
    for (let c = 0; c < 4; c++)
      chains.push((async () => { while (!stop) await statusRead(); })());
  return {
    async run() {
      await clock.run(() => finished !== undefined);
      stop = true;
      await clock.run(() => true);
      void Promise.all(chains);
      await discovery;
      return { duration: (finished ?? 0) - START, batchTimes, statusReads, coreReads: started.core };
    },
  };
}

void test('the Overview\'s visible status reads do not starve discovery\'s background batches', async (t) => {
  const alone = await simulate('none').run();
  const overview = await simulate('overview').run();
  const stress = await simulate('stress').run();
  const minutes = (ms: number) => (ms / 60_000).toFixed(1);
  t.diagnostic(`discovery alone: ${minutes(alone.duration)} min for ${PRS} PRs (${alone.coreReads} reads), batches ${Math.min(...alone.batchTimes) / 1000}-${Math.max(...alone.batchTimes) / 1000} s`);
  t.diagnostic(`with the Overview shown: ${minutes(overview.duration)} min, ${overview.statusReads} status reads`);
  t.diagnostic(`with four back-to-back status chains: ${minutes(stress.duration)} min, ${stress.statusReads} status reads`);
  assert.equal(alone.coreReads, PRS);
  // The automatic REST pace sets the pass: one read per window / allowance.
  const spacing = automaticWindow('core') / automaticLimit('core');
  assert.equal(spacing, 3600);
  // Each read waits 3.6 s after the last one answered, plus the 0.3 s it takes.
  assert.ok(alone.duration >= PRS * spacing && alone.duration <= PRS * (spacing + 300) + 30_000, `about ${PRS} × 3.9 s, was ${alone.duration} ms`);
  assert.ok(overview.statusReads > 0 && stress.statusReads > overview.statusReads, 'the status reads ran');
  // Within 2%: the status reads do not take discovery's turns.
  assert.ok(overview.duration <= alone.duration * 1.02, `the Overview slowed discovery from ${alone.duration} to ${overview.duration} ms`);
  assert.ok(stress.duration <= alone.duration * 1.02, `status reads in every slot slowed discovery from ${alone.duration} to ${stress.duration} ms`);
});
