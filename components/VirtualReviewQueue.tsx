import { useListScrollAnchor } from '../lib/use-list-order';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type ReactNode, type RefObject } from 'react';
import { EntryActions, type EntryActionGroups } from './EntryActions';
import { PrStarMarker } from './PrEntryActions';
import { SubjectIcon } from './SubjectIcon';
import { PrBadge } from './EntityBadge';
import { GitHubAuthor } from './GitHubAuthor';
import { timeAgo } from '../lib/utils';
import { useWorkspaceNavigation } from '../lib/workspace-navigation';
import { defaultRangeExtractor, useVirtualizer, type VirtualItem } from '@tanstack/react-virtual';
import type { QueueItem } from '../lib/workbench';
import type { ReviewHistoryEntry } from '../lib/types';

/** Lists longer than this mount only the rows near the viewport. */
export const QUEUE_VIRTUAL_THRESHOLD = 30;

/** Distance from the scrollport's content top to the list, kept current while content above it changes. */
function useScrollMargin(scrollElement: HTMLElement | null, container: RefObject<HTMLElement | null>, enabled: boolean) {
  const [margin, setMargin] = useState(0);
  useLayoutEffect(() => {
    const parent = scrollElement;
    const element = container.current;
    if (!parent || !element || !enabled) return;
    const measure = () => setMargin(element.getBoundingClientRect().top - parent.getBoundingClientRect().top + parent.scrollTop);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(parent);
    observer.observe(element);
    // Onboarding can expand above the virtual list without resizing the scrollport.
    for (const sibling of parent.children) if (sibling !== element) observer.observe(sibling);
    return () => observer.disconnect();
  }, [enabled, scrollElement, container]);
  return margin;
}

interface Props {
  items: QueueItem[];
  labels: Record<QueueItem['attention'], string> & { starred?: string };
  selected: string | null;
  scrollElement: HTMLElement | null;
  initialOffset: number;
  measurements: RefObject<VirtualItem[]>;
  renderRow: (item: QueueItem) => ReactNode;
  grouped?: boolean;
  starredFirst?: boolean;
  onVisibleItemsChange?: (ids: string[]) => void;
  /** The row under the pointer or keyboard focus, or null when neither rests on a row. */
  onIntent?: (id: string | null) => void;
}

/** Keep expanded stacks measured and the keyboard selection mounted in large queues. */
export const VirtualReviewQueue = memo(function VirtualReviewQueue({ items, labels, selected, scrollElement, initialOffset, measurements, renderRow, onVisibleItemsChange, onIntent, grouped = true, starredFirst = true }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const virtual = items.length > QUEUE_VIRTUAL_THRESHOLD;
  const margin = useScrollMargin(scrollElement, container, virtual);
  const category = useCallback((item: QueueItem) => item.starred && starredFirst ? 'starred' : item.attention, [starredFirst]);
  const { indexes, counts, ids } = useMemo(() => {
    const counts = new Map<QueueItem['attention'] | 'starred', number>();
    for (const item of items) counts.set(category(item), (counts.get(category(item)) ?? 0) + 1);
    return { indexes: new Map(items.map((item, index) => [item.subject.id, index])), counts, ids: items.map(item => item.subject.id) };
  }, [items, category]);
  const selectedIndex = selected ? indexes.get(selected) ?? -1 : -1;
  const focusedIndex = focused ? indexes.get(focused) ?? -1 : -1;
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
  useListScrollAnchor(scrollElement, ids, selected, index => { if (virtual && index >= 0) virtualizer.scrollToIndex(index, { align: 'start' }); });
  useLayoutEffect(() => () => {
    measurements.current = virtualizer.takeSnapshot();
  }, [virtualizer, measurements]);

  useEffect(() => {
    const list = container.current;
    if (!list || !scrollElement || !onVisibleItemsChange) return;
    const visible = new Set<Element>();
    const observed = new Set<Element>();
    let previous = '';
    const publish = () => {
      const ids = [...list.children].filter(row => visible.has(row))
        .map(row => (row as HTMLElement).dataset.queueId).filter((id): id is string => !!id);
      const signature = JSON.stringify(ids);
      if (signature !== previous) { previous = signature; onVisibleItemsChange(ids); }
    };
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (entry.isIntersecting && entry.intersectionRect.height > 0) visible.add(entry.target);
        else visible.delete(entry.target);
      }
      publish();
    }, { root: scrollElement });
    const observeRows = () => {
      for (const row of observed) if (row.parentElement !== list) {
        observer.unobserve(row); observed.delete(row); visible.delete(row);
      }
      for (const row of list.children) if (!observed.has(row)) {
        observed.add(row); observer.observe(row);
      }
      publish();
    };
    observeRows();
    const mutations = new MutationObserver(observeRows);
    mutations.observe(list, { childList: true });
    return () => { observer.disconnect(); mutations.disconnect(); onVisibleItemsChange([]); };
  }, [scrollElement, onVisibleItemsChange]);

  const render = (index: number) => {
    const item = items[index];
    const group = category(item);
    const first = index === 0 || category(items[index - 1]) !== group;
    return <>
      {grouped && first && <h2 className="queue-section-title">{labels[group] ?? 'Starred'} <span>{counts.get(group)}</span></h2>}
      {renderRow(item)}
    </>;
  };
  return (
    // #248 adds hover and focus intent handlers on this container; keep rows marked with data-queue-id.
    <div ref={container} role="list" aria-label={`${items.length} PRs and stacks`}
      data-queue-total={items.length}
      style={virtual ? { height: virtualizer.getTotalSize(), position: 'relative' } : undefined}
      onPointerOver={(event) => onIntent?.((event.target as HTMLElement).closest<HTMLElement>('[data-queue-id]')?.dataset.queueId ?? null)}
      onPointerLeave={() => onIntent?.(null)}
      onFocusCapture={(event) => {
        const row = (event.target as HTMLElement).closest<HTMLElement>('[data-queue-id]');
        setFocused(row?.dataset.queueId ?? null);
        onIntent?.(row?.dataset.queueId ?? null);
      }}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          // Menus are portaled, but their entry must stay mounted while keyboard focus is inside.
          const owner = (event.relatedTarget as HTMLElement | null)?.closest<HTMLElement>('[data-queue-id]');
          setFocused(owner?.dataset.queueId ?? null);
          onIntent?.(owner?.dataset.queueId ?? null);
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
});

