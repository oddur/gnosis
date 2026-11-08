import { useCallback, useEffect, useRef, useState, type DragEvent, type RefObject } from 'react';
import type { WorkspaceTabEntry } from './workspace-tabs';

/** Native dragging leaves clicks, keyboard navigation and cancelled drags intact. */
export function useWorkspaceTabDrag(
  list: RefObject<HTMLDivElement | null>,
  tabs: WorkspaceTabEntry[],
  move: (id: string, offset: number) => void
) {
  const drag = useRef<{ id: string; x: number; speed: number } | null>(null);
  const [dragging, setDragging] = useState<string>();
  const [before, setBefore] = useState<string | null>();
  const [announcement, setAnnouncement] = useState('');
  const clear = useCallback(() => {
    drag.current = null;
    setDragging(undefined);
    setBefore(undefined);
  }, []);
  useEffect(() => {
    if (dragging && !tabs.some((tab) => tab.id === dragging)) clear();
  }, [tabs, dragging, clear]);
  const insertionAt = useCallback(
    (x: number) => {
      const nodes = list.current?.querySelectorAll<HTMLElement>('[data-tab-id]') ?? [];
      for (const node of nodes) {
        const rect = node.getBoundingClientRect();
        if (x < rect.left + rect.width / 2) return node.dataset.tabId ?? null;
      }
      return null;
    },
    [list]
  );
  useEffect(() => {
    if (!dragging) return;
    let frame: number;
    let previous = performance.now();
    const scroll = (now: number) => {
      const current = drag.current;
      if (!current) return;
      if (list.current && current.speed) {
        list.current.scrollLeft += (current.speed * Math.min(now - previous, 32)) / 16;
        setBefore(insertionAt(current.x));
      }
      previous = now;
      frame = requestAnimationFrame(scroll);
    };
    frame = requestAnimationFrame(scroll);
    return () => cancelAnimationFrame(frame);
  }, [dragging, list, insertionAt]);
  useEffect(() => {
    const cancel = () => {
      if (drag.current) clear();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && drag.current) {
        // Keep Escape's native drag cancellation, but do not also navigate the review.
        event.stopImmediatePropagation();
        cancel();
      }
    };
    window.addEventListener('blur', cancel);
    window.addEventListener('keydown', escape, true);
    return () => {
      window.removeEventListener('blur', cancel);
      window.removeEventListener('keydown', escape, true);
    };
  }, [clear]);
  return {
    dragging,
    before,
    announcement,
    start: (event: DragEvent, id: string) => {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('application/x-gnosis-tab', id);
      drag.current = { id, x: event.clientX, speed: 0 };
      setDragging(id);
      setAnnouncement('');
    },
    end: clear,
    over: (event: DragEvent<HTMLDivElement>) => {
      if (!drag.current) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      const rect = event.currentTarget.getBoundingClientRect();
      drag.current.x = event.clientX;
      drag.current.speed = event.clientX < rect.left + 40 ? -12 : event.clientX > rect.right - 40 ? 12 : 0;
      setBefore(insertionAt(event.clientX));
    },
    leave: (event: DragEvent<HTMLDivElement>) => {
      if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
      if (drag.current) drag.current.speed = 0;
      setBefore(undefined);
    },
    drop: (event: DragEvent<HTMLDivElement>) => {
      if (!drag.current) return;
      event.preventDefault();
      const from = tabs.findIndex((tab) => tab.id === drag.current?.id);
      const beforeId = insertionAt(event.clientX);
      const slot = beforeId === null ? tabs.length : tabs.findIndex((tab) => tab.id === beforeId);
      const to = slot > from ? slot - 1 : slot;
      if (from >= 0 && to >= 0 && from !== to) {
        move(tabs[from].id, to - from);
        setAnnouncement(`Moved ${tabs[from].title} to position ${to + 1} of ${tabs.length}.`);
      }
      clear();
    },
  };
}
