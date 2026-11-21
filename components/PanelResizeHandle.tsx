import { useEffect, useRef } from 'react';
import { cn } from '../lib/utils';

/**
 * A focusable separator that resizes the panel beside it: drag it, or focus it and use the arrow keys (Shift for ten
 * steps), Home and End. Double-click resets the default width. A drag belongs to one pointer and ends on release,
 * cancellation or window blur; the new width is committed once, when it ends.
 *
 * `edge` names the panel's side the handle sits on: `start` for a panel docked to the right (chat), whose width grows
 * as the handle moves left, and `end` for a panel on the left (the Changes file browser).
 */
export function PanelResizeHandle({
  width,
  min,
  max,
  step,
  edge,
  label,
  className,
  onChange,
  onCommit,
  onReset,
}: {
  width: number;
  min: number;
  max: number;
  step: number;
  edge: 'start' | 'end';
  label: string;
  className?: string;
  onChange: (width: number) => void;
  onCommit: (width: number) => void;
  onReset?: () => void;
}) {
  const drag = useRef<{ id: number; element: HTMLDivElement; x: number; from: number } | undefined>(undefined);
  const current = useRef({ width, onCommit });
  // A second press at the same place within the double-click time resets: pointer capture can swallow dblclick.
  const lastPress = useRef({ time: -Infinity, x: 0 });
  current.current = { width, onCommit };
  const clamp = (value: number) => Math.round(Math.max(min, Math.min(max, value)));
  function finish() {
    const active = drag.current;
    if (!active) return;
    drag.current = undefined;
    document.documentElement.removeAttribute('data-panel-resizing');
    if (active.element.hasPointerCapture(active.id)) active.element.releasePointerCapture(active.id);
    if (current.current.width !== active.from) current.current.onCommit(current.current.width);
  }
  useEffect(() => {
    window.addEventListener('blur', finish);
    return () => {
      window.removeEventListener('blur', finish);
      finish();
    };
  }, []);
  const grow = edge === 'start' ? 'ArrowLeft' : 'ArrowRight';
  const shrink = edge === 'start' ? 'ArrowRight' : 'ArrowLeft';
  return (
    <div
      className={cn('panel-resize-handle', className)}
      data-edge={edge}
      role="separator"
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={width}
      aria-valuetext={`${width} pixels`}
      aria-keyshortcuts={onReset ? 'ArrowLeft ArrowRight Home End Enter' : 'ArrowLeft ArrowRight Home End'}
      title={onReset ? `${label}. Double-click to reset.` : label}
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.metaKey || event.ctrlKey || event.altKey) return;
        const by = step * (event.shiftKey ? 10 : 1);
        if (event.key === 'Enter' && onReset) {
          event.preventDefault();
          onReset();
          return;
        }
        const next =
          event.key === 'Home'
            ? min
            : event.key === 'End'
              ? max
              : event.key === grow
                ? width + by
                : event.key === shrink
                  ? width - by
                  : undefined;
        if (next === undefined) return;
        event.preventDefault();
        const value = clamp(next);
        if (value === width) return;
        onChange(value);
        onCommit(value);
      }}
      onPointerDown={(event) => {
        if (!event.isPrimary || event.button !== 0 || drag.current) return;
        event.preventDefault();
        const previous = lastPress.current;
        lastPress.current = { time: event.timeStamp, x: event.clientX };
        if (onReset && event.timeStamp - previous.time < 500 && Math.abs(event.clientX - previous.x) < 4) {
          lastPress.current = { time: -Infinity, x: 0 };
          onReset();
          return;
        }
        drag.current = { id: event.pointerId, element: event.currentTarget, x: event.clientX, from: width };
        event.currentTarget.setPointerCapture(event.pointerId);
        // Text in the panels beside the handle must not select while the pointer crosses it.
        document.documentElement.setAttribute('data-panel-resizing', '');
      }}
      onPointerMove={(event) => {
        const active = drag.current;
        if (active?.id !== event.pointerId || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
        const moved = event.clientX - active.x;
        const value = clamp(active.from + (edge === 'start' ? -moved : moved));
        if (value === current.current.width) return;
        current.current.width = value;
        onChange(value);
      }}
      onPointerUp={(event) => {
        if (drag.current?.id === event.pointerId) finish();
      }}
      onPointerCancel={(event) => {
        if (drag.current?.id === event.pointerId) finish();
      }}
      onLostPointerCapture={(event) => {
        if (drag.current?.id === event.pointerId) finish();
      }}
    />
  );
}
