/**
 * #385 part 1, "Noise": per-repository levels, bots, settled checks, one notification per PR and clear when handled.
 * Desktop notifications go through the service's injected `desktop` dependency; nothing is shown on this machine.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  botAllowed,
  levelAllows,
  normalizeBotLogins,
  notificationSettings,
  repositoryNotificationLevel,
  NOTIFICATION_EVENT_TYPES,
  REPOSITORY_NOTIFICATION_LEVELS,
  type NotificationEventType,
  type NotificationPreferences,
  type RepositoryNotificationLevel,
} from '../lib/notification-settings';
import { normalizeRepositorySettings } from '../lib/repository-settings';
import { checksLine, eventGate, eventLine, quietSummary, QUIET_MS, URGENCY, type NotificationDelivery } from '../lib/notification-routing';
import { CHECKS_SETTLE_CAP_MS, deriveEvents, type PrBasis, type NotificationEvent, type PrObservation } from '../lib/notification-events';
import { createNotificationService, type DesktopNotification, type DesktopNotificationOptions } from '../src/notification-service';
import { prTarget } from '../lib/deep-link';
import type { QueueSignals } from '../lib/queue-signals';
import type { ReviewMember } from '../lib/workbench';
import { LOGIN, T0, member, mine, signals } from './notification-fixtures';

// ── Levels ──

/** Events that "Only when it's on me" keeps on any PR, and those it keeps only on your own PRs. */
const ON_ME_ANY: readonly NotificationEventType[] = ['review-requested', 'rereview', 'mention', 'reply', 'snooze-ended', 'explanation-ready'];
const ON_ME_MINE: readonly NotificationEventType[] = ['changes-requested', 'checks-failed', 'ready-to-merge'];
const prefs = (level: RepositoryNotificationLevel | undefined, events: Partial<Record<NotificationEventType, boolean>> = {}, extra: Record<string, unknown> = {}) =>
  notificationSettings({
    watchedRepos: ['o/watched'],
    repositorySettings: level ? { 'o/r': { notifications: level } } : {},
    notificationSettings: { events, ...extra },
  });

test('every event × level × global switch: the global switch is the ceiling, a level only narrows it', () => {
  for (const type of NOTIFICATION_EVENT_TYPES) {
    for (const level of REPOSITORY_NOTIFICATION_LEVELS) {
      for (const globalOn of [true, false]) {
        for (const mine of [true, false]) {
          const settings = prefs(level, { [type]: globalOn });
          const reason = eventGate({ type, repo: 'o/r', url: 'https://github.com/o/r/pull/1', mine }, settings);
          const allowedByLevel = level === 'all' || (level === 'on-me' && (ON_ME_ANY.includes(type) || (ON_ME_MINE.includes(type) && mine)));
          const label = `${type} level=${level} global=${globalOn} mine=${mine}`;
          if (!globalOn) assert.equal(reason, 'type-off', label);
          else assert.equal(reason, allowedByLevel ? undefined : 'repository', label);
          assert.equal(levelAllows(level, { type, mine }), allowedByLevel, label);
        }
      }
    }
  }
});

test('"on me" leaves out team review requests, approvals, and own-PR events on other people\'s PRs', () => {
  assert.equal(levelAllows('on-me', { type: 'team-review-requested' }), false);
  assert.equal(levelAllows('on-me', { type: 'approved', mine: true }), false);
  assert.equal(levelAllows('on-me', { type: 'checks-failed', mine: false }), false);
  assert.equal(levelAllows('on-me', { type: 'checks-failed' }), false);
  assert.equal(levelAllows('on-me', { type: 'checks-failed', mine: true }), true);
  assert.equal(levelAllows('on-me', { type: 'review-requested' }), true);
  assert.equal(levelAllows('on-me', { type: 'mention' }), true);
  assert.equal(levelAllows('on-me', { type: 'reply' }), true);
});

