import test from 'node:test';
import assert from 'node:assert/strict';
import { publishQueueSignals, signalStamp, signalValues, updates } from '../lib/queue-signal-store';
import type { QueueSignals } from '../lib/queue-signals';

const pr = (n: number, headSha = `head-${n}`) => ({ url: `https://github.com/owner/repo/pull/${n}`, headSha });
const signal = (n: number, checkedAt: number, headSha?: string): QueueSignals => ({
  ...pr(n, headSha), checkedAt, comments: 0, checks: { state: 'success', passed: 1, total: 1 },
});
let accounts = 0;
// Each test uses its own account, because the store is shared by the whole renderer.
const scope = () => `account-${++accounts}`;

void test('published signals are readable synchronously for the same head SHA', () => {
  const account = scope();
  publishQueueSignals(account, [signal(1, 100)]);
  assert.deepEqual(signalValues(account, [pr(1)]), [signal(1, 100)]);
  assert.equal(signalStamp(account, [pr(1)]), '100');
});

void test('a different head SHA reads nothing', () => {
  const account = scope();
  publishQueueSignals(account, [signal(1, 100)]);
  assert.deepEqual(signalValues(account, [pr(1, 'force-pushed')]), []);
  assert.equal(signalStamp(account, [pr(1, 'force-pushed')]), '');
  assert.deepEqual(signalValues(scope(), [pr(1)]), [], 'Another account reads nothing');
});

void test('stamp changes only for the published member', () => {
  const account = scope();
  publishQueueSignals(account, [signal(1, 100), signal(2, 100)]);
  const first = signalStamp(account, [pr(1)]);
  const second = signalStamp(account, [pr(2)]);
  let events = 0;
  const count = () => events++;
  updates.addEventListener(account, count);
  publishQueueSignals(account, [signal(2, 200)]);
  updates.removeEventListener(account, count);
  assert.equal(events, 1);
  assert.equal(signalStamp(account, [pr(1)]), first, 'An unchanged row keeps its stamp and does not render');
  assert.notEqual(signalStamp(account, [pr(2)]), second);
  assert.equal(typeof signalStamp(account, [pr(1), pr(2)]), 'string');
});

void test('older checkedAt never replaces newer', () => {
  const account = scope();
  publishQueueSignals(account, [signal(1, 200)]);
  publishQueueSignals(account, [{ ...signal(1, 100), comments: 9 }]);
  assert.deepEqual(signalValues(account, [pr(1)]), [signal(1, 200)]);
  assert.equal(signalStamp(account, [pr(1)]), '200');
});
