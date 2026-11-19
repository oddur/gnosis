import { normalizeEffort } from './effort';
import type { QueueViewsSnapshot } from './saved-views';
import type { QueueFilters } from './queue-filters';
import type { Preferences, PrMetadata, PrSearchResult, ReviewGuide, ReviewHistoryEntry, Slide } from './types';

export interface ReviewMember extends PrMetadata {
  number: number;
  repo: string;
  headRepo: string;
  baseRepo: string;
  role: PrSearchResult['role'];
}
export interface StackEdge {
  parent: string;
  child: string;
  evidence: 'branch' | 'manual';
}
export interface ReviewSubject {
  id: string;
  /** User-owned local name; never part of generated-content identity. */
  name?: string;
  kind: 'pr' | 'stack';
  scope?: 'single';
  title: string;
  members: ReviewMember[];
  edges: StackEdge[];
  warnings: string[];
}
export interface ReviewSnapshot {
  version: 1;
  subject: ReviewSubject;
  fingerprint: string;
  capturedAt: string;
}
export interface Briefing {
  key: string;
  status: 'queued' | 'generating' | 'ready' | 'failed' | 'paused' | 'cancelled';
  summary?: string;
  systems?: string[];
  priorities?: string[];
  error?: string;
  /** Why an automatic briefing waits: the daily limit, the queue filters, or automatic briefings are off. */
  pauseReason?: 'filter' | 'limit' | 'manual';
  pauseDetail?: string;
  /** A deferred automatic briefing waits until this time (epoch ms) before it tries again. */
  retryAt?: number;
  /** How many times slow GitHub reads deferred this briefing. */
  deferrals?: number;
  /** Generated because the user asked, not by the automatic queue. */
  manual?: boolean;
  /** The user dismissed this result from Activity. It still shows on the PR. */
  dismissed?: boolean;
  updatedAt: string;
}
export interface QueueItem {
  responses?: Partial<Record<string, import('./response-needed').ResponseNeeded>>;
  /** Navigation context only. The subject is always the scope being reviewed. */
  parentStack?: ReviewSubject;
  unreadUrls?: string[];
  starred?: boolean;
  starredUrls?: string[];
  /** Snoozed PRs of a stack row that stays in the queue. They are dimmed and leave its unread state. */
  snoozedUrls?: string[];
  /** Why each of these PRs came back from a snooze, until it is read. */
  back?: Partial<Record<string, import('./snooze').SnoozeBack>>;
  subject: ReviewSubject;
  briefing?: Briefing;
  review?: ReviewHistoryEntry;
  attention: 'updated' | 'requested' | 'other';
  /**
   * The PRs that changed since your latest review of them (`updatedSinceReview`), with the commit that review was
   * on. Absent in older queues: then `attention: 'updated'` covers every PR of the entry.
   */
  sinceReview?: Record<string, { from: string | null }>;
  /**
   * The saved Gnosis review is for an older version of the subject, even when a newer GitHub review means nothing
   * changed since your review. Its explanation is not "ready".
   */
  reviewOutdated?: boolean;
  /** Content hash from `stampQueue`; equal revisions mean equal content. */
  revision?: string;
}
/** One content hash per queue field that renderers memoize on. */
export interface WorkbenchQueueParts {
  stacks: string;
  readStates: string;
  mutedPrs: string;
  snoozedPrs: string;
  starredPrs: string;
  savedViews: string;
  filters: string;
  sync: string;
}
/**
 * Main's GitHub sync state, as the Overview's freshness line reads it (lib/overview-freshness.ts).
 *
 * - `checkedAt`: when the last full discovery pass finished (`discoveredAt`).
 * - `progress`: the pass in progress: PRs read so far of the pass's total, once the total is known.
 * - `requested`: the reader asked for this pass (Refresh), so the page shows a spinner until its first results.
 * - `signals`: the change signals (notifications feed or changed-PR search) answered within their normal interval
 *   (lib/github-change-signals.ts, `healthy`). Absent where main does not run them.
 * - `reason`: why the status is `error`. `unreachable` when the pass failed; `incomplete` when it finished with
 *   warnings, such as a repository it could not read.
 */