test('a repository level, then All for watched repositories, then the "Other repositories" default', () => {
  const settings = notificationSettings({
    watchedRepos: ['O/Watched', 'o/quiet'],
    repositorySettings: { 'o/quiet': { notifications: 'none' }, 'x/y': { notifications: 'on-me' } },
    notificationSettings: { otherRepositories: 'on-me' },
  });
  assert.equal(repositoryNotificationLevel(settings, 'o/watched'), 'all');
  assert.equal(repositoryNotificationLevel(settings, 'O/QUIET'), 'none');
  assert.equal(repositoryNotificationLevel(settings, 'x/y'), 'on-me');
  assert.equal(repositoryNotificationLevel(settings, 'someone/else'), 'on-me');
  // The default default is All, so nothing changes for existing users.
  assert.equal(repositoryNotificationLevel(notificationSettings({}), 'someone/else'), 'all');
  // update-ready has no repository and is never narrowed.
  assert.equal(eventGate({ type: 'update-ready' }, notificationSettings({ notificationSettings: { otherRepositories: 'none' } })), undefined);
  // An event without `repo` is matched by its URL.
  assert.equal(eventGate({ type: 'explanation-ready', url: 'https://github.com/o/quiet/pull/3' }, settings), 'repository');
});

test('repository levels are normalized in RepositorySettings, and invalid values are dropped', () => {
  assert.deepEqual(normalizeRepositorySettings({ 'O/R': { notifications: 'on-me' }, 'a/b': { notifications: 'some' }, 'c/d': { notifications: 'none', color: 'blue' } }), {
    'o/r': { notifications: 'on-me' },
    'c/d': { color: 'blue', notifications: 'none' },
  });
  const settings = notificationSettings({ repositorySettings: { 'o/r': { notifications: 'none' }, bad: { notifications: 'none' }, 'a/b': { notifications: 7 } }, notificationSettings: { otherRepositories: 'loud' } });
  assert.deepEqual(settings.repositories, { 'o/r': 'none' });
  assert.equal(settings.otherRepositories, 'all');
});

// ── Bots ──

test('bots never notify unless allowed; either login form matches the allow list', () => {
  const event = { type: 'changes-requested' as const, repo: 'o/r', mine: true };
  assert.equal(eventGate({ ...event, actor: 'coderabbitai[bot]' }, prefs(undefined)), 'bot');
  assert.equal(eventGate({ ...event, actor: 'github-actions' }, prefs(undefined)), 'bot');
  // GraphQL names an App without the suffix: the signals' type says it is a bot.
  assert.equal(eventGate({ ...event, actor: 'coderabbitai', actorIsBot: true }, prefs(undefined)), 'bot');
  assert.equal(eventGate({ ...event, actor: 'lena' }, prefs(undefined)), undefined);
  const allowed = prefs(undefined, {}, { allowedBots: ['CodeRabbitAI[bot]'] });
  assert.deepEqual(allowed.allowedBots, ['coderabbitai[bot]']);
  assert.equal(eventGate({ ...event, actor: 'coderabbitai[bot]' }, allowed), undefined);
  assert.equal(eventGate({ ...event, actor: 'coderabbitai', actorIsBot: true }, allowed), undefined);
  assert.equal(botAllowed(allowed, 'dependabot[bot]'), false);
  assert.deepEqual(normalizeBotLogins(['a[bot]', 'A[bot]', ' b ', 'not a login', 3, '-x']), ['a[bot]', 'b']);
});

test('a review from an App is marked as a bot from the signals, even without the [bot] suffix', () => {
  const pr = mine(1);
  const start = deriveEvents(undefined, { member: pr, signals: signals(pr, { opinions: [] }) }, { login: LOGIN, now: T0, initialized: true }).basis;
  const value = signals(pr, { checkedAt: T0 + 1, opinions: [{ id: '9', author: 'coderabbitai', state: 'CHANGES_REQUESTED' }] });
  value.activity = { recent: [{ kind: 'review', id: `${pr.url}#pullrequestreview-9`, at: '2026-11-14T09:00:00Z', author: 'coderabbitai', automated: true }] };
  const { events } = deriveEvents(start, { member: pr, signals: value }, { login: LOGIN, now: T0 + 60_000, initialized: true });
  assert.equal(events[0]?.type, 'changes-requested');
  assert.equal(events[0]?.actorIsBot, true);
  assert.equal(events[0]?.mine, true);
});

