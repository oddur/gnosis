/**
 * "Group by" for the review queue and saved views: None, Action or Repository. Pure, with no React imports.
 *
 * - **Action** uses the Overview's lanes (`lib/overview.ts`): Answer, Review, Merge, Fix, Waiting on others, Parked,
 *   then Other for entries in no lane.
 * - **Repository** goes alphabetically by `owner/repo`, case-insensitively, so a repository is always in the same place.
 *
 * Groups keep the queue's sort inside them and hide when empty. A collapsed group keeps its heading and count; its
 * entries leave the list, so keyboard movement skips them.
 */
import { actionGroupOf, OVERVIEW_ACTION_GROUP_LABEL, OVERVIEW_ACTION_GROUPS, type OverviewActionGroup } from './overview';
import type { QueueItem } from './workbench';

export type QueueGroupBy = 'none' | 'action' | 'repository';
export const QUEUE_GROUP_BY: readonly QueueGroupBy[] = ['none', 'action', 'repository'];
export const QUEUE_GROUP_BY_LABEL: Readonly<Record<QueueGroupBy, string>> = { none: 'None', action: 'Action', repository: 'Repository' };
export const isQueueGroupBy = (value: unknown): value is QueueGroupBy => QUEUE_GROUP_BY.includes(value as QueueGroupBy);

export interface QueueGroup {
  /** `action:fix` or `repository:klang/engine`. Stable, so a collapsed group stays collapsed. */
  key: string;
  label: string;
  /** Entries in the group, collapsed or not. */
  count: number;
  collapsed: boolean;
}
export interface QueueGrouping {
  groups: QueueGroup[];
  /** The entries the list shows: group by group, sorted within each, without collapsed groups. */
  items: QueueItem[];
  /** Each shown entry's group key. */
  groupOf: ReadonlyMap<string, string>;
}

export const actionGroupKey = (group: OverviewActionGroup) => `action:${group}`;
export const repositoryGroupKey = (repo: string) => `repository:${repo.toLowerCase()}`;

/** The repository an entry is listed under: its first open PR's, else its first PR's. */
export function repositoryOf(item: Pick<QueueItem, 'subject'>): string {
  const members = item.subject.members;
  return (members.find((member) => member.state === 'open' && !member.merged) ?? members[0])?.repo ?? '';
}

/**
 * Splits sorted entries into groups. `items` must already be sorted; the order inside each group is kept. Returns
 * undefined for `none`, so the ungrouped list stays exactly as it was.
 */
export function groupQueueItems(
  items: readonly QueueItem[],
  groupBy: QueueGroupBy,
  options: { actionGroups?: Readonly<Record<string, OverviewActionGroup>>; collapsed?: ReadonlySet<string> } = {}
): QueueGrouping | undefined {
  if (groupBy === 'none') return undefined;
  const buckets = new Map<string, { label: string; items: QueueItem[] }>();
  const actionGroups = options.actionGroups ?? {};
  for (const item of items) {
    let key: string;
    let label: string;
    if (groupBy === 'action') {
      const group = actionGroupOf(item, actionGroups);
      key = actionGroupKey(group);
      label = OVERVIEW_ACTION_GROUP_LABEL[group];
    } else {
      label = repositoryOf(item);
      key = repositoryGroupKey(label);
    }
    const bucket = buckets.get(key);
    if (bucket) bucket.items.push(item);
    else buckets.set(key, { label, items: [item] });
  }
  const keys =
    groupBy === 'action'
      ? OVERVIEW_ACTION_GROUPS.map(actionGroupKey).filter((key) => buckets.has(key))
      : [...buckets.keys()].sort((a, b) => a.localeCompare(b));
  const collapsed = options.collapsed ?? new Set<string>();
  const groups: QueueGroup[] = [];
  const shown: QueueItem[] = [];
  const groupOf = new Map<string, string>();
  for (const key of keys) {
    const bucket = buckets.get(key);
    if (!bucket) continue;
    const closed = collapsed.has(key);
    groups.push({ key, label: bucket.label, count: bucket.items.length, collapsed: closed });
    if (closed) continue;
    for (const item of bucket.items) {
      shown.push(item);
      groupOf.set(item.subject.id, key);
    }
  }
  return { groups, items: shown, groupOf };
}

/** Collapsed groups, saved per view on this computer: `{ "view:abc": ["action:parked"] }`. */
export const QUEUE_COLLAPSED_GROUPS_KEY = 'gnosis-queue-collapsed-groups:v1';
const MAX_VIEWS = 200;
const MAX_KEYS = 200;

export function parseCollapsedGroups(raw: string | null): Record<string, string[]> {
  if (!raw) return {};
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const result: Record<string, string[]> = {};
    for (const [view, keys] of Object.entries(value as Record<string, unknown>).slice(0, MAX_VIEWS)) {
      if (!Array.isArray(keys)) continue;
      const valid = [...new Set(keys.filter((key): key is string => typeof key === 'string' && key.length <= 300))].slice(0, MAX_KEYS);
      if (valid.length) result[view] = valid;
    }
    return result;
  } catch {
    return {};
  }
}

/** The view's collapsed groups after toggling `key`, or after forcing it open with `open`. */
export function toggleCollapsedGroup(all: Readonly<Record<string, string[]>>, view: string, key: string, open?: boolean): Record<string, string[]> {
  const current = new Set(all[view] ?? []);
  const collapse = open === undefined ? !current.has(key) : !open;
  if (collapse) current.add(key);
  else current.delete(key);
  const next = { ...all };
  if (current.size) next[view] = [...current];
  else delete next[view];
  return next;
}
