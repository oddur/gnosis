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
  pauseReason?: 'filter';
  pauseDetail?: string;
  updatedAt: string;
}
export interface QueueItem {
  /** Navigation context only. The subject is always the scope being reviewed. */
  parentStack?: ReviewSubject;
  unreadUrls?: string[];
  starred?: boolean;
  starredUrls?: string[];
  subject: ReviewSubject;
  briefing?: Briefing;
  review?: ReviewHistoryEntry;
  attention: 'updated' | 'requested' | 'other';
}
export interface WorkbenchQueue {
  briefingBudget?: import('./repository-settings').BriefingBudget;
  /** Locally retained hierarchy, including completed stacks outside the active queue. */
  stacks?: ReviewSubject[];
  readStates?: Partial<Record<string, import('./pr-read-state').PrReadState>>;
  sync?: { status: 'idle' | 'checking' | 'paused' | 'error'; checkedAt?: number; retryAt?: number };
  mutedPrs?: import('./muted-prs').MutedPr[];
  starredPrs?: import('./starred-prs').StarredPr[];
  starredItems?: QueueItem[];
  savedViews?: QueueViewsSnapshot;
  filters?: QueueFilters;
  items: QueueItem[];
  warnings: string[];
  remaining: number;
}
export interface GroupingOverride {
  parent: string;
  child: string;
  action: 'link' | 'unlink';
}

// Stable content identity; timestamps and CI do not invalidate generated text.
export function fingerprint(subject: ReviewSubject): string {
  return JSON.stringify({
    members: subject.members.map((m) => [
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
    ]),
    edges: subject.edges,
  });
}
export function snapshot(subject: ReviewSubject): ReviewSnapshot {
  return { version: 1, subject, fingerprint: fingerprint(subject), capturedAt: new Date().toISOString() };
}
export function groupSubjects(
  members: ReviewMember[],
  overrides: GroupingOverride[] = [],
  previous: ReviewSubject[] = []
): ReviewSubject[] {
  const byUrl = new Map(members.map((m) => [m.url, m]));
  const edges: StackEdge[] = [];
  const warnings = new Map<string, string[]>();
  const warn = (url: string, text: string) => warnings.set(url, [...(warnings.get(url) ?? []), text]);
  for (const child of members) {
    const candidates = members.filter(
      (p) => p.url !== child.url && p.headRepo === child.baseRepo && p.headBranch === child.baseBranch
    );
    if (candidates.length === 1) edges.push({ parent: candidates[0].url, child: child.url, evidence: 'branch' });
    else if (candidates.length > 1) warn(child.url, 'Multiple possible parents. Confirm the stack relationship.');
  }
  // Retain observed lineage when GitHub retargets a child after its parent merges.
  for (const old of previous)
    for (const edge of old.edges) {
      const parent = byUrl.get(edge.parent);
      if (parent?.merged && byUrl.has(edge.child) && !edges.some((e) => e.child === edge.child)) edges.push(edge);
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
  const result: ReviewSubject[] = [];
  const seen = new Set<string>();
  for (const member of members) {
    if (seen.has(member.url)) continue;
    const component = new Set([member.url]);
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
    const relevant = edges.filter((e) => component.has(e.parent) && component.has(e.child));
    const ordered: ReviewMember[] = [];
    const pending = new Set(component);
    while (pending.size) {
      const ready = [...pending]
        .filter((url) => !relevant.some((e) => e.child === url && pending.has(e.parent)))
        .sort();
      if (!ready.length) break;
      for (const url of ready) {
        const item = byUrl.get(url);
        if (item) ordered.push(item);
        pending.delete(url);
      }
    }
    if (pending.size) {
      for (const url of component) {
        const m = byUrl.get(url);
        if (!m) continue;
        result.push({
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
    const old = previous
      .filter((p) => p.kind === 'stack' && !result.some(s => s.id === p.id) && p.members.some((m) => component.has(m.url)))
      .sort(
        (a, b) =>
          b.members.filter((m) => component.has(m.url)).length - a.members.filter((m) => component.has(m.url)).length
      )
      .at(0);
    const stack = ordered.length > 1 || !!old && old.members.filter(m => byUrl.has(m.url)).length === 1;
    const id = stack ? (old?.id ?? `stack:${ordered[0].url}`) : ordered[0].url;
    // A split group cannot retain the same identity as another resulting group.
    const uniqueId = result.some((s) => s.id === id) ? `stack:${ordered[0].url}` : id;
    result.push({
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
export function subjectForReview(review: ReviewGuide): string {
  return review.snapshot?.subject.id ?? review.prUrl;
}
export function attentionFor(subject: ReviewSubject, review?: ReviewHistoryEntry): QueueItem['attention'] {
  if (review?.snapshot && review.snapshot.fingerprint !== fingerprint(subject)) return 'updated';
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
