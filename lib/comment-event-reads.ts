import { COMMENT_READS_PER_POLL, type CommentCandidate } from './notification-comments';

/**
 * Reads the discussions behind mention and reply candidates and delivers each one that was read. The notifications
 * cursor has already moved past these candidates, so a candidate that hit a rate limit is never dropped: it waits
 * until the limit lifts and is read again, at most `COMMENT_READS_PER_POLL` per retry. Other failures are logged and
 * dropped, as before. Everything belongs to the account that queued it: after a sign-out or an account switch,
 * nothing is delivered and nothing waiting is read.
 */
/** The gap between capped retry turns: about one notifications poll. */
export const RETRY_TURN_MS = 60_000;

export function createCommentEventReader<D>(deps: {
  read: (urls: string[]) => Promise<PromiseSettledResult<D>[]>;
  deliver: (candidate: CommentCandidate, discussion: D) => void;
  /** With no error: when GitHub reads resume, if they are paused now. With an error: when it lifts, if it is a rate limit. */
  retryAt: (error?: unknown) => number | undefined;
  /** The signed-in account (token and login), or undefined when signed out. */
  account: () => string | undefined;
  schedule: (run: () => void, delay: number) => void;
  warn?: (message: string, error: unknown) => void;
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  const warn = (message: string, error: unknown) => deps.warn?.(message, error);
  const waiting = new Map<string, CommentCandidate>();
  let owner: string | undefined;
  let scheduled = false;
  function defer(account: string, candidates: CommentCandidate[], at: number) {
    if (owner !== account) waiting.clear();
    owner = account;
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
        if (deps.account() !== owner) {
          waiting.clear();
          return;
        }
        // At most one poll's worth of reads at once; the rest wait a poll interval for their turn.
        const retry = [...waiting.values()].slice(0, COMMENT_READS_PER_POLL);
        for (const candidate of retry) waiting.delete(`${candidate.url}\n${candidate.reason}`);
        if (waiting.size && owner) defer(owner, [], now() + RETRY_TURN_MS);
        run(retry).catch((error: unknown) => warn('Could not read discussions for mentions or replies:', error));
      },
      Math.max(1_000, at - now())
    );
  }
  async function run(candidates: CommentCandidate[]): Promise<void> {
    const account = deps.account();
    if (!candidates.length || !account) return;
    const paused = deps.retryAt();
    if (paused !== undefined && paused > now()) {
      defer(account, candidates, paused);
      return;
    }
    let results: PromiseSettledResult<D>[];
    try {
      results = await deps.read(candidates.map((candidate) => candidate.url));
    } catch (error) {
      const at = deps.retryAt(error);
      if (at !== undefined && deps.account() === account) defer(account, candidates, at);
      else warn('Could not read discussions for mentions or replies:', error);
      return;
    }
    // Read for another account: none of it is delivered or retried.
    if (deps.account() !== account) return;
    const retry: CommentCandidate[] = [];
    let at = 0;
    for (const [i, candidate] of candidates.entries()) {
      const result = results[i];
      if (result.status === 'fulfilled') {
        try {
          deps.deliver(candidate, result.value);
        } catch (error) {
          warn('Could not deliver a mention or reply:', error);
        }
        continue;
      }
      const limited = deps.retryAt(result.reason);
      if (limited === undefined) warn('Could not read the discussion for a mention or reply:', result.reason);
      else {
        retry.push(candidate);
        at = Math.max(at, limited);
      }
    }
    if (retry.length) defer(account, retry, at);
  }
  return run;
}
