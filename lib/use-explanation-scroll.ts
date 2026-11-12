import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { readReviewState, scheduleReviewStateWrite, writeReviewState } from './renderer-review-state';
import { captureDiffLineAnchor, diffLineAnchorTop, followScrollAnchor } from './diff-layout';

export function explanationPositionKey(id: string, pane: string) {
  return `gnosis-explanation-position:${id}:${pane}`;
}

/** Where the reader is, relative to content: a section, and in a long code column the file at the top. */
export interface ExplanationAnchor {
  section: number;
  filePath?: string;
  /** Pixels between the anchor's top and the top of the scrollport. */
  offset: number;
}
export interface ExplanationPosition {
  top: number;
  left: number;
  anchor?: ExplanationAnchor;
}

/** Saved positions come from storage; keep only well-formed values. Older records have no anchor. */
export function readExplanationPosition(saved: unknown): ExplanationPosition {
  const value = (saved ?? {}) as { top?: unknown; left?: unknown; anchor?: unknown };
  const number = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) ? n : undefined);
  const position: ExplanationPosition = {
    top: Math.max(0, number(value.top) ?? 0),
    left: Math.max(0, number(value.left) ?? 0),
  };
  const anchor = (value.anchor ?? {}) as { section?: unknown; filePath?: unknown; offset?: unknown };
  const section = number(anchor.section);
  const offset = number(anchor.offset);
  if (section !== undefined && Number.isInteger(section) && section >= 0 && offset !== undefined)
    position.anchor = {
      section,
      offset,
      ...(typeof anchor.filePath === 'string' && anchor.filePath ? { filePath: anchor.filePath } : {}),
    };
  return position;
}

const sectionSelector = ':scope > [data-explanation-section]';
const fileSelector = ':scope > .explanation-section-code .review-file-group[data-file-path]';

/** The last element whose top is at or above `line`. Elements are in document order. */
function lastAbove(elements: ArrayLike<HTMLElement>, line: number) {
  let low = 0;
  let high = elements.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (elements[middle].getBoundingClientRect().top <= line) low = middle + 1;
    else high = middle;
  }
  return low > 0 ? elements[low - 1] : undefined;
}

/** Off-screen chunks of a long Explanation hold estimated heights until seen, so a raw scrollTop can land
 * elsewhere after reopening. The anchor records the section, and the file when a long code column scrolls. */
export function captureExplanationAnchor(container: HTMLElement): ExplanationAnchor | undefined {
  const line = container.getBoundingClientRect().top + 1;
  const section = lastAbove(container.querySelectorAll<HTMLElement>(sectionSelector), line);
  if (!section) return undefined;
  const index = Number(section.dataset.explanationSection);
  if (!Number.isInteger(index)) return undefined;
  const code = section.querySelector<HTMLElement>(':scope > .explanation-section-code');
  const text = section.querySelector<HTMLElement>(':scope > .explanation-section-text');
  // A sticky code column moves with the reader, so only the tallest column anchors to a file.
  if (code && (!text || code.offsetHeight >= text.offsetHeight)) {
    const file = lastAbove(section.querySelectorAll<HTMLElement>(fileSelector), line);
    const bounds = file?.getBoundingClientRect();
    if (file && bounds && bounds.bottom > line)
      return { section: index, filePath: file.dataset.filePath, offset: line - 1 - bounds.top };
  }
  return { section: index, offset: line - 1 - section.getBoundingClientRect().top };
}

/** The section, or the file in its code column, that an anchor points at. */
function anchorElement(container: HTMLElement, anchor: ExplanationAnchor) {
  const section = container.querySelector<HTMLElement>(`:scope > [data-explanation-section="${anchor.section}"]`);
  if (!section || !anchor.filePath) return section ?? undefined;
  return [...section.querySelectorAll<HTMLElement>(fileSelector)].find(
    (element) => element.dataset.filePath === anchor.filePath
  );
}

/** The scrollTop that puts the anchor back where it was, or undefined while its content is not mounted yet. */
export function explanationAnchorTop(container: HTMLElement, anchor: ExplanationAnchor) {
  const target = anchorElement(container, anchor);
  if (!target) return undefined;
  return (
    container.scrollTop + target.getBoundingClientRect().top - container.getBoundingClientRect().top + anchor.offset
  );
}