// ── Checks failed when the run settles ──

const running = (pr: ReviewMember, checkedAt: number, state: QueueSignals['checks']['state'], failed: number, runningCount: number, total = 14): QueueSignals => ({
  ...signals(pr, { checks: state, checkedAt }),
  checks: { state, passed: total - failed - runningCount, failed, running: runningCount, total },
});
function steps(pr: ReviewMember, observations: { at: number; signals: QueueSignals; member?: ReviewMember }[]) {
  let basis: PrBasis | undefined;
  const fired: { at: number; event: NotificationEvent }[] = [];
  for (const step of observations) {
    const result = deriveEvents(basis, { member: step.member ?? pr, signals: step.signals }, { login: LOGIN, now: step.at, initialized: true });
    basis = result.basis;
    for (const event of result.events) fired.push({ at: step.at, event });
  }
  return fired;
}

test('checks failed waits until no checks are pending, and says how many of how many failed', () => {
  const pr = mine(1);
  const fired = steps(pr, [
    { at: T0, signals: running(pr, T0, 'pending', 0, 14) },
    { at: T0 + 60_000, signals: running(pr, T0 + 60_000, 'failure', 1, 10) },
    { at: T0 + 120_000, signals: running(pr, T0 + 120_000, 'failure', 2, 3) },
    { at: T0 + 180_000, signals: running(pr, T0 + 180_000, 'failure', 2, 0) },
    { at: T0 + 240_000, signals: running(pr, T0 + 240_000, 'failure', 2, 0) },
  ]);
  assert.deepEqual(fired.map(({ at, event }) => [at - T0, event.type]), [[180_000, 'checks-failed']]);
  assert.deepEqual(fired[0].event.checks, { failed: 2, total: 14, headSha: pr.headSha });
  assert.equal(eventLine(fired[0].event), '2 of 14 checks failed');
  assert.equal(eventLine({ ...fired[0].event, checks: { ...fired[0].event.checks!, names: ['test-windows', 'lint'] } }), '2 of 14 checks failed: test-windows, lint');
});

test('checks failed fires after 20 minutes even while a job is still pending', () => {
  const pr = mine(1);
  const fired = steps(pr, [
    { at: T0, signals: running(pr, T0, 'pending', 0, 14) },
    { at: T0 + 60_000, signals: running(pr, T0 + 60_000, 'failure', 1, 5) },
    { at: T0 + 60_000 + CHECKS_SETTLE_CAP_MS - 1, signals: running(pr, T0 + 60_000 + CHECKS_SETTLE_CAP_MS - 1, 'failure', 1, 1) },
    { at: T0 + 60_000 + CHECKS_SETTLE_CAP_MS, signals: running(pr, T0 + 60_000 + CHECKS_SETTLE_CAP_MS, 'failure', 1, 1) },
  ]);
  assert.deepEqual(fired.map(({ at }) => at - T0), [60_000 + CHECKS_SETTLE_CAP_MS]);
});

test('checks failed fires again only after a new commit', () => {
  const pr = mine(1);
  const next = { ...pr, headSha: 'head-2' };
  const fired = steps(pr, [
    { at: T0, signals: running(pr, T0, 'pending', 0, 2, 2) },
    { at: T0 + 1_000, signals: running(pr, T0 + 1_000, 'failure', 1, 0, 2) },
    // A rerun goes green, then fails again on the same commit: no second notification.
    { at: T0 + 2_000, signals: running(pr, T0 + 2_000, 'success', 0, 0, 2) },
    { at: T0 + 3_000, signals: running(pr, T0 + 3_000, 'failure', 1, 0, 2) },
    { at: T0 + 4_000, member: next, signals: running(next, T0 + 4_000, 'pending', 0, 2, 2) },
    { at: T0 + 5_000, member: next, signals: running(next, T0 + 5_000, 'failure', 2, 0, 2) },
  ]);
  const keys = new Set<string>();
  const delivered = fired.filter(({ event }) => !keys.has(event.key) && keys.add(event.key));
  assert.deepEqual(delivered.map(({ event }) => event.key), [`checks-failed|${pr.url}|head-1`, `checks-failed|${pr.url}|head-2`]);
});

