import { DEFAULT_LABEL_FILTER, normalizeLabelFilter, labelFilterActive, matchesLabelFilter, describeLabelFilter, type PrLabelFilter } from './pr-label-filter';
import { DEFAULT_PR_SORT, normalizePrListSort, sortQueueItems, type PrListSort } from './pr-list-sort';
import type { QueueSignals } from './queue-signals';
import { fingerprint, type QueueItem, type ReviewMember } from './workbench';

export interface QueueFilters {
  sort: PrListSort;
  starredOnly: boolean;
  readStatus: 'all' | 'unread' | 'read';
  involvement: 'all' | 'mine' | 'review' | 'authored';
  query: string;
  repo: string;
  repos?: string[];
  author: string;
  targetBranch: string;
  status: 'all' | 'ready' | 'draft';
  createdWithin: number;
  updatedWithin: number;
  labels: PrLabelFilter;
  kind: 'all' | 'stack' | 'pr';
  explanation: 'all' | 'none' | 'ready' | 'outdated' | 'generating' | 'failed';
  attention: 'all' | QueueItem['attention'];
  briefingScope: 'matches' | 'all';
}
export const DEFAULT_QUEUE_FILTERS: QueueFilters = {
  sort: DEFAULT_PR_SORT,
  starredOnly: false,
  readStatus: 'all',
  involvement: 'all',
  query: '',
  repo: 'all',
  author: 'all',
  targetBranch: '',
  status: 'all',
  createdWithin: 0,
  updatedWithin: 0,
  labels: DEFAULT_LABEL_FILTER,
  kind: 'all',
  explanation: 'all',
  attention: 'all',
  briefingScope: 'matches',
};
export const RECENCY_DAYS = [0, 7, 14, 30, 90, 180, 365] as const;
export function normalizeQueueFilters(value: unknown): QueueFilters {
  const raw = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const text = (key: string, fallback: string) => (typeof raw[key] === 'string' ? raw[key].slice(0, 300) : fallback);
  const choice = <T extends string>(key: string, values: readonly T[], fallback: T): T =>
    values.includes(raw[key] as T) ? (raw[key] as T) : fallback;
  const days = (key: string) =>
    RECENCY_DAYS.includes(raw[key] as (typeof RECENCY_DAYS)[number]) ? Number(raw[key]) : 0;
  return {
    sort: normalizePrListSort(raw.sort),
    starredOnly: raw.starredOnly === true,
    readStatus: choice('readStatus', ['all', 'unread', 'read'], raw.unreadOnly === true ? 'unread' : 'all'),
    involvement: choice('involvement', ['all', 'mine', 'review', 'authored'], 'all'),
    query: text('query', ''),
    repo: text('repo', 'all'),
    ...(Array.isArray(raw.repos) && raw.repos.length ? { repos: [...new Set(raw.repos.filter((r): r is string => typeof r === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(r)).map(r => r.toLowerCase()))].slice(0, 100) } : {}),
    author: text('author', 'all'),
    targetBranch: text('targetBranch', '').trim(),
    labels: normalizeLabelFilter(raw.labels ?? raw.label),
    status: choice('status', ['all', 'ready', 'draft'], 'all'),
    createdWithin: days('createdWithin'),
    updatedWithin: days('updatedWithin'),
    // Migrate the retired dependency category to the stack filter.
    kind: raw.attention === 'blocking' ? 'stack' : choice('kind', ['all', 'stack', 'pr'], 'all'),
    explanation: choice('explanation', ['all', 'none', 'ready', 'outdated', 'generating', 'failed'], 'all'),
    attention: choice('attention', ['all', 'updated', 'requested', 'other'], 'all'),
    briefingScope: choice('briefingScope', ['matches', 'all'], 'matches'),
  };
}
/** Case-sensitive, whole-branch glob. * includes slashes; ? matches one character.
 * No regular expressions: branch punctuation stays literal and patterns cannot cause regex backtracking.
 */
