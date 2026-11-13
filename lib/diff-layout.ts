import type { Preferences } from './types';
import type { ShortcutMap } from './use-keyboard-shortcuts';

export type DiffLayout = Preferences['diffLayout'];

/** `d` switches between split and unified diffs. `u` and `s` choose one directly. */
export const DIFF_LAYOUT_KEYS = { toggle: 'd', unified: 'u', split: 's' } as const;

/** The layout a diff-layout key asks for, or undefined for any other key. */
export function nextDiffLayout(key: string, current: DiffLayout): DiffLayout | undefined {
  if (key === DIFF_LAYOUT_KEYS.toggle) return current === 'split' ? 'unified' : 'split';
  if (key === DIFF_LAYOUT_KEYS.unified) return 'unified';
  if (key === DIFF_LAYOUT_KEYS.split) return 'split';
  return undefined;
}

/** The diff view on screen: its layout, and how to change it through the view's own save path. */
export interface DiffLayoutView {
  layout: DiffLayout;
  choose: (layout: DiffLayout) => void;
}

/** Shortcuts for `d`, `u` and `s`. They do nothing, and leave the key alone, while a modal is open, while the key
 * repeats, or when no diff is on screen. Typing and dialogs are handled by useKeyboardShortcuts. */
export function diffLayoutShortcutMap(view: () => DiffLayoutView | undefined, modalOpen: () => boolean): ShortcutMap {
  const press = (event: KeyboardEvent) => {
    if (event.repeat || modalOpen()) return false;
    const target = view();
    const layout = target && nextDiffLayout(event.key, target.layout);
    if (!target || !layout) return false;
    target.choose(layout);
  };
  return { [DIFF_LAYOUT_KEYS.toggle]: press, [DIFF_LAYOUT_KEYS.unified]: press, [DIFF_LAYOUT_KEYS.split]: press };
}

/** Pierre marks each rendered line with `data-line-index="<unified>,<split>"`. Both layouts keep the unified
 * index, so it identifies the same line before and after a switch. Plain file views use a single number. */
export function unifiedLineIndex(value: string | null | undefined): number | undefined {
  const first = value?.split(',')[0];
  if (!first) return undefined;
  const index = Number(first);
  return Number.isInteger(index) && index >= 0 ? index : undefined;
}

/** What the reader sees at the top of a scroller, inside one file's diff. */
export interface DiffLineAnchor {
  /** Which Pierre diff host in the block holds the line. Long ranges render as several hosts. */
  host: number;
  line?: number;
  /** Pixels from the scroller's top to the line's top. */
  delta: number;
  /** Fallback when the line is not rendered: how far down the block the scroller's top was. */
  fraction: number;
}

function lineSelector(line: number) {
  return `[data-line-index="${line}"],[data-line-index^="${line},"]`;
}

/** Record the diff line at `top`, a viewport y coordinate, inside `block`. */
export function captureDiffLineAnchor(block: HTMLElement, top: number): DiffLineAnchor {
  const bounds = block.getBoundingClientRect();
  const fraction = bounds.height > 0 ? Math.max(0, Math.min(1, (top - bounds.top) / bounds.height)) : 0;
  const hosts = block.querySelectorAll<HTMLElement>('diffs-container');
  for (let host = 0; host < hosts.length; host++) {
    if (hosts[host].getBoundingClientRect().bottom <= top) continue;
    // Split diffs list the left column before the right one, so lines are not in visual order.
    let best: { line: number; top: number } | undefined;
    for (const element of hosts[host].shadowRoot?.querySelectorAll<HTMLElement>('[data-line-index]') ?? []) {
      const rect = element.getBoundingClientRect();
      if (rect.height === 0 || rect.bottom <= top || (best && rect.top >= best.top)) continue;
      const line = unifiedLineIndex(element.dataset.lineIndex);
      if (line !== undefined) best = { line, top: rect.top };
    }
    if (best) return { host, line: best.line, delta: best.top - top, fraction };
    break;
  }
  return { host: -1, delta: 0, fraction };
}

/** The scrollTop that puts the anchored line back at the same height, or undefined while `block` is not laid out. */
export function diffLineAnchorTop(scroller: HTMLElement, block: HTMLElement, anchor: DiffLineAnchor) {
  const top = scroller.getBoundingClientRect().top;
  if (anchor.line !== undefined) {
    const host = block.querySelectorAll<HTMLElement>('diffs-container')[anchor.host] as HTMLElement | undefined;
    const rect = host?.shadowRoot?.querySelector<HTMLElement>(lineSelector(anchor.line))?.getBoundingClientRect();
    if (rect && rect.height > 0) return scroller.scrollTop + rect.top - top - anchor.delta;
  }
  const bounds = block.getBoundingClientRect();
  if (bounds.height === 0) return undefined;
  return scroller.scrollTop + bounds.top - top + anchor.fraction * bounds.height;
}

/** Keep `scroller` at the position `resolve` returns while diffs re-render and virtualized rows re-measure.
 * The reader's next wheel, pointer or key press hands scrolling back to them. Returns a function that stops. */
