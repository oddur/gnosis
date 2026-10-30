import type { AppLocation, HomeLocation } from './navigation-history';
import type { ReviewGuide } from './types';
import { normalizeQueueFilters } from './queue-filters';

export interface RecentVisit {
  id: string;
  title: string;
  label: string;
  detail: string;
  location: AppLocation;
}
const limit = 24;
export const recentStorageKey = (account: string) => `gnosis-recently-viewed:v1:${account}`;
export function homeVisit(home: HomeLocation): RecentVisit {
  const subject = home.item?.subject;
  const member = subject?.members[0];
  const section = home.savedView
    ? 'Saved reviews'
    : home.muted
      ? 'Muted PRs'
      : home.filters.starredOnly
        ? 'Starred'
        : home.filters.kind === 'stack'
          ? 'Stacks'
          : home.filters.attention === 'requested'
            ? 'Review requests'
            : home.filters.attention === 'updated'
              ? 'Updated PRs'
              : 'Review queue';
  return {
    id: subject
      ? `subject:${subject.id}`
      : home.viewId
        ? `view:${home.viewId}`
        : `queue:${section}:${home.filters.repo}`,
    title: subject?.title ?? home.viewName ?? section,
    label: subject?.kind === 'stack' ? 'Stack' : member ? `#${member.number}` : home.viewId ? 'View' : 'Queue',
    detail: subject
      ? [...new Set(subject.members.map((m) => m.repo))].join(', ')
      : home.filters.repo === 'all'
        ? ''
        : home.filters.repo,
    location: { page: 'home', home },
  };
}
export function reviewVisit(review: ReviewGuide): RecentVisit | undefined {
  if (!review.reviewId) return;
  return {
    id: `review:${review.reviewId}`,
    title: review.prTitle,
    label: 'Review',
    detail: review.prUrl.startsWith('local:') ? 'Local review' : review.prUrl,
    location: { page: 'review', reviewId: review.reviewId },
  };
}
function restore(value: unknown, account: string): RecentVisit[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is RecentVisit => {
      if (!entry || typeof entry !== 'object') return false;
      const e = entry as Partial<RecentVisit>;
      if (![e.id, e.title, e.label, e.detail].every((v) => typeof v === 'string')) return false;
      const location = e.location as { page?: string; reviewId?: unknown; home?: Partial<HomeLocation> } | undefined;
      if (location?.page === 'review') return typeof location.reviewId === 'string';
      if (location?.page !== 'home' || location.home?.account !== account) return false;
      const h = location.home;
      if (!h.tab || !['summary', 'changes', 'commits', 'explanation', 'checks', 'brief'].includes(h.tab)) return false;
      if (
        h.item &&
        (!Object.hasOwn(h.item, 'subject') ||
          !h.item.subject.id ||
          !h.item.subject.title ||
          !Array.isArray(h.item.subject.members) ||
          !h.item.subject.members.length ||
          !h.item.subject.members.every((m) => typeof m.url === 'string' && typeof m.repo === 'string'))
      )
        return false;
      h.filters = normalizeQueueFilters(h.filters);
      return true;
    })
    .slice(0, limit);
}
function sameVisit(a: RecentVisit | undefined, b: RecentVisit) {
  if (!a || a.id !== b.id || a.title !== b.title || a.detail !== b.detail) return false;
  if (a.location.page === 'review' || b.location.page === 'review') return a.location.page === b.location.page;
  const x = a.location.home,
    y = b.location.home;
  return (
    x.item === y.item &&
    x.filters === y.filters &&
    x.tab === y.tab &&
    x.selected === y.selected &&
    x.scroll === y.scroll &&
    x.savedQuery === y.savedQuery &&
    x.viewId === y.viewId
  );
}
/** Metadata-only history, separate from Back/Forward. All durable writes use the backend store. */
export function createRecentlyViewed(
  read: (key: string) => unknown,
  write: (key: string, value: unknown) => Promise<void>
) {
  let account: string | undefined;
  let entries: RecentVisit[] = [];
  let lastVisit: RecentVisit | undefined;
  const accounts = new Map<string, RecentVisit[]>();
  let hidden = new Set<string>();
  let snapshot = { entries, error: '' };
  let writes = Promise.resolve();
  const listeners = new Set<() => void>();
  function publish(error = '') {
    snapshot = {
      entries: entries.filter(
        (e) => e.location.page !== 'home' || !e.location.home.item?.subject.members.some((m) => hidden.has(m.url))
      ),
      error,
    };
    listeners.forEach((fn) => fn());
  }
  function persist() {
    if (!account) return;
    const scope = account,
      value = entries;
    writes = writes.catch(() => {}).then(() => write(recentStorageKey(scope), value));
    void writes.then(() => {
      if (scope === account && entries === value && snapshot.error) publish();
    }).catch(() => {
      if (scope === account && entries === value) publish('History is kept for this session. Could not save it.');
    });
  }
  return {
    subscribe: (fn: () => void) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    snapshot: () => snapshot,
    scope(next: string) {
      if (next === account) return;
      if (account) accounts.set(account, entries);
      account = next;
      lastVisit = undefined;
      hidden = new Set();
      try {
        entries = accounts.get(next) ?? restore(read(recentStorageKey(next)), next);
      } catch {
        entries = [];
      }
      publish();
    },
    hide(urls: Set<string>) {
      if (hidden.size === urls.size && [...urls].every((url) => hidden.has(url))) return;
      hidden = urls;
      publish(snapshot.error);
    },
    record(visit: RecentVisit) {
      if (!account || sameVisit(lastVisit, visit)) return;
      // Clearing history must remain effective through background renders of this destination.
      if (lastVisit?.id === visit.id && !entries.some((e) => e.id === visit.id)) {
        lastVisit = visit;
        return;
      }
      lastVisit = visit;
      entries = [visit, ...entries.filter((e) => e.id !== visit.id)].slice(0, limit);
      publish();
      persist();
    },
    clear() {
      entries = [];
      publish();
      persist();
    },
    retry() {
      publish();
      persist();
    },
  };
}
export type RecentlyViewedStore = ReturnType<typeof createRecentlyViewed>;
