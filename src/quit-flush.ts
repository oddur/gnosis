/** A window that can save its pending review state. Electron's `webContents` fits. */
export interface FlushTarget {
  isDestroyed(): boolean;
  isCrashed(): boolean;
  send(channel: string, ...args: unknown[]): void;
}

export const RENDERER_FLUSH_TIMEOUT_MS = 500;

/**
 * At quit, each window may still hold debounced saves (scroll positions, open tabs) or have saves in
 * flight. Main asks every window to send them and waits for its answer before it closes saved data.
 * Windows answer in parallel; a hung or busy window gets `timeoutMs`, so quit is delayed by that at most.
 */
export function createRendererFlush({ timeoutMs = RENDERER_FLUSH_TIMEOUT_MS } = {}) {
  let sequence = 0;
  const waiting = new Map<number, () => void>();
  return {
    /** Call for each `review-state-flushed` message from a renderer. */
    acknowledge(id: unknown) {
      if (typeof id === 'number') waiting.get(id)?.();
    },
    /** Resolves when every window has answered or timed out. Never rejects. */
    async flush(targets: readonly FlushTarget[]): Promise<{ flushed: number; timedOut: number }> {
      const results = await Promise.all(
        targets.map((target) => {
          if (target.isDestroyed() || target.isCrashed()) return Promise.resolve('skipped' as const);
          const id = ++sequence;
          return new Promise<'flushed' | 'timedOut' | 'skipped'>((resolve) => {
            const done = (result: 'flushed' | 'timedOut' | 'skipped') => {
              clearTimeout(timer);
              waiting.delete(id);
              resolve(result);
            };
            const timer = setTimeout(() => done('timedOut'), timeoutMs);
            waiting.set(id, () => done('flushed'));
            try {
              target.send('flush-review-state', id);
            } catch {
              // The window went away between the check and the send.
              done('skipped');
            }
          });
        })
      );
      return {
        flushed: results.filter((result) => result === 'flushed').length,
        timedOut: results.filter((result) => result === 'timedOut').length,
      };
    },
  };
}

/**
 * The saved-work part of quitting: windows save what they hold, then the store closes. Writes that
 * arrive while the store closes join its final flush. Rejects only when the store could not save.
 */
export async function saveWorkBeforeQuit({
  targets,
  flush,
  close,
}: {
  targets: readonly FlushTarget[];
  flush: (targets: readonly FlushTarget[]) => Promise<{ timedOut: number }>;
  close: () => Promise<void>;
}): Promise<void> {
  const { timedOut } = await flush(targets);
  if (timedOut)
    console.warn(
      `${timedOut === 1 ? 'A window' : `${timedOut} windows`} did not answer in time; their last review changes may not be saved.`
    );
  await close();
}
