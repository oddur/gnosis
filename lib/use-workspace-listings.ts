import { useMemo, useRef } from 'react';
import { useReviewHistory, useWorkbenchQueue, useWorkbenchStatus } from './workbench-store';
import {
  countWorkspaceListing,
  workspaceListingRequest,
  type WorkspaceListingRequest,
  type WorkspaceListingCount,
} from './workspace-listings';
import type { WorkspaceTabEntry } from './workspace-tabs';
import { useMergeStates } from './use-queue-signals';

/** Counts read the shared queue store, which stays subscribed while Activity hides every listing. */
export function useWorkspaceListings(tabs: WorkspaceTabEntry[], account?: string) {
  const signature = JSON.stringify(tabs.map((tab) => [tab.id, workspaceListingRequest(tab) ?? null]));
  const requests = useMemo(() => JSON.parse(signature) as [string, WorkspaceListingRequest | null][], [signature]);
  const hasListings = requests.some(([, request]) => request !== null);
  const enabled = !!account && hasListings;
  const queue = useWorkbenchQueue(enabled);
  const history = useReviewHistory(enabled);
  const { loaded } = useWorkbenchStatus(enabled);
  // Listings never load status; with the merge filter they count PRs whose loaded status shows conflicts.
  const mergeNeeded = enabled && (queue.filters?.merge === 'conflicts' || !!queue.savedViews?.views.some((view) => view.draft.merge === 'conflicts'));
  const members = useMemo(
    () => (mergeNeeded ? [...queue.items, ...(queue.starredItems ?? [])].flatMap((item) => item.subject.members) : []),
    [mergeNeeded, queue.items, queue.starredItems]
  );
  const merge = useMergeStates(account ?? null, members, mergeNeeded);
  const previousCounts = useRef<Record<string, WorkspaceListingCount | undefined>>({});
  return useMemo(() => {
    const results: Record<string, WorkspaceListingCount | undefined> = {};
    if (!enabled || !loaded || !account) return results;
    const cache = new Map<string, WorkspaceListingCount | undefined>();
    for (const [id, request] of requests) {
      if (!request) continue;
      const key = JSON.stringify(request);
      if (!cache.has(key))
        cache.set(key, countWorkspaceListing(request, queue, history, account, undefined, merge));
      results[id] = cache.get(key);
    }
    const previous = previousCounts.current;
    if (
      Object.keys(results).length === Object.keys(previous).length &&
      Object.entries(results).every(
        ([id, value]) =>
          value?.count === previous[id]?.count && value?.unread === previous[id]?.unread && id in previous
      )
    )
      return previous;
    previousCounts.current = results;
    return results;
  }, [requests, queue, history, account, enabled, loaded, merge]);
}