test('checks text: singular, all failed, and more than three names', () => {
  assert.equal(checksLine({ failed: 1, total: 1, headSha: 'a' }), '1 check failed');
  assert.equal(checksLine({ failed: 3, total: 3, headSha: 'a', names: ['a', 'b', 'c'] }), '3 checks failed: a, b, c');
  assert.equal(checksLine({ failed: 5, total: 9, headSha: 'a', names: ['a', 'b', 'c', 'd', 'e'] }), '5 of 9 checks failed: a, b, c +2');
});

// ── Resolved: what the notification asked for is done ──

test('the observation says which requests are handled: review submitted, checks green, merged', () => {
  const pr = member(1, { requestedReviewers: [LOGIN] });
  const context = { login: LOGIN, now: T0, initialized: true };
  assert.ok(!deriveEvents(undefined, { member: pr }, context).resolved.includes('review-requested'));
  assert.ok(deriveEvents(undefined, { member: { ...pr, requestedReviewers: [] } }, context).resolved.includes('review-requested'));
  const own = mine(2);
  assert.ok(deriveEvents(undefined, { member: own, signals: signals(own, { checks: 'success' }) }, context).resolved.includes('checks-failed'));
  assert.ok(!deriveEvents(undefined, { member: own, signals: signals(own, { checks: 'failure' }) }, context).resolved.includes('checks-failed'));
  const merged = deriveEvents(undefined, { member: { ...own, merged: true, state: 'closed' } }, context).resolved;
  for (const type of ['review-requested', 'checks-failed', 'ready-to-merge', 'mention', 'reply', 'approved'] as const) assert.ok(merged.includes(type), type);
});

// ── One notification per PR ──

function harness(options: { focused?: boolean; prefs?: NotificationPreferences; extra?: Record<string, unknown> } = {}) {
  let clock = T0;
  const timers: { at: number; fn: () => void; id: number }[] = [];
  let ids = 0;
  const state = { focused: options.focused ?? false, activeUrl: undefined as string | undefined };
  const desktop: (DesktopNotificationOptions & { closed: boolean; emit: (event: string) => void })[] = [];
  const toasts: NotificationDelivery[] = [];
  const closedToasts: string[][] = [];
  const counts: string[] = [];
  const service = createNotificationService({
    settings: () => notificationSettings({ notifications: true, notificationSettings: { introduced: true, ...options.prefs }, ...options.extra }),
    focus: () => state,
    desktop: {
      supported: () => true,
      create: (value) => {
        const listeners = new Map<string, (() => void)[]>();
        const handle = { ...value, closed: false, emit: (event: string) => listeners.get(event)?.forEach((fn) => fn()) };
        desktop.push(handle);
        const notification: DesktopNotification = {
          on: ((event: string, fn: () => void) => { listeners.set(event, [...(listeners.get(event) ?? []), fn]); }) as DesktopNotification['on'],
          show: () => {},
          close: () => {
            handle.closed = true;
            handle.emit('close');
          },
        };
        return notification;
      },
    },
    toast: (delivery) => (toasts.push(delivery), true),
    closeToasts: (urls) => closedToasts.push(urls),
    open: () => {},
    count: (kind, field) => counts.push(`${kind}:${field}`),
    formatTime: (at) => `t+${Math.floor((at - T0) / 60_000)}m`,
    now: () => clock,
    setTimer: (fn, ms) => {
      const id = ++ids;
      timers.push({ at: clock + ms, fn, id });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: (timer) => {
      const index = timers.findIndex((t) => t.id === (timer as unknown as number));
      if (index >= 0) timers.splice(index, 1);
    },
  });
  const advance = (ms: number) => {
    const end = clock + ms;
    for (;;) {
      const due = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at).at(0);
      if (!due) break;
      timers.splice(timers.indexOf(due), 1);
      clock = Math.max(clock, due.at);
      due.fn();
    }
    clock = end;
  };
  /** Delivers one event and lets its 20-second settle window pass. */
  const send = (event: NotificationEvent) => {
    service.deliver([event]);
    advance(20_000);
  };
  return { service, desktop, toasts, closedToasts, counts, state, advance, send };
}
let keys = 0;
const event = (type: NotificationEventType, n = 1, extra: Partial<NotificationEvent> = {}): NotificationEvent => ({
  type,
  key: `${type}|${n}|${++keys}`,
  title: `PR ${n}`,
  url: `https://github.com/o/r/pull/${n}`,
  repo: 'o/r',
  number: n,
  at: T0,
  mine: true,
  target: prTarget(`https://github.com/o/r/pull/${n}`, 'summary')!,
  ...extra,
});

