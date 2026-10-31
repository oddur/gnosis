import { parseGitHubSyncInterest } from '../lib/github-sync';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGitHubSyncService } from '../src/github-sync-service';
import type { GitHubSyncInterest, GitHubSyncUpdate } from '../lib/github-sync';
const target = (n = 1) => ({ url: `https://github.com/test/repo/pull/${n}`, headSha: 'a'.repeat(40) });
const watch = (priority: 'active' | 'visible' = 'active', n = 1): GitHubSyncInterest => ({
  kind: 'signals',
  priority,
  targets: [target(n)],
});
function fixture() {
  let now = 0,
    account: string | null = 'alice',
    enabled = true,
    backoff = 0,
    pending = true;
  const calls: { urls: string[]; priority: string }[] = [],
    published: GitHubSyncUpdate[][] = [];
  const sync = createGitHubSyncService({
    now: () => now,
    account: () => account,
    enabled: () => enabled,
    backoff: () => (backoff ? { retryAt: backoff, message: 'GitHub API limit reached' } : undefined),
    read: (kind, targets, priority) => {
      assert.equal(kind, 'signals');
      calls.push({ urls: targets.map((t) => t.url), priority });
      return Promise.resolve(
        targets.map((t) => ({
          kind: 'signals',
          url: t.url,
          value: {
            ...t,
            headSha: t.headSha ?? '',
            checkedAt: now,
            comments: 0,
            checks: { state: pending ? 'pending' : 'success', total: 1, passed: pending ? 0 : 1 },
          },
        }))
      );
    },
    publish: (updates) => published.push(updates),
  });
  return {
    sync,
    calls,
    published,
    time: (value: number) => {
      now = value;
    },
    account: (value: string | null) => {
      account = value;
    },
    enabled: (value: boolean) => {
      enabled = value;
    },
    backoff: (value: number) => {
      backoff = value;
    },
    pending: (value: boolean) => {
      pending = value;
    },
  };
}
void test('overlapping screens share one request; active PRs outrank visible rows', async () => {
  const f = fixture();
  f.sync.observe('1:row', watch('visible'));
  f.sync.observe('1:summary', watch());
  f.sync.observe('1:checks', watch());
  f.sync.observe('1:other', watch('visible', 2));
  await f.sync.tick();
  assert.deepEqual(f.calls, [{ urls: [target().url], priority: 'active' }]);
  await f.sync.tick();
  assert.deepEqual(f.calls[1], { urls: [target(2).url], priority: 'visible' });
  await f.sync.tick();
  assert.equal(f.calls.length, 2, 'reconciling overlapping priorities must not restart cadence');
});
void test('busy checks stay fast; unchanged state backs off; visible-to-active promotion runs promptly', async () => {
  const f = fixture();
  f.sync.observe('1:active', watch());
  await f.sync.tick();
  f.time(25_000);
  await f.sync.tick();
  assert.equal(f.calls.length, 2);
  f.pending(false);
  f.time(50_000);
  await f.sync.tick();
  f.time(75_000);
  await f.sync.tick();
  assert.equal(f.calls.length, 4);
  f.time(100_000);
  await f.sync.tick();
  assert.equal(f.calls.length, 4);
  f.time(125_000);
  await f.sync.tick();
  assert.equal(f.calls.length, 5);
  f.sync.observe('1:active', null);
  f.sync.observe('1:row', watch('visible', 2));
  await f.sync.tick();
  f.sync.observe('1:detail', watch('active', 2));
  await f.sync.tick();
  assert.equal(f.calls.at(-1)?.priority, 'active');
});
void test('pause offline/hidden and during shared backoff; wake revalidates once', async () => {
  const f = fixture();
  f.sync.observe('1:a', watch());
  f.enabled(false);
  await f.sync.tick();
  assert.equal(f.calls.length, 0);
  f.enabled(true);
  f.backoff(80_000);
  await f.sync.tick();
  assert.equal(f.calls.length, 0);
  f.time(80_000);
  await f.sync.tick();
  assert.equal(f.calls.length, 1);
  f.time(90_000);
  f.sync.wake();
  await f.sync.tick();
  assert.equal(f.calls.length, 2);
  await f.sync.tick();
  assert.equal(f.calls.length, 2);
});
void test('disconnected windows and old-account subscriptions cannot request data', async () => {
  const f = fixture();
  f.sync.observe('1:a', watch());
  f.sync.observe('2:a', watch('visible', 2));
  f.sync.removeOwner('1');
  await f.sync.tick();
  assert.deepEqual(f.calls[0].urls, [target(2).url]);
  f.account('bob');
  f.time(200_000);
  await f.sync.tick();
  assert.equal(f.calls.length, 1);
  f.sync.observe('2:b', watch());
  await f.sync.tick();
  assert.equal(f.calls.length, 2);
});
void test('batching drains all visible rows without exceeding GitHub batch size', async () => {
  const f = fixture();
  f.sync.observe('1:rows', { ...watch('visible'), targets: Array.from({ length: 61 }, (_, n) => target(n + 1)) });
  await f.sync.tick();
  await f.sync.tick();
  await f.sync.tick();
  assert.deepEqual(
    f.calls.map((call) => call.urls.length),
    [25, 25, 11]
  );
  assert.equal(new Set(f.calls.flatMap((call) => call.urls)).size, 61);
});
void test('an invalidation during a read rejects its result and schedules a fresh read', async () => {
  let release!: (values: GitHubSyncUpdate[]) => void;
  const updates: GitHubSyncUpdate[][] = [];
  let calls = 0;
  const sync = createGitHubSyncService({
    account: () => 'alice',
    enabled: () => true,
    backoff: () => undefined,
    read: () => {
      calls++;
      return new Promise((resolve) => {
        release = resolve;
      });
    },
    publish: (result) => updates.push(result),
  });
  sync.observe('1:a', watch());
  const first = sync.tick();
  sync.invalidate([target().url]);
  const value: GitHubSyncUpdate = {
    kind: 'signals',
    url: target().url,
    value: { ...target(), checkedAt: 0, comments: 0, checks: { state: 'pending', total: 1, passed: 0 } },
  };
  release([value]);
  await first;
  assert.equal(updates.length, 0);
  const second = sync.tick();
  release([value]);
  await second;
  assert.equal(calls, 2);
  assert.equal(updates.length, 1);
});
void test('failed requests back off and retain existing snapshots', async () => {
  let now = 0,
    calls = 0;
  const failures: unknown[] = [];
  const sync = createGitHubSyncService({
    now: () => now,
    account: () => 'alice',
    enabled: () => true,
    backoff: () => undefined,
    read: () => {
      calls++;
      return Promise.reject(Error('Offline'));
    },
    publish: () => assert.fail('failed reads must not replace cache'),
    failed: (value) => failures.push(value),
  });
  sync.observe('1:a', watch());
  await sync.tick();
  assert.equal(failures.length, 1);
  now = 29_999;
  await sync.tick();
  assert.equal(calls, 1);
  now = 30_000;
  await sync.tick();
  assert.equal(calls, 2);
  now = 60_000;
  await sync.tick();
  assert.equal(calls, 2);
});
void test('switching accounts while a request runs discards its result', async () => {
  let account = 'alice';
  let release!: (updates: GitHubSyncUpdate[]) => void;
  const published: unknown[] = [];
  const sync = createGitHubSyncService({
    account: () => account,
    enabled: () => true,
    backoff: () => undefined,
    read: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
    publish: (update) => published.push(update),
  });
  sync.observe('1:a', watch());
  const reading = sync.tick();
  account = 'bob';
  release([
    {
      kind: 'signals',
      url: target().url,
      value: { ...target(), checkedAt: 1, comments: 0, checks: { state: 'success', total: 1, passed: 1 } },
    },
  ]);
  await reading;
  assert.deepEqual(published, []);
});
void test('rapid navigation preserves freshness and does not refetch the same PR', async () => {
  const f = fixture();
  f.sync.observe('1:a', watch());
  await f.sync.tick();
  f.sync.observe('1:a', null);
  await f.sync.tick();
  f.sync.observe('1:b', watch());
  await f.sync.tick();
  assert.equal(f.calls.length, 1);
  f.time(1_000);
  f.sync.wake();
  await f.sync.tick();
  assert.equal(f.calls.length, 1);
  f.time(10_000);
  await f.sync.tick();
  assert.equal(f.calls.length, 2);
});
void test('a depleted REST budget does not stop GraphQL signals', async () => {
  const kinds: string[] = [];
  const sync = createGitHubSyncService({
    account: () => 'alice',
    now: () => 0,
    enabled: () => true,
    backoff: (kind) => (kind === 'metadata' ? { retryAt: 60_000, message: 'GitHub API limit reached' } : undefined),
    read: (kind) => {
      kinds.push(kind);
      return Promise.resolve([]);
    },
    publish: () => {},
  });
  sync.observe('1:signals', watch());
  sync.observe('1:metadata', { ...watch(), kind: 'metadata' });
  await sync.tick();
  assert.deepEqual(kinds, ['signals']);
});
void test('recovery republishes unchanged data so screens can clear an error', async () => {
  let now = 0,
    fail = false;
  const published: unknown[] = [];
  const value: GitHubSyncUpdate = {
    kind: 'discussion',
    url: target().url,
    value: { headSha: 'head', baseSha: 'base', threads: [] },
  };
  const sync = createGitHubSyncService({
    now: () => now,
    account: () => 'alice',
    enabled: () => true,
    backoff: () => undefined,
    read: () => (fail ? Promise.reject(Error('Offline')) : Promise.resolve([value])),
    publish: (values) => published.push(values),
  });
  sync.observe('1:a', { ...watch(), kind: 'discussion' });
  await sync.tick();
  assert.equal(published.length, 1);
  now = 60_000;
  fail = true;
  await sync.tick();
  now = 90_000;
  fail = false;
  await sync.tick();
  assert.equal(published.length, 2);
});

