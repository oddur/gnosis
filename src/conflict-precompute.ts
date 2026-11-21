import type { ConflictSession } from '../lib/conflict-resolution';
import { conflictHeader, type ConflictHeader } from '../lib/conflict-header';
import type { MergeConflictState } from '../lib/merge-conflicts';
import type { SyntaxLanguage } from '../lib/syntax-scope';
import { NO_PERMISSION } from './conflict-resolution-service';

/**
 * Background conflict preparation (#445 item 4). When GitHub reports conflicts for a PR you wrote or starred, or one
 * whose header you look at, the conflict service prepares it as it would on open: fetch, merge, earlier resolutions,
 * structural merge and the checks. Nothing is pushed. The draft is saved as a background draft, which opening the PR's
 * conflicts reuses while the PR head is the same.
 *
 * One PR at a time by default. A PR whose head moves, or that merges cleanly, has its run cancelled and its background
 * draft removed. On battery, nothing starts and a running preparation stops, to start again on power. Metered networks
 * are not detected: Electron has no portable way to tell.
 */
export interface ConflictPrecomputeDeps {
  /** The service's `prepareInBackground`. Undefined: another operation runs for the PR. */
  prepare: (url: string, signal: AbortSignal, files: (count: number) => void) => Promise<ConflictSession | undefined>;
  /** The saved draft for this head, a background one or yours. */
  draft: (url: string, headSha: string) => ConflictSession | undefined;
  /** Removes a background draft. Your own draft stays. */
  forget: (url: string) => Promise<void>;
  /** Keeps the newest background drafts and removes the rest. */
  trim: () => Promise<void>;
  /** You wrote or starred the PR. */
  wanted: (url: string) => boolean;
  onBattery: () => boolean;
  /** The PR's header line changed. */
  changed: (url: string) => void;
  /** The languages off in Settings: a saved verdict counts only for the same ones (lib/conflict-verdict-key.ts). */
  disabledLanguages?: () => SyntaxLanguage[];
  /** Preparations at once: 1 or 2. */
  concurrency?: number;
}
/** Runs and header lines remembered, newest last. A finished run says "no permission" or "failed" until the head moves. */
const REMEMBERED = 200;

interface Run {
  url: string;
  headSha: string;
  state: 'queued' | 'running' | 'done' | 'failed' | 'no-permission';
  files?: number;
  controller?: AbortController;
  finished?: Promise<void>;
}

export function createConflictPrecompute(deps: ConflictPrecomputeDeps) {
  const runs = new Map<string, Run>();
  /** Each PR's line from its saved draft, for one head: a draft can be megabytes, so it is read once per change. */
  const lines = new Map<string, { headSha: string; header: ConflictHeader | undefined }>();
  const limit = Math.min(2, Math.max(1, deps.concurrency ?? 1));
  let running = 0;
  const bounded = <T>(map: Map<string, T>, keep: (value: T) => boolean = () => false) => {
    for (const [key, value] of map) {
      if (map.size <= REMEMBERED) break;
      if (!keep(value)) map.delete(key);
    }
  };
  const note = (url: string) => {
    lines.delete(url);
    try {
      deps.changed(url);
    } catch (error) {
      console.warn('[conflicts] Could not announce a background preparation.', error);
    }
  };
  function fromDraft(url: string, headSha: string) {
    const known = lines.get(url);
    if (known?.headSha === headSha) return known.header;
    const draft = deps.draft(url, headSha);
    const header = draft ? conflictHeader(draft.files, deps.disabledLanguages?.() ?? []) : undefined;
    lines.delete(url);
    lines.set(url, { headSha, header });
    bounded(lines);
    return header;
  }
  function pump() {
    if (deps.onBattery()) return;
    for (const run of runs.values()) {
      if (running >= limit) return;
      if (run.state === 'queued') start(run);
    }
  }
  function start(run: Run) {
    running++;
    run.state = 'running';
    const controller = new AbortController();
    run.controller = controller;
    note(run.url);
    run.finished = (async () => {
      try {
        const session = await deps.prepare(run.url, controller.signal, (files) => {
          run.files = files;
          note(run.url);
        });
        run.state = 'done';
        if (session?.background) await deps.trim();
      } catch (error) {
        // Stopped on battery, it waits for power. Cancelled for a new head, `observe` already dropped it.
        if (controller.signal.aborted) run.state = 'queued';
        else if (error instanceof Error && error.message === NO_PERMISSION) run.state = 'no-permission';
        else {
          run.state = 'failed';
          console.warn(`[conflicts] Background preparation failed for ${run.url}.`, error);
        }
      } finally {
        running--;
        run.controller = undefined;
        note(run.url);
        pump();
      }
    })();
  }

  return {
    /**
     * GitHub's merge state for a PR head, from any status read. `opened`: you are looking at the PR, so it counts as
     * wanted. A new head, or a clean merge, cancels the run and removes its background draft.
     */
    observe(url: string, headSha: string, state: MergeConflictState, opened = false) {
      const run = runs.get(url);
      if (run && (run.headSha !== headSha || state === 'clear')) {
        run.controller?.abort();
        runs.delete(url);
        note(url);
        void deps.forget(url).catch((error: unknown) => console.warn('[conflicts] Could not remove a draft.', error));
      }
      if (state !== 'conflicts' || runs.has(url)) return;
      if (!opened && !deps.wanted(url)) return;
      if (fromDraft(url, headSha)) return;
      runs.set(url, { url, headSha, state: 'queued' });
      bounded(runs, (value) => value.state === 'queued' || value.state === 'running');
      note(url);
      pump();
    },
    /** The header line for this head, or undefined: nothing prepared and nothing running. */
    header(url: string, headSha: string): ConflictHeader | undefined {
      const run = runs.get(url);
      if (run?.headSha === headSha) {
        if (run.state === 'no-permission') return { state: 'no-permission' };
        if (run.state === 'running' || (run.state === 'queued' && !deps.onBattery()))
          return { state: 'checking', files: run.files };
      }
      return fromDraft(url, headSha);
    },
    /** The PR's draft changed (you edited or pushed it): its line is read again. */
    refresh: note,
    /** You discarded the PR's draft: this head is not prepared again in the background. */
    dismiss(url: string, headSha: string) {
      runs.get(url)?.controller?.abort();
      runs.set(url, { url, headSha, state: 'done' });
      note(url);
    },
    /**
     * You open the PR's conflicts: a running preparation finishes first, so the open reuses its draft. A queued one
     * is dropped, since your open prepares the PR itself.
     */
    async settle(url: string) {
      const run = runs.get(url);
      if (run?.state === 'queued') runs.delete(url);
      await run?.finished;
    },
    /** On battery, running preparations stop and wait; on power, they start again. */
    power() {
      if (deps.onBattery()) for (const run of runs.values()) run.controller?.abort();
      else pump();
    },
    dispose() {
      for (const run of runs.values()) run.controller?.abort();
      runs.clear();
    },
  };
}
