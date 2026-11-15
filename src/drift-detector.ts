import type { StateStorage } from './app-data-store';
import {
  DRIFT_SAMPLE_INTERVAL_MS,
  emptySyncHealth,
  DRIFT_SAMPLE_SIZE,
  classifyDrift,
  driftLogLine,
  normalizeSyncHealth,
  pickDriftSample,
  recordSample,
  type DriftCandidate,
  type GnosisView,
  type GroundTruth,
  type SampleResult,
  type SyncHealthSnapshot,
  type SyncHealthState,
} from '../lib/sync-health';

export const SYNC_HEALTH_KEY = 'sync-health';
/** The first background sample waits this long after launch, so it never competes with startup. */
export const DRIFT_FIRST_SAMPLE_MS = 3 * 60_000;
/** PRs the reader opened, kept in memory. */
const SEEN_LIMIT = 50;

interface Deps {
  storage: StateStorage;
  now?: () => number;
  /** Signed in, sync active (a window or the menu bar panel is visible) and the automatic budget allows optional work. */
  active: () => boolean;
  /** Manual checks need only a signed-in account and no hard rate limit. */
  available: () => boolean;
  /** PRs in the queue. */
  queue: () => string[];
  /** What Gnosis shows for this PR now, from local data only. */
  view: (url: string) => Promise<GnosisView | undefined>;
  /** One GraphQL query. Background reads run at the lowest priority and count as automatic. */
  read: (url: string, trigger: 'background' | 'manual') => Promise<{ truth: GroundTruth; cost: number }>;
  /** Written to main.log: mismatches as warnings, sample summaries as info. */
  log?: (line: string, level: 'info' | 'warn') => void;
  changed?: () => void;
}

/**
 * Samples a few PRs every 12 minutes while sync is active and compares them with GitHub. Never runs while idle,
 * signed out or paused by the budget. "Check now" samples at once, at normal priority.
 */
export function createDriftDetector(deps: Deps) {
  const now = deps.now ?? Date.now;
  const log =
    deps.log ?? ((line: string, level: 'info' | 'warn') => (level === 'warn' ? console.warn(line) : console.log(line)));
  // Saved work loads after launch: read it on first use.
  let state: SyncHealthState = emptySyncHealth();
  let loaded = false;
  const ensure = () => {
    if (loaded) return;
    try {
      state = normalizeSyncHealth(deps.storage.read(SYNC_HEALTH_KEY));
      loaded = true;
    } catch {
      // Still loading: an empty view until it is.
    }
  };
  let nextAt = now() + DRIFT_FIRST_SAMPLE_MS;
  let running: Promise<SyncHealthSnapshot> | undefined;
  const seen = new Map<string, number>();
  const save = () => {
    try {
      deps.storage.write(SYNC_HEALTH_KEY, state);
    } catch (error) {
      log(`[sync-health] Could not save: ${error instanceof Error ? error.message : String(error)}`, 'warn');
    }
    deps.changed?.();
  };
  const candidates = (): DriftCandidate[] => {
    const queue = new Set(deps.queue());
    const urls = new Set([...seen.keys(), ...queue]);
    return [...urls].map((url) => ({
      url,
      inQueue: queue.has(url),
      ...(seen.has(url) ? { seenAt: seen.get(url) } : {}),
    }));
  };
  const snapshot = (): SyncHealthSnapshot => {
    ensure();
    return {
      enabled: state.enabled,
      active: state.enabled && deps.active(),
      checking: !!running,
      ...(state.enabled ? { nextAt } : {}),
      drifts: state.drifts,
      stale: state.stale,
      runs: state.runs,
      unconfirmed: state.suspects.length,
    };
  };
  async function sample(urls: string[], trigger: 'background' | 'manual') {
    const startedAt = now();
    let cost = 0;
    const results: SampleResult[] = [];
    // One PR at a time: the detector never holds more than one request slot.
    for (const url of urls) {
      try {
        const read = await deps.read(url, trigger);
        cost += read.cost;
        // Gnosis's copy is read after GitHub's, so anything Gnosis learned meanwhile counts in its favour.
        const view = await deps.view(url);
        if (!view) {
          results.push({ url, readAt: read.truth.readAt, findings: [], suspects: [] });
          continue;
        }
        const { findings, suspects } = classifyDrift(view, read.truth, state.suspects);
        for (const finding of findings)
          if (finding.kind !== 'stale') log(driftLogLine(finding), finding.kind === 'drift' ? 'warn' : 'info');
        results.push({ url, readAt: read.truth.readAt, findings, suspects });
      } catch (error) {
        log(`[sync-health] Could not read ${url}: ${error instanceof Error ? error.message : String(error)}`, 'warn');
        results.push({ url, readAt: now() });
      }
    }
    state = recordSample(state, { at: startedAt, trigger, cost }, results);
    const run = state.runs[0];
    log(
      `[sync-health] ${trigger === 'manual' ? 'Manual' : 'Background'} sample: ${run.sampled} PRs, ${run.drift} drift, ` +
        `${run.stale} stale, ${run.failed} failed, cost ${run.cost}`,
      'info'
    );
    save();
  }
  function start(urls: string[], trigger: 'background' | 'manual') {
    running = sample(urls, trigger)
      .then(snapshot)
      .finally(() => {
        running = undefined;
        deps.changed?.();
      });
    deps.changed?.();
    return running;
  }
  return {
    /** Called every few seconds by the sync loop. Starts a background sample when one is due. */
    tick() {
      ensure();
      if (!loaded || !state.enabled || running) return;
      const time = now();
      if (time < nextAt) return;
      if (!deps.active()) return;
      nextAt = time + DRIFT_SAMPLE_INTERVAL_MS;
      const urls = pickDriftSample({
        candidates: candidates(),
        sampledAt: state.sampledAt,
        suspects: state.suspects,
        now: time,
      });
      if (!urls.length) return;
      return start(urls, 'background');
    },
    /** The open PRs first, then the usual sample, ignoring the resample wait. */
    checkNow(open: string[] = []) {
      if (running) return running;
      ensure();
      if (!loaded || !deps.available()) return Promise.resolve(snapshot());
      for (const url of open) seen.set(url, now());
      const picked = pickDriftSample({
        candidates: candidates(),
        sampledAt: {},
        suspects: state.suspects,
        now: now(),
        limit: DRIFT_SAMPLE_SIZE,
      });
      const urls = [...new Set([...open, ...picked])].slice(0, DRIFT_SAMPLE_SIZE);
      if (!urls.length) return Promise.resolve(snapshot());
      nextAt = now() + DRIFT_SAMPLE_INTERVAL_MS;
      return start(urls, 'manual');
    },
    /** The reader opened or returned to this PR. */
    noteSeen(url: string) {
      seen.delete(url);
      seen.set(url, now());
      while (seen.size > SEEN_LIMIT) seen.delete(seen.keys().next().value as string);
    },
    setEnabled(enabled: boolean) {
      ensure();
      if (!loaded) return snapshot();
      state = { ...state, enabled };
      if (enabled) nextAt = Math.max(nextAt, now() + DRIFT_FIRST_SAMPLE_MS);
      save();
      return snapshot();
    },
    clear() {
      ensure();
      if (!loaded) return snapshot();
      state = { ...state, drifts: [], stale: [], runs: [], suspects: [] };
      save();
      return snapshot();
    },
    snapshot,
    /** The saved state, for the diagnostics export. */
    state: () => {
      ensure();
      return state;
    },
  };
}
export type DriftDetector = ReturnType<typeof createDriftDetector>;