/** Small position records use the existing in-memory mirror and backend SQLite store. */
export function useExplanationScroll(key: string, active = true) {
  const node = useRef<HTMLDivElement | null>(null);
  const restoredKey = useRef<string | undefined>(undefined);
  const position = useRef<ExplanationPosition>({ top: 0, left: 0 });
  const cancelSave = useRef<(() => void) | undefined>(undefined);
  const pending = useRef(Promise.resolve());
  const observer = useRef<ResizeObserver | null>(null);
  const stopRestore = useRef<(() => void) | undefined>(undefined);
  const capture = useCallback((element: HTMLElement) => {
    position.current = {
      top: element.scrollTop,
      left: element.scrollLeft,
      anchor: captureExplanationAnchor(element) ?? position.current.anchor,
    };
  }, []);
  const save = useCallback(() => {
    if (node.current && node.current.clientHeight > 0 && active) capture(node.current);
    const value = { ...position.current };
    positions.set(key, value);
    pending.current = pending.current.then(() => writeReviewState(key, value)).catch(() => {});
  }, [key, active, capture]);
  /** Put the raw position back at once, then follow the anchor for a moment while lazy code mounts and
   * estimated heights become real. Any scroll the reader makes ends it. */
  const restore = useCallback((element: HTMLElement) => {
    stopRestore.current?.();
    element.scrollTop = position.current.top;
    element.scrollLeft = position.current.left;
    const anchor = position.current.anchor;
    if (!anchor) return;
    let expected = element.scrollTop;
    let settled = 0;
    let frame = 0;
    const until = performance.now() + 1500;
    const stop = () => {
      cancelAnimationFrame(frame);
      element.removeEventListener('scroll', foreign);
      for (const type of ['wheel', 'pointerdown', 'keydown'] as const) element.removeEventListener(type, stop);
      if (stopRestore.current === stop) stopRestore.current = undefined;
    };
    // Scrolls not made here come from the reader, a link or the page: they win.
    const foreign = () => {
      if (Math.abs(element.scrollTop - expected) > 1) stop();
    };
    const step = () => {
      if (performance.now() > until || !element.isConnected || element.clientHeight === 0) {
        stop();
        return;
      }
      const top = explanationAnchorTop(element, anchor);
      if (top !== undefined) {
        const target = Math.max(0, Math.min(top, element.scrollHeight - element.clientHeight));
        if (Math.abs(target - element.scrollTop) > 1) {
          expected = target;
          element.scrollTop = target;
          expected = element.scrollTop;
          settled = 0;
        } else if (++settled >= 3) {
          stop();
          return;
        }
      }
      frame = requestAnimationFrame(step);
    };
    element.addEventListener('scroll', foreign, { passive: true });
    for (const type of ['wheel', 'pointerdown', 'keydown'] as const)
      element.addEventListener(type, stop, { passive: true });
    stopRestore.current = stop;
    frame = requestAnimationFrame(step);
  }, []);
  /** Keep the reader's place while code changes height in place, as when diffs switch layout. In a long code
   * column the diff line at the top stays put; otherwise the section does. */
  const preserve = useCallback(() => {
    const element = node.current;
    if (!element || element.clientHeight === 0) return;
    const anchor = captureExplanationAnchor(element);
    if (!anchor) return;
    const file = anchor.filePath ? anchorElement(element, anchor) : undefined;
    const line = file ? captureDiffLineAnchor(file, element.getBoundingClientRect().top) : undefined;
    stopRestore.current?.();
    const stop = followScrollAnchor(element, () => {
      const target = line && anchorElement(element, anchor);
      return (target && diffLineAnchorTop(element, target, line)) ?? explanationAnchorTop(element, anchor);
    });
    const cancel = () => {
      stop();
      if (stopRestore.current === cancel) stopRestore.current = undefined;
    };
    stopRestore.current = cancel;
  }, []);
  const ref = useCallback(
    (element: HTMLDivElement | null) => {
      observer.current?.disconnect();
      observer.current = null;
      stopRestore.current?.();
      node.current = element;
      if (!element) return;
      try {
        if (restoredKey.current !== key) {
          position.current = readExplanationPosition(positions.get(key) ?? readReviewState(key));
          restoredKey.current = key;
        }
      } catch {
        /* Position is optional. */
      }
      restore(element);
      let visible = element.clientHeight > 0;
      observer.current = new ResizeObserver((entries) => {
        // The entry carries the size; reading clientHeight here would force a layout on every resize.
        const shown = entries[entries.length - 1].contentRect.height > 0;
        if (shown && !visible) restore(element);
        visible = shown;
      });
      observer.current.observe(element);
    },
    [key, restore]
  );
  const onScroll = useCallback(() => {
    if (!active || !node.current || node.current.clientHeight === 0) return;
    position.current = { ...position.current, top: node.current.scrollTop, left: node.current.scrollLeft };
    positions.set(key, { ...position.current });
    cancelSave.current?.();
    // Quit runs a pending save at once, so the last scroll survives a quick quit.
    cancelSave.current = scheduleReviewStateWrite(save, 300);
  }, [save, active]);
  useLayoutEffect(() => {
    const element = node.current;
    if (!element) return;
    // Cancel an in-flight smooth jump when leaving the tab; restore before its next paint.
    element.scrollTo({ top: position.current.top, left: position.current.left, behavior: 'instant' });
    return () => {
      stopRestore.current?.();
      if (element.clientHeight > 0) {
        capture(element);
        positions.set(key, { ...position.current });
      }
      element.scrollTo({ top: position.current.top, left: position.current.left, behavior: 'instant' });
    };
  }, [active, key, capture]);
  useEffect(
    () => () => {
      cancelSave.current?.();
      save();
    },
    [save]
  );
  return { node, ref, onScroll, preserve };
}

const positions = new Map<string, ExplanationPosition>();
