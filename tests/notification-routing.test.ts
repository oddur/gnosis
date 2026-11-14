import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routeEvent, coalesce, batch, nextDesktopSlot, isCatchUp, countLine, plainText, truncate, DESKTOP_LIMIT } from '../lib/notification-routing';
import { notificationSettings } from '../lib/notification-settings';
import type { NotificationEvent } from '../lib/notification-events';
import { prTarget } from '../lib/deep-link';
import { T0 } from './notification-fixtures';

const url = 'https://github.com/o/r/pull/1';
const settings = (overrides: Record<string, unknown> = {}, notifications = true) =>
  notificationSettings({ notifications, notificationSettings: { introduced: true, ...overrides } });
const event = (type: NotificationEvent['type'], n = 1, extra: Partial<NotificationEvent> = {}): NotificationEvent => ({
  type,
  key: `${type}|${n}`,
  title: `PR ${n}`,
  url: `https://github.com/o/r/pull/${n}`,
  repo: 'o/r',
  number: n,
  at: T0,
  target: prTarget(`https://github.com/o/r/pull/${n}`)!,
  ...extra,
});
const base = { focused: false, desktop: 'available' as const, settings: settings(), now: T0 };

test('focused: a toast; not focused: a desktop notification', () => {
  assert.deepEqual(routeEvent({ type: 'checks-failed', url }, { ...base, focused: true }), { surface: 'toast' });
  assert.deepEqual(routeEvent({ type: 'checks-failed', url }, base), { surface: 'desktop' });
});

test('the PR open in the focused window shows nothing', () => {
  assert.deepEqual(routeEvent({ type: 'checks-failed', url }, { ...base, focused: true, activeUrl: url }), { surface: 'none', reason: 'active' });
  // An unfocused window does not count as looking at it.
  assert.deepEqual(routeEvent({ type: 'checks-failed', url }, { ...base, activeUrl: url }), { surface: 'desktop' });
});

test('desktop off, unsupported or failed: a toast that waits for the return', () => {
  assert.deepEqual(routeEvent({ type: 'approved', url }, { ...base, settings: settings({}, false) }), { surface: 'toast' });
  assert.deepEqual(routeEvent({ type: 'approved', url }, { ...base, desktop: 'unsupported' }), { surface: 'toast' });
  assert.deepEqual(routeEvent({ type: 'approved', url }, { ...base, desktop: 'failed' }), { surface: 'toast' });
  assert.deepEqual(routeEvent({ type: 'approved', url }, { ...base, settings: settings({ inApp: false }, false) }), { surface: 'none', reason: 'in-app-off' });
});

test('before the introduction, PR events stay in the app; local results may use the desktop', () => {
  const fresh = notificationSettings({ notifications: true });
  assert.deepEqual(routeEvent({ type: 'review-requested', url }, { ...base, settings: fresh }), { surface: 'toast' });
  assert.deepEqual(routeEvent({ type: 'explanation-ready', url }, { ...base, settings: fresh }), { surface: 'desktop' });
});

test('paused, switched-off types, and the update banner', () => {
  assert.deepEqual(routeEvent({ type: 'approved', url }, { ...base, settings: settings({ pausedUntil: T0 + 1 }) }), { surface: 'hold', reason: 'paused' });
  assert.deepEqual(routeEvent({ type: 'team-review-requested', url }, base), { surface: 'none', reason: 'type-off' });
  assert.deepEqual(routeEvent({ type: 'update-ready' }, { ...base, focused: true }), { surface: 'none', reason: 'banner' });
  assert.deepEqual(routeEvent({ type: 'update-ready' }, base), { surface: 'desktop' });
});

test('several events on one PR coalesce, headline by rank, Approved folded into Ready', () => {
  const one = coalesce([event('checks-failed')], 'a');
  assert.equal(one?.title, 'Checks failed');
  assert.equal(one?.subtitle, 'o/r #1');
  const many = coalesce([event('approved', 1, { actor: 'maya' }), event('ready-to-merge'), event('changes-requested', 1, { actor: 'li' })], 'b');
  assert.equal(many?.title, '2 updates on #1');
  assert.match(many?.body ?? '', /^li requested changes · Ready to merge · PR 1$/);
  assert.deepEqual(many?.types, ['changes-requested', 'ready-to-merge']);
});

test('catch-up: one or two PRs as normal, three or more events become one summary', () => {
  let n = 0;
  const id = () => `n${++n}`;
  assert.equal(batch([event('approved', 1), event('checks-failed', 2)], id).length, 2);
  const summary = batch([event('review-requested', 1), event('review-requested', 2), event('checks-failed', 3), event('checks-failed', 4), event('approved', 5)], id);
  assert.equal(summary.length, 1);
  assert.equal(summary[0].title, '5 updates while you were away');
  assert.equal(summary[0].body, '2 review requests · 2 failing checks · 1 approval');
  assert.deepEqual(summary[0].target, { kind: 'queue', filters: { read: 'unread' } });
  assert.equal(countLine(['approved']), '1 approval');
});

test('at most three desktop notifications in five minutes', () => {
  assert.equal(nextDesktopSlot([T0 - 1000, T0 - 2000], T0), T0);
  const shown = [T0 - 60_000, T0 - 30_000, T0 - 10_000];
  assert.equal(nextDesktopSlot(shown, T0), T0 - 60_000 + DESKTOP_LIMIT.windowMs);
  assert.equal(nextDesktopSlot(shown, T0 + DESKTOP_LIMIT.windowMs), T0 + DESKTOP_LIMIT.windowMs);
});

test('a catch-up pass after launch, resume or a ten-minute gap, but not a slow watch cadence', () => {
  assert.equal(isCatchUp({ now: T0, resumed: false, intervalMs: 120_000 }), true);
  assert.equal(isCatchUp({ lastSyncAt: T0 - 60_000, now: T0, resumed: true, intervalMs: 120_000 }), true);
  assert.equal(isCatchUp({ lastSyncAt: T0 - 11 * 60_000, now: T0, resumed: false, intervalMs: 120_000 }), true);
  assert.equal(isCatchUp({ lastSyncAt: T0 - 3 * 60_000, now: T0, resumed: false, intervalMs: 120_000 }), false);
  assert.equal(isCatchUp({ lastSyncAt: T0 - 10.5 * 60_000, now: T0, resumed: false, intervalMs: 10 * 60_000 }), false);
});

test('copy is truncated and stripped of markup for Linux daemons', () => {
  assert.equal(truncate('x'.repeat(70), 60).length, 60);
  assert.equal(plainText('Fix <b> & </b>'), 'Fix b  /b');
});
