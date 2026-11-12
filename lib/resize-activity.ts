import { useLayoutEffect, useState, type RefObject } from 'react';

/** How long after the last window `resize` event a resize counts as settled. */
export const RESIZE_SETTLE_MS = 120;

type Observer = Pick<ResizeObserver, 'observe' | 'unobserve' | 'disconnect'>;
interface Environment {
  target: Pick<EventTarget, 'addEventListener'>;
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  createObserver: (callback: ResizeObserverCallback) => ResizeObserver;
}

/** Window-resize activity for work that only needs the final size, such as fitting a diagram. During a drag every
 * step would redo that work; settled observers hold their entries until the window has been still for 120 ms.
 * Size changes outside a window resize, such as opening a pane, pass through at once. */
export function createResizeActivity(environment: Environment) {
  let resizing = false;
  let timer: unknown;
  let listening = false;
  const listeners = new Set<() => void>();
  const listen = () => {
    if (listening) return;
    listening = true;
    environment.target.addEventListener('resize', () => {
      resizing = true;
      environment.clearTimeout(timer);
      timer = environment.setTimeout(() => {
        resizing = false;
        for (const listener of [...listeners]) listener();
      }, RESIZE_SETTLE_MS);
    });
  };
  function isResizing() {
    listen();
    return resizing;
  }
  function onResizeSettled(callback: () => void) {
    listen();
    listeners.add(callback);
    return () => {
      listeners.delete(callback);
    };
  }
  /** A ResizeObserver whose callback gets the latest entry per element once the window resize settles. */
  function settledObserver(callback: ResizeObserverCallback): Observer {
    listen();
    const latest = new Map<Element, ResizeObserverEntry>();
    let unsubscribe: (() => void) | undefined;
    const deliver = () => {
      unsubscribe?.();
      unsubscribe = undefined;
      if (!latest.size) return;
      const entries = [...latest.values()];
      latest.clear();
      callback(entries, observer);
    };
    const observer = environment.createObserver((entries) => {
      if (!resizing) {
        latest.clear();
        callback(entries, observer);
        return;
      }
      for (const entry of entries) latest.set(entry.target, entry);
      unsubscribe ??= onResizeSettled(deliver);
    });
    return {
      observe: (element, options) => {
        observer.observe(element, options);
      },
      unobserve: (element) => {
        latest.delete(element);
        observer.unobserve(element);
      },
      disconnect: () => {
        unsubscribe?.();
        unsubscribe = undefined;
        latest.clear();
        observer.disconnect();
      },
    };
  }
  return { isResizing, onResizeSettled, settledObserver };
}

let shared: ReturnType<typeof createResizeActivity> | undefined;
const activity = () =>
  (shared ??= createResizeActivity({
    target: window,
    setTimeout: (callback, ms) => window.setTimeout(callback, ms),
    clearTimeout: (handle) => {
      window.clearTimeout(handle as number);
    },
    createObserver: (callback) => new ResizeObserver(callback),
  }));

export const isResizing = () => activity().isResizing();
export const onResizeSettled = (callback: () => void) => activity().onResizeSettled(callback);
export const settledObserver = (callback: ResizeObserverCallback) => activity().settledObserver(callback);

/** The element's content-box size, updated at once for layout changes and once a window resize settles. */
export function useSettledSize(ref: RefObject<Element | null>) {
  const [size, setSize] = useState<{ width: number; height: number }>();
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = settledObserver((entries) => {
      const box = entries[entries.length - 1].contentRect;
      setSize((current) =>
        current?.width === box.width && current.height === box.height
          ? current
          : { width: box.width, height: box.height }
      );
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}
