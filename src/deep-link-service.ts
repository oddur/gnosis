/**
 * Main side of "open Gnosis at this exact place" (#309 section 6.1). No Electron imports, so it is unit-tested.
 *
 * `open` shows the window and queues the target until a renderer can navigate. The renderer calls `take` when
 * it is ready; from then on targets are sent at once. A reload or a closed window clears the ready mark, so the
 * next renderer asks again. This replaces the blind 100 ms `review-navigate` timer.
 *
 * #307 Phase 1 needs trusted sources only (notification and tray). #309 adds `receive(raw, source)`, which parses
 * untrusted strings and rate-limits `os` and `content` sources.
 */
import { parseDeepLinkTarget, type DeepLinkSource, type DeepLinkTarget } from '../lib/deep-link';

export interface DeepLinkDelivery {
  id: string;
  target: DeepLinkTarget;
  source: DeepLinkSource;
}
export const DEEP_LINK_QUEUE_LIMIT = 5;

export function createDeepLinks(deps: {
  /** Shows or creates the main window. */
  show: () => void;
  /** Sends one item to a renderer; false when that renderer is gone. */
  send: (webContentsId: number, item: DeepLinkDelivery) => boolean;
  /** The ready renderer to prefer, such as the main window. Defaults to the first that became ready. */
  preferred?: (ready: readonly number[]) => number | undefined;
  log?: (line: string) => void;
}) {
  const ready: number[] = [];
  let queue: DeepLinkDelivery[] = [];
  let sequence = 0;
  const log = deps.log ?? ((line: string) => console.log(line));
  function deliver(item: DeepLinkDelivery): boolean {
    while (ready.length) {
      const id = deps.preferred?.(ready) ?? ready[0];
      if (deps.send(id, item)) return true;
      ready.splice(ready.indexOf(id), 1);
    }
    return false;
  }
  return {
    open(target: DeepLinkTarget, source: DeepLinkSource): boolean {
      const valid = parseDeepLinkTarget(target);
      if (!valid) {
        log(`[link] source=${source} result=rejected code=bad-parameter`);
        return false;
      }
      log(`[link] source=${source} route=${valid.kind} result=accepted`);
      deps.show();
      const item: DeepLinkDelivery = { id: `link-${++sequence}`, target: valid, source };
      if (deliver(item)) return true;
      // A duplicate of the newest waiting item is dropped.
      const newest = queue.at(-1);
      if (newest && JSON.stringify(newest.target) === JSON.stringify(valid)) return true;
      queue = [...queue, item].slice(-DEEP_LINK_QUEUE_LIMIT);
      return true;
    },
    /** A renderer can navigate: mark it ready and hand it the waiting targets. */
    take(webContentsId: number): DeepLinkDelivery[] {
      if (!ready.includes(webContentsId)) ready.push(webContentsId);
      const items = queue;
      queue = [];
      return items;
    },
    /** The renderer reloaded, crashed or closed. */
    reset(webContentsId: number) {
      const index = ready.indexOf(webContentsId);
      if (index >= 0) ready.splice(index, 1);
    },
    pending: () => queue.length,
  };
}
export type DeepLinks = ReturnType<typeof createDeepLinks>;
