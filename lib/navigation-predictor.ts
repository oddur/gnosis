import type { WorkspaceTab } from './navigation-history';

/**
 * Knows where the reader is and where they are likely to go next. Screens declare likely destinations;
 * the predictor records every navigation and how long its content took to appear.
 *
 * Pure TypeScript with injected dependencies, so it runs in unit tests without a window.
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
  | { kind: 'pr-tab'; tab: WorkspaceTab; subjectId: string; members: PredictMember[] }
  | { kind: 'pr-open'; subjectId: string; members: PredictMember[] }
  | { kind: 'review'; reviewId: string; diagrams?: ('mermaid' | 'd2')[] }
  | { kind: 'chunk'; name: ChunkName };
export interface Prediction {
  destination: Destination;
  weight: number;
  strength: Strength;
}
/** Content was shown at once (hit), after a loading state while a prediction was in flight (joined), after a
 * loading state with nothing in flight (cold), or by a tab that stayed mounted from an earlier visit (kept). */
export type Outcome = 'hit' | 'joined' | 'cold' | 'kept';

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
  /** Time to content, excluding kept tabs. */
  p50: number | null;
  p95: number | null;
}
export interface PredictorSummary {
  destinations: Record<string, DestinationSummary>;
  /** Destinations reached from each previous destination kind. */
  transitions: Record<string, number>;
  /** Navigations to a declared destination / all navigations. */
  declared: { navigations: number; predicted: number };
  predictions: number;
  network: number;
  used: number;
  wasted: number;
  spend?: unknown;
}

/** What main allows now. Main keeps the budget, since several windows share one credential. */
export interface PredictionState {
  /** GNOSIS_PREDICT=off. */
  off: boolean;
  /** Hidden window, offline, idle, rate-limit backoff, or the predicted share or reserve is spent. */
  paused: boolean;
  battery: boolean;
  /** Serious or critical thermal state: committed predictions only. */
  hot: boolean;
  /** On battery or near the predicted cap: one file body per PR instead of three. */
  light: boolean;
}

export interface PredictorDependencies {
  now: () => number;
  /** One line per navigation, for `GNOSIS_PERF_TRACE`. */
  report?: (line: string) => void;
}

interface OpenNavigation {
  key: string;
  at: number;
  pending: boolean;
  predicted?: number;
  previous?: string;
}
const NAVIGATION_TIMEOUT_MS = 30_000;

export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

export function createNavigationPredictor(deps: PredictorDependencies) {
  const declared = new Map<string, Prediction[]>();
  const intents = new Map<string, Prediction>();
  const open = new Map<string, OpenNavigation>();
  let records: NavigationRecord[] = [];
  let last: string | undefined;
  let spend: unknown;

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

  return {
    /** Replaces the owner's set. An empty list clears it. Owners are screens, one per mounted view. */
    declare(owner: string, predictions: Prediction[]) {
      if (predictions.length) declared.set(owner, predictions);
      else declared.delete(owner);
    },
    /** Transient hover or focus. Pass null on leave. Callers debounce with `createRowIntent`. */
    intent(owner: string, prediction: Prediction | null) {
      if (prediction) intents.set(owner, prediction);
      else intents.delete(owner);
    },
    /**
     * The reader started a navigation. Starts the time-to-content clock at `at`, the input event time.
     * A navigation already waiting for the same destination keeps its earlier start.
     */
    navigate(key: string, at = deps.now()) {
      const existing = open.get(key);
      if (existing && deps.now() - existing.at < NAVIGATION_TIMEOUT_MS) return;
      for (const [other, navigation] of open) if (deps.now() - navigation.at >= NAVIGATION_TIMEOUT_MS) open.delete(other);
      open.set(key, { key, at, pending: false, predicted: weightOf(key), previous: last });
    },
    /** The reader left before the content appeared. */
    abandon(key: string) {
      open.delete(key);
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
        const entry = (destinations[record.kind] ??= { n: 0, hit: 0, joined: 0, cold: 0, kept: 0, p50: null, p95: null });
        entry.n++;
        entry[record.outcome]++;
        if (record.outcome !== 'kept') {
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
      return {
        destinations,
        transitions,
        declared: { navigations: records.length, predicted },
        predictions: 0,
        network: 0,
        used: 0,
        wasted: 0,
        ...(spend !== undefined ? { spend } : {}),
      };
    },
    records: () => [...records],
    /** Account change. */
    reset() {
      declared.clear();
      intents.clear();
      open.clear();
      records = [];
      last = undefined;
    },
  };
}
export type NavigationPredictor = ReturnType<typeof createNavigationPredictor>;
