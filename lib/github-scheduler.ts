import { AsyncLocalStorage } from 'node:async_hooks';

type Priority = 'foreground' | 'background';
const context = new AsyncLocalStorage<Priority>();
export const githubPriority = () => context.getStore() ?? 'foreground';
export const withGitHubPriority = <T>(priority: Priority, operation: () => T): T => context.run(priority, operation);

/** Serial network access, with interaction ahead of queued maintenance work. */
export function createGitHubScheduler() {
  const pending: { priority: Priority; run: () => Promise<void> }[] = [];
  let running = false;
  let foregroundRuns = 0;
  async function drain() {
    if (running) return;
    running = true;
    try {
      while (pending.length) {
        const priority = foregroundRuns >= 8 ? 'background' : 'foreground';
        const preferred = pending.findIndex((task) => task.priority === priority);
        const [task] = pending.splice(preferred < 0 ? 0 : preferred, 1);
        foregroundRuns = task.priority === 'background' ? 0 : foregroundRuns + 1;
        await task.run();
      }
    } finally {
      running = false;
    }
  }
  return <T>(priority: Priority, operation: () => Promise<T>): Promise<T> =>
    new Promise((resolve, reject) => {
      pending.push({
        priority,
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
