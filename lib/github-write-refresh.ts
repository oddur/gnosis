import type { GitHubSyncKind } from './github-sync';
import type { QueueSignals } from './queue-signals';
import type { PrMetadata } from './types';
import { metadataShows, type PrMetadataExpectation } from './pr-people';

/**
 * Every GitHub write Gnosis makes, by what it changes. After a write, main marks the saved copies it made stale, reads
 * GitHub again at once at the interactive tier, and then, for changes GitHub applies eventually, reads again with
 * backoff until the change is visible. See `createGitHubWriteRefresher`.
 */
export type GitHubWriteAction =
  | 'merge'
  | 'merge-queue'
  | 'merge-submitted'
  | 'stack-merged'
  | 'enable-auto-merge'
  | 'disable-auto-merge'
  | 'update-branch'
  | 'mark-ready'
  | 'convert-draft'
  | 'close-pr'
  | 'submit-review'
  | 'review-comment'
  | 'thread-reply'
  | 'thread-resolve'
  | 'thread-unresolve'
  | 'comment-edit'
  | 'comment-delete'
  | 'feedback-reply'
  | 'request-review'
  | 'edit-reviewers'
  | 'edit-assignees'
  | 'edit-labels'
  | 'edit-milestone'
  | 'rerun-checks'
  | 'push'
  | 'external';

/** What one read after a write saw. Either part may be missing when its read failed or was not needed. */
export interface WriteObservation {
  metadata?: Pick<
    PrMetadata,
    | 'headSha'
    | 'state'
    | 'merged'
    | 'updatedAt'
    | 'isDraft'
    | 'mergeable'
    | 'autoMerge'
    | 'requestedReviewers'
    | 'commentCount'
    | 'reviewCommentCount'
  > &
    Partial<Pick<PrMetadata, 'requestedTeams' | 'assignees' | 'labels' | 'milestone'>>;
  signals?: Pick<QueueSignals, 'headSha' | 'checks' | 'latestReview' | 'mine' | 'readiness' | 'comments'>;
}
export interface WriteDetails {
  /** The state before the write. Main captures it from local copies before the write starts. */
  before?: WriteObservation;
  /** The submitted review's URL, from GitHub's response. */
  reviewUrl?: string;
  /** The reviewer whose review was requested. */
  reviewer?: string;
  /** What a people, label or milestone edit changed, which the PR read must show. */
  expect?: PrMetadataExpectation;
  /** The signed-in account. */
  viewer?: string;
  /** When the write finished, in ms. */
  at?: number;
}
export type WriteProbe = 'metadata' | 'signals';
export interface WriteEffect {
  /** Saved copies the write makes stale. */
  kinds: GitHubSyncKind[];
  /** Reads that show the change. Metadata comes first: signals need the head it reports. */
  probes: WriteProbe[];
  /** Watched kinds that also get the sync service's short follow-up allowance, for views that show them. */
  followUpKinds?: GitHubSyncKind[];
  /** The change is visible. Without it, the immediate read is enough. */
  seen?: (now: WriteObservation, details: WriteDetails) => boolean;
  /** Queue membership or sections can change: bring discovery forward once the change is seen. */
  queue?: boolean;
}

const ALL: GitHubSyncKind[] = ['metadata', 'signals', 'checks', 'discussion'];
const before = (details: WriteDetails) => details.before?.metadata;
const count = (value: number | undefined) => value ?? 0;
const merged = ({ metadata, signals }: WriteObservation) =>
  !!metadata?.merged || metadata?.state === 'closed' || signals?.readiness?.state === 'MERGED';
const headMoved = ({ metadata }: WriteObservation, details: WriteDetails) =>
  !!metadata && (!before(details) || metadata.headSha !== before(details)?.headSha);
const commentsAdded =
  (field: 'commentCount' | 'reviewCommentCount') =>
  ({ metadata }: WriteObservation, details: WriteDetails) =>
    !!metadata && (!before(details) || count(metadata[field]) > count(before(details)?.[field]));

const editSeen = ({ metadata }: WriteObservation, details: WriteDetails) =>
  !!metadata && (!details.expect || metadataShows(metadata, details.expect));

