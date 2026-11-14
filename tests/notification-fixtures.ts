import type { ReviewMember } from '../lib/workbench';
import type { QueueSignals } from '../lib/queue-signals';

export const LOGIN = 'oddur';
export const T0 = Date.parse('2026-11-14T10:00:00Z');

export function member(n = 1, overrides: Partial<ReviewMember> = {}): ReviewMember {
  return {
    url: `https://github.com/o/r/pull/${n}`,
    number: n,
    repo: 'o/r',
    baseRepo: 'o/r',
    headRepo: 'o/r',
    role: 'watched',
    title: `PR ${n}`,
    description: '',
    author: 'alice',
    baseBranch: 'main',
    headBranch: `feature-${n}`,
    baseSha: 'base',
    headSha: `head-${n}`,
    merged: false,
    state: 'open',
    createdAt: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-14T09:00:00Z',
    labels: [],
    isDraft: false,
    mergeable: null,
    commitCount: 1,
    requestedReviewers: [],
    requestedTeams: [],
    mergeableState: null,
    autoMerge: null,
    milestone: null,
    ...overrides,
  };
}
export const mine = (n = 1, overrides: Partial<ReviewMember> = {}) => member(n, { author: LOGIN, role: 'author', ...overrides });

export function signals(
  pr: Pick<ReviewMember, 'url' | 'headSha' | 'baseBranch' | 'baseSha'>,
  options: {
    checks?: QueueSignals['checks']['state'];
    review?: { id: string; author: string; state: string } | null;
    decision?: string | null;
    mergeState?: string;
    mergeable?: string;
    checkedAt?: number;
  } = {}
): QueueSignals {
  const review = options.review;
  return {
    url: pr.url,
    headSha: pr.headSha,
    checkedAt: options.checkedAt ?? T0,
    comments: 0,
    latestReview: review
      ? { url: `${pr.url}#pullrequestreview-${review.id}`, author: review.author, state: review.state, submittedAt: '2026-11-14T09:59:00Z', headSha: pr.headSha }
      : null,
    activity: {},
    checks: { state: options.checks ?? 'pending', passed: 0, total: 1 },
    readiness: {
      state: 'OPEN',
      isDraft: false,
      mergeable: options.mergeable ?? 'MERGEABLE',
      mergeState: options.mergeState ?? 'BLOCKED',
      reviewDecision: options.decision === undefined ? 'REVIEW_REQUIRED' : options.decision,
      baseBranch: pr.baseBranch,
      baseSha: pr.baseSha,
      behindBy: 0,
      mergeQueue: false,
      queueState: null,
    },
  };
}
/** Signals for a PR GitHub reports as ready to merge. */
export const readySignals = (pr: Parameters<typeof signals>[0], checkedAt = T0) =>
  signals(pr, { checks: 'success', decision: 'APPROVED', mergeState: 'CLEAN', checkedAt });
