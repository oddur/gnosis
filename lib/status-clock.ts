import { useSyncExternalStore } from 'react';
import { isResizing } from './resize-activity';

export interface StatusClockHost {
  now: () => number;
  setInterval: (callback: () => void, ms: number) => unknown;
  clearInterval: (timer: unknown) => void;
  /** Receives `focus`. */
  window?: EventTarget;
  /** Receives `visibilitychange`. */
  document?: EventTarget;
  /** While true, interval ticks are skipped. Focus and visibility changes still tick. */
  paused?: () => boolean;
}

const browserHost = (): StatusClockHost => ({
  now: Date.now,
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: (timer) => clearInterval(timer as ReturnType<typeof setInterval>),
  window,
  document,
});

/**
 * One clock for every status badge and readiness label. Subscribers read the same time, and they all
 * update together: every 30 seconds, and when the window regains focus or becomes visible.
 */
export function createStatusClock(host: () => StatusClockHost = browserHost, interval = 30_000) {
  const listeners = new Set<() => void>();
  let now = 0;
  let stop: (() => void) | undefined;
  const tick = () => {
    now = host().now();
    for (const listener of [...listeners]) listener();
  };
  const start = () => {
    const current = host();
    const timer = current.setInterval(() => {
      if (!current.paused?.()) tick();
    }, interval);
    current.window?.addEventListener('focus', tick);
    current.document?.addEventListener('visibilitychange', tick);
    return () => {
      current.clearInterval(timer);
      current.window?.removeEventListener('focus', tick);
      current.document?.removeEventListener('visibilitychange', tick);
    };
  };
  return {
    /** Read the time now and update every subscriber together, for example when new status arrives. */
    tick,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      stop ??= start();
      return () => {
        listeners.delete(listener);
        if (listeners.size) return;
        stop?.();
        stop = undefined;
      };
    },
    /**
     * The shared time. While nothing listens the timer is stopped, so a first reader gets a time no
     * more than a second old instead of the time the last listener saw.
     */
    getSnapshot: () => {
      if (!listeners.size) {
        const current = host().now();
        if (current - now >= 1000) now = current;
      }
      return now;
    },
  };
}

export const statusClock = createStatusClock();

/** The shared status time. The component renders again when it ticks. */
export function useStatusNow() {
  return useSyncExternalStore(statusClock.subscribe, statusClock.getSnapshot);
}

/**
 * One 1-second clock for the elapsed time of running CI jobs and steps. It runs only while a running
 * duration label is mounted, and skips ticks while the window is hidden or being resized.
 */
export const elapsedClock = createStatusClock(
  () => ({
    ...browserHost(),
    paused: () => document.visibilityState === 'hidden' || isResizing(),
  }),
  1000
);

const idle = () => () => {};

/** The shared elapsed-time clock. The component renders again each second, but only while `running`. */
export function useElapsedNow(running: boolean) {
  return useSyncExternalStore(running ? elapsedClock.subscribe : idle, elapsedClock.getSnapshot);
}
