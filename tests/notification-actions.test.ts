import { test } from 'node:test';
import assert from 'node:assert/strict';
import { desktopExtras, notificationActionLabel, offersReply, quickActions, replyPlaceholder } from '../lib/notification-actions';
import { preciseTarget } from '../lib/notification-targets';
import { coalesce, eventLine, eventTitle, quoteLine, BODY_LIMIT, TITLE_LIMIT, type NotificationDelivery } from '../lib/notification-routing';
import { iconFor, iconPolylines, flattenPath, renderIcon, NOTIFICATION_ICONS, ICON_SHAPES } from '../lib/notification-icons';
import { encodePng, createNotificationIcons } from '../src/notification-icon-files';
import { NOTIFICATION_EVENT_TYPES, pauseUntil, parsePauseRequest } from '../lib/notification-settings';
import type { NotificationEvent, NotificationReplyTarget } from '../lib/notification-events';
import { parseReplyTarget } from '../lib/notification-events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { T0 } from './notification-fixtures';

const URL = 'https://github.com/acme/app/pull/7';
const pr = { host: 'github.com', owner: 'acme', repo: 'app', number: 7 };
const reply: NotificationReplyTarget = { kind: 'thread', prUrl: URL, threadId: 'PRRT_1', to: 'lena' };
const event = (type: NotificationEvent['type'], extra: Partial<NotificationEvent> = {}): NotificationEvent => ({
  type,
  key: `${type}|1`,
  title: 'Fix retry backoff',
  url: URL,
  repo: 'acme/app',
  number: 7,
  at: T0,
  target: { kind: 'pr', pr },
  ...extra,
});
const delivery = (kind: NotificationDelivery['kind'], extra: Partial<NotificationDelivery> = {}): NotificationDelivery => ({
  id: 'n1', kind, title: 't', body: 'b', url: URL, keys: ['k'], types: kind === 'summary' || kind === 'test' ? [] : [kind], ...extra,
});

void test('which notifications offer an inline reply: mentions, replies and change requests with a thread, while the setting is on', () => {
  for (const kind of ['mention', 'reply', 'changes-requested'] as const) assert.equal(offersReply(delivery(kind, { reply }), true), true, kind);
  for (const kind of ['checks-failed', 'approved', 'ready-to-merge', 'snooze-ended', 'update-ready', 'review-requested'] as const)
    assert.equal(offersReply(delivery(kind, { reply }), true), false, kind);
  assert.equal(offersReply(delivery('mention'), true), false, 'no thread, no reply');
  assert.equal(offersReply(delivery('mention', { reply }), false), false, 'Allow replies from notifications is off');
});

void test('macOS adds Reply and the two local buttons; Windows and Linux get the event icon and open the thread instead', () => {
  const mac = desktopExtras(delivery('mention', { reply }), { platform: 'darwin', allowReplies: true, icon: '/icons/mention.png' });
  assert.deepEqual(mac.extras, { hasReply: true, replyPlaceholder: 'Reply to lena…', actions: [{ type: 'button', text: 'Snooze 1 h' }, { type: 'button', text: 'Mark read' }] });
  assert.deepEqual(mac.actions, ['snooze', 'read']);
  assert.equal(replyPlaceholder('maya'), 'Reply to maya…');
  for (const platform of ['win32', 'linux']) {
    const other = desktopExtras(delivery('mention', { reply }), { platform, allowReplies: true, icon: '/icons/mention.png' });
    assert.deepEqual(other, { extras: { icon: '/icons/mention.png' }, actions: [] }, platform);
  }
  const off = desktopExtras(delivery('mention', { reply }), { platform: 'darwin', allowReplies: false });
  assert.equal(off.extras.hasReply, undefined);
  assert.deepEqual(quickActions(delivery('summary', { url: undefined })), []);
  assert.deepEqual(quickActions(delivery('explanation-ready')), []);
  assert.deepEqual(quickActions(delivery('checks-failed')), ['snooze', 'read']);
});

