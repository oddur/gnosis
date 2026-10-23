import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { PopoverManager, setPopoverPositionStyles } from '@pierre/diffs/edit';
import { Copy, MessageSquarePlus } from 'lucide-react';
import { reviewCodeSelection } from './ReviewDiff';

interface CodeSelection {
  text: string;
  range: Range;
  backward: boolean;
  root: Node;
}

function codeLine(node: Node): HTMLElement | null {
  const element = node instanceof Element ? node : node.parentElement;
  return (
    element?.closest<HTMLElement>(
      '[data-code] [data-line], [data-file-path][data-line-number], [data-file-path][data-base-line]'
    ) ?? null
  );
}

/** Read code only, preserving partial lines and indentation but excluding gutter/annotation text. */
function selectedCode(container: HTMLElement): CodeSelection | null {
  const selection = reviewCodeSelection(container);
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
  const range = selection.getRangeAt(0);
  const start = codeLine(range.startContainer),
    end = codeLine(range.endContainer);
  if (!start || !end) return null;
  const root = start.getRootNode();
  if (!container.contains(root instanceof ShadowRoot ? root.host : start)) return null;
  const column = start.closest('[data-code]') ?? start.parentElement;
  if (!column || !column.contains(end)) return null;
  const parts: string[] = [];
  for (const line of column.querySelectorAll<HTMLElement>('[data-line], [data-line-number], [data-base-line]')) {
    if (!range.intersectsNode(line)) continue;
    const part = document.createRange();
    part.selectNodeContents(line);
    if (range.compareBoundaryPoints(Range.START_TO_START, part) > 0)
      part.setStart(range.startContainer, range.startOffset);
    if (range.compareBoundaryPoints(Range.END_TO_END, part) < 0) part.setEnd(range.endContainer, range.endOffset);
    if (!part.collapsed) parts.push(part.toString().replace(/\n$/, ''));
  }
  const text = parts.join('\n');
  if (!text.trim()) return null;
  return {
    text,
    range: range.cloneRange(),
    backward: selection.anchorNode === range.endContainer && selection.anchorOffset === range.endOffset,
    root,
  };
}

