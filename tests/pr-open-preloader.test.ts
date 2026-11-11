import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrOpenPreloader, needsRefresh, type OpenKind, type SavedCopy } from '../src/pr-open-preloader';
import { GitHubBackoffError } from '../lib/github-client';
import type { OpenTarget, OpenTier } from '../lib/pr-open-targets';

const HOUR = 3_600_000;
const head = 'a'.repeat(40);
const base = 'b'.repeat(40);
const target = (n: number, tier: OpenTier = 1): OpenTarget => ({
  url: `https://github.com/o/r/pull/${n}`,
  headSha: head,
  baseSha: base,
  updatedAt: new Date(0).toISOString(),
  tier,
});
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
};
function harness() {
  let now = 10 * HOUR;
  const saved = new Map<string, SavedCopy>();
  const calls: { kind: string; urls: string[]; intent?: boolean }[] = [];
  const incomplete = new Set<string>();
  const details = new Set<string>();
  const state = { canRun: true, canIntent: true, idle: 0, usage: { spent: 0, limit: 1000 } };
  let fail: Partial<Record<OpenKind | 'full', Error>> = {};
  let hold: Promise<void> | undefined;
  const save = (kind: OpenKind, targets: OpenTarget[]) => {
    for (const t of targets) saved.set(`${kind}:${t.url}`, { headSha: t.headSha, baseSha: t.baseSha, checkedAt: now });
  };
  const step = (kind: OpenKind) => async (targets: OpenTarget[], intent: boolean) => {
    calls.push({ kind, urls: targets.map((t) => t.url), intent });
    if (hold) await hold;
    if (fail[kind]) throw fail[kind];
    save(kind, targets);
  };
  const byUrl = new Map<string, OpenTarget>();
  const preloader = createPrOpenPreloader({
    canRun: () => state.canRun,
    canIntent: () => state.canIntent,
    usage: () => state.usage,
    idleSeconds: () => state.idle,
    need: (t, kind) => (kind === 'details' ? details.has(t.url) : needsRefresh(kind, saved.get(`${kind}:${t.url}`), t, now)),
    status: step('status'),
    signals: step('signals'),
    checks: step('checks'),
    threads: (urls) => {
      calls.push({ kind: 'threads', urls });
      if (fail.threads) return Promise.reject(fail.threads);
      save('threads', urls.filter((url) => !incomplete.has(url)).map((url) => byUrl.get(url) ?? target(0)));
      return Promise.resolve({ incomplete: urls.filter((url) => incomplete.has(url)) });
    },
    threadsFull: async (url, intent) => {
      calls.push({ kind: 'full', urls: [url], intent });
      if (hold) await hold;
      save('threads', [byUrl.get(url) ?? target(0)]);
    },
    checkDetails: (t) => {
      calls.push({ kind: 'details', urls: [t.url], intent: true });
      details.delete(t.url);
      return Promise.resolve();
    },
    now: () => now,
  });
  return {
    preloader,
    calls,
    saved,
    state,
    incomplete,
    details,
    save,
    setTargets(owner: string, targets: OpenTarget[]) {
      for (const t of targets) byUrl.set(t.url, t);
      preloader.setTargets(owner, targets);
    },
    fail: (value: typeof fail) => {
      fail = value;
    },
    hold: (value: Promise<void> | undefined) => {
      hold = value;
    },
    advance: (ms: number) => {
      now += ms;
    },
    now: () => now,
    count: (kind: string) => calls.filter((call) => call.kind === kind).reduce((sum, call) => sum + call.urls.length, 0),
  };
}

void test('orders steps status, signals, checks, threads by tier', async () => {
  const h = harness();
  const targets = [target(1, 3), target(2, 1), target(3, 0), target(4, 2), target(5, 1)];
  h.setTargets('window', targets);
  await h.preloader.tick();
  assert.deepEqual(
    h.calls.map((call) => call.kind),
    ['status', 'signals', 'checks', 'threads']
  );
  const order = [2, 5, 4, 1].map((n) => target(n).url);
  for (const call of h.calls) {
    assert.deepEqual(call.urls, order, `${call.kind} follows tier, then queue order, and skips the open PR`);
    assert.notEqual(call.intent, true, 'Queue work is never hover prefetch');
  }
  const count = h.calls.length;
  await h.preloader.tick();
  assert.equal(h.calls.length, count, 'Fresh copies need no further requests');
});

void test('caps status at 100 and threads at 40 targets', async () => {
  const h = harness();
  h.setTargets('window', Array.from({ length: 120 }, (_, i) => target(i + 1)));
  await h.preloader.tick();
  assert.equal(h.count('status'), 100);
  assert.equal(h.calls.filter((call) => call.kind === 'status').length, 4, '25 PRs per status query');
  assert.equal(h.count('signals'), 100);
  assert.equal(h.count('checks'), 40);
  assert.equal(h.calls.filter((call) => call.kind === 'checks').length, 8, '5 PRs per checks query');
  assert.equal(h.count('threads'), 40);
  assert.ok(!h.calls.some((call) => call.kind === 'details'), 'Check details are never preloaded for queue tiers');
});

void test('pauses above half the automatic GraphQL budget', async () => {
  const h = harness();
  h.setTargets('window', [target(1)]);
  h.state.usage = { spent: 500, limit: 1000 };
  await h.preloader.tick();
  assert.equal(h.calls.length, 0);
  h.state.usage = { spent: 499, limit: 1000 };
  await h.preloader.tick();
  assert.equal(h.calls.length, 4);
});

