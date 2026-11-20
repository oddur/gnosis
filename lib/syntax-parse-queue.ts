/**
 * The tree-sitter worker's queue of parses (#393), nearest the reader first. Parses run one at a time; the next is
 * - a file on screen (`view`), the newest request first: the file the reader is looking at now;
 * - then a file near the view (`near`), newest first;
 * - then a prefetched file (`prefetch`), in the order prefetch read them, which is diff order.
 * Within a tier the after side goes first: it names the hunks, while the old side only adds removed symbols to the
 * outline and names hunks that only delete. A request for a parse already waiting raises it to the request's tier.
 *
 * A file's formatting and comment comparison (`noise`, lib/semantic-noise.ts) parses both sides again, and only hides
 * noise: it waits one tier lower than its file, so a file on screen compares after the breadcrumbs of files near the
 * view, and after the old sides of its own tier.
 *
 * A file's moved-symbol fingerprints (`symbols`, lib/moved-symbols.ts) parse both sides once more and only add labels:
 * they wait two tiers lower, behind every breadcrumb and comparison of the files around the view.
 */
export type SyntaxPriority = 'view' | 'near' | 'prefetch';
const RANK: Record<SyntaxPriority, number> = { view: 0, near: 1, prefetch: 2 };
export const priorityRank = (priority: SyntaxPriority) => RANK[priority];
/** The higher of two priorities. */
export const higherPriority = (a: SyntaxPriority, b: SyntaxPriority): SyntaxPriority => (RANK[a] <= RANK[b] ? a : b);

export interface ParseJob {
  key: string;
  priority: SyntaxPriority;
  side: 'after' | 'before' | 'noise' | 'symbols';
}
const SIDE_RANK = { after: 0, before: 1, noise: 2, symbols: 3 } as const;
/** Tiers a side waits below its file's own: noise one, moved symbols two (they only add labels). */
const SIDE_DROP = { after: 0, before: 0, noise: 1, symbols: 2 } as const;

export function createParseQueue<T extends ParseJob>() {
  const jobs = new Map<string, { job: T; seq: number }>();
  let seq = 0;
  /** Lower comes first: tier, then side, then order within the tier. */
  const order = ({ job, seq: at }: { job: T; seq: number }): [number, number, number] => [
    RANK[job.priority] + SIDE_DROP[job.side],
    SIDE_RANK[job.side],
    job.priority === 'prefetch' ? at : -at,
  ];
  return {
    /** Queues a parse; a waiting one with the same key leaves, and is returned so its caller can be answered. */
    add(job: T): T | undefined {
      const replaced = jobs.get(job.key)?.job;
      jobs.set(job.key, { job, seq: ++seq });
      return replaced;
    },
    /** Raises a waiting parse to `priority`; one already at or above it keeps its place. */
    raise(key: string, priority: SyntaxPriority): boolean {
      const entry = jobs.get(key);
      if (!entry || RANK[priority] >= RANK[entry.job.priority]) return false;
      entry.job.priority = priority;
      entry.seq = ++seq;
      return true;
    },
    take(): T | undefined {
      let best: { job: T; seq: number } | undefined, bestOrder: [number, number, number] | undefined;
      for (const entry of jobs.values()) {
        const o = order(entry);
        if (!bestOrder || o[0] < bestOrder[0] || (o[0] === bestOrder[0] && (o[1] < bestOrder[1] || (o[1] === bestOrder[1] && o[2] < bestOrder[2])))) {
          best = entry;
          bestOrder = o;
        }
      }
      if (!best) return undefined;
      jobs.delete(best.job.key);
      return best.job;
    },
    /** Removes the waiting parses `drop` picks, and returns them. */
    remove(drop: (job: T) => boolean): T[] {
      const removed: T[] = [];
      for (const [key, { job }] of jobs)
        if (drop(job)) {
          jobs.delete(key);
          removed.push(job);
        }
      return removed;
    },
    get size() {
      return jobs.size;
    },
  };
}
