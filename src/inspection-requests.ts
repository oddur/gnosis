/** IPC cancellation is scoped to the sending window and one inventory request. */
export function createInspectionRequests(timeoutMs = 120_000) {
  const requests = new Map<string, AbortController>();
  const key = (owner: number, id: string) => JSON.stringify([owner, id]);
  return {
    async run<T>(owner: number, id: string | undefined, operation: (signal: AbortSignal) => Promise<T>) {
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
      } finally {
        clearTimeout(timer);
        if (identity) requests.delete(identity);
      }
    },
    cancel(owner: number, id: string) {
      requests.get(key(owner, id))?.abort();
    },
    cancelOwner(owner: number) {
      for (const [id, controller] of requests) if (id.startsWith(`[${owner},`)) controller.abort();
    },
  };
}
