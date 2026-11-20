import { useEffect, useRef } from 'react';
import type { Virtualizer, VirtualItem } from '@tanstack/react-virtual';

/**
 * A settled signal for the browser checks: they wait until the app says a part of the screen is done moving, then
 * read it, instead of reading after a fixed sleep or a few frames. Parts register a check under a key, and
 * `window.__gnosisSettled.settled(key)` is true when every check under it passes. The check runs when the test asks,
 * so a scroll the test just made counts even if the app has not heard of it yet.
 *
 * Only the test fixtures install the registry (tests/fixtures/workbench.tsx). Without it, registering does nothing.
 */
export interface SettledRegistry {
  checks: Map<string, Set<() => boolean>>;
  settled(key: string): boolean;
}

declare global {
  interface Window {
    __gnosisSettled?: SettledRegistry;
  }
}

export function installSettledRegistry() {
  window.__gnosisSettled ??= {
    checks: new Map(),
    // No check under the key means nothing has mounted yet: not settled.
    settled(key) {
      const checks = this.checks.get(key);
      return !!checks?.size && [...checks].every((check) => check());
    },
  };
}

/** Adds a check under `key` while a part is mounted. Returns the function that removes it. */
export function registerSettled(key: string, check: () => boolean): () => void {
  const registry = typeof window === 'undefined' ? undefined : window.__gnosisSettled;
  if (!registry) return () => {};
  let checks = registry.checks.get(key);
  if (!checks) registry.checks.set(key, (checks = new Set()));
  checks.add(check);
  return () => checks.delete(check);
}

/**
 * A virtualized list is settled when it has stopped scrolling, has heard the last scroll, and every row on screen is
 * drawn at its measured height: no row still sits at its estimate, and no measurement waits for a render.
 */
export function useVirtualizerSettled<S extends Element>(key: string, virtual: Virtualizer<S, Element>, active = true) {
  const latest = useRef(virtual);
  latest.current = virtual;
  // The rows this render draws. getVirtualItems is memoized: a new array means a change the screen does not show yet.
  const drawn = useRef<VirtualItem[]>([]);
  drawn.current = virtual.getVirtualItems();
  useEffect(() => {
    if (!active || typeof window === 'undefined' || !window.__gnosisSettled) return;
    return registerSettled(key, () => {
      const v = latest.current;
      const scroller = v.scrollElement;
      // A list in a hidden tab is not on the screen the test reads.
      if (!scroller?.isConnected || !scroller.checkVisibility()) return true;
      if (v.isScrolling || v.scrollOffset !== scroller.scrollTop) return false;
      const items = v.getVirtualItems();
      if (items !== drawn.current) return false;
      return items.every((item) => {
        const element = v.elementsCache.get(item.key);
        // Sizes are whole pixels (measureElement rounds them).
        return !!element?.isConnected && Math.abs(element.getBoundingClientRect().height - item.size) < 1;
      });
    });
  }, [key, active]);
}