export function followScrollAnchor(scroller: HTMLElement, resolve: () => number | undefined, duration = 1000) {
  const until = performance.now() + duration;
  const inputs = ['wheel', 'pointerdown', 'keydown', 'touchstart'] as const;
  let frame = 0;
  const stop = () => {
    cancelAnimationFrame(frame);
    clearTimeout(listen);
    for (const type of inputs) scroller.removeEventListener(type, stop);
  };
  const step = () => {
    if (performance.now() > until || !scroller.isConnected || scroller.clientHeight === 0) {
      stop();
      return;
    }
    const top = resolve();
    if (top !== undefined) {
      const target = Math.max(0, Math.min(top, scroller.scrollHeight - scroller.clientHeight));
      if (Math.abs(target - scroller.scrollTop) > 1) scroller.scrollTop = target;
    }
    frame = requestAnimationFrame(step);
  };
  // The key that switched layouts may still be on its way to the scroller. Only later input stops following.
  const listen = setTimeout(() => {
    for (const type of inputs) scroller.addEventListener(type, stop, { passive: true });
  });
  frame = requestAnimationFrame(step);
  return stop;
}

/** Hold a scroll target in place for `duration` ms while content around it renders. Corrections run in a
 * ResizeObserver callback, after layout and before paint, so the target does not flicker. When browser scroll
 * anchoring moves scrollTop and the target stays put, that is accepted. Any other scroll comes from the reader, a
 * link or find in page: it wins and ends the hold, as does the reader's wheel, pointer or key press. Returns a
 * function that stops. */
export function holdScrollTarget(scroller: HTMLElement, resolve: () => number | undefined, duration = 1000) {
  const inputs = ['wheel', 'pointerdown', 'keydown', 'touchstart'] as const;
  let expected = scroller.scrollTop;
  let stopped = false;
  const check = () => {
    if (stopped) return;
    if (!scroller.isConnected || scroller.clientHeight === 0) {
      stop();
      return;
    }
    const top = resolve();
    if (top === undefined) return;
    const target = Math.max(0, Math.min(top, scroller.scrollHeight - scroller.clientHeight));
    if (Math.abs(scroller.scrollTop - expected) > 1) {
      if (Math.abs(target - scroller.scrollTop) > 1) {
        stop();
        return;
      }
    } else if (Math.abs(target - scroller.scrollTop) > 1) scroller.scrollTop = target;
    expected = scroller.scrollTop;
  };
  const observer = new ResizeObserver(check);
  const timer = setTimeout(stop, duration);
  function stop() {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    observer.disconnect();
    scroller.removeEventListener('scroll', check);
    for (const type of inputs) scroller.removeEventListener(type, stop);
  }
  // Any change of height inside the scroller changes the height of one of its children.
  for (const child of scroller.children) observer.observe(child);
  scroller.addEventListener('scroll', check, { passive: true });
  for (const type of inputs) scroller.addEventListener(type, stop, { passive: true });
  return stop;
}

/** Scroll to a target that can move while lazily drawn content changes height on the way. A destination computed
 * before a smooth scroll begins goes stale as the chunks it passes render, and browser scroll anchoring cannot
 * help: that content is below the anchor. So when the scroll ends it is put on the target itself, which is then
 * held for `settle` ms while what it landed on renders (#288). Aiming the smooth scroll again as the target moves
 * restarts its easing every frame, so it crawls. The reader's wheel, pointer or key press, or the returned
 * function, stops it. */
export function scrollToMovingTarget(
  scroller: HTMLElement,
  resolve: () => number | undefined,
  { smooth, settle = 1000, limit = 5000 }: { smooth: boolean; settle?: number; limit?: number }
) {
  const clamp = (top: number) => Math.max(0, Math.min(top, scroller.scrollHeight - scroller.clientHeight));
  const inputs = ['wheel', 'pointerdown', 'keydown', 'touchstart'] as const;
  let stopped = false;
  let hold: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined = undefined;
  const detach = () => {
    clearTimeout(timer);
    scroller.removeEventListener('scrollend', land);
    for (const type of inputs) scroller.removeEventListener(type, stop);
  };
  function stop() {
    stopped = true;
    detach();
    hold?.();
  }
  function land() {
    detach();
    if (stopped || !scroller.isConnected || scroller.clientHeight === 0) return;
    // Only a scroll that ended where it aimed, or where scroll anchoring moved that as the target moved, is
    // followed. Anything else was another scroll, from a link, find in page or code, and it wins.
    const top = resolve();
    if (top === undefined) return;
    const target = clamp(top);
    const position = scroller.scrollTop;
    if (position < Math.min(destination, target) - 2 || position > Math.max(destination, target) + 2) return;
    if (Math.abs(target - position) > 1) scroller.scrollTo({ top: target, behavior: 'instant' });
    hold = holdScrollTarget(scroller, resolve, settle);
  }
  const first = resolve();
  if (first === undefined) return stop;
  const destination = clamp(first);
  // A smooth scroll that has nowhere to go never ends with scrollend.
  if (!smooth || Math.abs(destination - scroller.scrollTop) <= 1) {
    scroller.scrollTo({ top: destination, behavior: 'instant' });
    land();
    return stop;
  }
  scroller.scrollTo({ top: destination, behavior: 'smooth' });
  scroller.addEventListener('scrollend', land);
  for (const type of inputs) scroller.addEventListener(type, stop, { passive: true });
  timer = setTimeout(stop, limit);
  return stop;
}