/** Pierre's editor selection hook requires editing. Reuse its public placement engine for read-only diffs. */
export function ReviewSelectionActions({
  containerRef,
  onAsk,
  resetKey,
}: {
  containerRef: RefObject<HTMLDivElement | null>;
  onAsk: (text: string) => void;
  resetKey: string;
}) {
  const [selection, setSelection] = useState<CodeSelection | null>(null);
  const [copyStatus, setCopyStatus] = useState('');
  const popoverRef = useRef<HTMLDivElement>(null);
  const dismissed = useRef(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    setSelection(null);
    let dragging = false,
      frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (dragging || dismissed.current) return;
        const next = selectedCode(container);
        setSelection((current) => {
          if (
            current &&
            next &&
            current.text === next.text &&
            current.backward === next.backward &&
            current.range.startContainer === next.range.startContainer &&
            current.range.startOffset === next.range.startOffset &&
            current.range.endContainer === next.range.endContainer &&
            current.range.endOffset === next.range.endOffset
          )
            return current;
          return next;
        });
      });
    };
    const down = (event: PointerEvent) => {
      if (popoverRef.current && event.composedPath().includes(popoverRef.current)) return;
      dragging = true;
      dismissed.current = false;
      setSelection(null);
    };
    const up = (event: Event) => {
      if (popoverRef.current && event.composedPath().includes(popoverRef.current)) return;
      dragging = false;
      update();
    };
    const keyUp = (event: KeyboardEvent) => {
      if (!popoverRef.current || !event.composedPath().includes(popoverRef.current)) update();
    };
    const changed = () => {
      dismissed.current = false;
      update();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      dismissed.current = true;
      setSelection(null);
    };
    document.addEventListener('pointerdown', down, true);
    document.addEventListener('pointerup', up);
    document.addEventListener('mouseup', up);
    document.addEventListener('selectionchange', changed);
    document.addEventListener('keyup', keyUp);
    document.addEventListener('keydown', escape);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('pointerdown', down, true);
      document.removeEventListener('pointerup', up);
      document.removeEventListener('mouseup', up);
      document.removeEventListener('selectionchange', changed);
      document.removeEventListener('keyup', keyUp);
      document.removeEventListener('keydown', escape);
    };
  }, [containerRef, resetKey]);

  useEffect(() => setCopyStatus(''), [selection]);

  useLayoutEffect(() => {
    const container = containerRef.current,
      popover = popoverRef.current;
    if (!selection || !container || !popover) return;
    const current = selection;
    let frame = 0;
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(position);
    };
    const manager = new PopoverManager({ hasActivePopover: () => true, updateActivePopover: schedule });
    manager.setViewportElements(container, container);
    function position() {
      if (!popover || !container) return;
      const rects = Array.from(current.range.getClientRects()).filter((rect) => rect.width && rect.height);
      const bounds = manager.getPlacementBounds();
      const origin = container.getBoundingClientRect();
      if (!current.range.startContainer.isConnected || !rects.length || !bounds) {
        setSelection(null);
        return;
      }
      const viewport = {
        top: Math.max(8, origin.top + bounds.top - container.scrollTop),
        bottom: Math.min(innerHeight - 8, origin.top + bounds.bottom - container.scrollTop),
        left: Math.max(8, origin.left + bounds.left - container.scrollLeft),
        right: Math.min(innerWidth - 8, origin.left + bounds.right - container.scrollLeft),
      };
      const visible = rects.some(
        (r) => r.bottom > viewport.top && r.top < viewport.bottom && r.right > viewport.left && r.left < viewport.right
      );
      popover.hidden = !visible;
      if (!visible) return;
      const anchor = current.backward ? rects[0] : rects[rects.length - 1];
      const height = popover.offsetHeight,
        gap = 6;
      const below = { top: anchor.bottom + gap, bottom: anchor.bottom + gap + height };
      const above = { top: anchor.top - gap - height, bottom: anchor.top - gap };
      const fallback =
        manager.choosePlacement({
          preferred: current.backward ? above : below,
          fallback: current.backward ? below : above,
          viewport,
          popoverHeight: height,
          atDocumentEdge: false,
        }) === 'fallback';
      const placeAbove = current.backward !== fallback;
      const y = placeAbove ? anchor.top - gap : anchor.bottom + gap;
      setPopoverPositionStyles(popover, {
        gutterWidth: 0,
        placeAbove,
        viewport,
        x: anchor.left,
        y: Math.max(viewport.top + (placeAbove ? height : 0), Math.min(y, viewport.bottom - (placeAbove ? 0 : height))),
      });
      popover.style.setProperty('--selection-action-width', `${popover.offsetWidth}px`);
      popover.style.visibility = 'visible';
    }
    const resized = () => {
      manager.cleanUp();
      manager.setViewportElements(container, container);
      schedule();
    };
    const observer = new ResizeObserver(resized);
    observer.observe(container);
    observer.observe(popover);
    observer.observe(document.body);
    const mutations = new MutationObserver(resized);
    mutations.observe(container, { subtree: true, childList: true, attributes: true, attributeFilter: ['hidden'] });
    mutations.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    document.fonts.addEventListener('loadingdone', resized);
    // Pierre watches the nearest scroller; the portal also needs outer-page scrolls.
    window.addEventListener('scroll', resized, true);
    selection.root.addEventListener('scroll', schedule, true);
    position();
    return () => {
      cancelAnimationFrame(frame);
      manager.cleanUp();
      observer.disconnect();
      mutations.disconnect();
      document.fonts.removeEventListener('loadingdone', resized);
      window.removeEventListener('scroll', resized, true);
      selection.root.removeEventListener('scroll', schedule, true);
    };
  }, [selection, containerRef]);

  if (!selection) return null;
  return createPortal(
    <div
      ref={popoverRef}
      className="review-selection-actions"
      role="group"
      aria-label="Code selection actions"
      onPointerDown={(event) => event.preventDefault()}
      onMouseDown={(event) => event.preventDefault()}
    >
      <button
        className="review-selection-ask"
        onClick={() => {
          onAsk(selection.text);
          dismissed.current = true;
          setSelection(null);
        }}
      >
        <MessageSquarePlus size={14} /> Ask about this
      </button>
      <button
        onClick={() => {
          void navigator.clipboard
            .writeText(selection.text)
            .then(() => setCopyStatus('Copied'))
            .catch(() => setCopyStatus('Could not copy'));
        }}
      >
        <Copy size={14} /> <span role="status">{copyStatus || 'Copy'}</span>
      </button>
    </div>,
    document.body
  );
}