export interface WorkbenchSync {
  status: 'idle' | 'checking' | 'paused' | 'error';
  checkedAt?: number;
  retryAt?: number;
  progress?: { done: number; total: number };
  requested?: boolean;
  signals?: boolean;
  reason?: 'unreachable' | 'incomplete';
}
export interface WorkbenchQueue {
  /** Content hash of the whole snapshot except saved reviews. */
  revision?: string;
  /** Content hash of the saved reviews that `listReviews` returns. */
  historyRevision?: string;
  parts?: WorkbenchQueueParts;
  briefingBudget?: import('./repository-settings').BriefingBudget;
  /** Locally retained hierarchy, including completed stacks outside the active queue. */
  stacks?: ReviewSubject[];
  readStates?: Partial<Record<string, import('./pr-read-state').PrReadState>>;
  sync?: WorkbenchSync;
  /** Frozen in the main process and shared between snapshots. */
  mutedPrs?: readonly import('./muted-prs').MutedPr[];
  /** Tools › Snoozed. Hidden from every queue section, saved view and count until they wake. */
  snoozedPrs?: readonly import('./snooze').SnoozedPr[];
  starredPrs?: import('./starred-prs').StarredPr[];
  starredItems?: QueueItem[];
  savedViews?: QueueViewsSnapshot;
  filters?: QueueFilters;
  items: QueueItem[];
  warnings: string[];
  remaining: number;
  /**
   * Saved PR status for the first rows, sent only with the first snapshot a window requests. The
   * renderer removes it before storing the queue, so it never changes revisions or identity.
   */
  savedSignals?: { account: string; values: import('./queue-signals').QueueSignals[] };
}
export interface GroupingOverride {
  parent: string;
  child: string;
  action: 'link' | 'unlink';
}

// Stable content identity; timestamps and CI do not invalidate generated text.
/** The member fields a saved review's fingerprint covers. */
const fingerprintFields = (m: ReviewMember) => [
  m.url,
  m.baseRepo,
  m.baseBranch,
  m.baseSha,
  m.headRepo,
  m.headBranch,
  m.headSha,
  m.title,
  m.description,
  m.state,
  m.merged,
];
export function fingerprint(subject: ReviewSubject): string {
  return JSON.stringify({
    members: subject.members.map(fingerprintFields),
    edges: subject.edges,
  });
}
const memberIds = new WeakMap<ReviewMember, number>();
let nextMemberId = 0;
/**
 * A short, process-local identity for a subject's members and edges. Only for callers whose members
 * are replaced rather than edited in place (the main-process queue state): there, equal identities
 * mean equal fingerprints, so derived values such as briefing keys can be reused.
 */
export function fingerprintIdentity(subject: ReviewSubject): string {
  const ids = subject.members.map((m) => {
    let id = memberIds.get(m);
    if (id === undefined) memberIds.set(m, (id = nextMemberId++));
    return id;
  });
  return `${ids.join(',')}|${JSON.stringify(subject.edges ?? null)}`;
}
export function snapshot(subject: ReviewSubject): ReviewSnapshot {
  return { version: 1, subject, fingerprint: fingerprint(subject), capturedAt: new Date().toISOString() };
}
/**
 * Groups PRs into stacks: a PR whose base branch is another PR's head branch is its child. Linear in the members and
 * edges: main regroups the whole queue after every discovery batch, and the earlier quadratic version took about
 * 350 ms on a queue of 3,000 PRs, every 12 to 30 seconds while discovery ran (#345).
 */