test('priority order: review requested, changes requested and mention first; comments and approvals last', () => {
  assert.equal(URGENCY['review-requested'], 1);
  assert.equal(URGENCY['changes-requested'], 1);
  assert.equal(URGENCY.mention, 1);
  assert.equal(URGENCY['checks-failed'], 2);
  assert.equal(URGENCY.reply, 2);
  assert.equal(URGENCY['ready-to-merge'], 3);
  assert.equal(URGENCY.approved, 4);
});

test('a more urgent event closes the PR\'s notification and banners again', () => {
  const h = harness();
  h.send(event('ready-to-merge'));
  assert.equal(h.desktop.length, 1);
  h.advance(60_000);
  h.send(event('checks-failed'));
  assert.equal(h.desktop.length, 2);
  assert.equal(h.desktop[0].closed, true, 'the older notification is closed');
  assert.equal(h.desktop[1].closed, false);
  h.advance(60_000);
  h.send(event('changes-requested', 1, { actor: 'lena' }));
  assert.equal(h.desktop.length, 3);
  assert.equal(h.desktop[1].closed, true);
  assert.equal(h.desktop[2].title, 'Changes requested · PR 1');
});

test('an equal or less urgent event waits 15 minutes, then one summary replaces the notification', () => {
  const h = harness();
  h.send(event('checks-failed'));
  assert.equal(h.desktop.length, 1);
  h.advance(60_000);
  h.send(event('reply'));
  h.advance(60_000);
  h.send(event('reply'));
  h.send(event('approved'));
  h.send(event('reply'));
  assert.equal(h.desktop.length, 1, 'no new banner during the quiet period');
  assert.equal(h.counts.filter((entry) => entry.endsWith('suppressed:quiet')).length, 4);
  h.advance(QUIET_MS);
  assert.equal(h.desktop.length, 2);
  assert.equal(h.desktop[0].closed, true);
  assert.equal(h.desktop[1].title, '3 new comments · 1 approval since t+0m');
  assert.equal(h.desktop[1].body, 'PR 1');
  // The summary starts a new quiet period; after it, a lone event banners as usual.
  h.advance(QUIET_MS);
  h.send(event('approved'));
  assert.equal(h.desktop.length, 3);
  assert.equal(h.desktop[2].title, 'Approved · PR 1');
});

test('the quiet period is per PR', () => {
  const h = harness();
  h.send(event('reply', 1));
  h.send(event('reply', 2));
  assert.equal(h.desktop.length, 2);
  assert.equal(h.desktop[0].closed, false);
});

test('events that waited survive a more urgent banner and are summed up after its quiet period', () => {
  const h = harness();
  h.send(event('checks-failed'));
  h.send(event('approved'));
  h.advance(60_000);
  h.send(event('review-requested'));
  assert.equal(h.desktop.length, 2);
  h.advance(QUIET_MS - 1);
  assert.equal(h.desktop.length, 2);
  h.advance(1);
  assert.equal(h.desktop.length, 3);
  assert.equal(h.desktop[2].title, 'Approved · PR 1');
});

test('in-app toasts follow the same rule', () => {
  const h = harness({ focused: true });
  h.send(event('ready-to-merge'));
  h.send(event('approved'));
  assert.equal(h.toasts.length, 1);
  h.send(event('changes-requested'));
  assert.equal(h.toasts.length, 2, 'more urgent: a new toast, which replaces the PR\'s toast in the window');
  assert.equal(h.toasts[1].url, h.toasts[0].url);
  h.advance(QUIET_MS);
  assert.equal(h.toasts.length, 3);
  assert.equal(h.toasts[2].title, 'Approved · PR 1');
});

