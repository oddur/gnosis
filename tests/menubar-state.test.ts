import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMenubarState, menubarSignalRequests, menubarTasks, menubarTooltip, MENUBAR_TASK_LIMIT, type MenubarInput } from '../lib/menubar-state';
import { createStateSignature } from '../src/tray-signature';
import type { ActivityTask } from '../lib/activity';
import type { QueueItem, ReviewMember } from '../lib/workbench';
import { LOGIN, T0, member, mine, readySignals, signals } from './notification-fixtures';

const item = (m: ReviewMember, extra: Partial<QueueItem> = {}): QueueItem => ({
  subject: { id: m.url, kind: 'pr', title: m.title, members: [m], edges: [], warnings: [] },
  attention: 'other',
  ...extra,
});
const requested = (n: number) => member(n, { requestedReviewers: [LOGIN], title: `Review ${n}` });
const input = (extra: Partial<MenubarInput> = {}): MenubarInput => ({
  login: LOGIN,
  signedIn: true,
  online: true,
  queue: { items: [item(requested(1)), item(requested(2), { unreadUrls: [requested(2).url] })], sync: { status: 'idle', checkedAt: T0 - 60_000 } },
  signals: () => undefined,
  now: T0,
  ...extra,
});
const task = (id: string, kind: ActivityTask['kind'], status: ActivityTask['status'], account?: string): ActivityTask => ({
  id, kind, status, title: id, detail: '', updatedAt: '', canCancel: false, canRetry: false, ...(account ? { account } : {}),
});

void test('default: groups, summary, age and queue size', () => {
  const { state, items } = buildMenubarState(input());
  assert.equal(state.connection, 'ok');
  assert.equal(state.loading, false);
  assert.equal(state.checkedAt, T0 - 60_000);
  assert.deepEqual(state.groups.map((g) => [g.group, g.label, g.count, g.rows.map((r) => r.number)]), [['review', 'To review', 2, [2, 1]]]);
  assert.deepEqual(state.groups[0].rows[0].labels, ['Review requested']);
  assert.equal(state.summary.line, '2 need you');
  assert.equal(state.queueSize, 2);
  assert.equal(items.length, 2);
  assert.equal(menubarTooltip(state), 'Gnosis: 2 need you');
});

void test('rows sent to the panel carry no URL or target; main resolves the id against its items', () => {
  const { state, items } = buildMenubarState(input());
  const row = state.groups[0].rows[0];
  assert.equal('url' in row || 'target' in row, false);
  assert.equal(JSON.stringify(state).includes('"target"'), false);
  const resolved = items.find((entry) => entry.id === row.id);
  assert.deepEqual(resolved?.target, { kind: 'pr', pr: { host: 'github.com', owner: 'o', repo: 'r', number: 2 }, tab: 'summary' });
  assert.equal(items.find((entry) => entry.id === 'https://github.com/o/r/pull/99|https://github.com/o/r/pull/99'), undefined, 'An unknown id resolves to nothing');
});

void test('at most five rows per group, with the full count', () => {
  const queue = { items: Array.from({ length: 8 }, (_, i) => item(requested(i + 1))) };
  const { state } = buildMenubarState(input({ queue }));
  assert.equal(state.groups[0].count, 8);
  assert.equal(state.groups[0].rows.length, 5);
});

void test('signed out: no rows, no tasks, no account', () => {
  const { state, items } = buildMenubarState(input({ signedIn: false, tasks: [task('review:1', 'review', 'running')] }));
  assert.equal(state.connection, 'signed-out');
  assert.equal(state.account, undefined);
  assert.deepEqual([state.groups, state.tasks, items], [[], [], []]);
  assert.equal(menubarTooltip(state), 'Gnosis: not connected to GitHub');
  assert.equal(buildMenubarState(input({ login: null })).state.connection, 'signed-out', 'A token without a login is not signed in yet');
});

void test('first load: no snapshot yet', () => {
  const { state } = buildMenubarState(input({ queue: undefined }));
  assert.equal(state.loading, true);
  assert.equal(state.connection, 'ok');
  assert.deepEqual(state.groups, []);
});

