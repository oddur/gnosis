import { useCallback, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { defaultRangeExtractor, useVirtualizer, type VirtualItem } from '@tanstack/react-virtual';
import type { QueueItem } from '../lib/workbench';

interface Props {
  items: QueueItem[];
  labels: Record<QueueItem['attention'], string> & { starred?: string };
  selected: string | null;
  scrollElement: HTMLElement | null;
  initialOffset: number;
  measurements: RefObject<VirtualItem[]>;
  renderRow: (item: QueueItem) => ReactNode;
}

/** Keep expanded stacks measured and the keyboard selection mounted in large queues. */
export function VirtualReviewQueue({ items, labels, selected, scrollElement, initialOffset, measurements, renderRow }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const [margin, setMargin] = useState(0);
  const [focused, setFocused] = useState<string | null>(null);
  const virtual = items.length > 80;
  const selectedIndex = items.findIndex((item) => item.subject.id === selected);
  const focusedIndex = items.findIndex((item) => item.subject.id === focused);
  const category = (item: QueueItem) => item.starred ? 'starred' : item.attention;
  const counts = new Map<QueueItem['attention'] | 'starred', number>();
  for (const item of items) counts.set(category(item), (counts.get(category(item)) ?? 0) + 1);
  const rowKey = useCallback((index: number) => items[index].subject.id, [items]);
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollElement,
    getItemKey: rowKey,
    estimateSize: () => 104,
    overscan: 5,
    enabled: virtual,
    initialOffset,
    initialMeasurementsCache: measurements.current,
    scrollMargin: margin,
    rangeExtractor: (range) => [...new Set([
      ...defaultRangeExtractor(range),
      // Preserve a tab stop and an actively focused stack member while scrolling.
      Math.max(0, selectedIndex),
      ...(focusedIndex >= 0 ? [focusedIndex] : []),
    ])].sort((a, b) => a - b),
  });
  useLayoutEffect(() => () => {
    measurements.current = virtualizer.takeSnapshot();
  }, [virtualizer, measurements]);
  useLayoutEffect(() => {
    const parent = scrollElement;
    const element = container.current;
    if (!parent || !element || !virtual) return;
    const measure = () => setMargin(element.getBoundingClientRect().top - parent.getBoundingClientRect().top + parent.scrollTop);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(parent);
    observer.observe(element);
    // Onboarding can expand above the virtual list without resizing the scrollport.
    for (const sibling of parent.children) if (sibling !== element) observer.observe(sibling);
    return () => observer.disconnect();
  }, [virtual, scrollElement]);

  const render = (index: number) => {
    const item = items[index];
    const group = category(item);
    const first = index === 0 || category(items[index - 1]) !== group;
    return <>
      {first && <h2 className="queue-section-title">{labels[group] ?? 'Starred'} <span>{counts.get(group)}</span></h2>}
      {renderRow(item)}
    </>;
  };
  return (
    <div ref={container} role="list" aria-label={`${items.length} PRs and stacks`}
      data-queue-total={items.length}
      style={virtual ? { height: virtualizer.getTotalSize(), position: 'relative' } : undefined}
      onFocusCapture={(event) => {
        const row = (event.target as HTMLElement).closest<HTMLElement>('[data-queue-id]');
        setFocused(row?.dataset.queueId ?? null);
      }}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          // Menus are portaled, but their entry must stay mounted while keyboard focus is inside.
          const owner = (event.relatedTarget as HTMLElement | null)?.closest<HTMLElement>('[data-queue-id]');
          setFocused(owner?.dataset.queueId ?? null);
        }
      }}>
      {virtual ? virtualizer.getVirtualItems().map((entry) => (
        <div key={entry.key} ref={virtualizer.measureElement} data-index={entry.index}
          data-queue-id={items[entry.index].subject.id}
          role="listitem" aria-posinset={entry.index + 1} aria-setsize={items.length}
          style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${entry.start - margin}px)` }}>
          {render(entry.index)}
        </div>
      )) : items.map((item, index) => (
        <div key={item.subject.id} role="listitem" data-queue-id={item.subject.id}>{render(index)}</div>
      ))}
    </div>
  );
}
