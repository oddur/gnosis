import { createByteCache } from './byte-cache';
import { RENDERER_EXPLANATION_BYTES, RENDERER_EXPLANATION_ENTRIES } from './inspection-limits';
import type { ReviewGuide, ReviewHistoryEntry } from './types';
import type { QueueItem, ReviewSubject } from './workbench';
import type { SearchDestination } from './command-search';
export interface ExplanationDestination {
  review: ReviewGuide;
  command: { destination: Extract<SearchDestination, { kind: 'review' }>; nonce: number };
}
// Saved PRs remain navigable without a live queue entry or a network request.
export function explanationSubject(review: ReviewGuide): ReviewSubject {
  if (review.snapshot) return review.snapshot.subject;
  const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(review.prUrl);
  const repo = match?.[1] ?? '';
  return {
    id: review.prUrl,
    kind: 'pr',
    title: review.prTitle,
    edges: [],
    warnings: ['Showing PR information saved with this explanation.'],
    members: [
      {
        url: review.prUrl,
        number: Number(match?.[2]),
        repo,
        baseRepo: review.baseRepo ?? repo,
        headRepo: review.headRepo ?? repo,
        role: 'watched',
        title: review.prTitle,
        description: review.prDescription,
        author: review.author,
        baseSha: review.baseSha ?? '',
        headSha: review.headSha ?? '',
        baseBranch: '',
        headBranch: '',
        state: 'open',
        merged: false,
        isDraft: false,
        createdAt: '',
        updatedAt: '',
        labels: [],
        mergeable: null,
        commitCount: 0,
        requestedReviewers: [],
        requestedTeams: [],
        mergeableState: null,
        autoMerge: null,
        milestone: null,
      },
    ],
  };
}
export function explanationItem(review: ReviewGuide): QueueItem {
  return { subject: explanationSubject(review), attention: 'other' };
}
export function matchesExplanation(entry: ReviewHistoryEntry, subject: ReviewSubject) {
  return entry.snapshot
    ? entry.snapshot.subject.id === subject.id
    : subject.kind === 'pr' && entry.prUrl === subject.members[0].url;
}
/**
 * Loaded explanations, least recently used first, bounded by bytes as well as count (#355): predictions load the
 * neighbours' explanations as the reader steps through the queue, and one explanation can take megabytes. Views hold
 * their own copy (components/PrExplanation.tsx, components/PrSummary.tsx), so one dropped here stays on screen.
 */
const loaded = createByteCache<string, ReviewGuide>(RENDERER_EXPLANATION_BYTES, RENDERER_EXPLANATION_ENTRIES, Date.now, {
  keepNewest: true,
});
const pending = new Map<string, Promise<ReviewGuide>>();
export function rememberExplanation(review: ReviewGuide) {
  if (!review.reviewId) return;
  loaded.set(review.reviewId, review);
}
export const peekExplanation = (id?: string) => (id ? loaded.get(id) : undefined);
/** Explanations held and their estimated size, for the diagnostics export (#355). */
export const explanationCacheStats = () => ({ entries: loaded.size, bytes: loaded.bytes });
export function loadExplanation(id: string): Promise<ReviewGuide> {
  const cached = loaded.get(id);
  if (cached) return Promise.resolve(cached);
  const existing = pending.get(id);
  if (existing) return existing;
  const request = window.electronAPI
    .loadReview(id)
    .then((review) => {
      rememberExplanation(review);
      return review;
    })
    .finally(() => pending.delete(id));
  pending.set(id, request);
  return request;
}
