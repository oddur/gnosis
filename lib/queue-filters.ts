import { fingerprint, type QueueItem, type ReviewMember } from './workbench';

export interface QueueFilters {
  involvement: 'all' | 'mine';
  query: string;
  repo: string;
  author: string;
  status: 'all' | 'ready' | 'draft';
  createdWithin: number;
  updatedWithin: number;
  label: string;
  kind: 'all' | 'stack' | 'pr';
  explanation: 'all' | 'none' | 'ready' | 'outdated' | 'generating' | 'failed';
  attention: 'all' | QueueItem['attention'];
  briefingScope: 'matches' | 'all';
}
export const DEFAULT_QUEUE_FILTERS: QueueFilters = {
  involvement: 'all',
  query: '',
  repo: 'all',
  author: 'all',
  status: 'all',
  createdWithin: 0,
  updatedWithin: 0,
  label: 'all',
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
    involvement: choice('involvement', ['all', 'mine'], 'all'),
    query: text('query', ''),
    repo: text('repo', 'all'),
    author: text('author', 'all'),
    label: text('label', 'all'),
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
      m.state === 'open' &&
      !m.merged &&
      (filters.involvement !== 'mine' || isMyPr(m, login)) &&
      (filters.repo === 'all' || m.repo === filters.repo) &&
      (filters.author === 'all' || m.author === filters.author) &&
      (filters.status === 'all' || (filters.status === 'draft' ? m.isDraft : !m.isDraft)) &&
      (filters.label === 'all' || m.labels.includes(filters.label)) &&
      recent(m.createdAt, filters.createdWithin) &&
      recent(m.updatedAt, filters.updatedWithin) &&
      `${subject.title} ${m.title} ${m.repo} #${m.number} ${m.author}`
        .toLowerCase()
        .includes(filters.query.trim().toLowerCase())
  );
}
export function activeQueueFilterCount(filters: QueueFilters) {
  return (Object.keys(DEFAULT_QUEUE_FILTERS) as (keyof QueueFilters)[]).filter(
    (key) => key !== 'briefingScope' && filters[key] !== DEFAULT_QUEUE_FILTERS[key]
  ).length;
}
/** Stable partition preserves the queue's review priority within each group. */
export function prioritizeBriefings(
  items: QueueItem[],
  filters: QueueFilters,
  now = Date.now(),
  login?: string | null
): QueueItem[] {
  const matching = items.filter((item) => matchesQueueFilters(item, filters, now, login));
  return filters.briefingScope === 'matches'
    ? matching
    : [...matching, ...items.filter((item) => !matchesQueueFilters(item, filters, now, login))];
}

export function describeQueueFilters(filters: QueueFilters): { key: keyof QueueFilters; label: string }[] {
  const labels: Partial<Record<keyof QueueFilters, string>> = {
    involvement: 'Assigned to or authored by me',
    query: `Search: ${filters.query}`,
    repo: filters.repo,
    author: `Author: ${filters.author}`,
    status: filters.status === 'draft' ? 'Draft PRs' : 'Ready for review',
    createdWithin: `Created: last ${filters.createdWithin} days`,
    updatedWithin: `Updated: last ${filters.updatedWithin} days`,
    label: `Label: ${filters.label}`,
    kind: filters.kind === 'stack' ? 'Stacks' : 'Standalone PRs',
    explanation: `Explanation: ${filters.explanation === 'none' ? 'not generated' : filters.explanation}`,
    attention: {
      all: 'All changes',
      requested: 'Review requested',
      updated: 'Updated since review',
      other: 'Other changes',
    }[filters.attention],
  };
  return (Object.keys(labels) as (keyof QueueFilters)[])
    .filter((key) => filters[key] !== DEFAULT_QUEUE_FILTERS[key])
    .map((key) => ({ key, label: labels[key] ?? '' }));
}
