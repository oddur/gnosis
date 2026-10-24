export interface QueueSignalRequest {
  url: string;
  headSha: string;
}
export interface QueueSignalOptions {
  active?: boolean;
  force?: boolean;
  cachedOnly?: boolean;
}
export interface QueueSignals extends QueueSignalRequest {
  checkedAt: number;
  comments: number;
  checks: { state: 'success' | 'failure' | 'pending' | 'neutral'; passed: number; skipped?: number; total: number };
  readiness?: {
    state: string;
    isDraft: boolean;
    mergeable: string;
    mergeState: string;
    reviewDecision: string | null;
    baseBranch: string;
    baseSha: string;
    behindBy: number | null;
    mergeQueue: boolean;
    queueState: string | null;
  };
}
export const QUEUE_SIGNALS_TTL = 2 * 60_000;
export const ACTIVE_SIGNALS_TTL = 25_000;
export const queueSignalKey = (request: QueueSignalRequest) => `${request.url}@${request.headSha}`;
