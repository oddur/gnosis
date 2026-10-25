import { useEffect, useRef } from 'react';

const clamp = (width: number) => Math.max(180, Math.min(500, width));

/** A resize gesture belongs to one pointer and ends on cancellation or window blur. */
export function ChangesFileResize({
  width,
  onChange,
  onCommit,
}: {
  width: number;
  onChange: (width: number) => void;
  onCommit: (width: number) => void;
}) {
  const drag = useRef<{ id: number; element: HTMLDivElement } | undefined>(undefined);
  const current = useRef({ width, onCommit });
  current.current = { width, onCommit };
  function finish() {
    const active = drag.current;
    if (!active) return;
    drag.current = undefined;
    if (active.element.hasPointerCapture(active.id)) active.element.releasePointerCapture(active.id);
    current.current.onCommit(current.current.width);
  }
  useEffect(() => {
    window.addEventListener('blur', finish);
    return () => {
      window.removeEventListener('blur', finish);
      finish();
    };
  }, []);
  return (
    <div
      className="changes-resize"
      role="separator"
      aria-label="Resize file browser"
      aria-orientation="vertical"
      aria-valuemin={180}
      aria-valuemax={500}
      aria-valuenow={width}
      aria-valuetext={`${width} pixels`}
      tabIndex={0}
      onKeyDown={(event) => {
        const next =
          event.key === 'Home'
            ? 180
            : event.key === 'End'
              ? 500
              : event.key === 'ArrowLeft'
                ? width - 20
                : event.key === 'ArrowRight'
                  ? width + 20
                  : undefined;
        if (next === undefined) return;
        event.preventDefault();
        const value = clamp(next);
        onChange(value);
        onCommit(value);
      }}
      onPointerDown={(event) => {
        if (!event.isPrimary || event.button !== 0 || drag.current) return;
        event.preventDefault();
        drag.current = { id: event.pointerId, element: event.currentTarget };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (drag.current?.id !== event.pointerId || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
        const value = clamp(event.clientX - (event.currentTarget.parentElement?.getBoundingClientRect().left ?? 0));
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
