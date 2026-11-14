import { test } from 'node:test';
import assert from 'node:assert/strict';
import { notificationSettings, normalizeNotificationPreferences, DEFAULT_NOTIFICATION_EVENTS, isPaused } from '../lib/notification-settings';
import { planSweep, sweepInterval, syncMode, watchInterval, SWEEP_ACTIVE_MS, SWEEP_SETTLED_MS } from '../lib/notification-cadence';
import { mine, signals, readySignals, T0 } from './notification-fixtures';

test('defaults: desktop and in-app on, every Phase 1 event on, team requests off, not paused', () => {
  const settings = notificationSettings({});
  assert.equal(settings.desktop, true);
  assert.equal(settings.inApp, true);
  assert.equal(settings.introduced, false);
  assert.equal(settings.pausedUntil, 0);
  assert.equal(settings.events['team-review-requested'], false);
  for (const type of ['review-requested', 'changes-requested', 'approved', 'checks-failed', 'ready-to-merge', 'explanation-ready', 'update-ready'] as const)
    assert.equal(settings.events[type], true, type);
  assert.deepEqual(settings.events, DEFAULT_NOTIFICATION_EVENTS);
});

test('an old preferences file keeps its desktop choice', () => {
  assert.equal(notificationSettings({ notifications: false }).desktop, false);
  assert.equal(notificationSettings({ notifications: true }).desktop, true);
});

test('invalid values fall back; the saved form is complete', () => {
  const settings = notificationSettings({ notificationSettings: { inApp: 'no', events: { approved: false, 'checks-failed': 1 }, pausedUntil: -5, introduced: 'yes' } });
  assert.equal(settings.inApp, true);
  assert.equal(settings.events.approved, false);
  assert.equal(settings.events['checks-failed'], true);
  assert.equal(settings.pausedUntil, 0);
  assert.equal(settings.introduced, false);
  assert.deepEqual(Object.keys(normalizeNotificationPreferences(null)).sort(), ['events', 'inApp', 'introduced', 'pausedUntil']);
  assert.equal(isPaused({ pausedUntil: T0 + 1 }, T0), true);
});

test('sweep cadence: 120 s while checks run or mergeability is computing, 5 min otherwise, wider when cost is above 1', () => {
  const pr = mine(1);
  assert.equal(sweepInterval(undefined), SWEEP_ACTIVE_MS);
  assert.equal(sweepInterval(signals(pr, { checks: 'pending' })), SWEEP_ACTIVE_MS);
  assert.equal(sweepInterval(signals(pr, { checks: 'success', mergeable: 'UNKNOWN' })), SWEEP_ACTIVE_MS);
  assert.equal(sweepInterval(readySignals(pr)), SWEEP_SETTLED_MS);
  assert.equal(sweepInterval(readySignals(pr), 2), 2 * SWEEP_SETTLED_MS);
});

test('the sweep plans only due PRs, in batches of 25, and counts a fresh visible-row read', () => {
  const members = Array.from({ length: 60 }, (_, i) => mine(i + 1));
  const batches = planSweep({ members, signals: () => undefined, sweptAt: new Map(), now: T0 });
  assert.deepEqual(batches.map((b) => b.length), [25, 25, 10]);
  const settled = new Map(members.map((m) => [m.url, readySignals(m, T0 - 60_000)]));
  assert.deepEqual(planSweep({ members, signals: (m) => settled.get(m.url), sweptAt: new Map(), now: T0 }), []);
  assert.equal(planSweep({ members, signals: (m) => settled.get(m.url), sweptAt: new Map(), now: T0 + 5 * 60_000 }).flat().length, 60);
  // Signals for an older head do not count.
  const old = signals({ ...members[0], headSha: 'old' }, { checks: 'success', checkedAt: T0 });
  assert.equal(planSweep({ members: [members[0]], signals: () => old, sweptAt: new Map(), now: T0 }).length, 1);
});

test('watch mode turns on only when no window is visible and desktop notifications are on', () => {
  const base = { signedIn: true, suspended: false, online: true, windowVisible: true, desktopNotifications: true };
  assert.equal(syncMode(base), 'sync');
  assert.equal(syncMode({ ...base, windowVisible: false }), 'watch');
  assert.equal(syncMode({ ...base, windowVisible: false, desktopNotifications: false }), 'off');
  assert.equal(syncMode({ ...base, windowVisible: false, suspended: true }), 'off');
  assert.equal(syncMode({ ...base, windowVisible: false, online: false }), 'off');
  assert.equal(syncMode({ ...base, signedIn: false }), 'off');
  assert.equal(watchInterval(false), 5 * 60_000);
  assert.equal(watchInterval(true), 10 * 60_000);
});
