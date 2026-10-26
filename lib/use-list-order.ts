import { useLayoutEffect, useRef } from 'react';
import { useEntryMenusOpen } from './entry-menu-state';

/** Keep menu targets in place while still applying refreshed row content. */
export function useListOrder<T>(sorted: T[], key: (item: T) => string): T[] {
  const menusOpen = useEntryMenusOpen();
  const order = useRef<string[]>([]);
  useLayoutEffect(() => { if (!menusOpen) order.current = sorted.map(key); });
  if (!menusOpen || !order.current.length) return sorted;
  const positions = new Map(order.current.map((id, index) => [id, index]));
  return [...sorted].sort((a, b) => (positions.get(key(a)) ?? Infinity) - (positions.get(key(b)) ?? Infinity));
}

/** Preserve a visible selected row (or the top visible row) across reorderings. */
export function useListScrollAnchor(parent: HTMLElement | null, ids: string[], selected?: string | null, reveal?: (index: number) => void) {
  const previous = useRef('');
  const anchor = useRef<{ id: string; offset: number } | undefined>(undefined);
  const pending = useRef<{ id: string; offset: number; stable: number; attempts: number } | undefined>(undefined);
  const frame = useRef<number | undefined>(undefined);
  const settleRef = useRef(() => {});
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const captureRef = useRef(() => {});
  captureRef.current = () => {
    if (!parent || pending.current) return;
    const bounds = parent.getBoundingClientRect();
    const rows = [...parent.querySelectorAll<HTMLElement>('[data-queue-id]')];
    const visible = rows.filter(row => { const r = row.getBoundingClientRect(); return r.bottom > bounds.top && r.top < bounds.bottom; });
    const row = visible.find(row => row.dataset.queueId === selectedRef.current) ?? visible.at(0);
    anchor.current = row ? { id: row.dataset.queueId ?? '', offset: row.getBoundingClientRect().top - bounds.top } : undefined;
  };
  // Virtual rows are measured after mounting. Keep the same anchor through those
  // measurements, then release it once the layout has settled for two frames.
  settleRef.current = () => {
    const target = pending.current;
    if (!parent || !target) return;
    const row = [...parent.querySelectorAll<HTMLElement>('[data-queue-id]')].find(row => row.dataset.queueId === target.id);
    if (row) {
      const delta = row.getBoundingClientRect().top - parent.getBoundingClientRect().top - target.offset;
      target.stable = Math.abs(delta) < 1 ? target.stable + 1 : 0;
      parent.scrollTop += delta;
    } else reveal?.(ids.indexOf(target.id));
    target.attempts++;
    if (target.stable >= 2 || target.attempts >= 12) {
      pending.current = undefined;
      captureRef.current();
    } else frame.current = requestAnimationFrame(() => { frame.current = undefined; settleRef.current(); });
  };
  useLayoutEffect(() => {
    if (!parent) { previous.current = ''; anchor.current = undefined; pending.current = undefined; return; }
    const signature = JSON.stringify(ids);
    if (previous.current && previous.current !== signature && anchor.current && ids.includes(anchor.current.id)) {
      pending.current = { ...anchor.current, stable: 0, attempts: 0 };
      if (frame.current !== undefined) cancelAnimationFrame(frame.current);
      frame.current = undefined;
      settleRef.current();
    }
    previous.current = signature;
    captureRef.current();
  });
  useLayoutEffect(() => {
    if (!parent) return;
    const capture = () => captureRef.current();
    const cancel = () => {
      if (frame.current !== undefined) cancelAnimationFrame(frame.current);
      frame.current = undefined;
      pending.current = undefined;
      capture();
    };
    parent.addEventListener('scroll', capture, { passive: true });
    parent.addEventListener('wheel', cancel, { passive: true });
    parent.addEventListener('pointerdown', cancel);
    parent.addEventListener('keydown', cancel);
    return () => {
      cancel();
      parent.removeEventListener('scroll', capture);
      parent.removeEventListener('wheel', cancel);
      parent.removeEventListener('pointerdown', cancel);
      parent.removeEventListener('keydown', cancel);
    };
  }, [parent]);
}
