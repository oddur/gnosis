import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Minus, Plus, Scan } from 'lucide-react';
import { Button } from './ui/button';
import { namespaceSVG } from '../lib/svg-ids';

/** A dedicated inspection surface: fit by default, readable scale on demand. */
export function DiagramViewport({
  svg,
  frameKey,
  onEntitySelect,
}: {
  svg: string;
  frameKey?: string;
  onEntitySelect?: (id: string) => void;
}) {
  const hintId = useId();
  const instanceId = useId().replace(/[^a-zA-Z0-9]/g, '');
  const viewport = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ width: 0, height: 0 });
  const [zoom, setZoom] = useState<number | 'fit'>('fit');
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ id: number; x: number; y: number; left: number; top: number } | undefined>(undefined);
  const anchor = useRef<{ x: number; y: number } | undefined>(undefined);
  const art = useMemo(() => {
    const root = new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement;
    const parts =
      root
        .getAttribute('viewBox')
        ?.trim()
        .split(/[\s,]+/)
        .map(Number) ?? [];
    const valid = Number.isFinite(parts[2]) && parts[2] > 0 && Number.isFinite(parts[3]) && parts[3] > 0;
    // The preview remains mounted. Give this copy its own marker/style IDs.
    return {
      width: valid ? parts[2] : 640,
      height: valid ? parts[3] : 480,
      svg: namespaceSVG(svg, instanceId),
    };
  }, [svg, instanceId]);
  useLayoutEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const measure = () => setBox({ width: el.clientWidth, height: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const fit = Math.min(1, Math.max(1, box.width - 32) / art.width, Math.max(1, box.height - 32) / art.height);
  const scale = zoom === 'fit' ? fit : zoom;
  const width = Math.max(box.width, art.width * scale + 32);
  const height = Math.max(box.height, art.height * scale + 32);
  const left = (width - art.width * scale) / 2;
  const top = (height - art.height * scale) / 2;
  const minimum = Math.min(fit, 0.1);
  function changeZoom(next: number | 'fit') {
    const el = viewport.current;
    if (el)
      anchor.current =
        next === 'fit'
          ? undefined
          : {
              x: (el.scrollLeft + box.width / 2 - left) / scale,
              y: (el.scrollTop + box.height / 2 - top) / scale,
            };
    setZoom(next === 'fit' ? next : Math.max(minimum, Math.min(4, next)));
  }
  useLayoutEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const point = anchor.current;
    el.scrollLeft = point ? point.x * scale + left - box.width / 2 : (width - box.width) / 2;
    el.scrollTop = point ? point.y * scale + top - box.height / 2 : (height - box.height) / 2;
    anchor.current = undefined;
  }, [scale, box.width, box.height, left, top, width, height]);
  function stopDragging(id = drag.current?.id) {
    if (id === undefined || drag.current?.id !== id) return;
    drag.current = undefined;
    if (viewport.current?.hasPointerCapture(id)) viewport.current.releasePointerCapture(id);
    setDragging(false);
  }
  useEffect(() => {
    const stop = () => stopDragging();
    window.addEventListener('blur', stop);
    return () => window.removeEventListener('blur', stop);
  }, []);
  return (
    <div className="mermaid-viewer" data-selectable={!!onEntitySelect}>
      <div className="mermaid-controls" role="group" aria-label="Diagram zoom">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Zoom out"
          disabled={scale <= minimum}
          onClick={() => changeZoom(scale / 1.25)}
        >
          <Minus />
        </Button>
        <output aria-label="Zoom level">{Math.round(scale * 100)}%</output>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Zoom in"
          disabled={scale >= 4}
          onClick={() => changeZoom(scale * 1.25)}
        >
          <Plus />
        </Button>
        <Button variant="outline" size="sm" onClick={() => changeZoom('fit')}>
          <Scan /> Fit
        </Button>
        <Button variant="ghost" size="sm" onClick={() => changeZoom(1)}>
          100%
        </Button>
        <span id={hintId} className="mermaid-pan-hint">
          Drag to pan · + / − to zoom · 0 to fit
        </span>
      </div>
      <div
        ref={viewport}
        className="mermaid-fullscreen"
        role="region"
        aria-label="Diagram canvas"
        aria-describedby={hintId}
        tabIndex={0}
        data-dragging={dragging}
        onKeyDown={(event) => {
          if (event.metaKey || event.ctrlKey || event.altKey || event.nativeEvent.isComposing) return;
          if (['+', '=', '-', '0', '1'].includes(event.key)) {
            event.preventDefault();
            changeZoom(
              event.key === '0' ? 'fit' : event.key === '1' ? 1 : event.key === '-' ? scale / 1.25 : scale * 1.25
            );
          }
        }}
        onPointerDown={(event) => {
          if (event.button !== 0 || !event.isPrimary) return;
          const el = event.currentTarget;
          drag.current = {
            id: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            left: el.scrollLeft,
            top: el.scrollTop,
          };
          el.setPointerCapture(event.pointerId);
          el.focus({ preventScroll: true });
          setDragging(true);
          event.preventDefault();
        }}
        onPointerMove={(event) => {
          const current = drag.current;
          if (!current || current.id !== event.pointerId) return;
          event.currentTarget.scrollLeft = current.left + current.x - event.clientX;
          event.currentTarget.scrollTop = current.top + current.y - event.clientY;
        }}
        onPointerUp={(event) => {
          const current = drag.current;
          const clicked = current && Math.hypot(event.clientX - current.x, event.clientY - current.y) < 5;
          stopDragging(event.pointerId);
          if (clicked && onEntitySelect) {
            // Pointer capture retargets the event to the viewport; hit-test the actual element.
            const element = document.elementFromPoint(event.clientX, event.clientY)?.closest('[data-d2-entity]');
            const id = element?.getAttribute('data-d2-entity');
            if (id && element && event.currentTarget.contains(element)) onEntitySelect(id);
          }
        }}
        onPointerCancel={(event) => stopDragging(event.pointerId)}
        onLostPointerCapture={(event) => stopDragging(event.pointerId)}
      >
        <div className="mermaid-pan-surface" style={{ width, height }}>
          <div
            key={frameKey}
            className={`mermaid-zoom-art${frameKey ? ' diagram-frame' : ''}`}
            style={{ width: art.width * scale, height: art.height * scale, left, top }}
            dangerouslySetInnerHTML={{ __html: art.svg }}
          />
        </div>
      </div>
    </div>
  );
}
