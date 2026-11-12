import { useEffect, useRef, useSyncExternalStore, type RefObject } from 'react';
import type { DiffLayout } from './diff-layout';

// The layout choice is shared like diff appearance: every mounted view follows the latest choice at once,
// before the preference write finishes. Views that own a layout control mark their root with
// `data-diff-layout` and handle `DIFF_LAYOUT_EVENT`, so a shortcut saves through the same path as the menu.

let current: DiffLayout | undefined;
const listeners = new Set<() => void>();
const before = new Set<() => void>();

/** Switch every open diff. Views first record what the reader is looking at, so they can keep it in place. */
export function publishDiffLayout(layout: DiffLayout) {
  if (current === layout) return;
  before.forEach((listener) => listener());
  current = layout;
  listeners.forEach((listener) => listener());
}

function subscribe(callback: () => void) {
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
  };
}

export function useDiffLayout(saved?: DiffLayout): DiffLayout {
  return useSyncExternalStore(subscribe, () => current) ?? saved ?? 'unified';
}

/** Runs just before diffs switch layout, while the old layout is still on screen. */
export function useBeforeDiffLayoutChange(callback: () => void) {
  const latest = useRef(callback);
  latest.current = callback;
  useEffect(() => {
    const listener = () => latest.current();
    before.add(listener);
    return () => {
      before.delete(listener);
    };
  }, []);
}

export const DIFF_LAYOUT_EVENT = 'gnosis-diff-layout';

/** Let shortcuts and commands change the layout of the view rooted at `ref`, through its own save path. */
export function useDiffLayoutTarget(
  ref: RefObject<HTMLElement | null>,
  choose: (layout: DiffLayout) => void,
  mounted = true
) {
  const latest = useRef(choose);
  latest.current = choose;
  useEffect(() => {
    const element = ref.current;
    if (!element || !mounted) return;
    const listener = (event: Event) => latest.current((event as CustomEvent<DiffLayout>).detail);
    element.addEventListener(DIFF_LAYOUT_EVENT, listener);
    return () => element.removeEventListener(DIFF_LAYOUT_EVENT, listener);
  }, [ref, mounted]);
}
