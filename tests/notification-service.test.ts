import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNotificationService, type DesktopNotification, type DesktopNotificationOptions } from '../src/notification-service';
import { notificationSettings, type NotificationPreferences } from '../lib/notification-settings';
import type { NotificationEvent } from '../lib/notification-events';
import type { NotificationDelivery } from '../lib/notification-routing';
import { prTarget, type DeepLinkTarget } from '../lib/deep-link';
import { T0 } from './notification-fixtures';

function harness(options: { focused?: boolean; activeUrl?: string; desktop?: boolean; prefs?: NotificationPreferences; supported?: boolean } = {}) {
  let clock = T0;
  const timers: { at: number; fn: () => void; id: number }[] = [];
  let ids = 0;
  const state = { focused: options.focused ?? false, activeUrl: options.activeUrl, prefs: { introduced: true, ...options.prefs } as NotificationPreferences };
  const desktop: (DesktopNotificationOptions & { emit: (event: string) => void })[] = [];
  const toasts: NotificationDelivery[] = [];
  const opened: DeepLinkTarget[] = [];
  const counts: string[] = [];
  const service = createNotificationService({
    settings: () => notificationSettings({ notifications: options.desktop ?? true, notificationSettings: state.prefs }),
    focus: () => ({ focused: state.focused, activeUrl: state.activeUrl }),
    desktop: {
      supported: () => options.supported ?? true,
      create: (value) => {
        const listeners = new Map<string, (() => void)[]>();
        const handle = { ...value, emit: (event: string) => listeners.get(event)?.forEach((fn) => fn()) };
        desktop.push(handle);
        const notification: DesktopNotification = {
          on: (event: string, fn: () => void) => listeners.set(event, [...(listeners.get(event) ?? []), fn]),
          show: () => {},
          close: () => {},
        };
        return notification;
      },
    },
    toast: (delivery) => (toasts.push(delivery), true),
    open: (target) => opened.push(target),
    count: (kind, field) => counts.push(`${kind}:${field}`),
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
    clock += ms;
    for (;;) {
      const due = timers.filter((t) => t.at <= clock).sort((a, b) => a.at - b.at).at(0);
      if (!due) break;
      timers.splice(timers.indexOf(due), 1);
      due.fn();
    }
  };
  return { service, desktop, toasts, opened, counts, state, advance };
}
const event = (type: NotificationEvent['type'], n = 1, key = `${type}|${n}`): NotificationEvent => ({
  type,
  key,
  title: `PR ${n}`,
  url: `https://github.com/o/r/pull/${n}`,
  repo: 'o/r',
  number: n,
  at: T0,
  target: prTarget(`https://github.com/o/r/pull/${n}`, type === 'checks-failed' ? 'checks' : 'summary')!,
});

test('events for one PR settle for 20 seconds and become one notification', () => {
  const h = harness();
  h.service.deliver([event('checks-failed')]);
  h.advance(5_000);
  h.service.deliver([event('changes-requested')]);
  assert.equal(h.desktop.length, 0);
  h.advance(20_000);
  assert.equal(h.desktop.length, 1);
  assert.equal(h.desktop[0].title, '2 updates on #1');
  assert.equal(h.desktop[0].subtitle, 'o/r #1');
});

test('clicking a desktop notification opens its target; no action buttons', () => {
  const h = harness();
  h.service.deliver([event('checks-failed')]);
  h.advance(20_000);
  h.desktop[0].emit('click');
  assert.deepEqual(h.opened, [prTarget('https://github.com/o/r/pull/1', 'checks')]);
  assert.ok(h.counts.includes('checks-failed:clicked'));
  assert.equal('actions' in h.desktop[0], false);
});

test('focused: one toast, never a desktop notification too', () => {
  const h = harness({ focused: true });
  h.service.deliver([event('approved')]);
  h.advance(20_000);
  assert.equal(h.desktop.length, 0);
  assert.equal(h.toasts.length, 1);
});

test('the PR you are looking at in the focused window shows nothing', () => {
  const h = harness({ focused: true, activeUrl: 'https://github.com/o/r/pull/1' });
  h.service.deliver([event('approved')]);
  h.advance(20_000);
  assert.equal(h.toasts.length + h.desktop.length, 0);
  assert.ok(h.counts.includes('approved:suppressed:active'));
});

test('a failed desktop delivery is shown in the app instead, and later events go there', () => {
  const h = harness();
  h.service.deliver([event('approved')]);
  h.advance(20_000);
  h.desktop[0].emit('failed');
  assert.equal(h.toasts.length, 1);
  h.service.deliver([event('approved', 2)]);
  h.advance(20_000);
  assert.equal(h.desktop.length, 1);
  assert.equal(h.toasts.length, 2);
  assert.equal(h.service.status().blocked, true);
});

test('catch-up: three or more events become one summary that opens the Unread view', () => {
  const h = harness();
  h.service.beginCatchUp();
  h.service.deliver([event('review-requested', 1), event('checks-failed', 2), event('approved', 3)]);
  h.service.endCatchUp();
  assert.equal(h.desktop.length, 1);
  assert.equal(h.desktop[0].title, '3 updates while you were away');
  h.desktop[0].emit('click');
  assert.deepEqual(h.opened, [{ kind: 'queue', filters: { read: 'unread' } }]);
});

test('at most three desktop notifications in five minutes; the rest wait as one digest', () => {
  const h = harness();
  for (let n = 1; n <= 6; n++) h.service.local({ ...event('explanation-ready', n), key: `explanation|${n}` });
  assert.equal(h.desktop.length, 3);
  h.advance(5 * 60_000);
  assert.equal(h.desktop.length, 4);
  assert.equal(h.desktop[3].title, '3 more updates');
});

test('until introduced, PR events are toasts, and only the first offers "Turn on"', () => {
  const h = harness({ prefs: { introduced: false } });
  h.service.deliver([event('approved', 1), event('approved', 2)]);
  h.advance(20_000);
  assert.equal(h.desktop.length, 0);
  assert.deepEqual(h.toasts.map((toast) => !!toast.introduce), [true, false]);
});

test('paused: nothing shown; when the pause ends, held events become one summary', () => {
  const h = harness({ prefs: { pausedUntil: T0 + 60 * 60_000 } });
  h.service.deliver([event('approved', 1), event('approved', 2), event('checks-failed', 3)]);
  h.advance(20_000);
  assert.equal(h.desktop.length + h.toasts.length, 0);
  h.state.prefs = { introduced: true, pausedUntil: 0 };
  h.service.settingsChanged();
  assert.equal(h.desktop.length, 1);
  assert.equal(h.desktop[0].title, '3 updates while notifications were paused');
});

test('marking a PR read drops its waiting events; switched-off types never show', () => {
  const h = harness({ prefs: { events: { approved: false } } });
  h.service.deliver([event('approved', 1), event('checks-failed', 2)]);
  h.service.read(['https://github.com/o/r/pull/2']);
  h.advance(20_000);
  assert.equal(h.desktop.length, 0);
  assert.ok(h.counts.includes('approved:suppressed:type-off'));
});

test('a local result is announced once, immediately', () => {
  const h = harness();
  const ready = { ...event('explanation-ready'), key: 'explanation|r1', target: { kind: 'review', reviewId: 'r1' } as DeepLinkTarget };
  h.service.local(ready);
  h.service.local(ready);
  assert.equal(h.desktop.length, 1);
  assert.equal(h.desktop[0].title, 'Explanation ready');
});

test('the test notification uses the desktop when it can', () => {
  assert.equal(harness().service.test(), 'desktop');
  assert.equal(harness({ desktop: false }).service.test(), 'toast');
  assert.equal(harness({ supported: false }).service.test(), 'toast');
});