export function groupSubjects(
  members: ReviewMember[],
  overrides: GroupingOverride[] = [],
  previous: ReviewSubject[] = []
): ReviewSubject[] {
  const byUrl = new Map(members.map((m) => [m.url, m]));
  const edges: StackEdge[] = [];
  const warnings = new Map<string, string[]>();
  const warn = (url: string, text: string) => warnings.set(url, [...(warnings.get(url) ?? []), text]);
  // Every member by the branch it pushes, so a child finds its candidate parents without a scan.
  const branchKey = (repo: unknown, branch: unknown) => `${typeof repo}:${String(repo)}\u0000${typeof branch}:${String(branch)}`;
  const byHead = new Map<string, ReviewMember[]>();
  for (const member of members) {
    const key = branchKey(member.headRepo, member.headBranch);
    const list = byHead.get(key);
    if (list) list.push(member);
    else byHead.set(key, [member]);
  }
  for (const child of members) {
    const candidates = (byHead.get(branchKey(child.baseRepo, child.baseBranch)) ?? []).filter((p) => p.url !== child.url);
    if (candidates.length === 1) edges.push({ parent: candidates[0].url, child: child.url, evidence: 'branch' });
    else if (candidates.length > 1) warn(child.url, 'Multiple possible parents. Confirm the stack relationship.');
  }
  // Retain observed lineage when GitHub retargets a child after its parent merges.
  const children = new Set(edges.map((edge) => edge.child));
  for (const old of previous)
    for (const edge of old.edges) {
      const parent = byUrl.get(edge.parent);
      if (parent?.merged && byUrl.has(edge.child) && !children.has(edge.child)) {
        edges.push(edge);
        children.add(edge.child);
      }
    }
  for (const override of overrides) {
    for (let i = edges.length - 1; i >= 0; i--) {
      if (edges[i].child === override.child && (override.action === 'link' || edges[i].parent === override.parent))
        edges.splice(i, 1);
    }
    if (
      override.action === 'link' &&
      byUrl.has(override.parent) &&
      byUrl.has(override.child) &&
      override.parent !== override.child
    )
      edges.push({ parent: override.parent, child: override.child, evidence: 'manual' });
  }
  // Connected components over the edges, in both directions. Every edge joins two members.
  const parents = new Map<string, string>(members.map((m) => [m.url, m.url]));
  const root = (url: string): string => {
    let top = url;
    for (let next = parents.get(top) ?? top; next !== top; next = parents.get(top) ?? top) top = next;
    for (let at = url; at !== top; ) {
      const next = parents.get(at) ?? top;
      parents.set(at, top);
      at = next;
    }
    return top;
  };
  for (const edge of edges) {
    const a = root(edge.parent), b = root(edge.child);
    if (a !== b) parents.set(b, a);
  }
  const group = <T>(map: Map<string, T[]>, key: string, value: T) => {
    const list = map.get(key);
    if (list) list.push(value);
    else map.set(key, [value]);
  };
  // Each component's edges in edge order, and its members.
  const componentEdges = new Map<string, StackEdge[]>();
  for (const edge of edges) group(componentEdges, root(edge.child), edge);
  const componentUrls = new Map<string, string[]>();
  for (const url of byUrl.keys()) group(componentUrls, root(url), url);
  // Earlier stacks by member, in their saved order, so a group keeps its identity and name.
  const stacksByUrl = new Map<string, number[]>();
  for (const [index, subject] of previous.entries())
    if (subject.kind === 'stack') for (const m of subject.members) group(stacksByUrl, m.url, index);
  const result: ReviewSubject[] = [];
  const ids = new Set<string>();
  const add = (subject: ReviewSubject) => {
    result.push(subject);
    ids.add(subject.id);
  };
  const seen = new Set<string>();
  for (const member of members) {
    if (seen.has(member.url)) continue;
    const key = root(member.url);
    const component = new Set(componentUrls.get(key) ?? [member.url]);
    const relevant = componentEdges.get(key) ?? [];
    // By dependency, one level at a time, each level sorted by URL.
    const ordered: ReviewMember[] = [];
    const pending = new Set(component);
    const waiting = new Map<string, number>();
    const dependents = new Map<string, string[]>();
    for (const edge of relevant) {
      waiting.set(edge.child, (waiting.get(edge.child) ?? 0) + 1);
      group(dependents, edge.parent, edge.child);
    }
    while (pending.size) {
      const ready = [...pending].filter((url) => !waiting.get(url)).sort();
      if (!ready.length) break;
      for (const url of ready) {
        const item = byUrl.get(url);
        if (item) ordered.push(item);
        pending.delete(url);
      }
      for (const url of ready)
        for (const child of dependents.get(url) ?? []) waiting.set(child, (waiting.get(child) ?? 0) - 1);
    }
    if (pending.size) {
      // A cycle: each member stands alone, in the order a walk from this member reaches it.
      for (const url of reachOrder(member.url, relevant)) {
        const m = byUrl.get(url);
        if (!m) continue;
        add({
          id: m.url,
          kind: 'pr',
          title: m.title,
          members: [m],
          edges: [],
          warnings: ['Conflicting stack dependencies. Correct the grouping before reviewing together.'],
        });
        seen.add(url);
      }
      continue;
    }
    // The earlier stack that shares the most members, the first saved on a tie, unless a group already took its id.
    let old: ReviewSubject | undefined;
    let shared = 0;
    const indexes = [...new Set([...component].flatMap((url) => stacksByUrl.get(url) ?? []))].sort((a, b) => a - b);
    for (const index of indexes) {
      const candidate = previous[index];
      if (ids.has(candidate.id)) continue;
      const count = candidate.members.filter((m) => component.has(m.url)).length;
      if (count > shared) {
        shared = count;
        old = candidate;
      }
    }
    const stack = ordered.length > 1 || !!old && old.members.filter(m => byUrl.has(m.url)).length === 1;
    const id = stack ? (old?.id ?? `stack:${ordered[0].url}`) : ordered[0].url;
    // A split group cannot retain the same identity as another resulting group.
    const uniqueId = ids.has(id) ? `stack:${ordered[0].url}` : id;
    add({
      id: uniqueId,
      kind: stack ? 'stack' : 'pr',
      title: stack && old?.name ? old.name : ordered[0].title,
      ...(stack && old?.name ? { name: old.name } : {}),
      members: ordered,
      edges: relevant,
      warnings: ordered.flatMap((m) => warnings.get(m.url) ?? []),
    });
    for (const url of component) seen.add(url);
  }
  return result;
}
/** The members a walk over `edges` from `start` reaches, in the order it reaches them, pass after pass. */
function reachOrder(start: string, edges: readonly StackEdge[]): Set<string> {
  const component = new Set([start]);
  for (let changed = true; changed; ) {
    changed = false;
    for (const edge of edges)
      if (component.has(edge.parent) || component.has(edge.child)) {
        for (const url of [edge.parent, edge.child])
          if (!component.has(url)) {
            component.add(url);
            changed = true;
          }
      }
  }
  return component;
}
export function subjectForReview(review: ReviewGuide): string {
  return review.snapshot?.subject.id ?? review.prUrl;
}
/** Your latest review of one PR on GitHub: when you submitted it and the commit it was on (null when unknown). */
export interface GitHubOwnReview {
  submittedAt: string;
  headSha: string | null;
  /** When the PR's current head was committed, if known. Decides a review whose commit is unknown. */
  headCommittedAt?: string;
}
/**
 * The PRs of a subject that changed since your latest review of them, each with the commit that review was on (null
 * when unknown). Your latest review of a PR is the newer of the saved Gnosis review (its snapshot) and your latest
 * review on GitHub (`github`; approval, request for changes or comment).
 *
 * - The GitHub review is newer: the PR changed only when its head moved past the reviewed commit. A review at the
 *   current head, or one with an unknown commit submitted after the head was committed, is current.
 * - Otherwise the saved review decides, as before: like its fingerprint, it covers the whole subject. Every PR it
 *   decides changed when a stack's members or edges changed, or a PR changed that no current GitHub review covers.
 *   With no GitHub review newer than the snapshot, this is exactly "the fingerprint differs".
 */
