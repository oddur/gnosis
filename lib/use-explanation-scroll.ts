import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { readReviewState, writeReviewState } from './renderer-review-state';

export function explanationPositionKey(id: string, pane: string) {
  return `gnosis-explanation-position:${id}:${pane}`;
}

const positions = new Map<string, { top: number; left: number }>();

/** Small position records use the existing in-memory mirror and backend SQLite store. */
export function useExplanationScroll(key: string, active = true) {
  const node = useRef<HTMLDivElement | null>(null);
  const position = useRef({ top: 0, left: 0 });
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pending = useRef(Promise.resolve());
  const observer = useRef<ResizeObserver | null>(null);
  const save = useCallback(() => {
    const value = { ...position.current };
    positions.set(key, value);
    pending.current = pending.current.then(() => writeReviewState(key, value)).catch(() => {});
  }, [key]);
  const ref = useCallback(
    (element: HTMLDivElement | null) => {
      observer.current?.disconnect();
      observer.current = null;
      node.current = element;
      if (!element) return;
      try {
        const saved = (positions.get(key) ?? readReviewState(key)) as { top?: number; left?: number } | undefined;
        position.current = {
          top: Number.isFinite(saved?.top) ? Math.max(0, saved?.top ?? 0) : 0,
          left: Number.isFinite(saved?.left) ? Math.max(0, saved?.left ?? 0) : 0,
        };
      } catch {
        /* Position is optional. */
      }
      element.scrollTop = position.current.top;
      element.scrollLeft = position.current.left;
      let visible = element.clientHeight > 0;
      observer.current = new ResizeObserver(() => {
        const shown = element.clientHeight > 0;
        if (shown && !visible) {
          element.scrollTop = position.current.top;
          element.scrollLeft = position.current.left;
        }
        visible = shown;
      });
      observer.current.observe(element);
    },
    [key]
  );
  const onScroll = useCallback(() => {
    if (!active || !node.current || node.current.clientHeight === 0) return;
    position.current = { top: node.current.scrollTop, left: node.current.scrollLeft };
    positions.set(key, { ...position.current });
    clearTimeout(timer.current);
    timer.current = setTimeout(save, 300);
  }, [save, active]);
  useLayoutEffect(() => {
    const element = node.current;
    if (!element) return;
    // Cancel an in-flight smooth jump when leaving the tab; restore before its next paint.
    element.scrollTo({ ...position.current, behavior: 'instant' });
    return () => {
      if (element.clientHeight > 0) {
        position.current = { top: element.scrollTop, left: element.scrollLeft };
        positions.set(key, { ...position.current });
      }
      element.scrollTo({ ...position.current, behavior: 'instant' });
    };
  }, [active, key]);
  useEffect(
    () => () => {
      clearTimeout(timer.current);
      save();
    },
    [save]
  );
  return { node, ref, onScroll };
}
