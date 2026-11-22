import type { CascadePreview, CascadeState } from '../lib/conflict-cascade';
import { BACKGROUND_YIELDED } from './conflict-resolution-service';

/**
 * Runs the cascade preview (#445 item 22) in the background, one result per draft version. The workspace asks for it
 * once every file is reviewed, and main says when it changes. Only a newer version replaces a draft's run: a window
 * that still shows an older version is told it is out of date. On battery nothing starts and a running preview stops;
 * on power, the drafts a window asked about recently start again, as background preparation does
 * (src/conflict-precompute.ts). A run that gave way to a request of yours, or found the PR busy, is asked for again.
 * A failed run starts again on Check again, or on an ask a minute later.
 */
export interface CascadePreviewDeps {
  /** The service's `previewCascade`. Undefined: another operation still holds the PR. */
  run: (id: string, version: number, signal: AbortSignal) => Promise<CascadePreview | undefined>;
  onBattery: () => boolean;
  /** The signed-in account: results belong to it. */
  account: () => string;
  /** The draft's saved version now, or undefined when it is gone. Power-on restarts only current drafts. */
  current?: (id: string) => number | undefined;
  /** The draft's preview changed state. */
  changed: (id: string) => void;
  /** Milliseconds now. Tests change it. */
  now?: () => number;
}
interface Entry {
  version: number;
  state: CascadeState | { state: 'idle' };
  controller?: AbortController;
  /** When a window last asked, and when the run failed. */
  asked: number;
  failed?: number;
}
/** Drafts remembered, newest last. */
const REMEMBERED = 20;
/** A failed run starts again on an ask after this long. */
export const CASCADE_RETRY_MS = 60_000;
/** Power-on restarts drafts asked about this recently, at most this many. */
const RECENT_MS = 5 * 60_000;
const RESTART_LIMIT = 2;
/** Quit waits this long for running previews to clean up their worktrees. */
const DISPOSE_MS = 3000;
export const CASCADE_OUT_OF_DATE = 'This draft changed in another window. Reopen it to check the stack.';

export function createCascadePreviews(deps: CascadePreviewDeps) {
  const entries = new Map<string, Entry>();
  const now = deps.now ?? Date.now;
  let account = '';
  function forAccount() {
    const current = deps.account();
    if (current === account) return;
    account = current;
    for (const entry of entries.values()) entry.controller?.abort();
    entries.clear();
  }
  const note = (id: string) => {
    try {
      deps.changed(id);
    } catch (error) {
      console.warn('[conflicts] Could not announce a cascade preview.', error);
    }
  };
  /** Each draft's last run, until it lets go: a run for a newer version waits for the one it cancelled. */
  const tails = new Map<string, Promise<void>>();
  function start(id: string, entry: Entry) {
    const controller = new AbortController();
    entry.controller = controller;
    entry.state = { state: 'checking' };
    entry.failed = undefined;
    const previous = tails.get(id) ?? Promise.resolve();
    const tail = (async () => {
      await previous;
      let next: Entry['state'];
      try {
        controller.signal.throwIfAborted();
        const preview = await deps.run(id, entry.version, controller.signal);
        next = preview ? { state: 'ready', preview } : { state: 'idle' };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (controller.signal.aborted) next = deps.onBattery() ? { state: 'battery' } : { state: 'idle' };
        else if (message === BACKGROUND_YIELDED) next = { state: 'idle' };
        else next = { state: 'failed', message };
      }
      // A newer version, power or another account replaced this run: its result is dropped.
      if (entries.get(id) !== entry || entry.controller !== controller) return;
      entry.controller = undefined;
      entry.state = next;
      if (next.state === 'failed') entry.failed = now();
      // Idle: the PR was busy, or a request of yours stopped the run. The window asks again and it starts again.
      note(id);
    })();
    tails.set(id, tail);
    void tail.finally(() => {
      if (tails.get(id) === tail) tails.delete(id);
    });
  }
  return {
    /**
     * The preview for this draft version: starts it when nothing ran yet, after an idle stop, or (`retry`, or a minute
     * later) after a failure. Null when the draft's entry is idle and could not start.
     */
    request(id: string, version: number, retry = false): CascadeState | null {
      forAccount();
      let entry = entries.get(id);
      // Another window with an older draft: it changes nothing.
      if (entry && version < entry.version) return { state: 'failed', message: CASCADE_OUT_OF_DATE };
      if (entry && entry.version !== version) {
        entry.controller?.abort();
        entry = undefined;
      }
      if (!entry) {
        entry = { version, state: { state: 'idle' }, asked: now() };
        entries.delete(id);
        entries.set(id, entry);
        for (const key of entries.keys()) {
          if (entries.size <= REMEMBERED) break;
          entries.get(key)?.controller?.abort();
          entries.delete(key);
        }
      }
      entry.asked = now();
      const again =
        entry.state.state === 'failed' && (retry || now() - (entry.failed ?? 0) >= CASCADE_RETRY_MS);
      if (entry.state.state === 'idle' || entry.state.state === 'battery' || again) {
        if (deps.onBattery()) entry.state = { state: 'battery' };
        else start(id, entry);
      }
      return entry.state.state === 'idle' ? null : entry.state;
    },
    /** The draft is gone, published or discarded: its run stops. */
    forget(id: string) {
      entries.get(id)?.controller?.abort();
      entries.delete(id);
    },
    /**
     * On battery, running previews stop and wait. On power, the current drafts of this account that a window asked
     * about recently start again, the newest first and at most two; the others are dropped.
     */
    power() {
      forAccount();
      if (deps.onBattery()) {
        for (const [id, entry] of entries)
          if (entry.controller) {
            entry.controller.abort();
            entry.controller = undefined;
            entry.state = { state: 'battery' };
            note(id);
          }
        return;
      }
      const waiting = [...entries].filter(([, entry]) => entry.state.state === 'battery');
      waiting.sort(([, a], [, b]) => b.asked - a.asked);
      let started = 0;
      for (const [id, entry] of waiting) {
        const current = deps.current ? deps.current(id) === entry.version : true;
        if (current && now() - entry.asked <= RECENT_MS && started < RESTART_LIMIT) {
          started++;
          start(id, entry);
        } else {
          entries.delete(id);
          entry.state = { state: 'idle' };
        }
        note(id);
      }
    },
    /** Stops every preview and waits, at most 3 seconds, for their private worktrees to be removed. */
    async dispose() {
      for (const entry of entries.values()) entry.controller?.abort();
      entries.clear();
      await Promise.race([
        Promise.allSettled([...tails.values()]),
        new Promise((resolve) => setTimeout(resolve, DISPOSE_MS).unref()),
      ]);
    },
  };
}
