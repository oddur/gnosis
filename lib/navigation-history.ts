import type { QueueFilters } from './queue-filters';
import type { QueueItem } from './workbench';

export type HistoryDirection = -1 | 1;
export interface HomeLocation {
  account: string;
  filters: QueueFilters;
  savedView: boolean;
  savedQuery: string;
  viewId: string | null;
  viewName?: string;
  muted: boolean;
  item: QueueItem | null;
  tab: 'summary' | 'changes' | 'commits' | 'explanation';
  selected: string | null;
  scroll: number;
}
export type AppLocation = { page: 'home'; home: HomeLocation } | { page: 'review'; reviewId: string };

export function locationKey(location: AppLocation): string {
  if (location.page === 'review') return `review:${location.reviewId}`;
  const h = location.home;
  // Filter edits and queue selection update the current visit, not browser history.
  return JSON.stringify([
    h.account,
    h.item?.subject.id ?? null,
    h.item ? h.tab : null,
    h.savedView,
    h.muted,
    h.viewId,
    h.filters.attention,
    h.filters.kind,
    h.filters.starredOnly,
  ]);
}

/** Window-local history holds metadata only, never review contents or diffs. */
export function createNavigationHistory<T>(key: (value: T) => string, limit = 100) {
  let entries: T[] = [];
  let index = -1;
  return {
    record(value: T) {
      if (index >= 0 && key(entries[index]) === key(value)) {
        entries[index] = value;
        return;
      }
      entries = entries.slice(0, index + 1);
      entries.push(value);
      if (entries.length > limit) entries.shift();
      index = entries.length - 1;
    },
    move(direction: HistoryDirection): T | undefined {
      const next = index + direction;
      if (next < 0 || next >= entries.length) return;
      index = next;
      return entries[index];
    },
    current: () => entries[index] as T | undefined,
    restore(value: T) {
      const previous = entries.indexOf(value);
      if (previous >= 0) index = previous;
    },
    clear() {
      entries = [];
      index = -1;
    },
  };
}

export function historyKeyDirection(
  event: Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'altKey' | 'ctrlKey' | 'shiftKey'>,
  platform: string
): HistoryDirection | undefined {
  if (event.key === 'BrowserBack') return -1;
  if (event.key === 'BrowserForward') return 1;
  if (event.shiftKey) return;
  if (platform === 'darwin' && event.metaKey && !event.ctrlKey && !event.altKey) {
    if (event.key === '[' || event.code === 'BracketLeft') return -1;
    if (event.key === ']' || event.code === 'BracketRight') return 1;
  }
  if (platform !== 'darwin' && event.altKey && !event.ctrlKey && !event.metaKey) {
    if (event.key === 'ArrowLeft') return -1;
    if (event.key === 'ArrowRight') return 1;
  }
}
