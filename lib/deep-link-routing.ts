/**
 * Renderer side of "open Gnosis at this exact place" (#309 section 6.2). Pure: maps a target to the workspace tab
 * to use and the `SearchDestination` to run, the path the command palette uses.
 */
import { prUrl, type DeepLinkTarget, type PrTab } from './deep-link';
import type { SearchDestination } from './command-search';
import type { WorkspaceTab } from './navigation-history';
import type { WorkspaceTabsState } from './workspace-tabs';
import type { QueueItem, WorkbenchQueue } from './workbench';
import { focusStackPr } from './stack-workspace';

export type DeepLinkTab = { kind: 'reuse'; id: string } | { kind: 'active' } | { kind: 'new' };
export interface DeepLinkRoute {
  tab: DeepLinkTab;
  destination: SearchDestination;
}
export const workspaceTab = (tab: PrTab | undefined): WorkspaceTab | undefined => (tab === 'notes' ? 'brief' : tab);

/** The queue item that shows a PR: a stack member is focused with its stack as context. */
export function queueItemFor(url: string, queue: Pick<WorkbenchQueue, 'items' | 'starredItems' | 'stacks'>): QueueItem | undefined {
  const items: QueueItem[] = [...queue.items, ...(queue.starredItems ?? [])];
  for (const stack of queue.stacks ?? []) if (!items.some((item) => item.subject.id === stack.id)) items.push({ subject: stack, attention: 'other' });
  const exact = items.find((item) => item.subject.kind === 'pr' && item.subject.id === url);
  if (exact) return exact;
  const parent = items.find((item) => item.subject.members.some((member) => member.url === url));
  const member = parent?.subject.members.find((m) => m.url === url);
  return parent && member ? (parent.subject.kind === 'stack' ? focusStackPr(parent, member) : parent) : undefined;
}

export function routeDeepLink(
  target: DeepLinkTarget,
  state: Pick<WorkspaceTabsState, 'tabs' | 'active'>,
  queue: Pick<WorkbenchQueue, 'items' | 'starredItems' | 'stacks'>,
  nonce = Date.now()
): DeepLinkRoute {
  if (target.kind === 'review') {
    // A tab already on that review is reused. Otherwise the active tab opens it, as "Explanation ready" always has.
    // `explore: false` opens the reader: without it, an open interactive explanation would stay in front.
    const reuse = state.tabs.find((tab) => tab.location?.page === 'review' && tab.location.reviewId === target.reviewId);
    return { tab: reuse ? { kind: 'reuse', id: reuse.id } : { kind: 'active' }, destination: { kind: 'review', reviewId: target.reviewId, explore: false } };
  }
  if (target.kind === 'queue') {
    const active = state.tabs.find((tab) => tab.id === state.active);
    const plainQueue = !active?.location || (active.location.page === 'home' && !active.location.home.item);
    return {
      tab: plainQueue ? { kind: 'active' } : { kind: 'new' },
      destination: { kind: 'home', section: target.section ?? 'all', ...(target.filters ? { filters: target.filters } : {}) },
    };
  }
  const url = prUrl(target.pr);
  const open = { tab: workspaceTab(target.tab), nonce };
  // Never replace what the user is looking at in another tab: reuse the tab showing this PR, or open one.
  const reuse = state.tabs.find(
    (tab) => tab.location?.page === 'home' && tab.location.home.item?.subject.members.some((member) => member.url === url)
  );
  const item = queueItemFor(url, queue);
  return {
    tab: reuse ? { kind: 'reuse', id: reuse.id } : { kind: 'new' },
    destination: item ? { kind: 'home', subject: item, open } : { kind: 'home', url, open },
  };
}
