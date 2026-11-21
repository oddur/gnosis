import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { prEntryActionGroups } from '../components/PrEntryActions';
import { conflictStateFor, conflictStateFrom } from '../lib/merge-conflicts';
import { QUEUE_SIGNALS_TTL } from '../lib/queue-signals';
import { latestPrSignals, publishQueueSignals } from '../lib/queue-signal-store';
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
  assert.equal(offered(undefined), true, 'no status for the current head');
  assert.equal(offered({ mergeable: 'MERGEABLE', mergeState: 'CLEAN' }), false, 'ready to merge');
  assert.equal(offered({ mergeable: 'MERGEABLE', mergeState: 'BEHIND' }), false, 'only behind: Update branch covers it');
  assert.equal(offered({ mergeable: 'MERGEABLE', mergeState: 'CLEAN' }, false), true, 'menus without status keep the item');
});

void test('an idle clean PR keeps the item hidden however old its status is', (t) => {
  t.after(() => mock.timers.reset());
  mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const pr = member(11);
  const clean = signals(pr, { mergeable: 'MERGEABLE', mergeState: 'CLEAN', checkedAt: Date.now() });
  mock.timers.tick(10 * QUEUE_SIGNALS_TTL);
  assert.equal(conflictStateFor(clean), 'clear', 'Main sends status only on changes; an idle answer still holds');
  assert.equal(conflictStateFrom([clean])(pr), 'clear');
  assert.equal(conflictStateFor(undefined), 'unchecked');
});

void test('the freshest value for the current head wins; other revisions are ignored', () => {
  const pr = member(8);
  const older = signals(pr, { mergeable: 'MERGEABLE', mergeState: 'CLEAN', checkedAt: 1 });
  const newer = signals(pr, { mergeable: 'CONFLICTING', mergeState: 'DIRTY', checkedAt: 2 });
  assert.equal(conflictStateFrom([newer, older])(pr), 'conflicts');
  assert.equal(conflictStateFrom([older, newer])(pr), 'conflicts', 'Not the first match');
  const otherHead = signals({ ...pr, headSha: 'older' }, { mergeable: 'CONFLICTING', mergeState: 'DIRTY', checkedAt: 3 });
  assert.equal(conflictStateFrom([otherHead])(pr), 'unchecked');
});

void test('the state icon reads a revision when it has a head, and the newest value of the PR when it does not', () => {
  const pr = member(9);
  publishQueueSignals('first', [signals({ ...pr, headSha: 'older' }, { mergeable: 'CONFLICTING', mergeState: 'DIRTY', checkedAt: 1 })]);
  publishQueueSignals('second', [signals(pr, { mergeable: 'MERGEABLE', mergeState: 'CLEAN', checkedAt: 2 })]);
  assert.equal(latestPrSignals(pr.url, pr.headSha)?.readiness?.mergeable, 'MERGEABLE');
  assert.equal(latestPrSignals(pr.url, 'older')?.readiness?.mergeable, 'CONFLICTING');
  assert.equal(latestPrSignals(pr.url)?.readiness?.mergeable, 'MERGEABLE', 'Without a head, the newest value wins');
  publishQueueSignals('first', [signals({ ...pr, headSha: 'older' }, { mergeable: 'CONFLICTING', mergeState: 'DIRTY', checkedAt: 3 })]);
  assert.equal(latestPrSignals(pr.url)?.readiness?.mergeable, 'CONFLICTING');
  assert.equal(latestPrSignals('https://github.com/o/r/pull/404'), undefined);
});