void test('each event lands on its precise target', () => {
  assert.deepEqual(preciseTarget(event('checks-failed')), { kind: 'pr', pr, tab: 'checks' });
  assert.deepEqual(preciseTarget(event('checks-failed', { target: { kind: 'pr', pr, tab: 'checks', check: '42' } })), { kind: 'pr', pr, tab: 'checks', check: '42' });
  for (const type of ['mention', 'reply', 'changes-requested'] as const)
    assert.deepEqual(preciseTarget(event(type, { target: { kind: 'pr', pr, tab: 'feedback', threadId: 'PRRT_1' } })), { kind: 'pr', pr, tab: 'feedback', threadId: 'PRRT_1' }, type);
  assert.deepEqual(preciseTarget(event('changes-requested')), { kind: 'pr', pr, tab: 'feedback' });
  assert.deepEqual(preciseTarget(event('review-requested')), { kind: 'pr', pr, tab: 'changes', focus: 'unviewed-file' });
  assert.deepEqual(preciseTarget(event('team-review-requested')), { kind: 'pr', pr, tab: 'changes', focus: 'unviewed-file' });
  assert.deepEqual(preciseTarget(event('ready-to-merge')), { kind: 'pr', pr, focus: 'merge' });
  assert.deepEqual(preciseTarget(event('snooze-ended', { target: { kind: 'pr', pr, tab: 'summary' } })), { kind: 'pr', pr });
  assert.deepEqual(preciseTarget(event('approved')), { kind: 'pr', pr });
  assert.deepEqual(preciseTarget(event('explanation-ready', { target: { kind: 'review', reviewId: 'r1' } })), { kind: 'review', reviewId: 'r1' });
});

void test('toast actions name where they go', () => {
  assert.equal(notificationActionLabel({ kind: 'mention', target: { kind: 'pr', pr, tab: 'feedback', threadId: 'PRRT_1' } }), 'Open thread');
  assert.equal(notificationActionLabel({ kind: 'review-requested', target: { kind: 'pr', pr, tab: 'changes', focus: 'unviewed-file' } }), 'Start review');
  assert.equal(notificationActionLabel({ kind: 'ready-to-merge', target: { kind: 'pr', pr, focus: 'merge' } }), 'Open merge');
  assert.equal(notificationActionLabel({ kind: 'summary', target: { kind: 'queue', filters: { prs: [URL] } } }), 'Show these PRs');
  assert.equal(notificationActionLabel({ kind: 'summary', target: { kind: 'queue', filters: { read: 'unread' } } }), 'Show unread PRs');
});

void test('titles start with the event in words and carry no symbols; bodies quote within the limit', () => {
  const symbols = /[✓✕✗✔❌✅]|\p{Extended_Pictographic}/u;
  for (const type of NOTIFICATION_EVENT_TYPES) {
    const title = eventTitle(type, 'Fix retry backoff');
    assert.ok(title.endsWith(' · Fix retry backoff'), title);
    assert.equal(symbols.test(title), false, title);
  }
  assert.equal(eventTitle('changes-requested', 'Fix retry backoff'), 'Changes requested · Fix retry backoff');
  assert.ok(eventTitle('mention', 'x'.repeat(200)).length <= TITLE_LIMIT);
  const quoted = coalesce([event('reply', { actor: 'lena', quote: 'The retry loop never backs off' })], 'a');
  assert.equal(quoted?.title, 'Reply · Fix retry backoff');
  assert.equal(quoted?.body, "lena: 'The retry loop never backs off'");
  assert.equal(eventLine(event('changes-requested', { actor: 'lena', quote: 'Back off' })), "lena requested changes: 'Back off'");
  assert.equal(eventLine(event('mention', { actor: 'lena' })), 'lena mentioned you');
  const long = quoteLine('lena: ', 'word '.repeat(100));
  assert.ok(long.length <= BODY_LIMIT, String(long.length));
  assert.ok(long.endsWith("…'"), 'the closing quote survives truncation');
  assert.deepEqual(coalesce([event('mention', { actor: 'lena', reply })], 'b')?.reply, reply);
});

