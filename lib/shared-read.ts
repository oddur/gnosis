export const readError = (error: unknown): Error => error instanceof Error ? error : new Error(typeof error === 'string' ? error : 'Request cancelled');

/** Cancel a shared operation only after its last reader leaves. */
export function createSharedRead<T>(run: (signal: AbortSignal) => Promise<T>) {
  const controller = new AbortController();
  let readers = 0,
    settled = false;
  const promise = run(controller.signal).finally(() => {
    settled = true;
  });
  // A caller can leave before the operation rejects; that rejection is still observed.
  void promise.catch(() => {});
  return {
    signal: controller.signal,
    read(signal?: AbortSignal): Promise<T> {
      if (signal?.aborted) return Promise.reject(readError(signal.reason));
      readers++;
      return new Promise<T>((resolve, reject) => {
        let done = false;
        const release = () => {
          if (done) return false;
          done = true;
          signal?.removeEventListener('abort', abort);
          if (--readers === 0 && !settled) controller.abort();
          return true;
        };
        const abort = () => {
          if (release()) reject(readError(signal?.reason));
        };
        signal?.addEventListener('abort', abort, { once: true });
        promise.then(
          (value) => {
            if (release()) resolve(value);
          },
          (error: unknown) => {
            if (release()) reject(readError(error));
          }
        );
      });
    },
  };
}
