import { needsResponse } from './response-needed';
import { DEFAULT_LABEL_FILTER, normalizeLabelFilter, labelFilterActive, matchesLabelFilter, describeLabelFilter, type PrLabelFilter } from './pr-label-filter';
import { DEFAULT_PR_SORT, normalizePrListSort, sortQueueItems, type PrListSort } from './pr-list-sort';
import type { QueueSignals } from './queue-signals';
import { memberMergeState, type MergeStates } from './merge-conflicts';
import { fingerprint, type Briefing, type QueueItem, type ReviewMember } from './workbench';

export interface QueueFilters {
  sort: PrListSort;
  starredOnly: boolean;
  readStatus: 'all' | 'unread' | 'read';
  involvement: 'all' | 'mine' | 'review' | 'authored' | 'response';
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
  /** Briefing status. It narrows the list only; it never decides which briefings run. */
  briefing: 'all' | BriefingState;
  briefingScope: 'matches' | 'all';
  /** Merge conflicts reported by GitHub. Needs status for every candidate PR, so the queue loads it only while this is on. */
  merge: 'all' | 'conflicts';
}
export const BRIEFING_STATES = ['generating', 'queued', 'ready', 'paused', 'failed'] as const;
export type BriefingState = (typeof BRIEFING_STATES)[number];
export type BriefingPause = 'limit' | 'filter' | 'manual' | 'waiting';
/** Cancelled and missing briefings have no state of their own; they count only toward All. */
export function briefingState(briefing: Briefing | undefined): BriefingState | undefined {
  const status = briefing?.status;
  return status === 'cancelled' ? undefined : status;
}
/** Older snapshots and fixtures carry only the detail text, so fall back to it. */
export function briefingPause(briefing: Briefing): BriefingPause {
  if (briefing.pauseReason) return briefing.pauseReason;
  if (/limit reached/i.test(briefing.pauseDetail ?? '')) return 'limit';
  if (/automatic briefings are off/i.test(briefing.pauseDetail ?? '')) return 'manual';
  return 'waiting';
}
export interface BriefingCounts {
  all: number;
  generating: number;
  queued: number;
  ready: number;
  paused: number;
  failed: number;
  pauses: Record<BriefingPause, number>;
}
/** Counts briefing states of entries that are already filtered. */
export function tallyBriefings(items: readonly QueueItem[]): BriefingCounts {
  const counts: BriefingCounts = { all: 0, generating: 0, queued: 0, ready: 0, paused: 0, failed: 0, pauses: { limit: 0, filter: 0, manual: 0, waiting: 0 } };
  for (const item of items) {
    counts.all++;
    const state = briefingState(item.briefing);
    if (!state) continue;
    counts[state]++;
    if (state === 'paused' && item.briefing) counts.pauses[briefingPause(item.briefing)]++;
  }
  return counts;
}
/** Counts for the briefing chips. Every other filter applies, so a chip's count is what clicking it shows. */
export function countBriefings(items: readonly QueueItem[], filters: QueueFilters, now = Date.now(), login?: string | null, merge?: MergeStates): BriefingCounts {
  const scope = filters.briefing === 'all' ? filters : { ...filters, briefing: 'all' as const };
  return tallyBriefings(items.filter((item) => matchesQueueFilters(item, scope, now, login, merge)));
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
  briefing: 'all',
  briefingScope: 'matches',
  merge: 'all',
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
    involvement: choice('involvement', ['all', 'mine', 'review', 'authored', 'response'], 'all'),
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
    briefing: choice('briefing', ['all', ...BRIEFING_STATES], 'all'),
    briefingScope: choice('briefingScope', ['matches', 'all'], 'matches'),
    merge: choice('merge', ['all', 'conflicts'], 'all'),
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
  if (involvement === 'authored' || involvement === 'response') return member.author.toLowerCase() === login.toLowerCase();
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
  login?: string | null,
  /** Required for the merge filter. A PR without a known state does not match. */
  merge?: MergeStates
): boolean {
  const { subject, review } = item;
  if (filters.attention !== 'all' && item.attention !== filters.attention) return false;
  if (filters.kind !== 'all' && subject.kind !== filters.kind) return false;
  if (filters.briefing !== 'all' && briefingState(item.briefing) !== filters.briefing) return false;
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
      (filters.involvement !== 'response' || (m.state === 'open' && !m.merged && needsResponse(item.responses?.[m.url]))) &&
      matchesRepositories(m.repo, filters) &&
      (filters.author === 'all' || m.author.toLowerCase() === filters.author.toLowerCase()) &&
      matchesTargetBranch(m.baseBranch, filters.targetBranch) &&
      (filters.status === 'all' ||
        (m.state === 'open' && !m.merged && (filters.status === 'draft' ? m.isDraft : !m.isDraft))) &&
      matchesLabelFilter(m.labels, filters.labels) &&
      (filters.merge === 'all' || (m.state === 'open' && !m.merged && memberMergeState(m, merge) === 'conflicts')) &&
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
  signals: QueueSignals[] = [],
  merge?: MergeStates
): QueueItem[] {
  items = sortQueueItems(items, filters.sort, signals);
  // The briefing filter follows briefing state, so it must not decide which briefing runs next.
  if (filters.briefing !== 'all') filters = { ...filters, briefing: 'all' };
  const matching = items.filter((item) => matchesQueueFilters(item, filters, now, login, merge));
  return filters.briefingScope === 'matches'
    ? matching
    : [...matching, ...items.filter((item) => !matchesQueueFilters(item, filters, now, login, merge))];
}

export function describeQueueFilters(filters: QueueFilters): { key: keyof QueueFilters; label: string }[] {
  const labels: Partial<Record<keyof QueueFilters, string>> = {
    starredOnly: 'Starred PRs',
    readStatus: filters.readStatus === 'unread' ? 'Unread PRs' : 'Read PRs',
    involvement: { all: 'All PRs', mine: 'Involving me', review: 'Needs my review', authored: 'Authored by me', response: 'Needs my response' }[filters.involvement],
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
    merge: 'Merge conflicts',
    briefing: `Briefing: ${{ all: 'any state', generating: 'generating', queued: 'queued', ready: 'ready', paused: 'paused', failed: 'failed' }[filters.briefing]}`,
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

const NO_CANDIDATES: { url: string; headSha: string }[] = [];
/**
 * PR revisions the merge filter must know about: open PRs that match every other filter. Empty while the
 * filter is off, so turning it off stops all merge-state reads.
 */
export function mergeFilterCandidates(
  items: readonly QueueItem[],
  filters: QueueFilters,
  now = Date.now(),
  login?: string | null
): { url: string; headSha: string }[] {
  if (filters.merge === 'all') return NO_CANDIDATES;
  const others = { ...filters, merge: 'all' as const };
  const candidates = new Map<string, { url: string; headSha: string }>();
  for (const item of items) {
    if (!matchesQueueFilters(item, others, now, login)) continue;
    for (const member of item.subject.members)
      if (
        member.state === 'open' &&
        !member.merged &&
        // The status service rejects a whole batch with one malformed request.
        /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(member.url) &&
        /^[a-zA-Z0-9_-]{1,64}$/.test(member.headSha) &&
        matchesQueueFilters({ ...item, subject: { ...item.subject, members: [member] } }, others, now, login)
      )
        candidates.set(`${member.url}@${member.headSha}`, { url: member.url, headSha: member.headSha });
  }
  return [...candidates.values()];
}
