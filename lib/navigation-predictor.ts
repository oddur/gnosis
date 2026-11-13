import type { WorkspaceTab } from './navigation-history';
import { PREDICTION_THRESHOLD } from './navigation-graph';
import type { PredictionState } from './github-budget';
/** What main allows now. Main keeps the budget, since several windows share one credential. */
export type { PredictionState };

/**
 * Knows where the reader is and where they are likely to go next. Screens declare likely destinations; the
 * predictor ranks them, removes duplicates, and runs the existing read paths that make them instant. It also
 * records every navigation and how long its content took to appear.
 *
 * Pure TypeScript with injected dependencies, so it runs in unit tests without a window. Main keeps the budget.
 */
export type Strength = 'committed' | 'intent' | 'ambient';
/** A PR revision, as the queue knows it. */
export interface PredictMember {
  url: string;
  headSha: string;
  baseSha: string;
  updatedAt: string;
}
export type ChunkName = 'workflow-graph' | 'mermaid' | 'd2' | 'review-page' | 'pr-summary';
export type Destination =
  /** `epoch` changes when the destination needs its reads again, such as a new failing-check count. */
  | { kind: 'pr-tab'; tab: WorkspaceTab; subjectId: string; members: PredictMember[]; epoch?: string }
  | { kind: 'pr-open'; subjectId: string; members: PredictMember[] }
  | { kind: 'review'; reviewId: string; diagrams?: ('mermaid' | 'd2')[] }
  | { kind: 'chunk'; name: ChunkName };
export interface Prediction {
  destination: Destination;
  weight: number;
  strength: Strength;
}
/** Content was shown at once (hit), after a loading state while a prediction was in flight (joined), after a
 * loading state with nothing in flight (cold), or by a tab that stayed mounted from an earlier visit (kept). The
 * reader left, or 30 s passed, before any content appeared (left): `ttcMs` is how long they waited. */
export type Outcome = 'hit' | 'joined' | 'cold' | 'kept' | 'left';

/** The destination kind, such as `pr-tab:changes`. Used for metrics and as the spend label in main. */
export function destinationKind(destination: Destination): string {
  if (destination.kind === 'pr-tab') return `pr-tab:${destination.tab}`;
  if (destination.kind === 'chunk') return `chunk:${destination.name}`;
  return destination.kind;
}
/** Identifies a destination the reader can navigate to, such as `pr-tab:changes:<subjectId>`. */
export function destinationKey(destination: Destination): string {
  if (destination.kind === 'pr-tab') return `pr-tab:${destination.tab}:${destination.subjectId}`;
  if (destination.kind === 'pr-open') return `pr-open:${destination.subjectId}`;
  if (destination.kind === 'review') return `review:${destination.reviewId}`;
  return `chunk:${destination.name}`;
}
/** `pr-tab:changes:<subject>` → `pr-tab:changes`. */
export const kindOfKey = (key: string) => (key.startsWith('pr-tab:') ? key.split(':', 2).join(':') : key.split(':', 1)[0]);

export interface PredictionConditions {
  /** The "Preload likely next pages" setting, and GNOSIS_PREDICT. */
  enabled: boolean;
  online: boolean;
  visible: boolean;
  /** A blurred window finishes committed work but starts no new intent. */
  focused: boolean;
  state: PredictionState;
}

/**
 * The only executors a prediction can reach: GitHub and disk reads plus code chunks. There is no write, generate,
 * mark-read or download function here, so a prediction cannot call one.
 */
export interface PredictorReads {
  /** The changed-file list, the commit list and the first `files` file bodies of one PR revision. */
  changes(member: PredictMember, subjectId: string, files: number, label: string): Promise<unknown>;
  changesReady(member: PredictMember, subjectId: string, files: number): boolean;
  /** Review threads and failing check details, through main's committed owner. Fresh saved copies send nothing. */
  open(members: PredictMember[], label: string): Promise<unknown>;
  /** Hover intent on a PR: the queue row's existing preparation. `null` clears it. */
  openIntent(members: PredictMember[] | null): void;
  /** The workflow run the Checks graph opens on (the member with failing checks, its failed or running run) and its graph. */
  graph(members: PredictMember[], label: string): Promise<unknown>;
  chunk(name: ChunkName): Promise<unknown>;
  /** A saved review's document, from disk. */
  review(reviewId: string): Promise<unknown>;
  reviewReady(reviewId: string): boolean;
}
export const PREDICTOR_READS = ['changes', 'changesReady', 'open', 'openIntent', 'graph', 'chunk', 'review', 'reviewReady'] as const;

