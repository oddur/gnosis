import { githubRateLimit } from '../lib/github-client';
import { withGitHubPriority } from '../lib/github-scheduler';
import type { OpenTarget } from '../lib/pr-open-targets';

export type OpenKind = 'status' | 'signals' | 'checks' | 'threads';
/** The identity and age of a saved copy. `running` is set for check lists with unfinished checks. */
export interface SavedCopy {
  headSha: string;
  baseSha?: string;
  checkedAt: number;
  revalidate?: boolean;
  running?: boolean;
}
const MINUTE = 60_000;
const MAX_AGE_MS = 6 * 60 * MINUTE;
const RUNNING_CHECKS_MS = 10 * MINUTE;

/** Stateless, so it survives restarts. A copy is refreshed well inside the 24-hour limit for showing it. */
export function needsRefresh(kind: OpenKind, saved: SavedCopy | undefined, target: OpenTarget, now: number) {
  if (!saved || saved.revalidate || saved.headSha !== target.headSha) return true;
  if (saved.baseSha !== undefined && saved.baseSha !== target.baseSha) return true;
  if (Date.parse(target.updatedAt) > saved.checkedAt - 5000) return true;
  const age = now - saved.checkedAt;
  if (age < 0 || age > MAX_AGE_MS) return true;
  return kind === 'checks' && !!saved.running && target.tier <= 1 && age > RUNNING_CHECKS_MS;
}

/** Queue preloading: automatic, paced, and charged to the automatic budget. */
export const queuePriority = <T>(operation: () => Promise<T>) => withGitHubPriority('background', operation);
/** Hover and focus prefetch: ahead of background work, outside automatic pacing, never in an interactive slot. */
export const intentPriority = <T>(operation: () => Promise<T>) =>
  withGitHubPriority('foreground', operation, { automatic: false });
/**
 * Committed navigation predictions, such as the open PR's threads and failing check details: foreground, never
 * interactive, unpaced, and charged to the predicted budget under `label`.
 */
export const predictedPriority = <T>(label: string, operation: () => Promise<T>) =>
  withGitHubPriority('foreground', operation, { automatic: false, predicted: label });

export interface PrOpenPreloaderDependencies {
  /** Queue tiers: signed in, window visible, and no GraphQL backoff or reserve. */
  canRun: () => boolean;
  /** Hover and focus: signed in, window visible, and no hard GraphQL backoff. */
  canIntent: () => boolean;
  /** Committed predictions: signed in, window visible, not idle, and inside the predicted budget. */
  canPredict?: () => boolean;
  /** Settings › Preloading › "Prepare the top of the queue". Off: no queue tier runs. */
  queueEnabled?: () => boolean;
  /** Settings › Preloading › "Preload likely next pages". Off: hover and focus intent send nothing. */
  intentEnabled?: () => boolean;
  /** Whether committed predictions read failing check details. Light reads threads only. */
  committedDetails?: () => boolean;
  usage: () => { spent: number; limit: number };
  idleSeconds: () => number;
  /** `details` is used by hover prefetch only: failing checks without fresh details. */
  need: (target: OpenTarget, kind: OpenKind | 'details') => boolean;
  status: (targets: OpenTarget[], intent: boolean) => Promise<unknown>;
  signals: (targets: OpenTarget[], intent: boolean) => Promise<unknown>;
  checks: (targets: OpenTarget[], intent: boolean) => Promise<unknown>;
  threads: (urls: string[]) => Promise<{ incomplete: string[] }>;
  threadsFull: (url: string, intent: boolean) => Promise<unknown>;
  checkDetails: (target: OpenTarget) => Promise<unknown>;
  now?: () => number;
}
type Step = { kind: OpenKind | 'full'; batch: OpenTarget[] };
const steps = [
  { kind: 'status', size: 25, window: 100 },
  { kind: 'signals', size: 25, window: 100 },
  { kind: 'checks', size: 5, window: 40 },
  { kind: 'threads', size: 5, window: 40 },
] as const;
const kinds: (OpenKind | 'details')[] = ['status', 'signals', 'checks', 'threads', 'details'];
const BUCKET = 3;
const REFILL_MS = 5000;
const HOURLY_INTENTS = 60;

