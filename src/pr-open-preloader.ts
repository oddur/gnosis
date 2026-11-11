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

export interface PrOpenPreloaderDependencies {
  /** Queue tiers: signed in, window visible, and no GraphQL backoff or reserve. */
  canRun: () => boolean;
  /** Hover and focus: signed in, window visible, and no hard GraphQL backoff. */
  canIntent: () => boolean;
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
  async function prefetch(target: OpenTarget, needed: Set<OpenKind | 'details'>) {
    const jobs: Promise<unknown>[] = [];
    if (needed.has('status')) jobs.push(deps.status([target], true));
    if (needed.has('signals')) jobs.push(deps.signals([target], true));
    // A click joins this shared read and promotes it.
    if (needed.has('threads')) jobs.push(deps.threadsFull(target.url, true));
    jobs.push(
      (needed.has('checks') ? deps.checks([target], true) : Promise.resolve()).then(() =>
        deps.need(target, 'details') ? deps.checkDetails(target) : undefined
      )
    );
    await Promise.allSettled(jobs);
  }
  async function runIntent(): Promise<void> {
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
      dirty = true;
    },
    /** Replaces any queued intent. A request already in flight finishes and is saved. */
    setIntent(owner: string, targets: OpenTarget[] | null) {
      if (!targets?.length) {
        if (queued?.owner === owner) queued = undefined;
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
      pausedUntil = 0;
      dirty = true;
    },
    async tick() {
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
