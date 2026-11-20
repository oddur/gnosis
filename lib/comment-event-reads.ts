import type { CommentCandidate } from './notification-comments';

/**
 * Reads the discussions behind mention and reply candidates and delivers each one that was read. The notifications
 * cursor has already moved past these candidates, so a candidate that hit a rate limit is never dropped: it waits
 * until the limit lifts and is read again. Other failures are logged and dropped, as before.
 */
export function createCommentEventReader<D>(deps: {
  read: (urls: string[]) => Promise<PromiseSettledResult<D>[]>;
  deliver: (candidate: CommentCandidate, discussion: D) => void;
  /** With no error: when GitHub reads resume, if they are paused now. With an error: when it lifts, if it is a rate limit. */
  retryAt: (error?: unknown) => number | undefined;
  schedule: (run: () => void, delay: number) => void;
  warn?: (message: string, error: unknown) => void;
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  const waiting = new Map<string, CommentCandidate>();
  let scheduled = false;
  function defer(candidates: CommentCandidate[], at: number) {
    for (const candidate of candidates) {
      const key = `${candidate.url}\n${candidate.reason}`;
      const previous = waiting.get(key);
      // The earlier cursor covers every comment the later one does.
      waiting.set(key, previous && previous.since <= candidate.since ? previous : candidate);
    }
    if (scheduled) return;
    scheduled = true;
    deps.schedule(
      () => {
        scheduled = false;
        const retry = [...waiting.values()];
        waiting.clear();
        void run(retry);
      },
      Math.max(1_000, at - now())
    );
  }
  async function run(candidates: CommentCandidate[]): Promise<void> {
    if (!candidates.length) return;
    const paused = deps.retryAt();
    if (paused !== undefined && paused > now()) {
      defer(candidates, paused);
      return;
    }
    let results: PromiseSettledResult<D>[];
    try {
      results = await deps.read(candidates.map((candidate) => candidate.url));
    } catch (error) {
      const at = deps.retryAt(error);
      if (at !== undefined) defer(candidates, at);
      else deps.warn?.('Could not read discussions for mentions or replies:', error);
      return;
    }
    const retry: CommentCandidate[] = [];
    let at = 0;
    for (const [i, candidate] of candidates.entries()) {
      const result = results[i];
      if (result.status === 'fulfilled') {
        deps.deliver(candidate, result.value);
        continue;
      }
      const limited = deps.retryAt(result.reason);
      if (limited === undefined) deps.warn?.('Could not read the discussion for a mention or reply:', result.reason);
      else {
        retry.push(candidate);
        at = Math.max(at, limited);
      }
    }
    if (retry.length) defer(retry, at);
  }
  return run;
}
