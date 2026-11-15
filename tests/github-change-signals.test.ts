import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createChangeSignals,
  changedPrQueries,
  notificationPrUrl,
  parseChangedPrs,
  planChangedPrs,
  planNotifications,
  CHANGE_PAGE,
  NOTIFICATIONS_INTERVAL_MS,
  NOTIFICATIONS_RECHECK_MS,
  SEARCH_FIRST_LOOKBACK_MS,
  SEARCH_INTERVAL_MS,
  SEARCH_OVERLAP_MS,
  type ChangeSignalsDeps,
  type ChangedPr,
  type NotificationsResponse,
} from '../lib/github-change-signals';
import { WATCH_INTERVAL_MS, type SyncMode } from '../lib/notification-cadence';

const pr = (n: number, repo = 'acme/app') => `https://github.com/${repo}/pull/${n}`;
const api = (n: number, repo = 'acme/app') => `https://api.github.com/repos/${repo}/pulls/${n}`;
const sha = (c: string) => c.repeat(40);
const thread = (id: string, n: number | null, updated: string, reason = 'comment', type = 'PullRequest') => ({
  id,
  reason,
  unread: true,
  updated_at: updated,
  subject: { type, url: n === null ? null : type === 'PullRequest' ? api(n) : `https://api.github.com/repos/acme/app/issues/${n}`, title: `#${n}` },
  repository: { full_name: 'acme/app' },
});
const T0 = Date.parse('2026-11-15T09:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();

void test('notification subjects map to github.com PRs only', () => {
  assert.equal(notificationPrUrl(thread('1', 7, iso(T0))), pr(7));
  assert.equal(notificationPrUrl(thread('2', 7, iso(T0), 'comment', 'Issue')), undefined, 'issues are not PRs');
  assert.equal(notificationPrUrl(thread('3', null, iso(T0))), undefined, 'some subjects have no URL');
  assert.equal(
    notificationPrUrl({ subject: { type: 'PullRequest', url: 'https://ghe.example.com/api/v3/repos/acme/app/pulls/7' } }),
    undefined,
    'other hosts are left to their own sync'
  );
});

void test('a notifications page names changed known PRs, asks discovery for unknown ones, and the first page only sets the cursor', () => {
  const threads = [
    thread('1', 1, iso(T0 + 3_000), 'comment'),
    thread('2', 2, iso(T0 + 2_000), 'review_requested'),
    thread('3', 3, iso(T0 + 1_000), 'subscribed'),
    thread('4', 4, iso(T0 - 1_000), 'comment'),
    thread('5', 5, iso(T0 + 4_000), 'mention', 'Issue'),
    { junk: true },
  ];
  const known = (url: string) => url === pr(1) || url === pr(4);
  const first = planNotifications(threads, undefined, known);
  assert.deepEqual(first.refresh, [], 'launch discovery covers what came before');
  assert.equal(first.cursor, T0 + 4_000);
  const plan = planNotifications(threads, T0, known);
  assert.deepEqual(plan.refresh, [pr(1)], 'PR 4 is older than the cursor');
  assert.deepEqual(plan.discover, [pr(2)], 'a new review request brings discovery forward');
  assert.equal(plan.saturated, false);
  const full = Array.from({ length: CHANGE_PAGE }, (_, i) => thread(String(i), i + 1, iso(T0 + 1_000 + i)));
  assert.equal(planNotifications(full, T0, () => true).saturated, true, 'a full page of new threads may hide more');
});

void test('the search query covers involvement and team review requests with a whole-second cursor', () => {
  const q = changedPrQueries(T0 + 1_500);
  assert.equal(q.involves, 'is:pr involves:@me updated:>=2026-11-15T09:00:01Z sort:updated-desc');
  assert.equal(q.requested, 'is:pr review-requested:@me updated:>=2026-11-15T09:00:01Z sort:updated-desc');
});

void test('search results merge both aliases, keep only ids, links, times and heads, and report truncation and cost', () => {
  const node = (n: number, updated: number, head = 'a') => ({ id: `PR_${n}`, url: pr(n), updatedAt: iso(updated), headRefOid: sha(head), title: 'ignored' });
  const parsed = parseChangedPrs({
    rateLimit: { cost: 1, remaining: 4999 },
    involves: { issueCount: 2, nodes: [node(1, T0), node(2, T0), {}] },
    requested: { issueCount: 60, nodes: [node(2, T0 + 5), { url: 'https://example.com/x' }] },
  });
  assert.equal(parsed.cost, 1);
  assert.equal(parsed.truncated, true);
  assert.deepEqual(parsed.prs.map((p) => [p.url, p.updatedAt]), [[pr(1), iso(T0)], [pr(2), iso(T0 + 5)]]);
  assert.deepEqual(Object.keys(parsed.prs[0]).sort(), ['headRefOid', 'id', 'updatedAt', 'url']);
});

void test('only PRs newer than the saved copy, or on another head, are read again', () => {
  const prs: ChangedPr[] = [
    { id: '1', url: pr(1), updatedAt: iso(T0), headRefOid: sha('a') },
    { id: '2', url: pr(2), updatedAt: iso(T0 + 1_000), headRefOid: sha('a') },
    { id: '3', url: pr(3), updatedAt: iso(T0), headRefOid: sha('b') },
    { id: '4', url: pr(4), updatedAt: iso(T0), headRefOid: sha('a') },
  ];
  const saved = new Map([
    [pr(1), { updatedAt: iso(T0), headSha: sha('a') }],
    [pr(2), { updatedAt: iso(T0), headSha: sha('a') }],
    [pr(3), { updatedAt: iso(T0), headSha: sha('a') }],
  ]);
  assert.deepEqual(planChangedPrs(prs, (url) => saved.get(url)), { refresh: [pr(2), pr(3)], discover: [pr(4)] });
});

function harness(overrides: Partial<ChangeSignalsDeps> = {}) {
  const clock = { now: T0 };
  let mode: SyncMode = 'sync';
  let idle = 0;
  let account: string | null = 'oddur';
  const feed: { responses: (NotificationsResponse | Error)[]; validators: { lastModified?: string; etag?: string }[] } = { responses: [], validators: [] };
  const searches: { queries: { involves: string; requested: string }; at: number }[] = [];
  let searchResult: ChangedPr[] = [];
  const saved = new Map<string, { updatedAt: string; headSha: string }>();
  const refreshed: { urls: string[]; source: string }[] = [];
  const heads: [string, string][] = [];
  const discoveries: string[] = [];
  const logs: string[] = [];
  const deps: ChangeSignalsDeps = {
    now: () => clock.now,
    mode: () => mode,
    idleSeconds: () => idle,
    account: () => account,
    notifications: (validators) => {
      feed.validators.push(validators);
      const next = feed.responses.shift() ?? { status: 304 };
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    },
    search: (queries) => {
      searches.push({ queries, at: clock.now });
      return Promise.resolve({ prs: searchResult, cost: 1, truncated: false });
    },
    known: (url) => saved.get(url),
    head: (url, head) => heads.push([url, head]),
    refresh: (urls, source) => {
      refreshed.push({ urls, source });
      return Promise.resolve();
    },
    discover: (source) => discoveries.push(source),
    log: (line) => logs.push(line),
    ...overrides,
  };
  const signals = createChangeSignals(deps);
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const tick = async () => {
    signals.tick();
    await settle();
    await settle();
  };
  return {
    clock, signals, feed, searches, saved, refreshed, heads, discoveries, logs, tick,
    setMode: (value: SyncMode) => { mode = value; },
    setIdle: (value: number) => { idle = value; },
    setAccount: (value: string | null) => { account = value; },
    setSearch: (value: ChangedPr[]) => { searchResult = value; },
  };
}

void test('the feed sends its validators back, a 304 refreshes nothing, and X-Poll-Interval sets the gap', async () => {
  const h = harness();
  h.saved.set(pr(1), { updatedAt: iso(T0 - 60_000), headSha: sha('a') });
  h.feed.responses.push({ status: 200, threads: [thread('1', 1, iso(T0 - 10_000))], lastModified: 'Sun, 15 Nov 2026 08:59:50 GMT', etag: 'W/"one"', pollInterval: 90 });
  await h.tick();
  assert.deepEqual(h.feed.validators, [{ lastModified: undefined, etag: undefined }]);
  assert.deepEqual(h.refreshed, [], 'the first page sets the cursor');
  h.clock.now += 60_000;
  await h.tick();
  assert.equal(h.feed.validators.length, 1, 'X-Poll-Interval: 90 s, not 60 s');
  h.clock.now += 30_000;
  h.feed.responses.push({ status: 304, pollInterval: 90 });
  await h.tick();
  assert.deepEqual(h.feed.validators[1], { lastModified: 'Sun, 15 Nov 2026 08:59:50 GMT', etag: 'W/"one"' });
  assert.deepEqual(h.refreshed, [], 'a 304 names no PR');
  assert.equal(h.signals.stats().notifications.notModified, 1);
  assert.ok(h.logs.some((line) => line.includes('304 not modified (free)')), 'each sweep logs what it cost');
  h.clock.now += 90_000;
  h.feed.responses.push({ status: 200, threads: [thread('1', 1, iso(T0 + 120_000)), thread('9', 9, iso(T0 + 100_000), 'review_requested')], lastModified: 'later', pollInterval: 60 });
  await h.tick();
  assert.deepEqual(h.refreshed, [{ urls: [pr(1)], source: 'notifications' }], 'only the changed PR is read');
  assert.deepEqual(h.discoveries, ['notifications'], 'an unknown requested PR brings discovery forward');
});

void test('a token without notifications access falls back to the search quietly and logs once', async () => {
  const h = harness();
  const logged: string[] = [];
  const original = console.log;
  console.log = (line: string) => logged.push(line);
  try {
    h.feed.responses.push({ status: 'unavailable', code: 403 });
    await h.tick();
    assert.equal(h.signals.notificationsUnavailable(), true);
    assert.equal(h.searches.length, 1, 'the search still runs');
    h.clock.now += 60 * 60_000;
    await h.tick();
    assert.equal(h.feed.validators.length, 1, 'no retry within the recheck interval');
    h.clock.now += NOTIFICATIONS_RECHECK_MS;
    h.feed.responses.push({ status: 'unavailable', code: 404 });
    await h.tick();
    assert.equal(h.feed.validators.length, 2, 'asked again later: the reader can grant the scope');
    assert.equal(logged.filter((line) => line.includes('notifications feed is not available')).length, 1, 'logged once');
    assert.equal(h.signals.healthy(), true, 'the search alone keeps signals healthy');
  } finally {
    console.log = original;
  }
});

void test('the search cursor is per account, starts with a short lookback and overlaps the previous search', async () => {
  const h = harness();
  await h.tick();
  const since = (i: number) => /updated:>=(\S+)/.exec(h.searches[i].queries.involves)?.[1];
  assert.equal(since(0), iso(T0 - SEARCH_FIRST_LOOKBACK_MS).replace('.000Z', 'Z'));
  assert.equal(h.signals.cursor('oddur'), T0);
  h.clock.now += SEARCH_INTERVAL_MS;
  await h.tick();
  assert.equal(h.searches.length, 2);
  assert.equal(since(1), iso(T0 - SEARCH_OVERLAP_MS).replace('.000Z', 'Z'), 'the previous start, less the overlap');
  h.setAccount('other');
  await h.tick();
  assert.equal(since(2), iso(h.clock.now - SEARCH_FIRST_LOOKBACK_MS).replace('.000Z', 'Z'), 'another account has its own cursor');
  assert.equal(h.signals.cursor('oddur'), T0 + SEARCH_INTERVAL_MS);
});

void test('the search reports heads and reads only PRs that changed', async () => {
  const h = harness();
  h.saved.set(pr(1), { updatedAt: iso(T0 - 60_000), headSha: sha('a') });
  h.saved.set(pr(2), { updatedAt: iso(T0 - 60_000), headSha: sha('a') });
  h.setSearch([
    { id: '1', url: pr(1), updatedAt: iso(T0 - 60_000), headRefOid: sha('a') },
    { id: '2', url: pr(2), updatedAt: iso(T0 - 1_000), headRefOid: sha('b') },
    { id: '3', url: pr(3), updatedAt: iso(T0 - 1_000), headRefOid: sha('c') },
  ]);
  h.feed.responses.push({ status: 304 });
  await h.tick();
  assert.deepEqual(h.refreshed, [{ urls: [pr(2)], source: 'search' }]);
  assert.deepEqual(h.heads, [[pr(1), sha('a')], [pr(2), sha('b')]], 'every known PR reports its head to noteHeadSha');
  assert.deepEqual(h.discoveries, ['search']);
  assert.equal(h.signals.stats().search.points, 1);
});

void test('a PR discovery leaves out asks for discovery once per update, and a muted PR never does', async () => {
  const h = harness({ ignored: (url) => url === pr(9) });
  h.setSearch([
    { id: '3', url: pr(3), updatedAt: iso(T0 - 1_000), headRefOid: sha('c') },
    { id: '9', url: pr(9), updatedAt: iso(T0 - 1_000), headRefOid: sha('d') },
  ]);
  await h.tick();
  assert.deepEqual(h.discoveries, ['search']);
  h.clock.now += SEARCH_INTERVAL_MS;
  await h.tick();
  assert.deepEqual(h.discoveries, ['search'], 'the overlap returns it again: no second discovery');
  h.setSearch([{ id: '9', url: pr(9), updatedAt: iso(h.clock.now), headRefOid: sha('d') }]);
  h.clock.now += SEARCH_INTERVAL_MS;
  await h.tick();
  assert.deepEqual(h.discoveries, ['search'], 'a muted PR is never a reason');
});

void test('nothing runs while sync is off, and watch mode or an idle reader slows to the watch cadence', async () => {
  const h = harness();
  h.setMode('off');
  for (let i = 0; i < 5; i++) {
    h.clock.now += 10 * 60_000;
    await h.tick();
  }
  assert.equal(h.feed.validators.length + h.searches.length, 0, 'off: no request at all');
  h.setMode('sync');
  await h.tick();
  assert.equal(h.feed.validators.length, 1);
  h.setIdle(600);
  h.clock.now += NOTIFICATIONS_INTERVAL_MS;
  await h.tick();
  assert.equal(h.feed.validators.length, 2, 'the due time set before the reader left still holds');
  h.clock.now += NOTIFICATIONS_INTERVAL_MS;
  await h.tick();
  assert.equal(h.feed.validators.length, 2, 'idle: the next poll waits for the watch cadence');
  h.clock.now += WATCH_INTERVAL_MS;
  await h.tick();
  assert.equal(h.feed.validators.length, 3);
  h.setIdle(0);
  h.setMode('watch');
  h.clock.now += NOTIFICATIONS_INTERVAL_MS;
  await h.tick();
  assert.equal(h.feed.validators.length, 3, 'watch mode keeps the watch cadence');
});

void test('rate limits and failures back off, and a source never overlaps itself', async () => {
  let release: (() => void) | undefined;
  let calls = 0;
  const h = harness({
    notifications: () => {
      calls++;
      if (calls === 1) return Promise.reject(Object.assign(new Error('limited'), { retryAt: T0 + 30 * 60_000 }));
      return new Promise<NotificationsResponse>((resolve) => { release = () => resolve({ status: 304 }); });
    },
  });
  await h.tick();
  h.clock.now += 10 * 60_000;
  await h.tick();
  assert.equal(calls, 1, 'waits for the rate limit');
  h.clock.now = T0 + 30 * 60_000;
  await h.tick();
  assert.equal(calls, 2);
  for (let i = 0; i < 5; i++) {
    h.clock.now += 120_000;
    await h.tick();
  }
  assert.equal(calls, 2, 'one request in flight at a time');
  release?.();
});

void test('budget pauses skip a source without spending a request', async () => {
  const h = harness({ blockedUntil: (resource) => (resource === 'graphql' ? T0 + 60_000 : undefined) });
  await h.tick();
  assert.equal(h.feed.validators.length, 1);
  assert.equal(h.searches.length, 0, 'GraphQL is paused');
  h.clock.now += 60_000;
  await h.tick();
  assert.equal(h.searches.length, 1);
});

void test('waking respects the feed interval, so focus changes cannot poll in a tight loop', async () => {
  const h = harness();
  await h.tick();
  for (let i = 0; i < 20; i++) {
    h.signals.wake();
    h.clock.now += 1_000;
    await h.tick();
  }
  assert.equal(h.feed.validators.length, 1, 'no second poll within the poll interval');
  assert.equal(h.searches.length, 1, 'no second search within 30 s');
});