void test('offline, paused with retryAt, and error keep the rows', () => {
  assert.equal(buildMenubarState(input({ online: false })).state.connection, 'offline');
  const paused = buildMenubarState(input({ backoffUntil: T0 + 30 * 60_000 })).state;
  assert.deepEqual([paused.connection, paused.retryAt, paused.groups.length], ['paused', T0 + 30 * 60_000, 1]);
  const syncPaused = buildMenubarState(input({ queue: { items: [], sync: { status: 'paused', retryAt: T0 + 5_000 } } })).state;
  assert.deepEqual([syncPaused.connection, syncPaused.retryAt], ['paused', T0 + 5_000]);
  assert.equal(buildMenubarState(input({ backoffUntil: T0 - 1 })).state.connection, 'ok', 'An expired pause is over');
  const error = buildMenubarState(input({ queue: { items: [item(requested(1))], sync: { status: 'error' } } })).state;
  assert.deepEqual([error.connection, error.groups.length], ['error', 1]);
});

void test('all clear still counts the open PRs in the queue', () => {
  const { state } = buildMenubarState(input({ queue: { items: [item(member(1)), item(member(2, { state: 'closed' }))] } }));
  assert.deepEqual([state.groups, state.queueSize, state.summary.line], [[], 1, 'Nothing needs you']);
});

void test('own PRs whose status is older than 30 minutes are counted as not checked recently', () => {
  const pr = mine(1);
  const stale = { ...readySignals(pr), checkedAt: T0 - 40 * 60_000 };
  const { state } = buildMenubarState(input({ queue: { items: [item(pr)] }, signals: () => stale }));
  assert.deepEqual([state.groups.length, state.unchecked], [0, 1]);
  const fresh = buildMenubarState(input({ queue: { items: [item(pr)] }, signals: () => readySignals(pr) })).state;
  assert.deepEqual([fresh.groups[0].group, fresh.unchecked, fresh.groups[0].rows[0].own], ['ready', 0, true]);
});

void test('tasks: routine work is quiet, other accounts are hidden, failed first, at most five', () => {
  const tasks = [
    task('preload:1', 'preload', 'running'),
    task('github:1', 'github', 'running'),
    task('review:done', 'review', 'completed'),
    task('review:other', 'review', 'running', 'someone-else'),
    task('review:1', 'review', 'running', LOGIN),
    task('briefing:1', 'briefing', 'queued'),
    task('review:failed', 'review', 'failed'),
    ...Array.from({ length: 6 }, (_, i) => task(`chat:${i}`, 'file-chat', 'running')),
  ];
  const result = menubarTasks(tasks, LOGIN);
  assert.equal(result.length, MENUBAR_TASK_LIMIT);
  assert.equal(result[0].id, 'review:failed');
  assert.equal(result.some((t) => ['preload:1', 'github:1', 'review:done', 'review:other'].includes(t.id)), false);
});

void test('the read on open asks for the rows first, then your other open PRs, at most 25', () => {
  const others = Array.from({ length: 30 }, (_, i) => mine(100 + i));
  const queue = { items: [item(requested(1)), ...others.map((pr) => item(pr)), item(member(2))] };
  const { items } = buildMenubarState(input({ queue, signals: (m) => (m.number === 100 ? signals(m, { checks: 'failure' }) : undefined) }));
  const requests = menubarSignalRequests(items, queue, LOGIN);
  assert.equal(requests.length, 25);
  assert.deepEqual(requests.slice(0, 2).map((r) => r.url), [requested(1).url, others[0].url]);
  assert.equal(requests.some((r) => r.url === member(2).url), false, 'Other people’s PRs without a row are not read');
  assert.deepEqual(Object.keys(requests[0]).sort(), ['headSha', 'url']);
});

void test('equal inputs give an equal signature, so an unchanged state is not pushed', () => {
  const signature = createStateSignature();
  assert.equal(signature.changed(buildMenubarState(input()).state), true);
  assert.equal(signature.changed(buildMenubarState(input()).state), false);
  assert.equal(signature.changed(buildMenubarState(input({ refreshing: true })).state), true);
  signature.reset();
  assert.equal(signature.changed(buildMenubarState(input({ refreshing: true })).state), true);
});