export const GITHUB_WRITE_EFFECTS: Record<GitHubWriteAction, WriteEffect> = {
  // The merge commit and the closed state can trail a confirmed merge.
  merge: { kinds: ALL, probes: ['metadata'], seen: merged, queue: true },
  'merge-queue': {
    kinds: ALL,
    probes: ['metadata', 'signals'],
    seen: (now) => merged(now) || !!now.signals?.readiness?.queueState,
    queue: true,
  },
  // GitHub accepted an atomic stack merge and is processing it. The merge monitor reports completion as `stack-merged`.
  'merge-submitted': { kinds: ['metadata', 'signals'], probes: ['metadata'] },
  'stack-merged': { kinds: ALL, probes: ['metadata'], seen: merged, queue: true },
  'enable-auto-merge': {
    kinds: ['metadata', 'signals'],
    probes: ['metadata'],
    seen: ({ metadata }) => !!metadata?.autoMerge || !!metadata?.merged,
  },
  'disable-auto-merge': {
    kinds: ['metadata', 'signals'],
    probes: ['metadata'],
    seen: ({ metadata }) => !!metadata && !metadata.autoMerge,
  },
  // A new head, then GitHub computes mergeability for it. New check runs follow through the checks allowance.
  'update-branch': {
    kinds: ALL,
    probes: ['metadata'],
    followUpKinds: ['signals', 'checks'],
    seen: (now, details) => headMoved(now, details) && now.metadata?.mergeable !== null && now.metadata?.mergeable !== undefined,
  },
  'mark-ready': {
    kinds: ['metadata', 'signals'],
    probes: ['metadata'],
    seen: ({ metadata }) => metadata?.isDraft === false,
    queue: true,
  },
  'convert-draft': {
    kinds: ['metadata', 'signals'],
    probes: ['metadata'],
    seen: ({ metadata }) => metadata?.isDraft === true,
    queue: true,
  },
  // The PR leaves the queue once GitHub reports it closed.
  'close-pr': {
    kinds: ALL,
    probes: ['metadata'],
    seen: ({ metadata }) => metadata?.state === 'closed',
    queue: true,
  },
  // The review decision, the latest review and the reviewer's queue section.
  'submit-review': {
    kinds: ALL,
    probes: ['metadata', 'signals'],
    // Your own latest review (`mine`) shows it even when someone else reviewed right after.
    seen: ({ signals }, details) =>
      [signals?.mine, signals?.latestReview].some((review) => {
        if (!review) return false;
        if (details.reviewUrl) return review.url === details.reviewUrl;
        return (
          !!details.viewer &&
          review.author.toLowerCase() === details.viewer.toLowerCase() &&
          Date.parse(review.submittedAt) >= (details.at ?? 0) - 120_000
        );
      }),
    queue: true,
  },
  'review-comment': {
    kinds: ['metadata', 'signals', 'discussion'],
    probes: ['metadata'],
    seen: commentsAdded('reviewCommentCount'),
  },
  'thread-reply': {
    kinds: ['metadata', 'signals', 'discussion'],
    probes: ['metadata'],
    seen: commentsAdded('reviewCommentCount'),
  },
  // GitHub returns the thread's new state with the mutation. One read is enough.
  'thread-resolve': { kinds: ['signals', 'discussion'], probes: ['metadata'] },
  'thread-unresolve': { kinds: ['signals', 'discussion'], probes: ['metadata'] },
  'comment-edit': { kinds: ['discussion'], probes: ['metadata'] },
  'comment-delete': {
    kinds: ['metadata', 'signals', 'discussion'],
    probes: ['metadata'],
    seen: ({ metadata }, details) =>
      !!metadata && (!before(details) || count(metadata.reviewCommentCount) < count(before(details)?.reviewCommentCount)),
  },
  'feedback-reply': {
    kinds: ['metadata', 'signals', 'discussion'],
    probes: ['metadata'],
    seen: commentsAdded('commentCount'),
  },
  'request-review': {
    kinds: ['metadata', 'signals', 'discussion'],
    probes: ['metadata'],
    seen: ({ metadata }, details) =>
      !!metadata &&
      (!details.reviewer ||
        metadata.requestedReviewers.some((login) => login.toLowerCase() === details.reviewer?.toLowerCase())),
    queue: true,
  },
  // Reviewers, assignees, labels and the milestone, edited from the Summary details (lib/pr-people.ts). A review
  // request moves the PR between queue sections; the others change rows, filters and the details column.
  'edit-reviewers': {
    kinds: ['metadata', 'signals', 'discussion'],
    probes: ['metadata'],
    seen: editSeen,
    queue: true,
  },
  'edit-assignees': { kinds: ['metadata'], probes: ['metadata'], seen: editSeen, queue: true },
  // Searches that filter by label or milestone catch up once GitHub shows the change.
  'edit-labels': { kinds: ['metadata'], probes: ['metadata'], seen: editSeen, queue: true },
  'edit-milestone': { kinds: ['metadata'], probes: ['metadata'], seen: editSeen, queue: true },
  // New runs start a moment after GitHub accepts a rerun.
  'rerun-checks': {
    kinds: ['checks', 'signals'],
    probes: ['metadata', 'signals'],
    followUpKinds: ['checks'],
    seen: ({ signals }) => !!signals && (signals.checks.state === 'pending' || count(signals.checks.running) > 0),
  },
  // A pushed conflict resolution or restack: a new head, then new checks for it.
  push: {
    kinds: ALL,
    probes: ['metadata'],
    followUpKinds: ['signals', 'checks'],
    seen: headMoved,
    queue: true,
  },
  // Back from GitHub after "Open on GitHub": anything could have changed. One read, no polling.
  external: { kinds: ALL, probes: ['metadata', 'signals'], queue: true },
};

