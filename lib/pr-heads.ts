/**
 * A PR's head commit is the main invalidation trigger (#339). Every saved copy of checks, signals, mergeability,
 * changes, review evidence, explanations and briefings belongs to one head. Whenever any read reveals a new head,
 * main drops what belongs to the old one, refreshes the open views and tells every window, in one place:
 * `noteHeadSha` in src/main.ts. Readers in lib only report what they saw through `reportPrHead`.
 */

/** Where a head was seen. Only for logs and for skipping a read that already happened. */
export type HeadSource = 'metadata' | 'status' | 'signals' | 'search' | 'notification' | 'discovery' | 'write';

export interface HeadObservation {
  /** When GitHub last changed the PR, if the read reported it. Orders reads that arrive out of order. */
  updatedAt?: string;
  source: HeadSource;
}

export interface HeadChange {
  url: string;
  from: string;
  to: string;
  source: HeadSource;
}

const SHA = /^[a-f\d]{40}$|^[a-f\d]{64}$/i;
/** Older heads remembered per PR, so a slow read of an older head cannot flip it back. */
const HISTORY = 4;
const LIMIT = 2_000;

interface Entry {
  sha: string;
  updatedAt?: number;
  previous: string[];
}

const time = (value: string | undefined) => {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
};

/**
 * The last head seen for each PR. `note` returns a change only when a PR moves to a head that is not the current one
 * and not an older head reported again by a slower read. The first head seen for a PR is a change only when local
 * data already knew a different head, such as a queue saved before a push.
 */
export function createHeadTracker(deps: { known?: (url: string) => { headSha: string; updatedAt?: string } | undefined } = {}) {
  const heads = new Map<string, Entry>();
  return {
    note(url: string, sha: string, observation: HeadObservation): HeadChange | undefined {
      if (!SHA.test(sha)) return;
      const at = time(observation.updatedAt);
      let entry = heads.get(url);
      if (!entry) {
        const known = deps.known?.(url);
        entry = known && SHA.test(known.headSha) ? { sha: known.headSha, updatedAt: time(known.updatedAt), previous: [] } : undefined;
        if (!entry) {
          heads.set(url, { sha, updatedAt: at, previous: [] });
          while (heads.size > LIMIT) heads.delete(heads.keys().next().value as string);
          return;
        }
        heads.set(url, entry);
      }
      if (entry.sha === sha) {
        if (at !== undefined && (entry.updatedAt === undefined || at > entry.updatedAt)) entry.updatedAt = at;
        return;
      }
      // An older head again: a read that started before the push. A force push back to it is newer than the push.
      if (entry.previous.includes(sha) && (at === undefined || entry.updatedAt === undefined || at <= entry.updatedAt)) return;
      // A read older than the current head's report cannot replace it.
      if (at !== undefined && entry.updatedAt !== undefined && at < entry.updatedAt) return;
      const from = entry.sha;
      entry.previous = [from, ...entry.previous.filter((value) => value !== sha && value !== from)].slice(0, HISTORY);
      entry.sha = sha;
      entry.updatedAt = at ?? entry.updatedAt;
      // Most recently changed last, so the size limit drops quiet PRs first.
      heads.delete(url);
      heads.set(url, entry);
      return { url, from, to: sha, source: observation.source };
    },
    current: (url: string) => heads.get(url)?.sha,
    /** A new account starts with no heads. */
    clear: () => heads.clear(),
  };
}

/** What main does when a head changes. Each step is local and synchronous, apart from the PR read it may queue. */
export interface HeadInvalidationDeps {
  known?: (url: string) => { headSha: string; updatedAt?: string } | undefined;
  /** Saved copies keyed to the old head: signals (mergeability, review decision, latest review) and checks. */
  dropSaved: (url: string, oldHead: string) => void;
  /** Review evidence: thread positions and outdated flags follow the head. */
  dropThreads: (url: string) => void;
  /** Views that watch the PR read these kinds again for the new head. */
  invalidateViews: (url: string, kinds: ('signals' | 'checks' | 'discussion')[]) => void;
  /** Reads the whole PR. Only for sources that did not return it. */
  readPr: (url: string) => void;
  /** Every window: open views refresh, explanations and briefings show they are outdated. */
  broadcast: (change: HeadChange) => void;
  log?: (line: string) => void;
}
/**
 * `noteHeadSha`: the one place a new head invalidates everything keyed to the old one. Returns the change, if any.
 */
export function createHeadInvalidation(deps: HeadInvalidationDeps) {
  const tracker = createHeadTracker({ known: deps.known });
  return {
    note(url: string, sha: string, observation: HeadObservation): HeadChange | undefined {
      const change = tracker.note(url, sha, observation);
      if (!change) return;
      deps.dropSaved(url, change.from);
      deps.dropThreads(url);
      deps.invalidateViews(url, ['signals', 'checks', 'discussion']);
      // A signals read names only the head. Every other source returned the whole PR or refreshes it next.
      if (observation.source === 'signals') deps.readPr(url);
      deps.log?.(
        `[heads] ${url} moved from ${change.from.slice(0, 7)} to ${change.to.slice(0, 7)} (seen by ${change.source}). Dropped old-head signals, checks and threads.`
      );
      deps.broadcast(change);
      return change;
    },
    current: tracker.current,
    clear: tracker.clear,
  };
}

type HeadReporter =(client: unknown, url: string, sha: string, observation: HeadObservation) => void;
let reporter: HeadReporter | undefined;
/** Main registers the one place heads go. Tests register their own or none. */
export function setPrHeadReporter(next: HeadReporter | undefined) {
  reporter = next;
}
/** A read saw this head. Never throws: reporting must not fail the read that saw it. */
export function reportPrHead(client: unknown, url: string, sha: string, observation: HeadObservation) {
  try {
    reporter?.(client, url, sha, observation);
  } catch (error) {
    console.warn('[heads] Could not apply a new head:', error instanceof Error ? error.message : error);
  }
}
