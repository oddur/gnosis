/**
 * Waits for a still view: no scroll for `settleMs`, then a whole frame with no scroll event in it (#429, #430).
 *
 * Time alone is not enough. Scroll events arrive only when a frame draws, so on a slow machine frames can come more
 * than `settleMs` apart while a scroll goes on. A frame's scroll steps deliver its scroll events before its animation
 * frame callbacks run, so the last check runs in the next frame. That check counts scroll events, not time: under
 * heavy load the work in a frame (layout, other callbacks) can take longer than `settleMs` by itself, so a scroll event
 * delivered at the start of the frame can look old by the time the check runs. Any scroll event since the frame was
 * asked for means the view moved, and the wait goes on. So does a scroller that is not where its last scroll event left
 * it (`moved`): a scroll made earlier in the same frame, or one whose event has not come yet, counts as a scroll then.
 */
export interface SettleEnvironment {
  now: () => number;
  /** Undefined where there are no frames (a hidden window, a test without a page): the wait ends without one. */
  frame?: (run: () => void) => () => void;
  setTimer: (run: () => void, ms: number) => () => void;
  /** Whether a scroller moved since its last scroll event; asked in the wait's last frame. */
  moved?: () => boolean;
}

export interface SettleWait {
  /** The view scrolled: call from a capturing `scroll` listener. */
  scrolled: () => void;
  /** Runs `run` once the view is still; the returned function cancels it. */
  whenSettled: (run: () => void) => () => void;
}

export function createSettleWait(settleMs: number, environment: SettleEnvironment): SettleWait {
  let lastScrollAt = -Infinity;
  let scrolls = 0;
  return {
    scrolled() {
      lastScrollAt = environment.now();
      scrolls++;
    },
    whenSettled(run) {
      let cancelTimer: (() => void) | undefined;
      let cancelFrame: (() => void) | undefined;
      let done = false;
      const check = () => {
        cancelTimer = cancelFrame = undefined;
        const wait = lastScrollAt + settleMs - environment.now();
        if (wait > 0) {
          cancelTimer = environment.setTimer(check, wait);
          return;
        }
        const frame = environment.frame;
        if (!frame) {
          done = true;
          run();
          return;
        }
        const seen = scrolls;
        cancelFrame = frame(() => {
          cancelFrame = undefined;
          if (done) return;
          if (environment.moved?.()) {
            lastScrollAt = environment.now();
            scrolls++;
          }
          if (scrolls !== seen) {
            check();
            return;
          }
          done = true;
          run();
        });
      };
      check();
      return () => {
        done = true;
        cancelTimer?.();
        cancelFrame?.();
      };
    },
  };
}
