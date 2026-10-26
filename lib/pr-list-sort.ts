import type { QueueItem, ReviewMember } from './workbench';
import type { ReviewHistoryEntry } from './types';
import { prReviewStatus } from './pr-review-status';
import { queueSignalKey, type QueueSignals } from './queue-signals';

export const PR_SORT_LABELS = {
  priority: 'Priority', updated: 'Last updated', created: 'Date opened', size: 'Change size',
  unread: 'Unread first', status: 'Review status', author: 'Author', repo: 'Repository', title: 'Title', generated: 'Date generated',
} as const;
export type PrSortKey = keyof typeof PR_SORT_LABELS;
export interface PrListSort { key: PrSortKey; direction: 'asc' | 'desc'; starredFirst: boolean }
export const DEFAULT_PR_SORT: PrListSort = { key: 'priority', direction: 'asc', starredFirst: true };
export const reversibleSort = (key: PrSortKey) => !['priority', 'unread', 'status'].includes(key);
export const defaultSortDirection = (key: PrSortKey) => ['updated', 'created', 'generated'].includes(key) ? 'desc' as const : 'asc' as const;
export function normalizePrListSort(value: unknown, savedReviews = false): PrListSort {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const key = typeof raw.key === 'string' && Object.hasOwn(PR_SORT_LABELS, raw.key) && (savedReviews || raw.key !== 'generated')
    ? raw.key as PrSortKey : 'priority';
  return { key, direction: reversibleSort(key) && (raw.direction === 'asc' || raw.direction === 'desc') ? raw.direction : defaultSortDirection(key), starredFirst: raw.starredFirst !== false };
}
export function sortDirectionLabel(sort: PrListSort) {
  if (['updated', 'created', 'generated'].includes(sort.key)) return sort.direction === 'desc' ? 'Newest first' : 'Oldest first';
  if (sort.key === 'size') return sort.direction === 'asc' ? 'Smallest first' : 'Largest first';
  return sort.direction === 'asc' ? 'A–Z' : 'Z–A';
}
const textOrder = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
const idOrder = new Intl.Collator(undefined, { numeric: true });
const statusOrder = ['changes-requested', 'awaiting-review', 'approved', 'draft', 'merged', 'closed'];
const date = (value?: string) => value && Number.isFinite(Date.parse(value)) ? Date.parse(value) : undefined;
function timestamp(members: ReviewMember[], field: 'createdAt' | 'updatedAt') {
  const dates = members.map(member => date(member[field]));
  if (!dates.length || dates.some(value => value === undefined)) return;
  return field === 'updatedAt' ? Math.max(...dates as number[]) : Math.min(...dates as number[]);
}
function changedLines(members: ReviewMember[]) {
  if (!members.length || members.some(member => !Number.isFinite(member.additions) || !Number.isFinite(member.deletions))) return;
  return members.reduce((sum, member) => sum + (member.additions ?? 0) + (member.deletions ?? 0), 0);
}
interface SortRow { id: string; members: ReviewMember[]; title?: string; author?: string; repo?: string; unread?: boolean; starred: boolean; priority?: number; generated?: string; state?: ReviewHistoryEntry['prState'] }
function sortRows<T>(items: T[], sort: PrListSort, rowFor: (item: T) => SortRow, signals: QueueSignals[]) {
  const byRevision = new Map(signals.map(signal => [queueSignalKey(signal), signal]));
  const value = (row: SortRow): string | number | undefined => {
    const root = row.members.at(0);
    switch (sort.key) {
      case 'priority': return row.priority ?? date(row.generated);
      case 'updated': return timestamp(row.members, 'updatedAt');
      case 'created': return timestamp(row.members, 'createdAt');
      case 'generated': return date(row.generated);
      case 'size': return changedLines(row.members);
      case 'unread': return row.unread === undefined ? undefined : Number(!row.unread);
      case 'title': return row.title || root?.title || undefined;
      case 'author': return root?.author || row.author || undefined;
      case 'repo': return root?.repo || row.repo || undefined;
      case 'status': {
        if (!row.members.length && (row.state === 'merged' || row.state === 'closed')) return statusOrder.indexOf(row.state);
        const ranks = row.members.map(member => statusOrder.indexOf(prReviewStatus(member, byRevision.get(queueSignalKey(member)), false).kind)).filter(rank => rank >= 0);
        return ranks.length ? Math.min(...ranks) : undefined;
      }
    }
  };
  return items.map(item => { const row = rowFor(item); return { item, row, value: value(row) }; }).sort((a, b) => {
    if (sort.starredFirst && a.row.starred !== b.row.starred) return a.row.starred ? -1 : 1;
    if (a.value === undefined || b.value === undefined) return Number(a.value === undefined) - Number(b.value === undefined) || idOrder.compare(a.row.id, b.row.id);
    const direction = sort.direction === 'desc' ? -1 : 1;
    const compared = typeof a.value === 'string' && typeof b.value === 'string'
      ? textOrder.compare(a.value, b.value)
      : Number(a.value) - Number(b.value);
    if (compared) return compared * direction;
    if (sort.key === 'priority') {
      const updated = (timestamp(b.row.members, 'updatedAt') ?? 0) - (timestamp(a.row.members, 'updatedAt') ?? 0);
      return updated; // Preserve discovery order for equal-priority, equal-date entries.
    }
    return idOrder.compare(a.row.id, b.row.id);
  }).map(row => row.item);
}
export function sortQueueItems(items: QueueItem[], sort: PrListSort = DEFAULT_PR_SORT, signals: QueueSignals[] = []) {
  return sortRows(items, sort, item => ({ id: item.subject.id, members: item.subject.members,
    title: item.subject.members[0]?.title ?? item.subject.title, unread: !!item.unreadUrls?.length, starred: !!item.starred,
    priority: { updated: 0, requested: 1, other: 2 }[item.attention] }), signals);
}
export function sortSavedReviews(items: ReviewHistoryEntry[], sort: PrListSort, starred: ReadonlySet<string>, signals: QueueSignals[] = []) {
  // Priority in saved history retains the familiar newest-generated-first order.
  const effective = sort.key === 'priority' ? { ...sort, key: 'generated' as const, direction: 'desc' as const } : sort;
  return sortRows(items, effective, entry => ({ id: entry.id, members: entry.snapshot?.subject.members ?? [],
    title: entry.snapshot?.subject.members[0]?.title ?? entry.prTitle, author: entry.author, repo: /^https:\/\/github.com\/([^/]+\/[^/]+)\//.exec(entry.prUrl)?.[1],
    generated: entry.savedAt, state: entry.prState, unread: !!entry.unread,
    starred: (entry.snapshot?.subject.members ?? [{ url: entry.prUrl }]).some(member => starred.has(member.url)),
  }), signals);
}
