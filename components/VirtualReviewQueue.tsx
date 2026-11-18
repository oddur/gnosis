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
import { ChevronRight } from 'lucide-react';
import type { QueueItem } from '../lib/workbench';
import type { QueueGroup, QueueGrouping } from '../lib/queue-groups';
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
    // The margin is a position, not a size. Read it once per frame, after the observers have run, not in each callback.
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    });
    observer.observe(parent);
    observer.observe(element);
    // Onboarding can expand above the virtual list without resizing the scrollport.
    for (const sibling of parent.children) if (sibling !== element) observer.observe(sibling);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
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
  /** Group by Action or Repository: a sticky, collapsible heading before each group. `items` are in group order. */
  groups?: QueueGrouping;
  onToggleGroup?: (key: string) => void;
  /** Scroll this group's heading to the top of the list and focus it, once per `nonce`. */
  reveal?: { key: string; nonce: number };
}

/** One line of the list: a group heading, or an entry. */
type Line = { kind: 'group'; group: QueueGroup } | { kind: 'item'; item: QueueItem };
const lineKey = (line: Line) => (line.kind === 'group' ? `group:${line.group.key}` : line.item.subject.id);

function GroupHeading({ group, onToggle }: { group: QueueGroup; onToggle?: (key: string) => void }) {
  return (
    <h2 className="queue-section-title queue-group-title">
      <button type="button" className="queue-group-toggle" aria-expanded={!group.collapsed} onClick={() => onToggle?.(group.key)}>
        <ChevronRight size={14} aria-hidden="true" />
        <span className="queue-group-label">{group.label}</span>
        <span className="queue-group-count" aria-label={`${group.count} ${group.count === 1 ? 'entry' : 'entries'}`}>{group.count}</span>
      </button>
    </h2>
  );
}

