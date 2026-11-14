/**
 * Main side of "open Gnosis at this exact place" (#309 section 6.1). No Electron imports, so it is unit-tested.
 *
 * `open` shows the window and queues the target until a renderer can navigate. The renderer calls `take` when
 * it is ready; from then on targets are sent at once. A reload or a closed window clears the ready mark, so the
 * next renderer asks again. This replaces the blind 100 ms `review-navigate` timer.
 *
 * `receive(raw, source)` takes an untrusted `gnosis://` string from the OS or from rendered content. It is
 * rate-limited, parsed by the one strict parser, and a refusal is delivered like a target, so the user sees why
 * nothing opened. Log lines carry the source, the route word and a result code only, never the link.
 */
import {
  parseDeepLink,
  parseDeepLinkTarget,
  targetRoute,
  TRUSTED_SOURCES,
  type DeepLinkError,
  type DeepLinkSource,
  type DeepLinkTarget,
} from '../lib/deep-link';

export type DeepLinkDelivery =
  | { id: string; target: DeepLinkTarget; source: DeepLinkSource; error?: undefined }
  | { id: string; error: DeepLinkError; source: DeepLinkSource; target?: undefined };
export type UntrustedSource = Extract<DeepLinkSource, 'os' | 'content'>;
export const DEEP_LINK_QUEUE_LIMIT = 5;
/** Token bucket for `os` and `content` links: 5 at once, one more every 2 seconds. */
export const DEEP_LINK_BURST = 5;
export const DEEP_LINK_REFILL_MS = 2_000;
/** Dropped links are reported at most once per 10 seconds. */
export const DEEP_LINK_REPORT_MS = 10_000;
/** Links focus the window at most once per second. */
export const DEEP_LINK_FOCUS_MS = 1_000;

export function createDeepLinks(deps: {
  /** Shows or creates the main window. */
  show: () => void;
  /** Sends one item to a renderer; false when that renderer is gone. */
  send: (webContentsId: number, item: DeepLinkDelivery) => boolean;
  /** The ready renderer to prefer, such as the main window. Defaults to the first that became ready. */
  preferred?: (ready: readonly number[]) => number | undefined;
  log?: (line: string) => void;
  /** `['gnosis']` when packaged, `['gnosis-dev']` in development. */
  schemes?: readonly string[];
  now?: () => number;
  /** Runs the report of dropped links later. */
  schedule?: (run: () => void, ms: number) => void;
}) {
  const ready: number[] = [];
  let queue: DeepLinkDelivery[] = [];
  let sequence = 0;
  const log = deps.log ?? ((line: string) => console.log(line));
  const now = deps.now ?? Date.now;
  const schedule = deps.schedule ?? ((run: () => void, ms: number) => void setTimeout(run, ms));
  const schemes = deps.schemes ?? ['gnosis'];
  let tokens = DEEP_LINK_BURST;
  let refilledAt = now();
  let dropped = 0;
  let reportScheduled = false;
  let nextReportAt = 0;
  let shownAt = -Infinity;

  function deliver(item: DeepLinkDelivery): boolean {
    while (ready.length) {
      const id = deps.preferred?.(ready) ?? ready[0];
      if (deps.send(id, item)) return true;
      ready.splice(ready.indexOf(id), 1);
    }
    return false;
  }
  function show(source: DeepLinkSource) {
    // A burst of outside links must not keep stealing focus.
    if (!TRUSTED_SOURCES.includes(source)) {
      if (now() - shownAt < DEEP_LINK_FOCUS_MS) return;
      shownAt = now();
    }
    deps.show();
  }
  function enqueue(item: DeepLinkDelivery) {
    if (deliver(item)) return;
    // A duplicate of the newest waiting item is dropped.
    const newest = queue.at(-1);
    const key = (value: DeepLinkDelivery) => JSON.stringify(value.target ?? value.error);
    if (newest && key(newest) === key(item)) return;
    queue = [...queue, item].slice(-DEEP_LINK_QUEUE_LIMIT);
  }
  function take(): boolean {
    const at = now();
    tokens = Math.min(DEEP_LINK_BURST, tokens + Math.max(0, at - refilledAt) / DEEP_LINK_REFILL_MS);
    refilledAt = at;
    if (tokens < 1) return false;
    tokens--;
    return true;
  }
  function report(source: DeepLinkSource) {
    reportScheduled = false;
    if (!dropped) return;
    const count = dropped;
    dropped = 0;
    nextReportAt = now() + DEEP_LINK_REPORT_MS;
    enqueue({ id: `link-${++sequence}`, error: { code: 'rate-limited', count }, source });
  }
  function reject(error: DeepLinkError, source: DeepLinkSource) {
    log(`[link] source=${source}${error.route ? ` route=${error.route}` : ''} result=rejected code=${error.code}`);
    show(source);
    enqueue({ id: `link-${++sequence}`, error, source });
  }

  return {
    open(target: DeepLinkTarget, source: DeepLinkSource): boolean {
      const valid = parseDeepLinkTarget(target);
      if (!valid) {
        log(`[link] source=${source} result=rejected code=bad-parameter`);
        return false;
      }
      log(`[link] source=${source} route=${targetRoute(valid)} result=accepted`);
      show(source);
      enqueue({ id: `link-${++sequence}`, target: valid, source });
      return true;
    },
    /** An untrusted `gnosis://` string from the OS or rendered content. True when it was accepted. */
    receive(raw: unknown, source: UntrustedSource): boolean {
      if (!take()) {
        dropped++;
        log(`[link] source=${source} result=dropped code=rate-limited`);
        if (!reportScheduled) {
          reportScheduled = true;
          schedule(() => report(source), Math.max(0, nextReportAt - now()));
        }
        return false;
      }
      const parsed = typeof raw === 'string' ? parseDeepLink(raw, schemes) : { error: { code: 'malformed' as const } };
      if ('error' in parsed) {
        reject(parsed.error, source);
        return false;
      }
      return this.open(parsed.target, source);
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
