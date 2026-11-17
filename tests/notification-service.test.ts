import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNotificationService, type DesktopNotification, type DesktopNotificationOptions } from '../src/notification-service';
import { notificationSettings, type NotificationPreferences } from '../lib/notification-settings';
import type { NotificationEvent } from '../lib/notification-events';
import type { NotificationDelivery } from '../lib/notification-routing';
import { prTarget, type DeepLinkTarget } from '../lib/deep-link';
import { T0 } from './notification-fixtures';

function harness(options: { focused?: boolean; activeUrl?: string; desktop?: boolean; prefs?: NotificationPreferences; supported?: boolean; deps?: Partial<Parameters<typeof createNotificationService>[0]> } = {}) {
  let clock = T0;
  const timers: { at: number; fn: () => void; id: number }[] = [];
  let ids = 0;
  const state = { focused: options.focused ?? false, activeUrl: options.activeUrl, prefs: { introduced: true, ...options.prefs } as NotificationPreferences };
  const desktop: (DesktopNotificationOptions & { emit: (event: string, value?: unknown) => void })[] = [];
  const toasts: NotificationDelivery[] = [];
  const opened: DeepLinkTarget[] = [];
  const counts: string[] = [];
  const service = createNotificationService({
    settings: () => notificationSettings({ notifications: options.desktop ?? true, notificationSettings: state.prefs }),
    focus: () => ({ focused: state.focused, activeUrl: state.activeUrl }),
    desktop: {
      supported: () => options.supported ?? true,
      create: (value) => {
        const listeners = new Map<string, ((value?: unknown) => void)[]>();
        const handle = { ...value, emit: (event: string, arg?: unknown) => listeners.get(event)?.forEach((fn) => fn(arg)) };
        desktop.push(handle);
        const notification: DesktopNotification = {
          on: ((event: string, fn: (value?: unknown) => void) => { listeners.set(event, [...(listeners.get(event) ?? []), fn]); }) as DesktopNotification['on'],
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
    ...options.deps,
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
  assert.equal(h.desktop[0].title, 'Changes requested · PR 1');
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

test('catch-up: three or more events become one summary that opens the queue filtered to its PRs', () => {
  const h = harness();
  h.service.beginCatchUp();
  h.service.deliver([event('review-requested', 1), event('checks-failed', 2), event('approved', 3)]);
  h.service.endCatchUp();
  assert.equal(h.desktop.length, 1);
  assert.equal(h.desktop[0].title, '3 updates while you were away');
  h.desktop[0].emit('click');
  assert.deepEqual(h.opened, [{ kind: 'queue', filters: { prs: [1, 2, 3].map((n) => `https://github.com/o/r/pull/${n}`) } }]);
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
  assert.equal(h.desktop[0].title, 'Explanation ready · PR 1');
});

test('the test notification uses the desktop when it can', () => {
  assert.equal(harness().service.test(), 'desktop');
  assert.equal(harness({ desktop: false }).service.test(), 'toast');
  assert.equal(harness({ supported: false }).service.test(), 'toast');
});

// ── Part 2: inline reply, actions, icons, pause (#385) ──

const thread = { kind: 'thread' as const, prUrl: 'https://github.com/o/r/pull/1', threadId: 'PRRT_1', to: 'lena' };
const mention = (): NotificationEvent => ({
  ...event('mention'),
  actor: 'lena',
  quote: 'The retry loop never backs off',
  reply: thread,
  target: { kind: 'pr', pr: { host: 'github.com', owner: 'o', repo: 'r', number: 1 }, tab: 'feedback', threadId: 'PRRT_1' },
});
const flushPromises = () => new Promise((resolve) => setImmediate(resolve));

test('macOS: a mention offers Reply to its author and the two local buttons; the quote is the body', () => {
  const h = harness({ deps: { platform: 'darwin' } });
  h.service.deliver([mention()]);
  h.advance(20_000);
  assert.equal(h.desktop[0].title, 'Mentioned · PR 1');
  assert.equal(h.desktop[0].body, "lena: 'The retry loop never backs off'");
  assert.equal(h.desktop[0].hasReply, true);
  assert.equal(h.desktop[0].replyPlaceholder, 'Reply to lena…');
  assert.deepEqual(h.desktop[0].actions?.map((action) => action.text), ['Snooze 1 h', 'Mark read']);
  assert.equal(h.desktop[0].icon, undefined, 'macOS keeps the app icon');
});

test('a reply from the notification posts through the reply path and counts', async () => {
  const sent: [string, string][] = [];
  const h = harness({ deps: { platform: 'darwin', reply: (target, text) => { sent.push([target.kind === 'thread' ? target.threadId : target.sourceId, text]); return Promise.resolve(); } } });
  h.service.deliver([mention()]);
  h.advance(20_000);
  h.desktop[0].emit('reply', '  Good catch, fixing  ');
  await flushPromises();
  assert.deepEqual(sent, [['PRRT_1', 'Good catch, fixing']]);
  assert.ok(h.counts.includes('mention:replied'));
  assert.deepEqual(h.opened, [], 'a reply does not open the app');
});

test('a reply GitHub refuses keeps the text for the thread and asks for Retry', async () => {
  const failures: { text: string; message: string; threadId?: string }[] = [];
  const h = harness({
    deps: {
      platform: 'darwin',
      reply: () => Promise.reject(new Error('Resource not accessible')),
      replyFailed: (failure) => failures.push({ text: failure.text, message: failure.message, threadId: failure.reply.kind === 'thread' ? failure.reply.threadId : undefined }),
    },
  });
  h.service.deliver([mention()]);
  h.advance(20_000);
  h.desktop[0].emit('reply', 'Fixing it');
  await flushPromises();
  assert.deepEqual(failures, [{ text: 'Fixing it', message: 'Resource not accessible', threadId: 'PRRT_1' }]);
  assert.ok(h.counts.includes('mention:replyFailed'));
});

test('with "Allow replies from notifications" off there is no Reply, and a stray reply only opens the thread', async () => {
  let posted = 0;
  const h = harness({ prefs: { allowReplies: false }, deps: { platform: 'darwin', reply: () => { posted++; return Promise.resolve(); } } });
  h.service.deliver([mention()]);
  h.advance(20_000);
  assert.equal(h.desktop[0].hasReply, undefined);
  h.desktop[0].emit('reply', 'text');
  await flushPromises();
  assert.equal(posted, 0);
  assert.deepEqual(h.opened, [mention().target]);
});

test('Snooze 1 h and Mark read run the local handlers by button index, never a GitHub write', () => {
  const acted: string[] = [];
  const h = harness({ deps: { platform: 'darwin', act: (action, delivery) => acted.push(`${action}:${delivery.url}`) } });
  h.service.deliver([event('checks-failed')]);
  h.advance(20_000);
  h.desktop[0].emit('action', 0);
  h.service.deliver([event('checks-failed', 2)]);
  h.advance(20_000);
  h.desktop[1].emit('action', 1);
  h.desktop[1].emit('action', 7);
  assert.deepEqual(acted, ['snooze:https://github.com/o/r/pull/1', 'read:https://github.com/o/r/pull/2']);
  assert.ok(h.counts.includes('checks-failed:snoozed'));
  assert.ok(h.counts.includes('checks-failed:markedRead'));
  h.service.quickAction('read', { id: 'x', kind: 'approved', title: '', body: '', url: 'https://github.com/o/r/pull/3', keys: [], types: ['approved'] });
  assert.equal(acted.at(-1), 'read:https://github.com/o/r/pull/3', 'toasts use the same handler');
});

test('Windows and Linux: the event icon, no Reply and no buttons; the body names the repository; Linux text is plain', () => {
  for (const platform of ['win32', 'linux']) {
    const h = harness({ deps: { platform, icon: (kind) => `/icons/${kind}.png` } });
    h.service.deliver([{ ...mention(), quote: 'Use <b>backoff</b> & jitter' }]);
    h.advance(20_000);
    const shown = h.desktop[0];
    assert.equal(shown.icon, '/icons/mention.png', platform);
    assert.equal(shown.hasReply, undefined, platform);
    assert.equal(shown.actions, undefined, platform);
    assert.match(shown.body, /· o\/r #1$/, platform);
    if (platform === 'linux') assert.equal(/[<>&]/.test(shown.body), false);
  }
});

test('a pause holds events; when it ends, more than one becomes one catch-up summary', () => {
  const h = harness({ prefs: { pausedUntil: T0 + 60_000 } });
  h.service.deliver([event('checks-failed', 1), event('approved', 2)]);
  assert.equal(h.desktop.length, 0);
  h.advance(62_000);
  assert.equal(h.desktop.length, 1);
  assert.equal(h.desktop[0].title, '2 updates while notifications were paused');
  const one = harness({ prefs: { pausedUntil: T0 + 60_000 } });
  one.service.deliver([event('approved', 2)]);
  one.advance(62_000);
  assert.equal(one.desktop[0].title, 'Approved · PR 2', 'a single held event is shown as itself');
});
