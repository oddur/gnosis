import { AsyncLocalStorage } from 'node:async_hooks';

export type GitHubPriority = 'interactive' | 'foreground' | 'background';
const rank: Record<GitHubPriority, number> = { interactive: 2, foreground: 1, background: 0 };
interface PriorityScope {
  priority: GitHubPriority;
  parent?: PriorityScope;
}
const context = new AsyncLocalStorage<PriorityScope>();
export const githubPriorityScope = (): PriorityScope => context.getStore() ?? { priority: 'foreground' };
export function githubPriority(scope = githubPriorityScope()): GitHubPriority {
  const parent = scope.parent && githubPriority(scope.parent);
  return parent && rank[parent] > rank[scope.priority] ? parent : scope.priority;
}
export const withGitHubPriority = <T>(priority: GitHubPriority, operation: () => T): T =>
  context.run({ priority }, operation);
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
  if (rank[priority] > rank[work.scope.priority]) work.scope.priority = priority;
  return work.promise;
}

/** UI reads always take the next available slot; lower tiers share otherwise idle capacity. */
export function createGitHubScheduler() {
  const pending: { scope: PriorityScope; run: () => Promise<void> }[] = [];
  let running = false;
  let foregroundRuns = 0;
  async function drain() {
    if (running) return;
    running = true;
    try {
      while (pending.length) {
        let preferred = pending.findIndex((task) => githubPriority(task.scope) === 'interactive');
        if (preferred < 0) {
          const priority = foregroundRuns >= 8 ? 'background' : 'foreground';
          preferred = pending.findIndex((task) => githubPriority(task.scope) === priority);
        }
        const [task] = pending.splice(preferred < 0 ? 0 : preferred, 1);
        const priority = githubPriority(task.scope);
        if (priority === 'foreground') foregroundRuns++;
        else if (priority === 'background') foregroundRuns = 0;
        await context.run(task.scope, task.run);
      }
    } finally {
      running = false;
    }
  }
  return <T>(priority: GitHubPriority | PriorityScope, operation: () => Promise<T>): Promise<T> =>
    new Promise((resolve, reject) => {
      pending.push({
        scope: typeof priority === 'string' ? { priority } : priority,
        run: async () => {
          try {
            resolve(await operation());
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        },
      });
      void drain();
    });
}