/**
 * Saves status, signals, check summaries and discussions for queue PRs before they are opened. One
 * request at a time, in tier order. Hover and focus prefetch one row at a time, bounded by a token bucket.
 */
export function createPrOpenPreloader(deps: PrOpenPreloaderDependencies) {
  const now = deps.now ?? Date.now;
  const owners = new Map<string, OpenTarget[]>();
  const retries = new Map<string, { at: number; delay: number }>();
  const incomplete = new Set<string>();
  let running = false,
    epoch = 0,
    pausedUntil = 0,
    dirty = true,
    recheckAt = 0;
  let queued: { owner: string; targets: OpenTarget[] } | undefined;
  // Committed predictions, one set per owner (`<window>:committed`). A hover never replaces them.
  const committed = new Map<string, { targets: OpenTarget[]; label: string; done: (() => void)[] }>();
  let committedRunning = false;
  let intentRunning = false,
    tokens = BUCKET,
    refilledAt = now();
  const intentStarts: number[] = [];

  function ordered(): OpenTarget[] {
    const best = new Map<string, { target: OpenTarget; index: number }>();
    let index = 0;
    for (const list of owners.values())
      for (const target of list) {
        const previous = best.get(target.url);
        if (!previous || target.tier < previous.target.tier) best.set(target.url, { target, index: previous?.index ?? index });
        index++;
      }
    return [...best.values()]
      .sort((a, b) => a.target.tier - b.target.tier || a.index - b.index)
      .map(({ target }) => target)
      .filter((target) => target.tier !== 0); // The open PR is already synced.
  }
  const ready = (key: string) => (retries.get(key)?.at ?? 0) <= now();
  function retryLater(key: string) {
    const previous = retries.get(key);
    const delay = previous ? Math.min(10 * MINUTE, previous.delay * 2) : MINUTE;
    retries.set(key, { at: now() + delay, delay });
  }
  function nextStep(targets: OpenTarget[]): Step | undefined {
    const memo = new Map<string, boolean>();
    const need = (target: OpenTarget, kind: OpenKind) => {
      const id = `${kind}:${target.url}`;
      if (!memo.has(id)) memo.set(id, deps.need(target, kind));
      return memo.get(id) === true;
    };
    for (const step of steps) {
      const batch = targets
        .slice(0, step.window)
        .filter(
          (target) =>
            !(step.kind === 'threads' && incomplete.has(target.url)) &&
            ready(`${step.kind}:${target.url}`) &&
            need(target, step.kind)
        )
        .slice(0, step.size);
      if (batch.length) return { kind: step.kind, batch };
    }
    const full = targets
      .slice(0, 40)
      .find((target) => incomplete.has(target.url) && ready(`full:${target.url}`) && need(target, 'threads'));
    if (full) return { kind: 'full', batch: [full] };
  }
  async function run(step: Step) {
    const { kind, batch } = step;
    if (kind === 'status') await deps.status(batch, false);
    else if (kind === 'signals') await deps.signals(batch, false);
    else if (kind === 'checks') await deps.checks(batch, false);
    else if (kind === 'full') await deps.threadsFull(batch[0].url, false);
    else {
      const result = await deps.threads(batch.map((target) => target.url));
      for (const url of result.incomplete) incomplete.add(url);
    }
  }
  const queueAllowed = () => {
    if (deps.queueEnabled?.() === false) return false;
    if (pausedUntil > now() || !deps.canRun()) return false;
    const usage = deps.usage();
    // Half of the automatic GraphQL budget stays for signals, checks and discussion sync.
    return usage.spent < 0.5 * usage.limit && deps.idleSeconds() < 300;
  };

  function refill() {
    const time = now();
    tokens = Math.min(BUCKET, tokens + Math.max(0, time - refilledAt) / REFILL_MS);
    refilledAt = time;
    while (intentStarts.length && intentStarts[0] <= time - 60 * MINUTE) intentStarts.shift();
  }
  /** `details`: read failing check details too, checked again after the check list. Light skips them. */
  async function prefetch(target: OpenTarget, needed: Set<OpenKind | 'details'>, details = true) {
    const jobs: Promise<unknown>[] = [];
    if (needed.has('status')) jobs.push(deps.status([target], true));
    if (needed.has('signals')) jobs.push(deps.signals([target], true));
    // A click joins this shared read and promotes it.
    if (needed.has('threads')) jobs.push(deps.threadsFull(target.url, true));
    jobs.push(
      (needed.has('checks') ? deps.checks([target], true) : Promise.resolve()).then(() =>
        details && deps.need(target, 'details') ? deps.checkDetails(target) : undefined
      )
    );
    await Promise.allSettled(jobs);
  }
  /**
   * Committed work for the open PR skips status and signals: live sync revalidates them on open. At the Light
   * amount it skips failing check details too.
   */
  const committedKinds = (target: OpenTarget): (OpenKind | 'details')[] => {
    const list: (OpenKind | 'details')[] = target.tier === 0 ? ['threads', 'details'] : kinds;
    return deps.committedDetails?.() === false ? list.filter((kind) => kind !== 'details') : list;
  };
  const intentEnabled = () => deps.intentEnabled?.() !== false;
  const settle = (entry: { done: (() => void)[] } | undefined) => entry?.done.splice(0).forEach((done) => done());
  async function runCommitted(): Promise<void> {
    if (committedRunning || !committed.size) return;
    if (!(deps.canPredict ?? deps.canIntent)()) {
      // Nothing starts while paused. The renderer declares again when it can run.
      for (const entry of committed.values()) settle(entry);
      committed.clear();
      return;
    }
    const [owner, entry] = committed.entries().next().value as [string, { targets: OpenTarget[]; label: string; done: (() => void)[] }];
    committed.delete(owner);
    const work = entry.targets.flatMap((target) => {
      const allowed = committedKinds(target);
      const needed = new Set(allowed.filter((kind) => deps.need(target, kind)));
      return needed.size ? [{ target, needed, details: allowed.includes('details') }] : [];
    });
    if (!work.length) {
      // Fresh saved copies: nothing to send, and no allowance spent.
      settle(entry);
      return runCommitted();
    }
    committedRunning = true;
    const generation = epoch;
    try {
      await predictedPriority(entry.label, () => Promise.allSettled(work.map(({ target, needed, details }) => prefetch(target, needed, details))));
    } finally {
      committedRunning = false;
      if (generation === epoch) dirty = true;
      settle(entry);
      void runCommitted();
    }
  }
  async function runIntent(): Promise<void> {
    if (queued && !intentEnabled()) queued = undefined;
    if (intentRunning || !queued || !deps.canIntent()) return;
    const work = queued.targets.flatMap((target) => {
      const needed = new Set(kinds.filter((kind) => deps.need(target, kind)));
      return needed.size ? [{ target, needed }] : [];
    });
    // Fresh saved copies: nothing to send, and no allowance spent.
    if (!work.length) {
      queued = undefined;
      return;
    }
    refill();
    if (intentStarts.length >= HOURLY_INTENTS) {
      queued = undefined;
      return;
    }
    // Wait for a token; a newer intent replaces this one meanwhile.
    if (tokens < 1) return;
    tokens--;
    intentStarts.push(now());
    queued = undefined;
    intentRunning = true;
    const generation = epoch;
    try {
      await Promise.allSettled(work.map(({ target, needed }) => prefetch(target, needed)));
    } finally {
      intentRunning = false;
      if (generation === epoch) dirty = true;
      void runIntent();
    }
  }

  return {
    setTargets(owner: string, targets: OpenTarget[]) {
      owners.set(owner, targets);
      const urls = new Set(ordered().map((target) => target.url));
      for (const url of incomplete) if (!urls.has(url)) incomplete.delete(url);
      for (const key of retries.keys()) if (!urls.has(key.slice(key.indexOf(':') + 1))) retries.delete(key);
      dirty = true;
    },
    removeOwner(owner: string) {
      owners.delete(owner);
      if (queued?.owner === owner) queued = undefined;
      for (const key of [owner, `${owner}:committed`]) {
        settle(committed.get(key));
        committed.delete(key);
      }
      dirty = true;
    },
    /**
     * Committed predictions for `owner`, such as the open PR. They may target the open PR, which queue tiers skip,
     * run ahead of hover intent, and spend the predicted budget instead of the hover bucket. Replaces the owner's
     * queued set; work in flight finishes and is saved. Resolves when this set has run or was replaced.
     */
    setCommitted(owner: string, targets: OpenTarget[] | null, label = 'pr-open'): Promise<void> {
      settle(committed.get(owner));
      committed.delete(owner);
      if (!targets?.length) return Promise.resolve();
      return new Promise<void>((resolve) => {
        committed.set(owner, { targets: targets.slice(0, 5), label, done: [resolve] });
        void runCommitted();
      });
    },
    /** Replaces any queued intent. A request already in flight finishes and is saved. */
    setIntent(owner: string, targets: OpenTarget[] | null) {
      if (!targets?.length) {
        if (queued?.owner === owner) queued = undefined;
        return;
      }
      if (!intentEnabled()) {
        queued = undefined;
        return;
      }
      queued = { owner, targets: targets.slice(0, 5) };
      void runIntent();
    },
    /** After an account change. Targets stay, since the renderer resends them only when the queue changes. */
    clear() {
      epoch++;
      retries.clear();
      incomplete.clear();
      queued = undefined;
      for (const entry of committed.values()) settle(entry);
      committed.clear();
      pausedUntil = 0;
      dirty = true;
    },
    async tick() {
      void runCommitted();
      void runIntent();
      if (running) return;
      running = true;
      const generation = epoch;
      try {
        while (generation === epoch && queueAllowed()) {
          // Without new targets or results, re-evaluate at most once a minute or at the next retry.
          if (!dirty && now() < recheckAt) break;
          const step = nextStep(ordered());
          if (!step) {
            dirty = false;
            const next = Math.min(...[...retries.values()].map((retry) => retry.at).filter((at) => at > now()));
            recheckAt = Math.min(now() + MINUTE, next);
            break;
          }
          const keys = step.batch.map((target) => `${step.kind}:${target.url}`);
          try {
            await run(step);
            if (generation !== epoch) break;
            // A copy that is still out of date, for example after a skipped head, waits before the next try.
            const kind = step.kind === 'full' ? 'threads' : step.kind;
            for (const [i, target] of step.batch.entries()) {
              if (kind === 'threads' && step.kind === 'threads' && incomplete.has(target.url)) continue;
              if (deps.need(target, kind)) retryLater(keys[i]);
              else retries.delete(keys[i]);
            }
          } catch (error) {
            if (generation !== epoch) break;
            const limited = githubRateLimit(error, now());
            if (limited) {
              pausedUntil = Math.max(pausedUntil, limited.retryAt);
              break;
            }
            // A failed discussion batch retries its PRs one at a time.
            if (step.kind === 'threads') for (const target of step.batch) incomplete.add(target.url);
            else keys.forEach(retryLater);
          }
        }
      } finally {
        running = false;
      }
    },
  };
}
export type PrOpenPreloader = ReturnType<typeof createPrOpenPreloader>;
