import { useEffect, useMemo, useRef, useState } from 'react';
import {
  countWorkspaceListing,
  workspaceListingRequest,
  type WorkspaceListingRequest,
  type WorkspaceListingCount,
} from './workspace-listings';
import type { WorkspaceTabEntry } from './workspace-tabs';
import type { WorkbenchQueue } from './workbench';
import type { ReviewHistoryEntry } from './types';

/** One cache-only subscription survives Activity hiding every individual listing. */
export function useWorkspaceListings(tabs: WorkspaceTabEntry[], account?: string) {
  const signature = JSON.stringify(tabs.map((tab) => [tab.id, workspaceListingRequest(tab) ?? null]));
  const requests = useMemo(() => JSON.parse(signature) as [string, WorkspaceListingRequest | null][], [signature]);
  const hasListings = requests.some(([, request]) => request !== null);
  const hasSaved = requests.some(
    ([, request]) => request && ('kind' in request ? request.kind === 'saved' : request.destination.section === 'saved')
  );
  const [snapshot, setSnapshot] = useState<{ account: string; queue: WorkbenchQueue; history: ReviewHistoryEntry[] }>();
  useEffect(() => {
    if (!account || !hasListings) return;
    let live = true,
      running = false,
      dirty = false;
    const isLive = () => live;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      if (!live) return;
      if (running) {
        dirty = true;
        return;
      }
      running = true;
      try {
        const [queue, history] = await Promise.all([
          window.electronAPI.workbenchSnapshot(),
          hasSaved ? window.electronAPI.listReviews() : Promise.resolve([]),
        ]);
        if (isLive()) setSnapshot({ account, queue, history });
      } catch {
        /* Keep the last known counts until the next local update or window focus. */
      } finally {
        running = false;
        if (dirty && isLive()) {
          dirty = false;
          schedule();
        }
      }
    };
    const schedule = () => {
      if (timer !== undefined || !live) return;
      timer = setTimeout(() => {
        timer = undefined;
        void refresh();
      }, 50);
    };
    const stopQueue = window.electronAPI.onWorkbenchChanged?.(schedule);
    const stopRead = window.electronAPI.onPrReadStateChanged(schedule);
    const stopActivity = hasSaved ? window.electronAPI.onActivityChanged?.(schedule) : undefined;
    window.addEventListener('focus', schedule);
    void refresh();
    return () => {
      live = false;
      clearTimeout(timer);
      stopQueue?.();
      stopRead();
      stopActivity?.();
      window.removeEventListener('focus', schedule);
    };
  }, [account, hasListings, hasSaved]);
  const previousCounts = useRef<Record<string, WorkspaceListingCount | undefined>>({});
  return useMemo(() => {
    const results: Record<string, WorkspaceListingCount | undefined> = {};
    if (!snapshot || snapshot.account !== account) return results;
    const cache = new Map<string, WorkspaceListingCount | undefined>();
    for (const [id, request] of requests) {
      if (!request) continue;
      const key = JSON.stringify(request);
      if (!cache.has(key))
        cache.set(key, countWorkspaceListing(request, snapshot.queue, snapshot.history, snapshot.account));
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
  }, [requests, snapshot, account]);
}