export function updatedSinceReview(
  subject: ReviewSubject,
  review?: Pick<ReviewHistoryEntry, 'snapshot'>,
  github?: (member: ReviewMember) => GitHubOwnReview | undefined
): Record<string, { from: string | null }> {
  const snapshot = review?.snapshot;
  const capturedAt = snapshot ? Date.parse(snapshot.capturedAt) : NaN;
  const before = new Map(snapshot?.subject.members.map((m) => [m.url, m]) ?? []);
  const result: Record<string, { from: string | null }> = {};
  const fromSnapshot: ReviewMember[] = [];
  let changed = false;
  for (const member of subject.members) {
    const mine = github?.(member);
    const at = mine ? Date.parse(mine.submittedAt) : NaN;
    if (mine && Number.isFinite(at) && !(at <= capturedAt)) {
      const current = mine.headSha
        ? mine.headSha === member.headSha
        : !!mine.headCommittedAt && at >= Date.parse(mine.headCommittedAt);
      if (!current) {
        result[member.url] = { from: mine.headSha };
        changed = true;
      }
      continue;
    }
    if (!snapshot) continue;
    fromSnapshot.push(member);
    const old = before.get(member.url);
    if (!old || JSON.stringify(fingerprintFields(old)) !== JSON.stringify(fingerprintFields(member))) changed = true;
  }
  if (!snapshot || !fromSnapshot.length) return result;
  const reshaped =
    JSON.stringify(snapshot.subject.edges) !== JSON.stringify(subject.edges) ||
    snapshot.subject.members.map((m) => m.url).join('\n') !== subject.members.map((m) => m.url).join('\n');
  // Only the saved review decides: exactly its fingerprint.
  const outdated = fromSnapshot.length === subject.members.length ? snapshot.fingerprint !== fingerprint(subject) : changed || reshaped;
  if (outdated) for (const member of fromSnapshot) result[member.url] = { from: before.get(member.url)?.headSha ?? null };
  return result;
}
/**
 * `updated` when a PR changed since your latest review (`updatedSinceReview`; pass it as `updated` when already
 * known). Without `github`, only the saved Gnosis review counts.
 */
