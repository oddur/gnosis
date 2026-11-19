/**
 * The tree-sitter worker's queue of parses (#393), nearest the reader first. Parses run one at a time; the next is
 * - a file on screen (`view`), the newest request first: the file the reader is looking at now;
 * - then a file near the view (`near`), newest first;
 * - then a prefetched file (`prefetch`), in the order prefetch read them, which is diff order.
 * Within a tier the after side goes first: it names the hunks, while the old side only adds removed symbols to the
 * outline and names hunks that only delete. A request for a parse already waiting raises it to the request's tier.
 */
export type SyntaxPriority = 'view' | 'near' | 'prefetch';
const RANK: Record<SyntaxPriority, number> = { view: 0, near: 1, prefetch: 2 };
export const priorityRank = (priority: SyntaxPriority) => RANK[priority];
/** The higher of two priorities. */
export const higherPriority = (a: SyntaxPriority, b: SyntaxPriority): SyntaxPriority => (RANK[a] <= RANK[b] ? a : b);

export interface ParseJob {
  key: string;
  priority: SyntaxPriority;
  side: 'after' | 'before';
}

export function createParseQueue<T extends ParseJob>() {
  const jobs = new Map<string, { job: T; seq: number }>();
  let seq = 0;
  /** Lower comes first: tier, then side, then order within the tier. */
  const order = ({ job, seq: at }: { job: T; seq: number }): [number, number, number] => [
    RANK[job.priority],
    job.side === 'after' ? 0 : 1,
    job.priority === 'prefetch' ? at : -at,
  ];
  return {
    add(job: T) {
      jobs.set(job.key, { job, seq: ++seq });
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
