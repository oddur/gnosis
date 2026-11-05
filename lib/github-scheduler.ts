import { AsyncLocalStorage } from 'node:async_hooks';
import { createSharedRead } from './shared-read';

export type GitHubPriority = 'interactive' | 'foreground' | 'background';
const rank: Record<GitHubPriority, number> = { interactive: 2, foreground: 1, background: 0 };
interface PriorityScope {
  priority: GitHubPriority;
  parallelReads?: boolean;
  automatic?: boolean;
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
export const withGitHubPriority = <T>(priority: GitHubPriority, operation: () => T, options: { automatic?: boolean } = {}): T =>
  context.run({ priority, automatic: options.automatic ?? (context.getStore() && githubAutomatic() ? true : undefined) }, operation);
/** Automatic refreshes can be urgent without borrowing the user's interactive allowance. */
export function githubAutomatic(scope = githubPriorityScope()): boolean {
  if (githubPriority(scope) === 'interactive') return false;
  if (scope.automatic !== undefined) return scope.automatic;
  return scope.parent ? githubAutomatic(scope.parent) : githubPriority(scope) === 'background';
}
/** Opt in only for independent reads on the visible workflow's critical path. */
export const withParallelGitHubReads = <T>(operation: () => T): T =>
  context.run({ priority: githubPriority(), parallelReads: true, parent: context.getStore() }, operation);
export function githubParallelReads(scope = githubPriorityScope()): boolean {
  return !!(scope.parallelReads || (scope.parent && githubParallelReads(scope.parent)));
}
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
  if (rank[priority] > rank[work.scope.priority]) {
    work.scope.priority = priority;
    work.scope.automatic = githubAutomatic();
  }
  // A user-requested generation can join an automatic foreground refresh.
  if (!githubAutomatic() && rank[priority] >= rank[work.scope.priority]) work.scope.automatic = false;
  return work.promise;
}

/** UI reads always take the next available slot; lower tiers share otherwise idle capacity. */
export function createGitHubScheduler() {
  const pending: { scope: PriorityScope; parallel: boolean; run: () => Promise<void> }[] = [];
  let active = 0,
    exclusive = false;
  function drain() {
    while (pending.length && active < 3 && !exclusive) {
      let preferred = pending.findIndex((task) => githubPriority(task.scope) === 'interactive');
      if (preferred < 0) preferred = pending.findIndex((task) => githubPriority(task.scope) === 'foreground');
      const index = preferred < 0 ? 0 : preferred;
      const task = pending[index];
      const parallel = task.parallel && githubPriority(task.scope) === 'interactive';
      // Ordinary reads and all mutations retain the original exclusive ordering.
      if (active && !parallel) return;
      pending.splice(index, 1);
      active++;
      exclusive = !parallel;
      void context.run(task.scope, task.run).finally(() => {
        active--;
        if (!parallel) exclusive = false;
        drain();
      });
    }
  }
  return <T>(
    priority: GitHubPriority | PriorityScope,
    operation: () => Promise<T>,
    options: { parallel?: boolean } = {}
  ): Promise<T> =>
    new Promise((resolve, reject) => {
      pending.push({
        parallel: options.parallel === true,
        scope: typeof priority === 'string' ? { priority } : priority,
        run: async () => {
          try {
            resolve(await operation());
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        },
      });
      drain();
    });
}
