import test from 'node:test';
import assert from 'node:assert/strict';
import { createStartup, gateHandlers, afterStartup } from '../src/startup';

type Listener = (event: unknown, ...args: unknown[]) => unknown;
function registry() {
  const handlers = new Map<string, Listener>();
  return {
    handlers,
    handle(channel: string, listener: Listener) {
      handlers.set(channel, listener);
    },
    invoke: (channel: string, ...args: unknown[]) => Promise.resolve(handlers.get(channel)?.({}, ...args)),
  };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
function gated() {
  const startup = createStartup();
  const ipc = registry();
  gateHandlers(ipc, startup, { ungated: ['load-preferences'], dataOnly: ['load-review-state'] });
  const calls: string[] = [];
  for (const channel of ['load-preferences', 'load-review-state', 'workbench-snapshot', 'new-handler'])
    ipc.handle(channel, (_event, ...args) => {
      calls.push(channel);
      return [channel, ...args];
    });
  return { startup, ipc, calls };
}

void test('gated handler waits for all', async () => {
  const { startup, ipc, calls } = gated();
  const snapshot = ipc.invoke('workbench-snapshot', 'argument');
  const added = ipc.invoke('new-handler');
  startup.resolveData();
  await tick();
  assert.deepEqual(calls, [], 'Handlers wait for every store unless listed');
  startup.resolveAll();
  assert.deepEqual(await snapshot, ['workbench-snapshot', 'argument']);
  await added;
  assert.deepEqual(calls, ['workbench-snapshot', 'new-handler']);
});

void test('dataOnly handler runs before cache', async () => {
  const { startup, ipc, calls } = gated();
  const state = ipc.invoke('load-review-state');
  await tick();
  assert.deepEqual(calls, []);
  startup.resolveData();
  assert.deepEqual(await state, ['load-review-state']);
  assert.equal(startup.ready('all'), false);
});

void test('ungated handler runs at once', async () => {
  const { ipc, calls } = gated();
  const preferences = ipc.handlers.get('load-preferences')?.({});
  assert.deepEqual(preferences, ['load-preferences'], 'The listener is registered unwrapped');
  assert.deepEqual(calls, ['load-preferences']);
  // Ready handlers call through without waiting for another turn.
  await ipc.invoke('load-preferences');
});

void test('failure rejects waiting handlers', async () => {
  const { startup, ipc, calls } = gated();
  const snapshot = ipc.invoke('workbench-snapshot');
  const state = ipc.invoke('load-review-state');
  startup.fail(new Error('Could not open saved data'));
  await assert.rejects(snapshot, /Could not open saved data/);
  await assert.rejects(state, /Could not open saved data/);
  assert.deepEqual(calls, []);
});

void test('on-listeners keep order', async () => {
  const startup = createStartup();
  const seen: string[] = [];
  const listener = afterStartup(startup, (_event: unknown, value: string) => seen.push(value));
  listener({}, 'first');
  listener({}, 'second');
  await tick();
  assert.deepEqual(seen, [], 'Messages wait for startup');
  startup.resolveAll();
  listener({}, 'third');
  await tick();
  assert.deepEqual(seen, ['first', 'second', 'third']);
});
