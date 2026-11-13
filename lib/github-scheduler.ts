import { AsyncLocalStorage } from 'node:async_hooks';
import { createSharedRead } from './shared-read';

export type GitHubPriority = 'interactive' | 'foreground' | 'background';
const rank: Record<GitHubPriority, number> = { interactive: 2, foreground: 1, background: 0 };
interface PriorityScope {
  priority: GitHubPriority;
  automatic?: boolean;
  /**
   * A navigation prediction, labelled by destination kind such as `pr-tab:changes`. Charged to the predicted
   * budget, not paced. `null` means a user joined the work: the rest is charged to the user.
   */
  predicted?: string | null;
  parent?: PriorityScope;
}
const context = new AsyncLocalStorage<PriorityScope>();
const readContext = new AsyncLocalStorage<AbortSignal>();
export const githubReadSignal = () => readContext.getStore();
export function createSharedGitHubRead<T>(run: () => Promise<T>) {
  let work: GitHubWork<T>;
  const shared = createSharedRead(signal => {
    work = readContext.run(signal, () => createGitHubWork(run));
    return work.promise;
  });
  return { signal: shared.signal, read: (signal?: AbortSignal) => {
    void joinGitHubWork(work);
    return shared.read(signal);
  } };
}
export const githubPriorityScope = (): PriorityScope => context.getStore() ?? { priority: 'foreground' };
export function githubPriority(scope = githubPriorityScope()): GitHubPriority {
  const parent = scope.parent && githubPriority(scope.parent);
  return parent && rank[parent] > rank[scope.priority] ? parent : scope.priority;
}
export const withGitHubPriority = <T>(
  priority: GitHubPriority,
  operation: () => T,
  options: { automatic?: boolean; predicted?: string } = {}
): T =>
  context.run({
    priority,
    automatic: options.automatic ?? (context.getStore() && githubAutomatic() ? true : undefined),
    // Reads made inside a prediction stay a prediction, unless the user's own interactive work starts them.
    predicted: options.predicted ?? (priority !== 'interactive' && context.getStore() ? githubPredicted() : undefined),
  }, operation);
/** Automatic refreshes can be urgent without borrowing the user's interactive allowance. */
export function githubAutomatic(scope = githubPriorityScope()): boolean {
  if (githubPriority(scope) === 'interactive') return false;
  if (scope.automatic !== undefined) return scope.automatic;
  return scope.parent ? githubAutomatic(scope.parent) : githubPriority(scope) === 'background';
}
/** The prediction label of non-automatic, non-interactive work. Interactive and automatic work is never predicted. */
export function githubPredicted(scope = githubPriorityScope()): string | undefined {
  if (githubPriority(scope) === 'interactive' || githubAutomatic(scope)) return undefined;
  if (scope.predicted !== undefined) return scope.predicted ?? undefined;
  return scope.parent ? githubPredicted(scope.parent) : undefined;
}
let predictedJoins = 0;
/** How often a user request joined a prediction in flight. */
export const githubPredictedJoins = () => predictedJoins;
export interface GitHubWork<T> {
  promise: Promise<T>;
  scope: PriorityScope;
}
/** Coalesced operations inherit promotions, including requests made after an await. */
export function createGitHubWork<T>(operation: () => Promise<T>): GitHubWork<T> {
  const scope = { priority: githubPriority(), parent: context.getStore() };
  return { scope, promise: context.run(scope, operation) };
}
export function joinGitHubWork<T>(work: GitHubWork<T>): Promise<T> {
  const priority = githubPriority();
  const before = [work.scope.priority, work.scope.automatic];
  const joiner = { automatic: githubAutomatic(), predicted: githubPredicted() };
  const was = { automatic: githubAutomatic(work.scope), predicted: githubPredicted(work.scope) };
  if (rank[priority] > rank[work.scope.priority]) {
    work.scope.priority = priority;
    work.scope.automatic = githubAutomatic();
  }
  // A user-requested generation can join an automatic foreground refresh.
  if (!githubAutomatic() && rank[priority] >= rank[work.scope.priority]) work.scope.automatic = false;
  if (was.predicted && !joiner.predicted && !joiner.automatic) {
    // The user caught up with a prediction. The rest of the work is charged to the user.
    work.scope.predicted = null;
    predictedJoins++;
  } else if (joiner.predicted && was.automatic && !githubAutomatic(work.scope)) {
    // A prediction promoted queue work: the rest is charged to the predicted budget, not to nobody.
    work.scope.predicted = joiner.predicted;
  }
  // A promoted task may now fit a slot its old tier could not use.
  if (before[0] !== work.scope.priority || before[1] !== work.scope.automatic) for (const drain of [...stalled]) drain();
  return work.promise;
}

/** Schedulers with queued work. A promotion re-drains them so a raised task starts at once. */
const stalled = new Set<() => void>();
const slots = 6;
// Foreground and background together never hold more than four slots, so two stay free for UI reads.
const lowerSlots = 4;
const backgroundSlots = 2;

/** UI reads take the next free slot; lower tiers share a subset. Exclusive tasks (writes) run alone. */
export function createGitHubScheduler() {
  interface Task {
    scope: PriorityScope;
    exclusive: boolean;
    run: () => Promise<void>;
  }
  const pending: Task[] = [];
  const running = new Set<Task>();
  let writing = false;
  function drain() {
    while (pending.length && !writing && running.size < slots) {
      // Count live priorities: a promoted in-flight request frees its lower-tier slot.
      let lower = 0,
        background = 0;
      for (const task of running) {
        const priority = githubPriority(task.scope);
        if (priority !== 'interactive') lower++;
        if (priority === 'background') background++;
      }
      let preferred = pending.findIndex((task) => githubPriority(task.scope) === 'interactive');
      if (preferred < 0) preferred = pending.findIndex((task) => githubPriority(task.scope) === 'foreground');
      const index = preferred < 0 ? 0 : preferred;
      const task = pending[index];
      const priority = githubPriority(task.scope);
      // A queued write is a barrier: nothing overtakes it, and it waits for running work to finish.
      if (task.exclusive && running.size) break;
      if (priority === 'foreground' && lower >= lowerSlots) break;
      if (priority === 'background' && (background >= backgroundSlots || lower >= lowerSlots)) break;
      pending.splice(index, 1);
      running.add(task);
      writing = task.exclusive;
      void context.run(task.scope, task.run).finally(() => {
        running.delete(task);
        if (task.exclusive) writing = false;
        drain();
      });
    }
    if (!pending.length) stalled.delete(drain);
  }
  return <T>(
    priority: GitHubPriority | PriorityScope,
    operation: () => Promise<T>,
    options: { exclusive?: boolean } = {}
  ): Promise<T> =>
    new Promise((resolve, reject) => {
      pending.push({
        exclusive: options.exclusive === true,
        scope: typeof priority === 'string' ? { priority } : priority,
        run: async () => {
          try {
            resolve(await operation());
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        },
      });
      stalled.add(drain);
      drain();
    });
}
