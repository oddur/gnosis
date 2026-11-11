import test from 'node:test';
import assert from 'node:assert/strict';
import { createRowIntent } from '../lib/row-intent';

function harness() {
  const events: string[] = [];
  const intent = createRowIntent({ fire: (id) => events.push(`fire:${id}`), clear: () => events.push('clear') });
  return { intent, events };
}

void test('fires after 150 ms', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { intent, events } = harness();
  intent.enter('a');
  t.mock.timers.tick(149);
  assert.deepEqual(events, []);
  t.mock.timers.tick(1);
  assert.deepEqual(events, ['fire:a']);
  intent.enter('a');
  t.mock.timers.tick(500);
  assert.deepEqual(events, ['fire:a'], 'The same row does not fire twice in a row');
  intent.leave();
  assert.deepEqual(events, ['fire:a', 'clear']);
});

void test('rapid moves fire once', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { intent, events } = harness();
  // A held arrow key or a quick pass over the queue.
  for (const id of ['a', 'b', 'c', 'd']) {
    intent.enter(id);
    t.mock.timers.tick(100);
  }
  t.mock.timers.tick(50);
  assert.deepEqual(events, ['fire:d']);
  intent.enter('e');
  t.mock.timers.tick(150);
  assert.deepEqual(events, ['fire:d', 'fire:e'], 'A newer row replaces the intent without clearing it first');
});

void test('leave cancels', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { intent, events } = harness();
  intent.enter('a');
  t.mock.timers.tick(100);
  intent.leave();
  t.mock.timers.tick(500);
  assert.deepEqual(events, [], 'Leaving before 150 ms sends nothing, and there is nothing to clear');
});