test('quietSummary shows one waiting notification as it is, and several as counts', () => {
  const one: NotificationDelivery = { id: 'a', kind: 'reply', title: 'New reply', body: 'PR', url: 'u', keys: ['k'], types: ['reply'], prTitle: 'PR' };
  assert.deepEqual(quietSummary([one], 'b', '10:42'), { ...one, id: 'b' });
  const two = quietSummary([one, { ...one, kind: 'mention', types: ['mention'] }], 'c', '10:42');
  assert.equal(two.title, '1 mention · 1 new comment since 10:42');
  assert.equal(two.kind, 'mention');
  assert.equal(two.url, 'u');
});

// ── Clear when handled ──

test('opening or reading the PR closes its notification, drops what waits and closes its toasts', () => {
  const h = harness();
  h.send(event('checks-failed'));
  h.send(event('approved'));
  h.service.read(['https://github.com/o/r/pull/1']);
  assert.equal(h.desktop[0].closed, true);
  assert.deepEqual(h.closedToasts, [['https://github.com/o/r/pull/1']]);
  h.advance(QUIET_MS);
  assert.equal(h.desktop.length, 1, 'the waiting approval was dropped');
  // Handled: the next event banners at once.
  h.send(event('reply'));
  assert.equal(h.desktop.length, 2);
  assert.deepEqual(h.service.notifiedUrls(), ['https://github.com/o/r/pull/1']);
});

test('a resolved request closes only a notification about it', () => {
  const h = harness();
  h.send(event('checks-failed'));
  h.service.resolved('https://github.com/o/r/pull/1', ['review-requested']);
  assert.equal(h.desktop[0].closed, false);
  h.service.resolved('https://github.com/o/r/pull/1', ['checks-failed']);
  assert.equal(h.desktop[0].closed, true);
  assert.deepEqual(h.service.notifiedUrls(), []);
});

test('the settings gate runs in the service: a repository set to None and a bot are counted, not shown', () => {
  const h = harness({ extra: { repositorySettings: { 'o/r': { notifications: 'none' } } } });
  h.send(event('review-requested'));
  assert.equal(h.desktop.length, 0);
  assert.ok(h.counts.includes('review-requested:suppressed:repository'));
  const b = harness();
  b.send(event('changes-requested', 1, { actor: 'renovate[bot]' }));
  assert.equal(b.desktop.length, 0);
  assert.ok(b.counts.includes('changes-requested:suppressed:bot'));
  const allowed = harness({ prefs: { allowedBots: ['renovate[bot]'] } });
  allowed.send(event('changes-requested', 1, { actor: 'renovate[bot]' }));
  assert.equal(allowed.desktop.length, 1);
});

test('"on me" in the service: checks failed on someone else\'s PR is left out, a review request is not', () => {
  const h = harness({ extra: { repositorySettings: { 'o/r': { notifications: 'on-me' } } } });
  h.send(event('checks-failed', 1, { mine: false }));
  h.send(event('team-review-requested', 2, { mine: false }));
  assert.equal(h.desktop.length, 0);
  h.send(event('review-requested', 3, { mine: false }));
  assert.equal(h.desktop.length, 1);
});

test('the store reports resolved types for every observed PR', async () => {
  const { createNotificationStore } = await import('../src/notification-store');
  const saved = new Map<string, unknown>();
  const storage = {
    read: (name: string) => saved.get(name),
    write: (name: string, value: unknown) => void saved.set(name, value),
    patch: () => {},
  } as unknown as Parameters<typeof createNotificationStore>[0];
  const store = createNotificationStore(storage, () => T0);
  const resolved: [string, string[]][] = [];
  const pr = member(1);
  const observation: PrObservation = { member: { ...pr, merged: true, state: 'closed' } };
  store.observe(LOGIN, [observation], { login: LOGIN, resolved: (url, types) => resolved.push([url, types]) });
  assert.equal(resolved[0][0], pr.url);
  assert.ok(resolved[0][1].includes('ready-to-merge'));
});
