import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../src/app-data-store';
import { createNotificationStore, notificationStateName } from '../src/notification-store';
import { LOGIN, T0, member, mine, signals } from './notification-fixtures';

const observe = (store: ReturnType<typeof createNotificationStore>, observations: Parameters<ReturnType<typeof createNotificationStore>['observe']>[1], extra: { finishBaseline?: boolean; count?: boolean } = {}) =>
  store.observe(LOGIN, observations, { login: LOGIN, ...extra }).map((event) => event.key);

test('keys survive a reload, so a replayed snapshot after a restart fires nothing', () => {
  const saved = new Map<string, string>();
  let clock = T0;
  const first = createNotificationStore(createMemoryStorage(saved), () => clock);
  observe(first, [{ member: member(1) }], { finishBaseline: true });
  const asked = member(1, { requestedReviewers: [LOGIN] });
  assert.deepEqual(observe(first, [{ member: asked }]), ['requested|https://github.com/o/r/pull/1|1']);
  clock += 60_000;
  const restarted = createNotificationStore(createMemoryStorage(saved), () => clock);
  assert.equal(restarted.initialized(LOGIN), true);
  assert.deepEqual(observe(restarted, [{ member: asked }]), []);
});

test('the same event arriving by two paths is delivered once', () => {
  let clock = T0;
  const store = createNotificationStore(createMemoryStorage(), () => clock);
  const pr = mine(1);
  observe(store, [{ member: pr, signals: signals(pr) }], { finishBaseline: true });
  clock += 1000;
  const failing = signals(pr, { checks: 'failure', checkedAt: clock });
  assert.deepEqual(observe(store, [{ member: pr, signals: failing }]), ['checks-failed|https://github.com/o/r/pull/1|head-1']);
  // Re-run and fail again on the same SHA.
  clock += 1000;
  observe(store, [{ member: pr, signals: signals(pr, { checks: 'pending', checkedAt: clock }) }]);
  clock += 1000;
  assert.deepEqual(observe(store, [{ member: pr, signals: signals(pr, { checks: 'failure', checkedAt: clock }) }], { count: true }), []);
  const today = Object.values(store.counters(LOGIN))[0];
  assert.equal(today['checks-failed']?.['suppressed:duplicate'], 1);
});

test('the first run only records a baseline', () => {
  const store = createNotificationStore(createMemoryStorage(), () => T0);
  assert.deepEqual(observe(store, [{ member: member(1, { requestedReviewers: [LOGIN] }) }]), []);
  assert.equal(store.initialized(LOGIN), false);
  observe(store, [], { finishBaseline: true });
  assert.equal(store.initialized(LOGIN), true);
  assert.deepEqual(observe(store, [{ member: member(1, { requestedReviewers: [LOGIN] }) }]), []);
});

test('a suppressed event keeps its key, so unmuting does not deliver it later', () => {
  const store = createNotificationStore(createMemoryStorage(), () => T0);
  observe(store, [{ member: member(1) }], { finishBaseline: true });
  const asked = member(1, { requestedReviewers: [LOGIN] });
  assert.deepEqual(store.observe(LOGIN, [{ member: asked }], { login: LOGIN, suppress: () => 'muted' }), []);
  assert.deepEqual(observe(store, [{ member: asked }]), []);
});

test('an unchanged queue saves nothing; rows unseen for 30 days are dropped', () => {
  const saved = new Map<string, string>();
  let clock = T0;
  const store = createNotificationStore(createMemoryStorage(saved), () => clock);
  observe(store, [{ member: member(1) }, { member: member(2) }], { finishBaseline: true });
  const before = saved.get(notificationStateName(LOGIN));
  clock += 60_000;
  observe(store, [{ member: member(1) }, { member: member(2) }]);
  assert.equal(saved.get(notificationStateName(LOGIN)), before);
  clock += 31 * 86_400_000;
  const later = createNotificationStore(createMemoryStorage(saved), () => clock);
  assert.equal(later.basis(LOGIN, member(1).url), undefined);
});

test('invalid saved data is rejected and replaced by a new silent baseline', () => {
  for (const value of [{ initialized: 'yes', entries: {} }, { initialized: true, entries: { 'not a url': {} } }, { initialized: true, entries: { [member(1).url]: { basis: { headSha: 1 }, fired: {} } } }]) {
    const saved = new Map([[notificationStateName(LOGIN), JSON.stringify(value)]]);
    const store = createNotificationStore(createMemoryStorage(saved), () => T0);
    assert.equal(store.initialized(LOGIN), false);
    assert.deepEqual(observe(store, [{ member: member(1, { requestedReviewers: [LOGIN] }) }]), []);
  }
});

test('counters hold no names and keep 30 days', () => {
  let clock = T0;
  const store = createNotificationStore(createMemoryStorage(), () => clock);
  for (let day = 0; day < 35; day++) {
    store.count(LOGIN, 'review-requested', 'clicked');
    clock += 86_400_000;
  }
  const counters = store.counters(LOGIN);
  assert.equal(Object.keys(counters).length, 30);
  assert.doesNotMatch(JSON.stringify(counters), /github|o\/r/);
});