void test('event icons: one glyph and tone per kind, the same set as the in-app toasts', () => {
  assert.equal(iconFor('checks-failed').icon, 'circle-x');
  assert.equal(iconFor('checks-failed').tone, 'danger');
  assert.equal(iconFor('approved').tone, 'success');
  assert.equal(iconFor('mention').icon, 'at-sign');
  assert.equal(iconFor('reply').icon, 'message-square-reply');
  assert.equal(iconFor('changes-requested').icon, 'message-square-warning');
  for (const kind of [...NOTIFICATION_EVENT_TYPES, 'summary', 'test'] as const) assert.ok(NOTIFICATION_ICONS[kind], kind);
  for (const name of Object.keys(ICON_SHAPES) as (keyof typeof ICON_SHAPES)[]) {
    const lines = iconPolylines(name);
    assert.ok(lines.length > 0, name);
    for (const point of lines.flat()) assert.ok(point.every((v) => Number.isFinite(v) && v > -1 && v < 25), `${name} ${point.join(',')}`);
  }
  // An arc ends where the path says.
  assert.deepEqual(flattenPath('M2 12a10 10 0 0 0 20 0')[0].at(-1), [22, 12]);
});

void test('icons render to cached PNG files once', () => {
  const pixels = renderIcon('checks-failed', 32);
  assert.equal(pixels.length, 32 * 32 * 4);
  const at = (x: number, y: number) => [...pixels.slice((y * 32 + x) * 4, (y * 32 + x) * 4 + 4)];
  assert.equal(at(0, 0)[3], 0, 'corners are transparent');
  assert.equal(at(16, 16)[3], 255, 'the disc is opaque');
  const red = [...Array(32 * 32).keys()].some((i) => pixels[i * 4] > 150 && pixels[i * 4 + 1] < 90 && pixels[i * 4 + 3] === 255);
  assert.ok(red, 'the glyph is drawn in the event colour');
  const png = encodePng(pixels, 32, 32);
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const data = png.subarray(png.indexOf('IDAT') + 4, png.indexOf('IEND') - 8);
  assert.equal(zlib.inflateSync(data).length, 32 * (32 * 4 + 1));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gnosis-icons-'));
  try {
    const icons = createNotificationIcons(directory);
    const file = icons('mention');
    assert.ok(file && fs.existsSync(file));
    const written = fs.statSync(file as string).mtimeMs;
    assert.equal(icons('mention'), file);
    assert.equal(fs.statSync(file as string).mtimeMs, written, 'rendered once');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

void test('pause choices: an hour, tomorrow morning, Monday', () => {
  const local = (y: number, m: number, d: number, h: number, min = 0) => new Date(y, m - 1, d, h, min).getTime();
  // 2026-11-17 is a Tuesday.
  assert.equal(pauseUntil('hour', local(2026, 11, 17, 15)), local(2026, 11, 17, 16));
  assert.equal(pauseUntil('morning', local(2026, 11, 17, 15)), local(2026, 11, 18, 8));
  assert.equal(pauseUntil('morning', local(2026, 11, 18, 1)), local(2026, 11, 18, 8), 'after midnight, the coming morning');
  assert.equal(pauseUntil('monday', local(2026, 11, 17, 15)), local(2026, 11, 23, 8));
  assert.equal(pauseUntil('monday', local(2026, 11, 22, 23)), local(2026, 11, 23, 8), 'Sunday night');
  assert.equal(pauseUntil('monday', local(2026, 11, 23, 9)), local(2026, 11, 30, 8), 'on Monday, the next one');
  assert.equal(parsePauseRequest(true), 'hour');
  assert.equal(parsePauseRequest(false), false);
  assert.equal(parsePauseRequest('monday'), 'monday');
  assert.equal(parsePauseRequest('forever'), undefined);
});

void test('a reply target that crossed IPC is re-validated', () => {
  assert.deepEqual(parseReplyTarget({ ...reply, extra: 1 }), reply);
  assert.deepEqual(parseReplyTarget({ kind: 'feedback', prUrl: URL, sourceId: 'IC_kw1', to: 'lena' }), { kind: 'feedback', prUrl: URL, sourceId: 'IC_kw1', to: 'lena' });
  assert.equal(parseReplyTarget({ ...reply, prUrl: 'https://evil.example/pull/1' }), undefined);
  assert.equal(parseReplyTarget({ ...reply, threadId: '../x' }), undefined);
  assert.equal(parseReplyTarget({ ...reply, kind: 'issue' }), undefined);
  assert.equal(parseReplyTarget(null), undefined);
});
