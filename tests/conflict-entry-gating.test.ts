import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prEntryActionGroups } from '../components/PrEntryActions';
import { conflictStateFrom } from '../lib/merge-conflicts';
import { QUEUE_SIGNALS_TTL } from '../lib/queue-signals';
import { latestPrSignals, notePrHeads, publishQueueSignals } from '../lib/queue-signal-store';
import { member, signals } from './notification-fixtures';

const offered = (status?: { mergeable: string; mergeState: string; checkedAt?: number }, withResolver = true) => {
  const pr = member(7, { state: 'open', merged: false });
  const values = status ? [signals(pr, { checkedAt: Date.now(), ...status })] : [];
  return prEntryActionGroups({
    members: [pr],
    starredUrls: new Set(),
    onStarChange: () => {},
    ...(withResolver ? { conflictState: conflictStateFrom(values) } : {}),
  })
    .flat()
    .some((action) => action.label === 'Resolve conflicts…');
};

void test('"Resolve conflicts…" is offered for conflicts and unknown merge states, not for clean or behind PRs', () => {
  assert.equal(offered({ mergeable: 'CONFLICTING', mergeState: 'DIRTY' }), true, 'conflicting');
  assert.equal(offered({ mergeable: 'UNKNOWN', mergeState: 'DIRTY' }), true, 'DIRTY while mergeable is computing');
  assert.equal(offered({ mergeable: 'UNKNOWN', mergeState: 'UNKNOWN' }), true, 'GitHub still computing');
  assert.equal(offered(undefined), true, 'no status read yet');
  assert.equal(offered({ mergeable: 'MERGEABLE', mergeState: 'CLEAN' }), false, 'ready to merge');
  assert.equal(offered({ mergeable: 'MERGEABLE', mergeState: 'BEHIND' }), false, 'only behind: Update branch covers it');
  assert.equal(offered({ mergeable: 'MERGEABLE', mergeState: 'CLEAN' }, false), true, 'menus without status keep the item');
});

void test('an expired clean answer counts as unknown, so the item stays offered', () => {
  const old = Date.now() - QUEUE_SIGNALS_TTL - 1;
  assert.equal(offered({ mergeable: 'MERGEABLE', mergeState: 'CLEAN', checkedAt: old }), true, 'after a restart or backoff');
  assert.equal(offered({ mergeable: 'MERGEABLE', mergeState: 'CLEAN', checkedAt: Date.now() - QUEUE_SIGNALS_TTL + 5_000 }), false);
});

void test('conflict state ignores status for another revision of the PR', () => {
  const pr = member(8);
  const old = signals({ ...pr, headSha: 'older' }, { mergeable: 'CONFLICTING', mergeState: 'DIRTY', checkedAt: Date.now() });
  assert.equal(conflictStateFrom([old])(pr), 'unchecked');
});

void test('the state icon reads the freshest status of a PR from any account, for its current head', () => {
  const pr = member(9);
  publishQueueSignals('first', [signals({ ...pr, headSha: 'older' }, { mergeable: 'CONFLICTING', mergeState: 'DIRTY', checkedAt: 1 })]);
  publishQueueSignals('second', [signals(pr, { mergeable: 'MERGEABLE', mergeState: 'CLEAN', checkedAt: 2 })]);
  assert.equal(latestPrSignals(pr.url, pr.headSha)?.readiness?.mergeable, 'MERGEABLE');
  assert.equal(latestPrSignals(pr.url, 'older')?.readiness?.mergeable, 'CONFLICTING');
  assert.equal(latestPrSignals(pr.url)?.readiness?.mergeable, 'MERGEABLE', 'without a head, the newest read wins');
  assert.equal(latestPrSignals('https://github.com/o/r/pull/404'), undefined);

  // Just pushed: the old head's conflicts were read last, but the queue shows the new head. No status for it yet.
  const pushed = member(10);
  publishQueueSignals('first', [signals({ ...pushed, headSha: 'before-push' }, { mergeable: 'CONFLICTING', mergeState: 'DIRTY', checkedAt: 5 })]);
  assert.equal(latestPrSignals(pushed.url)?.readiness?.mergeable, 'CONFLICTING');
  notePrHeads([pushed]);
  assert.equal(latestPrSignals(pushed.url), undefined, 'An icon without a head never shows the old head’s conflicts');
  publishQueueSignals('first', [signals(pushed, { mergeable: 'MERGEABLE', mergeState: 'CLEAN', checkedAt: 4 })]);
  assert.equal(latestPrSignals(pushed.url)?.readiness?.mergeable, 'MERGEABLE');
});