void test('IPC subscriptions reject malformed URLs, revisions and unbounded batches', () => {
  assert.deepEqual(parseGitHubSyncInterest(watch()), watch());
  assert.equal(parseGitHubSyncInterest(null), null);
  assert.equal(parseGitHubSyncInterest({ ...watch(), targets: [null] }), undefined);
  assert.equal(parseGitHubSyncInterest({ ...watch(), targets: [{ url: 'file:///etc/passwd' }] }), undefined);
  assert.equal(parseGitHubSyncInterest({ ...watch(), targets: [{ ...target(), headSha: 'bad' }] }), undefined);
  assert.equal(
    parseGitHubSyncInterest({ ...watch(), targets: Array.from({ length: 201 }, () => target()) }),
    undefined
  );
});

void test('rerun follow-up uses reserved allowance only for the affected PR and still honors real limits', async () => {
  let now = 0;
  let limited = false;
  const calls: string[] = [];
  const failures: { message: string; retryAt: number }[] = [];
  const sync = createGitHubSyncService({
    now: () => now,
    account: () => 'alice',
    enabled: () => true,
    backoff: (_kind, background) =>
      limited
        ? { retryAt: 90_000, message: 'GitHub API limit reached' }
        : background
          ? { retryAt: 300_000, message: 'Background updates paused to preserve API allowance' }
          : undefined,
    failed: (values) => failures.push(...values),
    read: (kind, targets) => {
      calls.push(...targets.map((t) => t.url));
      return Promise.resolve(
        targets.map((t) => ({
          kind: 'checks' as const,
          url: t.url,
          value: { ...t, headSha: t.headSha ?? '', checkedAt: now, checks: [] },
        }))
      );
    },
    publish: () => {},
  });
  sync.observe('1:checks', { kind: 'checks', priority: 'active', targets: [target(), target(2)] });
  await sync.tick();
  assert.equal(calls.length, 0);
  assert.equal(failures[0].message, 'Background updates paused to preserve API allowance');
  assert.equal(failures[0].retryAt, 300_000);
  sync.invalidate([target().url], ['checks'], { followUp: true });
  await sync.tick();
  assert.deepEqual(calls, [target().url]);
  now = 30_000;
  limited = true;
  await sync.tick();
  assert.equal(calls.length, 1, 'Real rate limits still apply to user-triggered follow-up');
  now = 90_000;
  limited = false;
  await sync.tick();
  assert.equal(calls.length, 2);
  now = 120_000;
  await sync.tick();
  assert.equal(calls.length, 2, 'Follow-up expires; ordinary polling cannot drain the reserve');
});

