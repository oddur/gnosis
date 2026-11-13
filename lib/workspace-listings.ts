import { normalizeQueueFilters, matchesQueueFilters, type QueueFilters } from './queue-filters';
import type { MergeStates } from './merge-conflicts';
import { isMutedReview } from './muted-prs';
import type { HomeLocation } from './navigation-history';
import type { ReviewHistoryEntry } from './types';
import type { WorkbenchQueue } from './workbench';
import type { WorkspaceTabEntry } from './workspace-tabs';
import type { SearchDestination } from './command-search';

type Listing = { kind: 'queue' | 'saved' | 'muted'; filters: QueueFilters; query: string };
export type WorkspaceListingRequest = Listing | { destination: Extract<SearchDestination, { kind: 'home' }> };
export interface WorkspaceListingCount {
  count: number;
  unread: boolean;
}
const fromHome = (home: Pick<HomeLocation, 'savedView' | 'muted' | 'filters' | 'savedQuery'>): Listing => ({
  kind: home.muted ? 'muted' : home.savedView ? 'saved' : 'queue',
  filters: home.filters,
  query: home.savedQuery,
});
/** Only listing metadata: scroll updates must not recalculate every background filter. */
export function workspaceListingRequest(tab: WorkspaceTabEntry): WorkspaceListingRequest | undefined {
  if (tab.location)
    return tab.location.page === 'home' && !tab.location.home.item ? fromHome(tab.location.home) : undefined;
  const initial = tab.initial;
  if (!initial) return { destination: { kind: 'home' } };
  if (initial.kind === 'location')
    return initial.location.page === 'home' && !initial.location.home.item
      ? fromHome(initial.location.home)
      : undefined;
  if (initial.kind === 'restore') {
    const saved = initial.saved;
    if (saved.reviewId || saved.home?.subjectId || saved.destination?.url) return;
    if (saved.home) return fromHome(saved.home);
    return { destination: saved.destination ?? { kind: 'home' } };
  }
  if (initial.kind === 'home' && !initial.subject && !initial.url)
    return { destination: { kind: 'home', section: initial.section, repo: initial.repo, viewId: initial.viewId } };
}
function resolveListing(request: WorkspaceListingRequest, queue: WorkbenchQueue): Listing | undefined {
  if ('kind' in request) return request;
  const target = request.destination;
  let filters = normalizeQueueFilters(queue.filters);
  if (target.viewId) {
    const view = queue.savedViews?.views.find((view) => view.id === target.viewId);
    return view ? { kind: 'queue', filters: view.draft, query: '' } : undefined;
  }
  if (target.repo) filters = normalizeQueueFilters({ repo: target.repo });
  else if (target.section && target.section !== 'saved' && target.section !== 'muted') {
    filters = {
      ...filters,
      involvement:
        target.section === 'response' ? 'response' : filters.involvement === 'response' ? 'all' : filters.involvement,
      starredOnly: target.section === 'starred',
      attention: target.section === 'updated' || target.section === 'requested' ? target.section : 'all',
      kind: target.section === 'stacks' ? 'stack' : 'all',
    };
  }
  return {
    kind: target.section === 'saved' ? 'saved' : target.section === 'muted' ? 'muted' : 'queue',
    filters,
    query: '',
  };
}
export function countWorkspaceListing(
  request: WorkspaceListingRequest,
  queue: WorkbenchQueue,
  history: ReviewHistoryEntry[],
  login: string,
  now = Date.now(),
  /** Loaded merge states, for listings with the merge filter. */
  merge?: MergeStates
): WorkspaceListingCount | undefined {
  const listing = resolveListing(request, queue);
  if (!listing) return;
  const urls = new Set<string>();
  const unread = new Set<string>();
  const isUnread = (url: string, fallback = false) => {
    const state = queue.readStates?.[url];
    return state ? state.unread.length > 0 : fallback;
  };
  const add = (url: string, fallback = false) => {
    urls.add(url);
    if (isUnread(url, fallback)) unread.add(url);
  };
  if (listing.kind === 'muted') {
    for (const entry of queue.mutedPrs ?? []) add(entry.member.url);
  } else if (listing.kind === 'saved') {
    const muted = new Set(queue.mutedPrs?.map((entry) => entry.member.url));
    for (const entry of history) {
      if (
        isMutedReview(entry, muted) ||
        !`${entry.prTitle} ${entry.prUrl}`.toLowerCase().includes(listing.query.toLowerCase())
      )
        continue;
      if (entry.snapshot?.subject.members.length)
        for (const member of entry.snapshot.subject.members) add(member.url, entry.unread);
      else add(entry.prUrl, entry.unread);
    }
  } else {
    const filters = listing.filters;
    for (const item of filters.starredOnly ? (queue.starredItems ?? []) : queue.items) {
      const unreadUrls = item.subject.members
        .filter((member) => isUnread(member.url, item.unreadUrls?.includes(member.url)))
        .map((member) => member.url);
      if (!matchesQueueFilters({ ...item, unreadUrls }, filters, now, login, merge)) continue;
      for (const member of item.subject.members) {
        // Keep stack-level criteria, but count only members that match all PR filters.
        if (
          matchesQueueFilters(
            { ...item, unreadUrls, subject: { ...item.subject, members: [member] } },
            { ...filters, explanation: 'all' },
            now,
            login,
            merge
          )
        )
          add(member.url, unreadUrls.includes(member.url));
      }
    }
  }
  return { count: urls.size, unread: unread.size > 0 };
}
export function workspaceTabTitle(tab: WorkspaceTabEntry, listing?: WorkspaceListingCount) {
  return listing ? `${tab.title} (${listing.count})` : tab.title;
}
