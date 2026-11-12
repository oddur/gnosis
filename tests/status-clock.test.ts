import test from 'node:test';
import assert from 'node:assert/strict';
import { createStatusClock, type StatusClockHost } from '../lib/status-clock';

function fakeHost() {
  const timers = new Map<number, () => void>();
  let next = 0;
  const host = {
    time: 1_000_000,
    timers,
    window: new EventTarget(),
    document: new EventTarget(),
    now: () => host.time,
    setInterval: (callback: () => void) => {
      timers.set(++next, callback);
      return next;
    },
    clearInterval: (timer: unknown) => {
      timers.delete(timer as number);
    },
    fire: () => {
      for (const callback of [...timers.values()]) callback();
    },
  };
  return host;
}

void test('one timer for many subscribers', () => {
  const host = fakeHost();
  const clock = createStatusClock(() => host as StatusClockHost);
  const seen: number[][] = [[], [], []];
  const stops = seen.map((values) => clock.subscribe(() => values.push(clock.getSnapshot())));
  assert.equal(host.timers.size, 1);
  host.time += 30_000;
  host.fire();
  // Every subscriber reads the same time from the same tick.
  assert.deepEqual(seen, [[host.time], [host.time], [host.time]]);
  for (const stop of stops) stop();
});

void test('focus and visibilitychange tick', () => {
  const host = fakeHost();
  const clock = createStatusClock(() => host as StatusClockHost);
  let ticks = 0;
  const stop = clock.subscribe(() => ticks++);
  host.time += 5_000;
  host.window.dispatchEvent(new Event('focus'));
  assert.equal(ticks, 1);
  assert.equal(clock.getSnapshot(), host.time);
  host.time += 5_000;
  host.document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(ticks, 2);
  assert.equal(clock.getSnapshot(), host.time);
  stop();
});

void test('timer stops with the last unsubscribe', () => {
  const host = fakeHost();
  const clock = createStatusClock(() => host as StatusClockHost);
  const first = clock.subscribe(() => {});
  const second = clock.subscribe(() => {});
  first();
  assert.equal(host.timers.size, 1, 'One subscriber still listens');
  second();
  assert.equal(host.timers.size, 0);
  let ticks = 0;
  const count = () => ticks++;
  clock.subscribe(count)();
  host.window.dispatchEvent(new Event('focus'));
  assert.equal(ticks, 0, 'Focus no longer ticks');
  // A first reader after a pause does not see the time the last listener saw.
  host.time += 60_000;
  assert.equal(clock.getSnapshot(), host.time);
  assert.equal(clock.getSnapshot(), clock.getSnapshot(), 'Consecutive reads agree');
});

void test('paused interval ticks are skipped', () => {
  const host = fakeHost();
  let paused = true;
  const clock = createStatusClock(() => ({ ...(host as StatusClockHost), paused: () => paused }), 1000);
  let ticks = 0;
  const stop = clock.subscribe(() => ticks++);
  host.fire();
  assert.equal(ticks, 0, 'A paused clock does not tick');
  host.document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(ticks, 1, 'Becoming visible still ticks');
  paused = false;
  host.time += 1000;
  host.fire();
  assert.equal(ticks, 2);
  assert.equal(clock.getSnapshot(), host.time);
  stop();
});
