import test from 'node:test';
import assert from 'node:assert/strict';
import { createSettleWait } from '../lib/settle-wait';

/** A clock, timers and animation frames the test moves by hand. */
function fakePage(frames = true) {
  let time = 0;
  /** A scroll whose event has not come yet. */
  let unheard = false;
  let timers: { at: number; run: () => void }[] = [];
  let pending: (() => void)[] = [];
  const settle = createSettleWait(150, {
    now: () => time,
    frame: frames
      ? (run) => {
          pending.push(run);
          return () => {
            pending = pending.filter((other) => other !== run);
          };
        }
      : undefined,
    setTimer: (run, ms) => {
      const timer = { at: time + ms, run };
      timers.push(timer);
      return () => {
        timers = timers.filter((other) => other !== timer);
      };
    },
    moved: () => {
      const moved = unheard;
      unheard = false;
      return moved;
    },
  });
  return {
    settle,
    /** Moves the clock, running the timers that come due. */
    advance(ms: number) {
      const until = time + ms;
      for (;;) {
        const next = timers.filter((timer) => timer.at <= until).sort((a, b) => a.at - b.at).at(0);
        if (!next) break;
        timers = timers.filter((timer) => timer !== next);
        time = next.at;
        next.run();
      }
      time = until;
    },
    /**
     * Draws a frame: its scroll steps (`scroll` delivers a scroll event), then `work` ms of other work in it (layout,
     * other callbacks), then the frame callbacks asked for before it.
     */
    frame({ scroll = false, work = 0, silent = false } = {}) {
      if (scroll) settle.scrolled();
      time += work;
      // A callback that runs before the wait's scrolls the view; its event comes in the next frame.
      if (silent) unheard = true;
      const callbacks = pending;
      pending = [];
      for (const run of callbacks) run();
    },
  };
}

void test('a file near a still view asks after one frame', () => {
  const page = fakePage();
  let runs = 0;
  page.settle.whenSettled(() => runs++);
  assert.equal(runs, 0, 'It waits for a frame');
  page.frame();
  assert.equal(runs, 1);
});

void test('the wait lasts 150 ms after the last scroll, then a frame', () => {
  const page = fakePage();
  page.settle.scrolled();
  let runs = 0;
  page.settle.whenSettled(() => runs++);
  page.advance(149);
  page.frame();
  assert.equal(runs, 0, 'Not before 150 ms');
  page.advance(1);
  page.frame();
  assert.equal(runs, 1);
});

void test('a scroll event in the frame holds the read, though the frame came long after the last scroll (#430)', () => {
  const page = fakePage();
  let runs = 0;
  // At 1/6 CPU frames come 400 ms apart, each with a scroll step, and 200 ms of work before the frame callbacks.
  page.frame({ scroll: true, work: 200 });
  page.advance(200);
  // The file came near between frames, more than 150 ms after the last scroll event.
  page.settle.whenSettled(() => runs++);
  for (let i = 0; i < 10; i++) {
    page.frame({ scroll: true, work: 200 });
    page.advance(200);
  }
  assert.equal(runs, 0, 'The scroll goes on: nothing is read');
  // The scroll stops: a still frame after the wait reads.
  page.advance(150);
  page.frame({ work: 200 });
  assert.equal(runs, 1, 'Read once the view is still');
});

void test('a scroller that moved without its event yet holds the read', () => {
  const page = fakePage();
  let runs = 0;
  page.settle.whenSettled(() => runs++);
  page.frame({ silent: true });
  assert.equal(runs, 0, 'The scroll counts though no event came');
  page.frame({ scroll: true });
  page.advance(100);
  page.frame();
  assert.equal(runs, 0, 'Its event restarts the wait');
  page.advance(50);
  page.frame();
  assert.equal(runs, 1);
});

void test('a cancelled wait never runs', () => {
  const page = fakePage();
  let runs = 0;
  const cancel = page.settle.whenSettled(() => runs++);
  cancel();
  page.frame();
  page.advance(1000);
  page.frame();
  assert.equal(runs, 0);
});

void test('without frames (a hidden window) a still view runs at once', () => {
  const page = fakePage(false);
  let runs = 0;
  page.settle.whenSettled(() => runs++);
  assert.equal(runs, 1);
  page.settle.scrolled();
  page.settle.whenSettled(() => runs++);
  assert.equal(runs, 1, 'Not while a scroll is recent');
  page.advance(150);
  assert.equal(runs, 2);
});