/** Delays between follow-up reads after the immediate one: about a minute in total. */
export const GITHUB_WRITE_FOLLOW_UP_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000];
/** A follow-up never starts later than this after the write. */
export const GITHUB_WRITE_FOLLOW_UP_LIMIT_MS = 60_000;

/** The PR a github.com link points into, such as its files tab or a review comment. */
export function githubPrUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return;
  const match = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/([1-9]\d*)(?:[/?#]|$)/.exec(value);
  return match ? `https://github.com/${match[1]}/${match[2]}/pull/${match[3]}` : undefined;
}
const PR_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/[1-9]\d*$/;

export interface GitHubWriteEvent {
  action: GitHubWriteAction;
  urls: string[];
  /** `immediate`: the first read finished. `follow-up`: a later read finished. `settled`: the change is visible. */
  phase: 'immediate' | 'follow-up' | 'settled' | 'gave-up';
  /**
   * Set when a change signal, not a write, named the PRs (#337, #338): the notifications feed, the changed-PR
   * search, or a new head seen by a signals read. Such events use the `external` action: the change happened
   * outside Gnosis, and main has read the PRs once.
   */
  source?: 'notifications' | 'search' | 'head';
}
export interface GitHubWriteRefresherDeps {
  now?: () => number;
  setTimer?: (run: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
  /** Someone is using Gnosis: a window or the menu bar panel is visible and the computer is awake and online. */
  active: () => boolean;
  /** The signed-in credential. A change stops every follow-up. */
  account: () => string | null;
  /** Local copies only, never a request. */
  baseline: (url: string) => WriteObservation;
  /** Marks saved copies stale and schedules watched views. Local, synchronous. */
  invalidate: (urls: string[], kinds: GitHubSyncKind[], followUpKinds: GitHubSyncKind[]) => void;
  /** Reads GitHub again, bypassing saved copies, and publishes the result. */
  read: (
    probe: WriteProbe,
    target: { url: string; headSha?: string },
    phase: 'immediate' | 'follow-up',
    action: GitHubWriteAction
  ) => Promise<WriteObservation[WriteProbe] | undefined>;
  /** When GitHub reads are paused for the budget or a rate limit, the time they resume. */
  blockedUntil?: () => number | undefined;
  /** Tells every window, including the menu bar panel. */
  refreshed?: (event: GitHubWriteEvent) => void;
  /** Brings queue discovery forward. */
  queue?: () => void;
}
interface Job {
  action: GitHubWriteAction;
  url: string;
  effect: WriteEffect;
  details: WriteDetails;
  account: string | null;
  startedAt: number;
  attempt: number;
  timer?: unknown;
  done: boolean;
}

/**
 * One refresh path for every GitHub write. Per write and PR: one immediate read, then at most
 * `GITHUB_WRITE_FOLLOW_UP_MS.length` follow-up reads within `GITHUB_WRITE_FOLLOW_UP_LIMIT_MS`, only while the change is
 * not yet visible and someone is using Gnosis. A newer write to the same PR replaces the older follow-up.
 */
export function createGitHubWriteRefresher(deps: GitHubWriteRefresherDeps) {
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? ((run, ms) => setTimeout(run, ms));
  const clearTimer = deps.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  const jobs = new Map<string, Job>();

  const stop = (job: Job) => {
    job.done = true;
    if (job.timer !== undefined) clearTimer(job.timer);
    job.timer = undefined;
    if (jobs.get(job.url) === job) jobs.delete(job.url);
  };
  /** Local notifications never stop the refresh: the write already succeeded. */
  const quietly = (run: () => void) => {
    try {
      run();
    } catch {
      // Normal sync reconciles what a failed notification missed.
    }
  };
  const current = (job: Job) => !job.done && jobs.get(job.url) === job && deps.account() === job.account;

  async function observe(job: Job, phase: 'immediate' | 'follow-up'): Promise<WriteObservation> {
    const seen: WriteObservation = {};
    for (const probe of job.effect.probes) {
      try {
        if (probe === 'metadata') {
          seen.metadata = (await deps.read('metadata', { url: job.url }, phase, job.action)) as WriteObservation['metadata'];
        } else {
          const headSha = seen.metadata?.headSha ?? job.details.before?.metadata?.headSha;
          seen.signals = (await deps.read('signals', { url: job.url, headSha }, phase, job.action)) as WriteObservation['signals'];
        }
      } catch {
        // A failed read counts as an attempt. The next one, or normal sync, tries again.
      }
    }
    return seen;
  }
  function settle(job: Job, event: GitHubWriteEvent['phase']) {
    stop(job);
    // Watched views read their kinds when the write finished, possibly before GitHub showed the change. Once a
    // follow-up sees it, they read once more.
    quietly(() => {
      if (event === 'settled' && job.attempt > 0) deps.invalidate([job.url], job.effect.kinds, []);
    });
    quietly(() => {
      if (event === 'settled' && job.effect.queue) deps.queue?.();
    });
    quietly(() => deps.refreshed?.({ action: job.action, urls: [job.url], phase: event }));
  }
  function schedule(job: Job) {
    if (!current(job)) return;
    const deadline = job.startedAt + GITHUB_WRITE_FOLLOW_UP_LIMIT_MS;
    const delay = job.attempt < GITHUB_WRITE_FOLLOW_UP_MS.length ? GITHUB_WRITE_FOLLOW_UP_MS[job.attempt] : Infinity;
    if (now() + delay > deadline) {
      settle(job, 'gave-up');
      return;
    }
    job.timer = setTimer(() => {
      job.timer = undefined;
      void followUp(job);
    }, delay);
  }
  async function followUp(job: Job) {
    if (!current(job)) return;
    // Never poll while nobody uses Gnosis. Focus, the menu bar panel and normal sync catch up later.
    if (!deps.active()) {
      settle(job, 'gave-up');
      return;
    }
    const blocked = deps.blockedUntil?.() ?? 0;
    if (blocked > now()) {
      const deadline = job.startedAt + GITHUB_WRITE_FOLLOW_UP_LIMIT_MS;
      if (blocked > deadline) {
        settle(job, 'gave-up');
        return;
      }
      // Waiting for the budget does not use up an attempt.
      job.timer = setTimer(() => {
        job.timer = undefined;
        void followUp(job);
      }, blocked - now());
      return;
    }
    job.attempt++;
    const seen = await observe(job, 'follow-up');
    if (!current(job)) return;
    if (job.effect.seen?.(seen, job.details) !== false) {
      settle(job, 'settled');
      return;
    }
    quietly(() => deps.refreshed?.({ action: job.action, urls: [job.url], phase: 'follow-up' }));
    schedule(job);
  }

  return {
    /** Local copies of the PRs before a write, to compare with what GitHub reports after it. */
    capture(urls: string[]): Map<string, WriteObservation> {
      return new Map(urls.filter((url) => PR_URL.test(url)).map((url) => [url, deps.baseline(url)]));
    },
    /**
     * Marks the write's saved copies stale, reads the PRs again at once and starts the follow-up. Resolves when the
     * immediate read has finished; it never rejects.
     */
    async after(
      action: GitHubWriteAction,
      urls: string[],
      details: WriteDetails | ((url: string) => WriteDetails) = {},
      options: { followUp?: boolean } = {}
    ): Promise<void> {
      const effect = GITHUB_WRITE_EFFECTS[action];
      const targets = [...new Set(urls)].filter((url) => PR_URL.test(url));
      if (!targets.length) return;
      quietly(() => deps.invalidate(targets, effect.kinds, effect.followUpKinds ?? []));
      const account = deps.account();
      const started = targets.map((url) => {
        const own = typeof details === 'function' ? details(url) : details;
        const job: Job = {
          action,
          url,
          effect,
          details: { at: now(), ...own, before: own.before ?? deps.baseline(url) },
          account,
          startedAt: now(),
          attempt: 0,
          done: false,
        };
        const previous = jobs.get(url);
        if (previous) stop(previous);
        jobs.set(url, job);
        return job;
      });
      await Promise.all(
        started.map(async (job) => {
          const seen = await observe(job, 'immediate');
          if (!current(job)) return;
          quietly(() => deps.refreshed?.({ action, urls: [job.url], phase: 'immediate' }));
          if (!job.effect.seen || job.effect.seen(seen, job.details)) settle(job, 'settled');
          else if (options.followUp === false) settle(job, 'gave-up');
          else schedule(job);
        })
      );
    },
    /** Follow-ups in progress, for diagnostics and tests. */
    pending: () => [...jobs.values()].map((job) => ({ action: job.action, url: job.url, attempt: job.attempt })),
    /** Stops every follow-up, such as after sign-out. */
    cancel() {
      for (const job of [...jobs.values()]) stop(job);
    },
  };
}
