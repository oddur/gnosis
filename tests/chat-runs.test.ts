import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createChatRuns, waitForChatContext } from '../src/chat-runs';
void test('chat cancellation isolates renderers and requests and releases finished runs', () => {
  const registry = createChatRuns();
  const a = registry.begin(1, 'same'),
    b = registry.begin(2, 'same'),
    c = registry.begin(1, 'other');
  assert.throws(() => registry.begin(1, 'same'), /already running/);
  registry.cancel(1, 'same');
  assert.equal(a.controller.signal.aborted, true);
  assert.equal(b.controller.signal.aborted, false);
  assert.equal(c.controller.signal.aborted, false);
  a.release();
  const replacement = registry.begin(1, 'same');
  a.release();
  registry.cancel(1, 'same');
  assert.equal(replacement.controller.signal.aborted, true, 'An old release cannot erase a new run');
  b.release();
  registry.cancel(2, 'same');
  assert.equal(b.controller.signal.aborted, false);
});

void test('stopping chat interrupts context waits without waiting for shared cache fetches', async () => {
  const controller = new AbortController();
  let finish!: (value: string) => void;
  const pending = waitForChatContext(
    () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
    controller.signal
  );
  controller.abort();
  await assert.rejects(pending, /GNOSIS_CANCELLED/);
  finish('Still useful to the cache');
  let invoked = false;
  await assert.rejects(
    waitForChatContext(() => {
      invoked = true;
      return Promise.resolve('cached');
    }, controller.signal)
  );
  assert.equal(invoked, false);
});