/** Saved reviews: mounts only nearby rows in long lists, measuring each row as it renders. */
export const VirtualSavedReviews = memo(function VirtualSavedReviews({ entries, scrollElement, renderRow }: {
  entries: ReviewHistoryEntry[];
  scrollElement: HTMLElement | null;
  renderRow: (entry: ReviewHistoryEntry) => ReactNode;
}) {
  const container = useRef<HTMLDivElement>(null);
  const virtual = entries.length > QUEUE_VIRTUAL_THRESHOLD;
  const margin = useScrollMargin(scrollElement, container, virtual);
  const rowKey = useCallback((index: number) => entries[index].id, [entries]);
  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scrollElement,
    getItemKey: rowKey,
    estimateSize: () => 72,
    overscan: 5,
    enabled: virtual,
    scrollMargin: margin,
  });
  if (!virtual) return <>{entries.map(renderRow)}</>;
  return (
    <div ref={container} style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
      {virtualizer.getVirtualItems().map((entry) => (
        <div key={entry.key} ref={virtualizer.measureElement} data-index={entry.index}
          style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${entry.start - margin}px)` }}>
          {renderRow(entries[entry.index])}
        </div>
      ))}
    </div>
  );
});

/** Stable callbacks for saved review rows; they read the page's latest state when they run. */
export interface SavedRowActions {
  open: (entry: ReviewHistoryEntry) => void;
  retry: (entry: ReviewHistoryEntry) => void;
  menuGroups: (entry: ReviewHistoryEntry) => EntryActionGroups;
}
export const SavedRow = memo(function SavedRow({ entry, starredUrls, actions }: {
  entry: ReviewHistoryEntry;
  starredUrls: ReadonlySet<string>;
  /** Changes whenever menu content would change. */
  menuKey: string;
  actions: SavedRowActions;
}) {
  const tabs = useWorkspaceNavigation();
  const [, refreshMenu] = useReducer((count: number) => count + 1, 0);
  const choose = () => { if (entry.status === 'failed') actions.retry(entry); else actions.open(entry); };
  return (
    <EntryActions label={`Actions for ${entry.prTitle}`} groups={actions.menuGroups(entry)} onBeforeOpen={refreshMenu}>{menu => <div className="saved-row" data-queue-id={entry.id}>
      <div className="queue-row-content" onClick={event => { if ((event.target as HTMLElement).closest('a,button') || entry.status === 'generating') return; choose(); }}>
      <button
        className="queue-row-main"
        disabled={entry.status === 'generating'}
        onClick={event => { if (tabs && entry.status === 'completed' && (event.metaKey || event.ctrlKey)) tabs.open({ kind: 'review', reviewId: entry.id }, !event.shiftKey); else choose(); }}
        onAuxClick={event => { if (event.button === 1 && tabs && entry.status === 'completed') { event.preventDefault(); tabs.open({ kind: 'review', reviewId: entry.id }, true); } }}
      >
        <span className="queue-title">{!entry.prUrl.startsWith('local:') && <SubjectIcon kind={entry.snapshot?.subject.kind === 'stack' ? 'stack' : 'pr'} />}{entry.prTitle}</span>
      </button>
        <span className="queue-meta">
          {entry.snapshot?.subject.kind === 'stack'
            ? `${entry.snapshot.subject.members.length} PR stack · `
            : ''}
          <PrBadge url={entry.prUrl} title={entry.prTitle} /> <GitHubAuthor login={entry.author}/> · {timeAgo(entry.savedAt)} ·{' '}
          {entry.status === 'generating'
            ? 'Generating explanation'
            : entry.status === 'failed'
              ? 'Generation failed'
              : 'Explanation ready'}
        </span>
        {entry.error && <span className="text-xs text-destructive">{entry.error}</span>}
      </div>
      <PrStarMarker members={entry.snapshot?.subject.members ?? []} starredUrls={starredUrls} />
      {menu}
    </div>}</EntryActions>
  );
});
