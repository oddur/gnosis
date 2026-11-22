import type { CascadePreview, CascadeState } from '../lib/conflict-cascade';
import { BACKGROUND_YIELDED } from './conflict-resolution-service';

/**
 * Runs the cascade preview (#445 item 22) in the background, one result per draft version. The workspace asks for it
 * once every file is reviewed, and main says when it changes. A newer version cancels the run for the older one. On
 * battery nothing starts and a running preview stops, to start again on power, as background preparation does
 * (src/conflict-precompute.ts). A run that gave way to a request of yours starts again on the next ask.
 */
export interface CascadePreviewDeps {
  /** The service's `previewCascade`. Undefined: another operation runs for the PR. */
  run: (id: string, version: number, signal: AbortSignal) => Promise<CascadePreview | undefined>;
  onBattery: () => boolean;
  /** The signed-in account: results belong to it. */
  account: () => string;
  /** The draft's preview changed state. */
  changed: (id: string) => void;
}
interface Entry {
  version: number;
  state: CascadeState | { state: 'idle' };
  controller?: AbortController;
}
/** Drafts remembered, newest last. */
const REMEMBERED = 20;

export function createCascadePreviews(deps: CascadePreviewDeps) {
  const entries = new Map<string, Entry>();
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
      // A newer version or another account replaced this entry: its result is dropped.
      if (entries.get(id) !== entry || entry.controller !== controller) return;
      entry.controller = undefined;
      entry.state = next;
      // Busy with a request of yours: the workspace asks again when it is done, so this says nothing.
      if (next.state !== 'idle' || deps.onBattery()) note(id);
    })();
    tails.set(id, tail);
    void tail.finally(() => {
      if (tails.get(id) === tail) tails.delete(id);
    });
  }
  return {
    /** The preview for this draft version: starts it when nothing ran yet. Null when idle and not started. */
    request(id: string, version: number): CascadeState | null {
      forAccount();
      let entry = entries.get(id);
      if (entry && entry.version !== version) {
        entry.controller?.abort();
        entry = undefined;
      }
      if (!entry) {
        entry = { version, state: { state: 'idle' } };
        entries.delete(id);
        entries.set(id, entry);
        for (const key of entries.keys()) {
          if (entries.size <= REMEMBERED) break;
          entries.get(key)?.controller?.abort();
          entries.delete(key);
        }
      }
      if (entry.state.state === 'idle' || entry.state.state === 'battery') {
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
    /** On battery, running previews stop and wait; on power, they start again. */
    power() {
      const battery = deps.onBattery();
      for (const [id, entry] of entries) {
        if (battery && entry.controller) {
          entry.controller.abort();
          entry.controller = undefined;
          entry.state = { state: 'battery' };
          note(id);
        } else if (!battery && entry.state.state === 'battery') {
          start(id, entry);
          note(id);
        }
      }
    },
    dispose() {
      for (const entry of entries.values()) entry.controller?.abort();
      entries.clear();
    },
  };
}