/** Keep expanded stacks measured and the keyboard selection mounted in large queues. */
export const VirtualReviewQueue = memo(function VirtualReviewQueue({ items, labels, selected, scrollElement, initialOffset, measurements, renderRow, onVisibleItemsChange, onIntent, grouped = true, starredFirst = true, groups, onToggleGroup, reveal }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const [focused, setFocused] = useState<string | null>(null);
  // Without groups, one line per entry, as before. Grouped, a heading line before each group's entries.
  const lines = useMemo<Line[]>(() => {
    if (!groups) return items.map((item) => ({ kind: 'item', item }));
    const byGroup = new Map<string, QueueItem[]>();
    for (const item of items) {
      const key = groups.groupOf.get(item.subject.id) ?? '';
      const list = byGroup.get(key);
      if (list) list.push(item);
      else byGroup.set(key, [item]);
    }
    const result: Line[] = [];
    for (const group of groups.groups) {
      result.push({ kind: 'group', group });
      for (const item of byGroup.get(group.key) ?? []) result.push({ kind: 'item', item });
      byGroup.delete(group.key);
    }
    // An entry without a known group (an open menu held the old order) still shows, at the end.
    for (const list of byGroup.values()) for (const item of list) result.push({ kind: 'item', item });
    return result;
  }, [items, groups]);
  const virtual = lines.length > QUEUE_VIRTUAL_THRESHOLD;
  const margin = useScrollMargin(scrollElement, container, virtual);
  const category = useCallback((item: QueueItem) => item.starred && starredFirst ? 'starred' : item.attention, [starredFirst]);
  const { indexes, counts, ids, headings, positions } = useMemo(() => {
    const counts = new Map<QueueItem['attention'] | 'starred', number>();
    for (const item of items) counts.set(category(item), (counts.get(category(item)) ?? 0) + 1);
    // Entries are numbered among entries only: headings are not list items.
    const headings: number[] = [];
    const positions = new Map<number, number>();
    lines.forEach((line, index) => {
      if (line.kind === 'group') headings.push(index);
      else positions.set(index, positions.size + 1);
    });
    return { indexes: new Map(lines.map((line, index) => [lineKey(line), index])), counts, ids: items.map(item => item.subject.id), headings, positions };
  }, [items, lines, category]);
  const selectedIndex = selected ? indexes.get(selected) ?? -1 : -1;
  const focusedIndex = focused ? indexes.get(focused) ?? -1 : -1;
  const rowKey = useCallback((index: number) => lineKey(lines[index]), [lines]);
  // The heading of the group at the top of the viewport stays mounted and sticks there.
  const activeHeading = useRef(-1);
  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => scrollElement,
    getItemKey: rowKey,
    estimateSize: (index) => lines[index]?.kind === 'group' ? 37 : 104,
    overscan: 5,
    enabled: virtual,
    initialOffset,
    initialMeasurementsCache: measurements.current,
    scrollMargin: margin,
    rangeExtractor: (range) => {
      let heading = -1;
      for (const index of headings) {
        if (index > range.startIndex) break;
        heading = index;
      }
      activeHeading.current = heading;
      return [...new Set([
        ...defaultRangeExtractor(range),
        // Preserve a tab stop and an actively focused stack member while scrolling.
        Math.max(0, selectedIndex),
        ...(focusedIndex >= 0 ? [focusedIndex] : []),
        ...(heading >= 0 ? [heading] : []),
      ])].sort((a, b) => a - b);
    },
  });
  useListScrollAnchor(scrollElement, ids, selected, index => {
    const line = index >= 0 ? indexes.get(ids[index]) ?? -1 : -1;
    if (virtual && line >= 0) virtualizer.scrollToIndex(line, { align: 'start' });
  });
  // An Overview tile opens its group: the heading scrolls to the top of the list and takes focus. It waits until the
  // group is there, since the list may still be applying the new grouping.
  const revealed = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!reveal || revealed.current === reveal.nonce || !scrollElement) return;
    const index = indexes.get(`group:${reveal.key}`);
    if (index === undefined) return;
    revealed.current = reveal.nonce;
    if (virtual) virtualizer.scrollToIndex(index, { align: 'start' });
    let frames = 0;
    let frame = 0;
    const settle = () => {
      const heading = container.current?.querySelector<HTMLElement>(`[data-queue-group="${CSS.escape(reveal.key)}"]`);
      // Virtual lines are measured after they mount; give them two frames to settle first.
      if (heading && (!virtual || frames >= 2)) {
        if (!virtual) scrollElement.scrollTop += heading.getBoundingClientRect().top - scrollElement.getBoundingClientRect().top;
        heading.querySelector<HTMLElement>('button')?.focus({ preventScroll: true });
        return;
      }
      if (virtual && frames === 1) virtualizer.scrollToIndex(index, { align: 'start' });
      if (++frames < 12) frame = requestAnimationFrame(settle);
    };
    frame = requestAnimationFrame(settle);
    return () => cancelAnimationFrame(frame);
  }, [reveal, indexes, virtual, virtualizer, scrollElement]);
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
    const line = lines[index];
    if (line.kind === 'group') return <GroupHeading group={line.group} onToggle={onToggleGroup} />;
    const item = line.item;
    if (groups) return renderRow(item);
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
      data-queue-grouped={groups ? '' : undefined}
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
      {virtual ? virtualizer.getVirtualItems().map((entry) => {
        const line = lines[entry.index];
        if (line.kind === 'group') {
          // The heading of the group at the top sticks there; the others sit in place.
          const sticky = entry.index === activeHeading.current;
          return (
            <div key={entry.key} ref={virtualizer.measureElement} data-index={entry.index} className="queue-group-heading"
              data-queue-group={line.group.key} data-sticky={sticky ? '' : undefined}
              style={sticky ? { position: 'sticky', top: 0, width: '100%' } : { position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${entry.start - margin}px)` }}>
              {render(entry.index)}
            </div>
          );
        }
        return (
          <div key={entry.key} ref={virtualizer.measureElement} data-index={entry.index}
            data-queue-id={line.item.subject.id}
            role="listitem" aria-posinset={positions.get(entry.index)} aria-setsize={items.length}
            style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${entry.start - margin}px)` }}>
            {render(entry.index)}
          </div>
        );
      }) : lines.map((line, index) => line.kind === 'group' ? (
        <div key={lineKey(line)} className="queue-group-heading" data-queue-group={line.group.key}>{render(index)}</div>
      ) : (
        <div key={line.item.subject.id} role="listitem" data-queue-id={line.item.subject.id}>{render(index)}</div>
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
        <span className="queue-title">{!entry.prUrl.startsWith('local:') && <SubjectIcon kind={entry.snapshot?.subject.kind === 'stack' ? 'stack' : 'pr'} pr={entry.snapshot?.subject.members[0] ?? { url: entry.prUrl }} />}{entry.prTitle}</span>
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
