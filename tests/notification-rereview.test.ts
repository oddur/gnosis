import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveEvents, type PrBasis, type PrObservation } from '../lib/notification-events';
import { levelAllows, notificationSettings } from '../lib/notification-settings';
import { coalesce, URGENCY } from '../lib/notification-routing';
import { preciseTarget } from '../lib/notification-targets';
import { LOGIN, T0, member, mine, signals } from './notification-fixtures';
import type { ReviewMember } from '../lib/workbench';
import type { QueueSignals } from '../lib/queue-signals';

/** Signals for `pr` in which the reader's latest review was made on `reviewedSha`. */
const reviewedOn = (pr: ReviewMember, reviewedSha: string, extra: { checkedAt?: number; author?: string; pushedBy?: string } = {}): QueueSignals => {
  const value = signals(pr, { checkedAt: extra.checkedAt });
  return {
    ...value,
    latestReview: { url: `${pr.url}#pullrequestreview-9`, author: extra.author ?? LOGIN, state: 'COMMENTED', submittedAt: '2026-11-14T08:00:00Z', headSha: reviewedSha },
    ...(extra.pushedBy ? { activity: { head: { author: extra.pushedBy, committer: extra.pushedBy } } } : {}),
  };
};
function run(steps: PrObservation[]) {
  let basis: PrBasis | undefined;
  const events: { type: string; key: string; target?: unknown }[] = [];
  const resolved: string[][] = [];
  steps.forEach((step, i) => {
    const result = deriveEvents(basis, step, { login: LOGIN, now: T0 + i * 60_000, initialized: true });
    basis = result.basis;
    resolved.push(result.resolved);
    events.push(...result.events.map(({ type, key, target }) => ({ type, key, target })));
  });
  return { basis, events, resolved };
}
const at = (i: number) => T0 + i * 60_000;

void test('new commits after your review raise one re-review, once per head', () => {
  const a = member(1, { headSha: 'a' });
  const b = member(1, { headSha: 'b' });
  const c = member(1, { headSha: 'c' });
  const { events } = run([
    { member: a, signals: reviewedOn(a, 'a', { checkedAt: at(0) }) },
    { member: b, signals: reviewedOn(b, 'a', { checkedAt: at(1) }) },
    { member: b, signals: reviewedOn(b, 'a', { checkedAt: at(2) }) },
    { member: c, signals: reviewedOn(c, 'a', { checkedAt: at(3) }) },
  ]);
  assert.deepEqual(events.map((e) => e.key), ['rereview|https://github.com/o/r/pull/1|b', 'rereview|https://github.com/o/r/pull/1|c']);
  assert.deepEqual(events[0].target, { kind: 'pr', pr: { host: 'github.com', owner: 'o', repo: 'r', number: 1 }, tab: 'changes' });
});

void test('a head seen before its signals waits in the basis until they arrive', () => {
  const a = member(1, { headSha: 'a' });
  const b = member(1, { headSha: 'b' });
  const { events, basis } = run([
    { member: a, signals: reviewedOn(a, 'a', { checkedAt: at(0) }) },
    { member: b },
    { member: b, signals: reviewedOn(b, 'a', { checkedAt: at(2) }) },
  ]);
  assert.deepEqual(events.map((e) => e.type), ['rereview']);
  assert.equal(basis?.rereviewHead, undefined, 'cleared once the signals were read');
});

void test('no re-review without your review, on a head you reviewed, on your own PR, on a draft, or for your own push', () => {
  const a = member(1, { headSha: 'a' });
  const b = member(1, { headSha: 'b' });
  const nothing = (steps: PrObservation[]) => assert.deepEqual(run(steps).events, []);
  nothing([{ member: a, signals: reviewedOn(a, 'a', { author: 'maya', checkedAt: at(0) }) }, { member: b, signals: reviewedOn(b, 'a', { author: 'maya', checkedAt: at(1) }) }]);
  nothing([{ member: a, signals: reviewedOn(a, 'a', { checkedAt: at(0) }) }, { member: b, signals: reviewedOn(b, 'b', { checkedAt: at(1) }) }]);
  const ownA = mine(1, { headSha: 'a' });
  const ownB = mine(1, { headSha: 'b' });
  nothing([{ member: ownA, signals: reviewedOn(ownA, 'a', { checkedAt: at(0) }) }, { member: ownB, signals: reviewedOn(ownB, 'a', { checkedAt: at(1) }) }]);
  const draft = member(1, { headSha: 'b', isDraft: true });
  nothing([{ member: a, signals: reviewedOn(a, 'a', { checkedAt: at(0) }) }, { member: draft, signals: reviewedOn(draft, 'a', { checkedAt: at(1) }) }]);
  nothing([{ member: a, signals: reviewedOn(a, 'a', { checkedAt: at(0) }) }, { member: b, signals: reviewedOn(b, 'a', { checkedAt: at(1), pushedBy: LOGIN }) }]);
  // A PR seen for the first time only starts a basis.
  nothing([{ member: b, signals: reviewedOn(b, 'a', { checkedAt: at(0) }) }]);
});

void test('reviewing the new head resolves the re-review', () => {
  const a = member(1, { headSha: 'a' });
  const b = member(1, { headSha: 'b' });
  const { resolved } = run([
    { member: a, signals: reviewedOn(a, 'a', { checkedAt: at(0) }) },
    { member: b, signals: reviewedOn(b, 'a', { checkedAt: at(1) }) },
    { member: b, signals: reviewedOn(b, 'b', { checkedAt: at(2) }) },
  ]);
  assert.equal(resolved[1].includes('rereview'), false);
  assert.equal(resolved[2].includes('rereview'), true);
});

void test('re-review: on by default, "on me", review-request urgency, worded title, Changes at the first unviewed file', () => {
  assert.equal(notificationSettings({}).events.rereview, true);
  assert.equal(levelAllows('on-me', { type: 'rereview' }), true);
  assert.equal(URGENCY.rereview, URGENCY['review-requested']);
  const event = { type: 'rereview' as const, key: 'k', title: 'Fix retry backoff', url: 'https://github.com/o/r/pull/1', repo: 'o/r', number: 1, at: T0 };
  assert.equal(coalesce([event], 'n')?.title, 'New commits · Fix retry backoff');
  assert.equal(coalesce([event], 'n')?.body, 'New commits since your review');
  assert.deepEqual(preciseTarget(event), { kind: 'pr', pr: { host: 'github.com', owner: 'o', repo: 'r', number: 1 }, tab: 'changes', focus: 'unviewed-file' });
});
