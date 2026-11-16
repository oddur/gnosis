import { useCallback, useEffect, useRef } from 'react';
import { createRowIntent } from './row-intent';
import { intentsEnabled } from './predictions';
import { openRows } from './pr-open-targets';
import { signalValues } from './queue-signal-store';
import { workbenchStore } from './workbench-store';
import { sectionPatch, viewTopMembers, VIEW_TOP_ROWS, type SidebarSection } from './saved-view-sync';
import { normalizeQueueFilters, type QueueFilters } from './queue-filters';
import type { WorkbenchQueue } from './workbench';

interface Input {
  /** The signed-in account; null while signed out or unknown. */
  login: string | null;
  queue: WorkbenchQueue;
  filters: QueueFilters;
  /** The view or section shown, as one string. Changing it is a switch. */
  shownKey: string;
  /** The first screenful of rows shown, in order. */
  shownUrls: readonly string[];
  /** The queue has loaded, and its view and filters are the reader's own. */
  ready: boolean;
}

/**
 * Keeps a queue view in sync when the reader switches to it, and prepares it when they rest on it in the sidebar.
 *
 * Switching to a view or section asks main once to read its first screenful of rows again (`refreshQueueRows`). Main
 * skips rows read within 30 s, so moving between two views does not read them twice. The first view after loading is
 * left to startup and focus wake.
 *
 * Resting on a saved view or section for 150 ms applies its filters to the current queue here and sends its top rows to
 * main's queue preparation (`prOpenViewHover`): paced, automatic, and only for saved copies that are missing or old.
 * Leaving cancels what has not started; a quick pass sends nothing. Nothing is sent while the saved queue copy is shown.
 */
export function useViewSync({ login, queue, filters, shownKey, shownUrls, ready }: Input) {
  const latest = useRef({ login, queue, filters, shownKey });
  latest.current = { login, queue, filters, shownKey };

  // ── Refresh on switch ──
  const baseline = useRef<string | undefined>(undefined);
  const urls = shownUrls.slice(0, VIEW_TOP_ROWS).join('\n');
  useEffect(() => {
    if (!ready || !login) return;
    if (baseline.current === undefined) { baseline.current = shownKey; return; }
    if (baseline.current === shownKey) return;
    // Rows settle after the filters apply; a quick run of switches asks only for the last view.
    const timer = setTimeout(() => {
      if (document.visibilityState === 'hidden' || workbenchStore.getStatus().saved) return;
      baseline.current = shownKey;
      // Saved reviews, muted PRs and empty views have no rows to read.
      if (urls) window.electronAPI.refreshQueueRows?.(urls.split('\n'));
    }, 250);
    return () => clearTimeout(timer);
  }, [ready, login, shownKey, urls]);

  // ── Prefetch on hover ──
  const intent = useRef<ReturnType<typeof createRowIntent> | null>(null);
  intent.current ??= createRowIntent({
    fire: (id) => {
      const { login, queue, filters, shownKey } = latest.current;
      const send = window.electronAPI.prOpenViewHover;
      if (!send || !login || !intentsEnabled() || workbenchStore.getStatus().saved) return;
      const views = queue.savedViews;
      const [kind, key] = [id.slice(0, id.indexOf(':')), id.slice(id.indexOf(':') + 1)];
      let target: unknown;
      if (kind === 'view') target = views?.views.find((view) => view.id === key)?.draft;
      else {
        // A section applies over the queue's own filters, not a saved view's.
        const base = views?.activeId ? normalizeQueueFilters(views.queueDraft) : filters;
        target = { ...base, ...sectionPatch(key as SidebarSection, base) };
      }
      // The view shown is already prepared as the current view.
      if (!target || shownKey === id) return;
      const all = [...queue.items, ...(queue.starredItems ?? [])].flatMap((item) => item.subject.members);
      const members = viewTopMembers(queue, target, { login, signals: signalValues(login, all) });
      const { targets } = openRows([{ id, members }], { unread: members.map((member) => member.url) });
      if (targets.length) send(targets);
    },
    clear: () => window.electronAPI.prOpenViewHover?.([]),
  });
  useEffect(() => () => intent.current?.leave(), []);
  /** `view:<id>` or `section:<id>`; null on leave. */
  const onViewIntent = useCallback((id: string | null) => {
    if (id) intent.current?.enter(id);
    else intent.current?.leave();
  }, []);
  return onViewIntent;
}
