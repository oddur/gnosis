/**
 * IPC cancellation is scoped to the sending window and one inventory request. A read stopped because its
 * window closed resolves `undefined`: nobody waits for it, and its cancellation is not an error to log.
 */
export function createInspectionRequests(timeoutMs = 120_000) {
  const requests = new Map<string, AbortController>();
  const windowClosed = new WeakSet<AbortController>();
  const key = (owner: number, id: string) => JSON.stringify([owner, id]);
  return {
    async run<T>(owner: number, id: string | undefined, operation: (signal: AbortSignal) => Promise<T>): Promise<T | undefined> {
      const controller = new AbortController();
      const identity = id && key(owner, id);
      if (identity && requests.has(identity)) throw new Error('This PR request is already running.');
      if (identity) requests.set(identity, controller);
      const timer = setTimeout(
        () => controller.abort(new Error('Loading this PR took too long. Retry this PR or open it on GitHub.')),
        timeoutMs
      );
      try {
        return await operation(controller.signal);
      } catch (error) {
        // Only the cancellation itself is quiet; a read that failed for another reason still reports it.
        const aborted = error === controller.signal.reason || (error instanceof Error && error.name === 'AbortError');
        if (aborted && windowClosed.has(controller)) return undefined;
        throw error;
      } finally {
        clearTimeout(timer);
        if (identity) requests.delete(identity);
      }
    },
    cancel(owner: number, id: string) {
      requests.get(key(owner, id))?.abort();
    },
    cancelOwner(owner: number) {
      for (const [id, controller] of requests)
        if (id.startsWith(`[${owner},`)) {
          windowClosed.add(controller);
          controller.abort();
        }
    },
  };
}