void test('pauses when hidden, idle or backing off', async () => {
  const h = harness();
  h.setTargets('window', [target(1), target(2)]);
  h.state.canRun = false;
  await h.preloader.tick();
  h.state.canRun = true;
  h.state.idle = 300;
  await h.preloader.tick();
  assert.equal(h.calls.length, 0, 'Hidden windows, backoff reported by the client, and idle users send nothing');
  h.state.idle = 299;
  h.fail({ status: new GitHubBackoffError(h.now() + 120_000) });
  await h.preloader.tick();
  assert.equal(h.calls.length, 1);
  await h.preloader.tick();
  assert.equal(h.calls.length, 1, 'A backoff stops all queue steps until its deadline');
  h.fail({});
  h.advance(120_001);
  await h.preloader.tick();
  assert.equal(h.calls.length, 5);
});

void test('refreshes on a new head, a newer updatedAt and six-hour age', async () => {
  const h = harness();
  const first = target(1),
    second = target(2),
    third = target(3);
  h.setTargets('window', [first, second, third]);
  await h.preloader.tick();
  h.calls.length = 0;
  h.advance(60_000);
  const moved = { ...first, headSha: 'c'.repeat(40) };
  const updated = { ...second, updatedAt: new Date(h.now() - 10_000).toISOString() };
  h.setTargets('window', [moved, updated, third]);
  await h.preloader.tick();
  assert.deepEqual(
    h.calls.map((call) => [call.kind, call.urls]),
    (['status', 'signals', 'checks', 'threads'] as const).map((kind) => [kind, [first.url, second.url]])
  );
  h.calls.length = 0;
  h.advance(6 * HOUR - 30_000);
  await h.preloader.tick();
  assert.equal(h.count('status'), 1, 'Only the copy older than six hours');
  assert.equal(h.calls[0].urls[0], third.url);
  // Running checks on a visible row refresh after ten minutes; elsewhere they wait for the six-hour roll.
  const copy = { headSha: head, baseSha: base, checkedAt: HOUR, running: true };
  const later = HOUR + 10 * 60_000 + 1;
  assert.equal(needsRefresh('checks', copy, { ...third, tier: 1 }, later), true);
  assert.equal(needsRefresh('checks', copy, { ...third, tier: 2 }, later), false);
  assert.equal(needsRefresh('status', copy, third, later), false);
  assert.equal(needsRefresh('status', { ...copy, revalidate: true }, third, later), true, 'A write marks the copy stale');
  assert.equal(needsRefresh('status', { ...copy, baseSha: head }, third, later), true, 'A new base');
});

void test('falls back to a full read for incomplete threads', async () => {
  const h = harness();
  h.incomplete.add(target(2).url);
  h.setTargets('window', [target(1), target(2), target(3)]);
  await h.preloader.tick();
  assert.deepEqual(
    h.calls.filter((call) => call.kind === 'threads' || call.kind === 'full').map((call) => [call.kind, call.urls]),
    [
      ['threads', [target(1).url, target(2).url, target(3).url]],
      ['full', [target(2).url]],
    ]
  );
  // A failed batch retries its PRs one at a time.
  const failed = harness();
  failed.fail({ threads: new Error('timeout') });
  failed.setTargets('window', [target(1), target(2)]);
  await failed.preloader.tick();
  assert.deepEqual(
    failed.calls.filter((call) => call.kind === 'full').map((call) => call.urls[0]),
    [target(1).url, target(2).url]
  );
});

void test('intent bucket allows three then one per five seconds', async () => {
  const h = harness();
  for (let n = 1; n <= 5; n++) {
    h.preloader.setIntent('window', [target(n)]);
    await settle();
  }
  const started = () => new Set(h.calls.filter((call) => call.intent).map((call) => call.urls[0])).size;
  assert.equal(started(), 3);
  assert.ok(h.calls.every((call) => call.intent), 'Hover reads use the prefetch priority');
  await h.preloader.tick();
  await settle();
  assert.equal(started(), 3, 'The fifth intent replaced the fourth and waits for a token');
  h.advance(5000);
  await h.preloader.tick();
  await settle();
  assert.equal(started(), 4);
  assert.ok(h.calls.some((call) => call.urls[0] === target(5).url));
  assert.ok(!h.calls.some((call) => call.urls[0] === target(4).url));
});

void test('intent with fresh copies makes no request', async () => {
  const h = harness();
  const fresh = target(1);
  for (const kind of ['status', 'signals', 'checks', 'threads'] as const) h.save(kind, [fresh]);
  for (let i = 0; i < 5; i++) {
    h.preloader.setIntent('window', [fresh]);
    await settle();
  }
  assert.equal(h.calls.length, 0);
  // No tokens were spent.
  for (let n = 2; n <= 4; n++) {
    h.preloader.setIntent('window', [target(n)]);
    await settle();
  }
  assert.equal(new Set(h.calls.map((call) => call.urls[0])).size, 3);
  // Failing checks without saved details are read with the rest.
  h.details.add(target(9).url);
  h.advance(5000);
  h.preloader.setIntent('window', [target(9)]);
  await settle();
  assert.ok(h.calls.some((call) => call.kind === 'details' && call.urls[0] === target(9).url));
});

void test('a newer intent replaces a queued one', async () => {
  const h = harness();
  let release!: () => void;
  h.hold(new Promise<void>((resolve) => (release = resolve)));
  h.preloader.setIntent('window', [target(1)]);
  await settle();
  h.preloader.setIntent('window', [target(2)]);
  h.preloader.setIntent('window', [target(3)]);
  await settle();
  assert.deepEqual([...new Set(h.calls.map((call) => call.urls[0]))], [target(1).url], 'One intent in flight');
  h.hold(undefined);
  release();
  await settle();
  assert.deepEqual([...new Set(h.calls.map((call) => call.urls[0]))], [target(1).url, target(3).url]);
  assert.ok(h.saved.has(`status:${target(1).url}`), 'The request in flight still finishes and saves');
});
