import type { PrMetadata } from './types';
import type { QueueSignals } from './queue-signals';
import type { PrChecks } from './pr-checks';
import type { GitHubReviewThreads } from './review-threads';
export type GitHubSyncKind = 'metadata' | 'signals' | 'checks' | 'discussion';
export interface GitHubSyncTarget {
  url: string;
  headSha?: string;
}
export interface GitHubSyncInterest {
  kind: GitHubSyncKind;
  targets: GitHubSyncTarget[];
  priority: 'active' | 'visible';
}
export type GitHubSyncUpdate =
  | { kind: 'metadata'; url: string; value: PrMetadata }
  | { kind: 'signals'; url: string; value: QueueSignals }
  | { kind: 'checks'; url: string; value: PrChecks }
  | { kind: 'discussion'; url: string; value: GitHubReviewThreads };
export interface GitHubSyncFailure {
  kind: GitHubSyncKind;
  url: string;
  message: string;
  retryAt: number;
}
export interface GitHubSyncEvent {
  account: string;
  subscriptionId: string;
  reset?: boolean;
  updates: GitHubSyncUpdate[];
  failures?: GitHubSyncFailure[];
}

/** Validate the renderer's untrusted subscription before it can schedule API work. */
export function parseGitHubSyncInterest(value: unknown): GitHubSyncInterest | null | undefined {
  if (value === null) return null;
  if (!value || typeof value !== 'object') return;
  const input = value as Record<string, unknown>;
  if (
    !['metadata', 'signals', 'checks', 'discussion'].includes(String(input.kind)) ||
    !['active', 'visible'].includes(String(input.priority)) ||
    !Array.isArray(input.targets) ||
    input.targets.length > 200
  )
    return;
  const targets: GitHubSyncTarget[] = [];
  for (const value of input.targets as unknown[]) {
    if (!value || typeof value !== 'object') return;
    const target = value as Record<string, unknown>;
    if (
      typeof target.url !== 'string' ||
      !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/[1-9]\d*$/.test(target.url) ||
      (target.headSha !== undefined && (typeof target.headSha !== 'string' || !/^[a-f\d]{40}$/i.test(target.headSha)))
    )
      return;
    targets.push({ url: target.url, ...(typeof target.headSha === 'string' ? { headSha: target.headSha } : {}) });
  }
  return { kind: input.kind as GitHubSyncKind, priority: input.priority as 'active' | 'visible', targets };
}