void test('checks batch five PRs and follow reruns quickly with a bounded allowance', async () => {
  let now = 0;
  const batches: string[][] = [];
  const sync = createGitHubSyncService({
    now: () => now,
    account: () => 'alice',
    enabled: () => true,
    backoff: () => undefined,
    read: (_kind, targets) => {
      batches.push(targets.map((t) => t.url));
      return Promise.resolve(
        targets.map((t) => ({
          kind: 'checks' as const,
          url: t.url,
          value: { ...t, headSha: t.headSha ?? '', checkedAt: now, checks: [] },
        }))
      );
    },
    publish: () => {},
  });
  sync.observe('1:stack', {
    kind: 'checks',
    priority: 'active',
    targets: Array.from({ length: 6 }, (_, i) => target(i + 1)),
  });
  await sync.tick();
  await sync.tick();
  assert.deepEqual(
    batches.map((b) => b.length),
    [5, 1]
  );
  sync.observe('1:stack', { kind: 'checks', priority: 'active', targets: [target()] });
  sync.invalidate([target().url], ['checks'], { followUp: true });
  for (now = 0; now <= 15_000; now += 5_000) await sync.tick();
  assert.equal(batches.length, 6);
  now = 19_999;
  await sync.tick();
  assert.equal(batches.length, 6);
  now = 20_000;
  await sync.tick();
  // The short follow-up has ended; ordinary adaptive polling resumes.
  assert.equal(batches.length, 6);
  now = 25_000;
  await sync.tick();
  assert.equal(batches.length, 6);
});