export function matchesTargetBranch(branch: string, pattern: string): boolean {
  pattern = pattern.trim();
  if (!pattern) return true;
  let b = 0, p = 0, star = -1, retry = 0;
  while (b < branch.length) {
    if (pattern[p] === '*') {
      star = p++;
      retry = b;
    } else if (pattern[p] === '?' || pattern[p] === branch[b]) {
      b++;
      p++;
    } else if (star >= 0) {
      p = star + 1;
      b = ++retry;
    } else {
      return false;
    }
  }
  while (pattern[p] === '*') p++;
  return p === pattern.length;
}
export function isMyPr(member: ReviewMember, login?: string | null): boolean {
  if (!login) return false;
  const me = login.toLowerCase();
  return (
    member.author.toLowerCase() === me ||
    member.assignees?.some((name) => name.toLowerCase() === me) === true ||
    member.requestedReviewers.some((name) => name.toLowerCase() === me) ||
    member.role === 'assigned' ||
    member.role === 'review-requested'
  );
}
export function matchesInvolvement(member: ReviewMember, involvement: QueueFilters['involvement'], login?: string | null): boolean {
  if (involvement === 'all') return true;
  if (!login) return false;
  if (involvement === 'mine') return isMyPr(member, login);
  if (involvement === 'authored') return member.author.toLowerCase() === login.toLowerCase();
  return member.assignees?.some(name => name.toLowerCase() === login.toLowerCase()) === true ||
    member.requestedReviewers.some(name => name.toLowerCase() === login.toLowerCase()) ||
    member.role === 'assigned' || member.role === 'review-requested';
}
export function matchesRepositories(repo: string, filters: Pick<QueueFilters, 'repo' | 'repos'>): boolean {
  return (filters.repo === 'all' || repo.toLowerCase() === filters.repo.toLowerCase()) &&
    (!filters.repos?.length || filters.repos.some(value => value.toLowerCase() === repo.toLowerCase()));
}
export function matchesQueueFilters(
  item: QueueItem,
  filters: QueueFilters,
  now = Date.now(),
  login?: string | null
): boolean {
  const { subject, review } = item;
  if (filters.attention !== 'all' && item.attention !== filters.attention) return false;
  if (filters.kind !== 'all' && subject.kind !== filters.kind) return false;
  if (filters.explanation !== 'all') {
    const state = !review
      ? 'none'
      : review.status === 'generating' || review.status === 'failed'
        ? review.status
        : review.snapshot?.fingerprint === fingerprint(subject)
          ? 'ready'
          : 'outdated';
    if (filters.explanation !== state) return false;
  }
  const recent = (date: string, days: number) => !days || Date.parse(date) >= now - days * 86_400_000;
  // All PR-specific conditions must match the same open member. Keep its full stack as context.
  return subject.members.some(
    (m: ReviewMember) =>
      (filters.starredOnly || (m.state === 'open' && !m.merged)) &&
      (!filters.starredOnly || item.starredUrls?.includes(m.url)) &&
      (filters.readStatus === 'all' || (filters.readStatus === 'unread') === !!item.unreadUrls?.includes(m.url)) &&
      matchesInvolvement(m, filters.involvement, login) &&
      matchesRepositories(m.repo, filters) &&
      (filters.author === 'all' || m.author.toLowerCase() === filters.author.toLowerCase()) &&
      matchesTargetBranch(m.baseBranch, filters.targetBranch) &&
      (filters.status === 'all' ||
        (m.state === 'open' && !m.merged && (filters.status === 'draft' ? m.isDraft : !m.isDraft))) &&
      matchesLabelFilter(m.labels, filters.labels) &&
      recent(m.createdAt, filters.createdWithin) &&
      recent(m.updatedAt, filters.updatedWithin) &&
      `${subject.title} ${m.title} ${m.repo} #${m.number} ${m.author}`
        .toLowerCase()
        .includes(filters.query.trim().toLowerCase())
  );
}
export function activeQueueFilterCount(filters: QueueFilters) {
  return (Object.keys(DEFAULT_QUEUE_FILTERS) as (keyof QueueFilters)[]).filter(
    (key) => key === 'labels' ? labelFilterActive(filters.labels) : key !== 'briefingScope' && key !== 'sort' && filters[key] !== DEFAULT_QUEUE_FILTERS[key]
  ).length + (filters.repos?.length ? 1 : 0);
}
/** Stable partition preserves the queue's review priority within each group. */
export function prioritizeBriefings(
  items: QueueItem[],
  filters: QueueFilters,
  now = Date.now(),
  login?: string | null,
  signals: QueueSignals[] = []
): QueueItem[] {
  items = sortQueueItems(items, filters.sort, signals);
  const matching = items.filter((item) => matchesQueueFilters(item, filters, now, login));
  return filters.briefingScope === 'matches'
    ? matching
    : [...matching, ...items.filter((item) => !matchesQueueFilters(item, filters, now, login))];
}

export function describeQueueFilters(filters: QueueFilters): { key: keyof QueueFilters; label: string }[] {
  const labels: Partial<Record<keyof QueueFilters, string>> = {
    starredOnly: 'Starred PRs',
    readStatus: filters.readStatus === 'unread' ? 'Unread PRs' : 'Read PRs',
    involvement: { all: 'All PRs', mine: 'Involving me', review: 'Needs my review', authored: 'Authored by me' }[filters.involvement],
    ...(filters.repos?.length ? { repos: `Repositories: ${filters.repos.join(', ')}` } : {}),
    query: `Search: ${filters.query}`,
    repo: filters.repo,
    author: `Author: ${filters.author}`,
    targetBranch: `Target branch: ${filters.targetBranch}`,
    status: filters.status === 'draft' ? 'Draft PRs' : 'Open, not draft',
    createdWithin: `Created: last ${filters.createdWithin} days`,
    updatedWithin: `Updated: last ${filters.updatedWithin} days`,
    labels: describeLabelFilter(filters.labels),
    kind: filters.kind === 'stack' ? 'Stacks' : 'Standalone PRs',
    explanation: `AI explanation: ${
      {
        all: 'any state',
        none: 'not generated',
        ready: 'up to date',
        outdated: 'needs regeneration',
        generating: 'generating',
        failed: 'generation failed',
      }[filters.explanation]
    }`,
    attention: {
      all: 'All changes',
      requested: 'Review requested',
      updated: 'Changed since AI explanation',
      other: 'Other changes',
    }[filters.attention],
  };
  return (Object.keys(labels) as (keyof QueueFilters)[])
    .filter((key) => key === 'labels' ? labelFilterActive(filters.labels) : filters[key] !== DEFAULT_QUEUE_FILTERS[key])
    .map((key) => ({ key, label: labels[key] ?? '' }));
}
