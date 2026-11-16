import { matchesQueueFilters, normalizeQueueFilters, type QueueFilters } from './queue-filters';
import { sortQueueItems } from './pr-list-sort';
import { mergeStates } from './merge-conflicts';
import type { QueueSignals } from './queue-signals';
import type { QueueItem } from './workbench';

/**
 * About one screenful of queue rows. Switching to a view reads at most this many PRs again, and resting on a view
 * prepares at most this many. Both fit in one 25-PR signals request.
 */
export const VIEW_TOP_ROWS = 15;

export type SidebarSection = 'all' | 'starred' | 'requested' | 'response' | 'updated' | 'stacks';
type Member = QueueItem['subject']['members'][number];

/** The filters a sidebar section applies over the queue's own filters. */
export function sectionPatch(id: SidebarSection, current: Pick<QueueFilters, 'involvement'>): Partial<QueueFilters> {
  return {
    starredOnly: id === 'starred',
    attention: id === 'stacks' || id === 'starred' || id === 'response' || id === 'all' ? 'all' : id,
    involvement: id === 'response' ? 'response' : current.involvement === 'response' ? 'all' : current.involvement,
    kind: id === 'stacks' ? 'stack' : 'all',
  };
}

/**
 * The PRs at the top of a view, in the order the queue would show them: the view's filters and sort over the current
 * queue, in the renderer, with no request. Members of the first rows, at most `limit` PRs.
 */
export function viewTopMembers(
  queue: { items: QueueItem[]; starredItems?: QueueItem[] },
  rawFilters: unknown,
  options: { now?: number; login?: string | null; signals?: QueueSignals[]; limit?: number } = {}
): Member[] {
  const filters = normalizeQueueFilters(rawFilters);
  const limit = options.limit ?? VIEW_TOP_ROWS;
  const signals = options.signals ?? [];
  const candidates = filters.starredOnly ? (queue.starredItems ?? []) : queue.items;
  const merge = filters.merge === 'all' ? undefined : mergeStates(candidates.flatMap((item) => item.subject.members), signals);
  const matching = candidates.filter((item) => matchesQueueFilters(item, filters, options.now ?? Date.now(), options.login, merge));
  const members = new Map<string, Member>();
  for (const item of sortQueueItems(matching, filters.sort, signals)) {
    for (const member of item.subject.members) {
      if (members.size >= limit) break;
      if (!members.has(member.url)) members.set(member.url, member);
    }
    if (members.size >= limit) break;
  }
  return [...members.values()];
}