export interface NavigationRecord {
  key: string;
  kind: string;
  outcome: Outcome;
  ttcMs: number;
  /** The weight this destination had in the declared set when the navigation started. */
  predicted?: number;
  previous?: string;
}
export interface DestinationSummary {
  n: number;
  hit: number;
  joined: number;
  cold: number;
  kept: number;
  left: number;
  /** Time to content, excluding kept tabs and navigations left before content. */
  p50: number | null;
  p95: number | null;
}
export interface PredictorSummary {
  destinations: Record<string, DestinationSummary>;
  /** Destinations reached from each previous destination kind. */
  transitions: Record<string, number>;
  /** Navigations to a declared destination / all navigations. */
  declared: { navigations: number; predicted: number };
  /** Destinations whose reads the predictor ran, those that needed the network, and whether they were visited. */
  predictions: number;
  network: number;
  used: number;
  wasted: number;
  spend?: unknown;
}

export interface PredictorDependencies {
  now: () => number;
  /** One line per navigation and per prediction run, for `GNOSIS_PERF_TRACE`. */
  report?: (line: string) => void;
  /** Executors. Without them the predictor only measures. */
  reads?: PredictorReads;
  conditions?: () => PredictionConditions;
  /** Requests in flight per window. */
  concurrency?: number;
}

interface OpenNavigation {
  key: string;
  at: number;
  pending: boolean;
  predicted?: number;
  previous?: string;
}
/** One read the predictor can run. Keys are revision-pinned, so a finished read never goes stale. */
interface Resource {
  key: string;
  label: string;
  strength: Strength;
  destinations: Set<string>;
  ready?: (reads: PredictorReads, files: number) => boolean;
  run: (reads: PredictorReads, files: number) => Promise<unknown>;
}
interface ResourceState {
  status: 'pending' | 'ready' | 'failed';
  at: number;
}
const NAVIGATION_TIMEOUT_MS = 30_000;
/** A resource that ran is not run again for a minute, even if its saved copy looks stale. A real visit ignores this. */
const RERUN_MS = 60_000;
const FAILED_RETRY_MS = 60_000;
const FILES = 3;
const LIGHT_FILES = 1;
const rank: Record<Strength, number> = { committed: 0, intent: 1, ambient: 2 };

export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

/** The reads that make a destination instant. Each is an existing cache or preloader entry point. */
export function resourcesFor(prediction: Prediction): Omit<Resource, 'destinations'>[] {
  const { destination, strength } = prediction;
  const label = destinationKind(destination);
  const revision = (m: PredictMember) => `${m.url}@${m.baseSha}:${m.headSha}`;
  if (destination.kind === 'pr-tab') {
    const { members, subjectId, tab } = destination;
    const open = {
      key: `open:${members.map(revision).join('|')}${destination.epoch ? `#${destination.epoch}` : ''}`,
      label,
      strength,
      run: (reads: PredictorReads) => reads.open(members, label),
    };
    const changes = members.map((member) => ({
      key: `changes:${revision(member)}`,
      label,
      strength,
      ready: (reads: PredictorReads, files: number) => reads.changesReady(member, subjectId, files),
      run: (reads: PredictorReads, files: number) => reads.changes(member, subjectId, files, label),
    }));
    if (tab === 'changes') return [...changes, open];
    if (tab === 'commits') return changes;
    if (tab === 'feedback') return [open];
    if (tab === 'checks') {
      return [
        open,
        // Keyed by the failing-check count too: which member and run the graph opens on depends on it.
        { key: `graph:${members.map(revision).join('|')}${destination.epoch ? `#${destination.epoch}` : ''}`, label, strength,
          run: (reads) => reads.graph(members, label) },
        { key: 'chunk:workflow-graph', label, strength, run: (reads) => reads.chunk('workflow-graph') },
      ];
    }
    // Explanation and local notes are local; Summary is already shown.
    return [];
  }
  if (destination.kind === 'review') {
    const id = destination.reviewId;
    return [
      { key: `review:${id}`, label, strength, ready: (reads) => reads.reviewReady(id), run: (reads) => reads.review(id) },
      { key: 'chunk:review-page', label, strength, run: (reads) => reads.chunk('review-page') },
      ...(destination.diagrams ?? []).map((name) => ({ key: `chunk:${name}`, label, strength, run: (reads: PredictorReads) => reads.chunk(name) })),
    ];
  }
  if (destination.kind === 'chunk') {
    const name = destination.name;
    return [{ key: `chunk:${name}`, label, strength, run: (reads) => reads.chunk(name) }];
  }
  // A PR open is hover intent; it is forwarded to the queue's existing preparation, not queued here.
  return [];
}

