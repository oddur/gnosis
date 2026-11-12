/** Sticky offset for one Explanation column, or null to keep the stylesheet's `top: 16px`.
 *
 * A column taller than the viewport is pinned by its bottom, so its end stays reachable while the
 * other column scrolls. CSS cannot express this, because a sticky `top` cannot refer to the
 * element's own height. The tallest column in a row has no sticky travel, so it never needs a value.
 */
export function columnTop(viewportHeight: number, columnHeight: number, rowTallestHeight: number): number | null {
  if (columnHeight >= rowTallestHeight) return null;
  if (columnHeight <= viewportHeight - 32) return null;
  return Math.min(16, Math.round(viewportHeight - columnHeight - 16));
}

type Scheduler = { request: (callback: () => void) => number; cancel: (handle: number) => void };
const animationFrames: Scheduler = {
  request: (callback) => requestAnimationFrame(callback),
  cancel: (handle) => cancelAnimationFrame(handle),
};

export interface ColumnLayout {
  /** Observe the scrollport whose height bounds every sticky column. */
  viewport: (element: HTMLElement | null) => void;
  /** Observe one column of a row. Returns a function that stops observing and clears its offset. */
  column: (row: number, element: HTMLElement) => () => void;
  disconnect: () => void;
}

/** One ResizeObserver for the whole Explanation. Its callback only records sizes from the entries and reads no
 * layout. A single animation-frame flush then writes `style.top` only where the value changes, so a window
 * resize costs one coordinated pass instead of one forced layout per section. */
export function createColumnLayout(
  observe: (callback: ResizeObserverCallback) => Pick<ResizeObserver, 'observe' | 'unobserve' | 'disconnect'> = (
    callback
  ) => new ResizeObserver(callback),
  frames: Scheduler = animationFrames
): ColumnLayout {
  const heights = new Map<Element, number>();
  const rows = new Map<number, Set<HTMLElement>>();
  const written = new Map<HTMLElement, number | null>();
  let viewportElement: HTMLElement | null = null;
  let viewportHeight = 0;
  let frame = 0;
  const flush = () => {
    frame = 0;
    if (!viewportHeight) return;
    for (const columns of rows.values()) {
      let tallest = 0;
      for (const column of columns) tallest = Math.max(tallest, heights.get(column) ?? 0);
      for (const column of columns) {
        const height = heights.get(column);
        if (height === undefined) continue;
        const top = columnTop(viewportHeight, height, tallest);
        if ((written.get(column) ?? null) === top) continue;
        written.set(column, top);
        if (top === null) column.style.removeProperty('top');
        else column.style.top = `${top}px`;
      }
    }
  };
  const schedule = () => {
    if (!frame) frame = frames.request(flush);
  };
  const observer = observe((entries) => {
    for (const entry of entries) {
      if (entry.target === viewportElement) viewportHeight = entry.contentBoxSize[0].blockSize;
      else heights.set(entry.target, entry.borderBoxSize[0].blockSize);
    }
    schedule();
  });
  return {
    viewport(element) {
      if (viewportElement) observer.unobserve(viewportElement);
      viewportElement = element;
      viewportHeight = 0;
      if (element) observer.observe(element);
    },
    column(row, element) {
      let columns = rows.get(row);
      if (!columns) rows.set(row, (columns = new Set()));
      columns.add(element);
      observer.observe(element, { box: 'border-box' });
      return () => {
        observer.unobserve(element);
        heights.delete(element);
        written.delete(element);
        columns.delete(element);
        if (!columns.size) rows.delete(row);
        element.style.removeProperty('top');
        // The remaining columns of the row may have lost their tallest neighbour.
        schedule();
      };
    },
    disconnect() {
      if (frame) frames.cancel(frame);
      frame = 0;
      observer.disconnect();
    },
  };
}