export function attentionFor(
  subject: ReviewSubject,
  review?: ReviewHistoryEntry,
  updated: Record<string, unknown> = updatedSinceReview(subject, review)
): QueueItem['attention'] {
  if (Object.keys(updated).length) return 'updated';
  if (subject.members.some((m) => m.role === 'review-requested' && !m.merged && m.state === 'open')) return 'requested';
  return 'other';
}
export function memberPrefix(member: ReviewMember): string {
  return `PR-${member.repo.replace(/\//g, '~')}-${member.number}/`;
}
export function sourceForPath(review: ReviewGuide, filePath: string): { member?: ReviewMember; path: string } {
  const members = review.snapshot?.subject.members ?? [];
  if (members.length < 2) return { member: members[0], path: filePath };
  const member = members.find((m) => filePath.startsWith(memberPrefix(m)));
  return { member, path: member ? filePath.slice(memberPrefix(member).length) : filePath };
}
export function coverageKey(review: ReviewGuide, slide: Slide): string {
  const members = review.snapshot?.subject.members ?? [];
  const involved = new Set(slide.diffHunks.map((h) => sourceForPath(review, h.filePath).member?.url).filter(Boolean));
  const direct = new Set(involved);
  // Include ancestors: unchanged child code can have changed meaning after a parent edit.
  for (let changed = true; changed; ) {
    changed = false;
    for (const edge of review.snapshot?.subject.edges ?? [])
      if (involved.has(edge.child) && !involved.has(edge.parent)) {
        involved.add(edge.parent);
        changed = true;
      }
  }
  return JSON.stringify([
    slide.diffHunks.map((h) => [h.filePath, h.hunkHeader, h.content]),
    slide.diffHunks.length ? null : slide.narrative,
    members
      .filter((m) => involved.has(m.url))
      .map((m) => [m.url, m.baseSha, direct.has(m.url) ? null : m.headSha, m.description]),
    (review.snapshot?.subject.edges ?? []).filter((e) => involved.has(e.child) && involved.has(e.parent)),
  ]);
}

/** One effective model selection for briefing generation and its visible label. */
export function briefingModel(
  p: Pick<Preferences, 'provider' | 'model'> &
    Partial<
      Pick<Preferences, 'proactiveReviewOverrides' | 'proactiveProvider' | 'proactiveModel' | 'proactiveThinking' | 'proactiveEffort' | 'effort'>
    >
) {
  return p.proactiveReviewOverrides
    ? {
        provider: p.proactiveProvider ?? p.provider,
        model: p.proactiveModel ?? p.model,
        thinking: p.proactiveThinking ?? false,
        effort: normalizeEffort(p.proactiveProvider ?? p.provider, p.proactiveModel ?? p.model, p.proactiveEffort, p.proactiveThinking ?? false),
      }
    : { provider: p.provider, model: p.model, thinking: false, effort: normalizeEffort(p.provider, p.model, p.proactiveEffort, false) };
}

/** Match GitHub bot identities, never PR titles or dependency-related labels. */
export function isDependabot(author: string): boolean {
  return /^(?:dependabot|dependabot-preview)(?:\[bot\])?$/i.test(author);
}