export function createNavigationPredictor(deps: PredictorDependencies) {
  const declared = new Map<string, Prediction[]>();
  const intents = new Map<string, Prediction>();
  const open = new Map<string, OpenNavigation>();
  const states = new Map<string, ResourceState>();
  /** Destinations whose reads ran: whether any needed the network, and whether the reader went there. */
  const executed = new Map<string, { network: boolean; used: boolean }>();
  const totals = { predictions: 0, network: 0, used: 0, wasted: 0 };
  let wanted: Resource[] = [];
  let byDestination = new Map<string, string[]>();
  let running = 0;
  let records: NavigationRecord[] = [];
  let last: string | undefined;
  let spend: unknown;
  let openIntentOwner: string | undefined;
  const concurrency = deps.concurrency ?? 2;

  /** The highest declared weight for a destination, from any owner. */
  function weightOf(key: string): number | undefined {
    let best: number | undefined;
    const consider = (prediction: Prediction) => {
      if (destinationKey(prediction.destination) === key) best = Math.max(best ?? 0, prediction.weight);
    };
    for (const list of declared.values()) list.forEach(consider);
    for (const prediction of intents.values()) consider(prediction);
    return best;
  }
  function allowed(strength: Strength) {
    if (!deps.reads || !deps.conditions) return false;
    const c = deps.conditions();
    if (!c.enabled || c.state.off || c.state.paused || !c.online || !c.visible) return false;
    // Ambient work belongs to the existing background queues. Intent waits for focus and a cool machine.
    if (strength === 'ambient') return false;
    return strength === 'committed' || (c.focused && !c.state.hot);
  }
  const fileCount = () => (deps.conditions?.().state.light ? LIGHT_FILES : FILES);
  /** A destination left the set. Count it once: used if the reader went there, wasted if its reads needed the network. */
  function settle(key: string) {
    const run = executed.get(key);
    if (!run) return;
    executed.delete(key);
    totals.predictions++;
    if (run.network) totals.network++;
    if (run.used) totals.used++;
    else if (run.network) totals.wasted++;
  }
  /** Rank, de-duplicate and keep the set. Work that has not started and is no longer wanted is dropped. */
  function recompute() {
    const predictions = [
      ...[...declared.values()].flat().filter((p) => p.weight >= PREDICTION_THRESHOLD && p.strength !== 'ambient'),
      ...[...intents.values()].filter((p) => p.strength !== 'ambient'),
    ].sort((a, b) => rank[a.strength] - rank[b.strength] || b.weight - a.weight);
    const byKey = new Map<string, Resource>();
    const destinations = new Map<string, string[]>();
    for (const prediction of predictions) {
      const destination = destinationKey(prediction.destination);
      for (const resource of resourcesFor(prediction)) {
        const existing = byKey.get(resource.key);
        if (existing) existing.destinations.add(destination);
        else byKey.set(resource.key, { ...resource, destinations: new Set([destination]) });
        destinations.set(destination, [...(destinations.get(destination) ?? []), resource.key]);
      }
    }
    for (const key of executed.keys()) if (!destinations.has(key)) settle(key);
    wanted = [...byKey.values()];
    byDestination = destinations;
    pump();
  }
  function startable(resource: Resource, at: number) {
    const state = states.get(resource.key);
    if (state?.status === 'pending') return false;
    if (state?.status === 'failed' && at - state.at < FAILED_RETRY_MS) return false;
    if (state?.status === 'ready' && at - state.at < RERUN_MS) return false;
    return allowed(resource.strength);
  }
  function pump() {
    const reads = deps.reads;
    if (!reads) return;
    while (running < concurrency) {
      const at = deps.now();
      const resource = wanted.find((candidate) => startable(candidate, at));
      if (!resource) return;
      const files = fileCount();
      const mark = (network: boolean) => {
        for (const destination of resource.destinations) {
          const run = executed.get(destination) ?? { network: false, used: false };
          run.network ||= network;
          executed.set(destination, run);
        }
      };
      // Warm data costs nothing.
      if (resource.ready?.(reads, files)) {
        states.set(resource.key, { status: 'ready', at });
        mark(false);
        continue;
      }
      mark(true);
      states.set(resource.key, { status: 'pending', at });
      running++;
      const started = at;
      const kind = resource.key.split(':', 1)[0];
      void Promise.resolve()
        .then(() => resource.run(reads, files))
        .then(
          () => {
            states.set(resource.key, { status: 'ready', at: deps.now() });
            deps.report?.(`run ${resource.label} ${kind} ${Math.round(deps.now() - started)}ms`);
          },
          (error: unknown) => {
            states.set(resource.key, { status: 'failed', at: deps.now() });
            deps.report?.(`run ${resource.label} ${kind} failed ${error instanceof Error ? error.message.slice(0, 80) : ''}`);
          }
        )
        .finally(() => {
          running--;
          pump();
        });
    }
  }

  return {
    /** Replaces the owner's set. An empty list clears it. Owners are screens, one per mounted view. */
    declare(owner: string, predictions: Prediction[]) {
      if (predictions.length) declared.set(owner, predictions);
      else declared.delete(owner);
      recompute();
    },
    /** Transient hover or focus. Pass null on leave. Callers debounce with `createRowIntent`. */
    intent(owner: string, prediction: Prediction | null) {
      if (prediction) intents.set(owner, prediction);
      else intents.delete(owner);
      // Opening a PR is prepared by the queue's existing hover path, at most one at a time.
      if (prediction?.destination.kind === 'pr-open') {
        if (deps.reads && allowed('intent')) {
          openIntentOwner = owner;
          deps.reads.openIntent(prediction.destination.members);
        }
      } else if (openIntentOwner === owner) {
        openIntentOwner = undefined;
        deps.reads?.openIntent(null);
      }
      recompute();
    },
    /** Conditions changed: focus, visibility, network, battery, budget or the setting. */
    wake: () => pump(),
    /**
     * The reader started a navigation. Starts the time-to-content clock at `at`, the input event time.
     * A navigation already waiting for the same destination keeps its earlier start.
     */
    navigate(key: string, at = deps.now()) {
      const run = executed.get(key);
      if (run) run.used = true;
      const existing = open.get(key);
      if (existing && deps.now() - existing.at < NAVIGATION_TIMEOUT_MS) return;
      for (const [other, navigation] of open) if (deps.now() - navigation.at >= NAVIGATION_TIMEOUT_MS) open.delete(other);
      const pending = (byDestination.get(key) ?? []).some((resource) => states.get(resource)?.status === 'pending');
      open.set(key, { key, at, pending, predicted: weightOf(key), previous: last });
    },
    /** The reader left, or gave up waiting, before the content appeared. Logged, so slow tabs are not invisible. */
    abandon(key: string, at = deps.now()) {
      const navigation = open.get(key);
      if (!navigation) return;
      open.delete(key);
      const record: NavigationRecord = {
        key,
        kind: kindOfKey(key),
        outcome: 'left',
        ttcMs: Math.max(0, Math.round(at - navigation.at)),
        ...(navigation.predicted !== undefined ? { predicted: navigation.predicted } : {}),
        ...(navigation.previous ? { previous: kindOfKey(navigation.previous) } : {}),
      };
      records.push(record);
      deps.report?.(`nav ${record.kind} left ${record.ttcMs}ms` +
        (record.predicted !== undefined ? ` predicted=${record.predicted}` : ' predicted=no') + (record.previous ? ` from=${record.previous}` : ''));
    },
    /** Whether a navigation to `key` is waiting for its content. */
    awaiting: (key: string) => open.has(key),
    /** The destination painted real content. `loading` says whether a loading state was shown first. */
    arrived(key: string, result: { loading: boolean; kept?: boolean }, at = deps.now()): NavigationRecord | undefined {
      const navigation = open.get(key);
      if (!navigation) return;
      open.delete(key);
      const outcome: Outcome = result.kept && !result.loading ? 'kept' : !result.loading ? 'hit' : navigation.pending ? 'joined' : 'cold';
      const record: NavigationRecord = {
        key,
        kind: kindOfKey(key),
        outcome,
        ttcMs: Math.max(0, Math.round(at - navigation.at)),
        ...(navigation.predicted !== undefined ? { predicted: navigation.predicted } : {}),
        ...(navigation.previous ? { previous: kindOfKey(navigation.previous) } : {}),
      };
      last = key;
      records.push(record);
      if (records.length > 2000) records = records.slice(-1000);
      deps.report?.(
        `nav ${record.kind} ${record.outcome} ${record.ttcMs}ms` +
          (record.predicted !== undefined ? ` predicted=${record.predicted}` : ' predicted=no') +
          (record.previous ? ` from=${record.previous}` : '')
      );
      return record;
    },
    /** Main's spend counters, shown in the summary. */
    setSpend(value: unknown) {
      spend = value;
    },
    summary(): PredictorSummary {
      const destinations: Record<string, DestinationSummary> = {};
      const times = new Map<string, number[]>();
      const transitions: Record<string, number> = {};
      let predicted = 0;
      for (const record of records) {
        const entry = (destinations[record.kind] ??= { n: 0, hit: 0, joined: 0, cold: 0, kept: 0, left: 0, p50: null, p95: null });
        entry.n++;
        entry[record.outcome]++;
        if (record.outcome !== 'kept' && record.outcome !== 'left') {
          const list = times.get(record.kind) ?? [];
          list.push(record.ttcMs);
          times.set(record.kind, list);
        }
        if (record.predicted !== undefined) predicted++;
        if (record.previous) transitions[`${record.previous} -> ${record.kind}`] = (transitions[`${record.previous} -> ${record.kind}`] ?? 0) + 1;
      }
      for (const [kind, list] of times) {
        destinations[kind].p50 = percentile(list, 50);
        destinations[kind].p95 = percentile(list, 95);
      }
      // Destinations still declared count too, so a summary taken while a PR is open is complete.
      const current = { ...totals };
      for (const run of executed.values()) {
        current.predictions++;
        if (run.network) current.network++;
        if (run.used) current.used++;
      }
      return {
        destinations,
        transitions,
        declared: { navigations: records.length, predicted },
        ...current,
        ...(spend !== undefined ? { spend } : {}),
      };
    },
    records: () => [...records],
    /** Nothing in flight and nothing left that may start now. For tests and the dev summary. */
    idle: () => running === 0 && !wanted.some((resource) => startable(resource, deps.now())),
    /** Resource keys the predictor wants now, in run order. For tests and the dev summary. */
    wanted: () => wanted.map((resource) => resource.key),
    /** Account change: forget declarations, measurements and which reads ran. Reads in flight finish. */
    reset() {
      declared.clear();
      intents.clear();
      open.clear();
      states.clear();
      executed.clear();
      Object.assign(totals, { predictions: 0, network: 0, used: 0, wasted: 0 });
      wanted = [];
      byDestination = new Map();
      records = [];
      last = undefined;
      if (openIntentOwner) deps.reads?.openIntent(null);
      openIntentOwner = undefined;
    },
  };
}
export type NavigationPredictor = ReturnType<typeof createNavigationPredictor>;
