export interface QueueSignalRequest {
  url: string;
  headSha: string;
}
export interface QueueSignals extends QueueSignalRequest {
  checkedAt: number;
  comments: number;
  checks: { state: 'success' | 'failure' | 'pending' | 'neutral'; passed: number; total: number };
}
export const QUEUE_SIGNALS_TTL = 5 * 60_000;
export const queueSignalKey = (request: QueueSignalRequest) => `${request.url}@${request.headSha}`;
