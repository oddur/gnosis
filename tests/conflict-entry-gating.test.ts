import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conflictStateFrom, prEntryActionGroups } from '../components/PrEntryActions';
import { latestPrSignals, publishQueueSignals } from '../lib/queue-signal-store';
import { member, signals } from './notification-fixtures';

const offered = (status?: { mergeable: string; mergeState: string }, withResolver = true) => {
  const pr = member(7, { state: 'open', merged: false });
  const values = status ? [signals(pr, status)] : [];
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

void test('conflict state ignores status for another revision of the PR', () => {
  const pr = member(8);
  const old = signals({ ...pr, headSha: 'older' }, { mergeable: 'CONFLICTING', mergeState: 'DIRTY' });
  assert.equal(conflictStateFrom([old])(pr), 'unchecked');
});

void test('the state icon reads the freshest status of a PR from any account', () => {
  const pr = member(9);
  publishQueueSignals('first', [signals({ ...pr, headSha: 'older' }, { mergeable: 'CONFLICTING', mergeState: 'DIRTY', checkedAt: 1 })]);
  publishQueueSignals('second', [signals(pr, { mergeable: 'MERGEABLE', mergeState: 'CLEAN', checkedAt: 2 })]);
  assert.equal(latestPrSignals(pr.url, pr.headSha)?.readiness?.mergeable, 'MERGEABLE');
  assert.equal(latestPrSignals(pr.url, 'older')?.readiness?.mergeable, 'CONFLICTING');
  assert.equal(latestPrSignals(pr.url)?.readiness?.mergeable, 'MERGEABLE', 'without a head, the newest read wins');
  assert.equal(latestPrSignals('https://github.com/o/r/pull/404'), undefined);
});
