/** Cancellation belongs to one renderer and one request, never a global provider. */
export function createChatRuns() {
  const runs = new Map<string, AbortController>();
  const key = (owner: number, id: string) => JSON.stringify([owner, id]);
  return {
    begin(owner: number, id: string) {
      const identity = key(owner, id);
      if (runs.has(identity)) throw new Error('This question is already running.');
      const controller = new AbortController();
      runs.set(identity, controller);
      return {
        controller,
        release: () => {
          if (runs.get(identity) === controller) runs.delete(identity);
        },
      };
    },
    cancel(owner: number, id: string) {
      runs.get(key(owner, id))?.abort();
    },
  };
}

/** Stop waiting on cached/network context immediately; shared cache warming may finish independently. */
export async function waitForChatContext<T>(load: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new Error('GNOSIS_CANCELLED'));
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    return await Promise.race([load(), cancelled]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}
