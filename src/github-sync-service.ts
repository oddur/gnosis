import { noteWork } from '../lib/perf-trace';
import type {
  GitHubSyncInterest,
  GitHubSyncKind,
  GitHubSyncTarget,
  GitHubSyncUpdate,
  GitHubSyncFailure,
} from '../lib/github-sync';
/** Targets per read. Signals: one aliased query. Checks: bounded pages. Discussion: one preload. Metadata: parallel REST. */
const SYNC_BATCH: Record<GitHubSyncKind, number> = { signals: 25, checks: 5, discussion: 5, metadata: 6 };
const intervals: Record<GitHubSyncKind, number> = {
  metadata: 30_000,
  signals: 25_000,
  checks: 15_000,
  discussion: 60_000,
};
interface Task {
  kind: GitHubSyncKind;
  target: GitHubSyncTarget;
  priority: 'active' | 'visible';
  observed: boolean;
  lastObserved: number;
  lastAttempt: number;
  due: number;
  interval: number;
  signature?: string;
  pending: boolean;
  failures: number;
  version: number;
  blockedUntil?: number;
  followUpUntil?: number;
  followUpRemaining?: number;
  /** Asked for by `refreshRows`: read once at foreground automatic priority, ahead of other visible rows. */
  boosted?: boolean;
}
/** At most this many PRs per `refreshRows` call: about one screenful of queue rows, one signals request. */
export const ROW_REFRESH_LIMIT = 15;
/** A row refresh asked for before the row subscribed waits this long for its subscription. */
const ROW_REFRESH_WAIT_MS = 10_000;
/** A batched read where some targets failed alone; each failed target backs off as if it had been read by itself. */
export interface GitHubSyncRead {
  updates: GitHubSyncUpdate[];
  failed: { url: string; error: unknown }[];
}
interface Deps {
  account: () => string | null;
  enabled: () => boolean;
  backoff: (kind: GitHubSyncKind, background: boolean) => { retryAt: number; message: string } | undefined;
  read: (
    kind: GitHubSyncKind,
    targets: GitHubSyncTarget[],
    priority: 'active' | 'visible',
    requestedFollowUp: boolean,
    /** Rows the reader just switched to (`refreshRows`): foreground, automatic, and fresher than a visible row. */
    refresh?: boolean
  ) => Promise<GitHubSyncUpdate[] | GitHubSyncRead>;
  publish: (updates: GitHubSyncUpdate[]) => void;
  failed?: (failures: GitHubSyncFailure[]) => void;
  now?: () => number;
}
function signature(update: GitHubSyncUpdate) {
  // Freshness timestamps change even when the GitHub state does not.
  return JSON.stringify(update.value, (key, value: unknown) => (key === 'checkedAt' ? undefined : value));
}
/** One owner per renderer subscription; shared tasks survive navigation without restarting their cadence. */
export function createGitHubSyncService(deps: Deps) {
  const now = deps.now ?? Date.now;
  const interests = new Map<string, { account: string | null; interest: GitHubSyncInterest }>();
  const tasks = new Map<string, Task>();
  let account: string | null = null;
  let epoch = 0;
  const pendingKinds = new Set<string>();
  /** Row refreshes asked for before the row's task existed, by `kind:url`, until they expire. */
  const rowRefreshes = new Map<string, number>();
  function reconcile() {
    const nextAccount = deps.account();
    if (account !== nextAccount) {
      account = nextAccount;
      epoch++;
      tasks.clear();
      pendingKinds.clear();
      rowRefreshes.clear();
    }
    const wanted = new Map<
      string,
      { kind: GitHubSyncKind; target: GitHubSyncTarget; priority: 'active' | 'visible' }
    >();
    for (const subscription of interests.values()) {
      if (subscription.account !== account) continue;
      const { interest } = subscription;
      for (const target of interest.targets) {
        const key = `${interest.kind}:${target.url}`;
        const previous = wanted.get(key);
        if (!previous || (previous.priority === 'visible' && interest.priority === 'active'))
          wanted.set(key, { kind: interest.kind, target, priority: interest.priority });
      }
    }
    for (const task of tasks.values()) task.observed = false;
    for (const [key, value] of wanted) {
      const task = tasks.get(key);
      if (!task) {
        tasks.set(key, {
          ...value,
          observed: true,
          lastObserved: now(),
          lastAttempt: -Infinity,
          due: 0,
          interval: intervals[value.kind],
          pending: false,
          failures: 0,
          version: 0,
          boosted: (rowRefreshes.get(key) ?? -Infinity) > now(),
        });
        rowRefreshes.delete(key);
      } else {
        task.observed = true;
        task.lastObserved = now();
        if (task.priority === 'visible' && value.priority === 'active') task.due = 0;
        if (value.target.headSha && value.target.headSha !== task.target.headSha) {
          task.due = 0;
          task.version++;
        }
        task.target = value.target;
        task.priority = value.priority;
      }
    }
    for (const [key, task] of tasks)
      if (!task.observed && !task.pending && now() - task.lastObserved > 300_000) tasks.delete(key);
    for (const [key, until] of rowRefreshes) if (until <= now()) rowRefreshes.delete(key);
  }
  const followingUp = (task: Task) => (task.followUpUntil ?? 0) > now() && (task.followUpRemaining ?? 0) > 0;
  const pause = (task: Task) => deps.backoff(task.kind, !followingUp(task));
  async function tick() {
    reconcile();
    if (!account || !deps.enabled()) return;
    const generation = epoch;
    const paused: GitHubSyncFailure[] = [];
    for (const task of tasks.values()) {
      const blocked = pause(task);
      const retryAt = blocked?.retryAt ?? 0;
      if (
        blocked &&
        task.observed &&
        !task.pending &&
        task.due <= now() &&
        retryAt > now() &&
        task.blockedUntil !== retryAt
      ) {
        task.blockedUntil = retryAt;
        paused.push({
          kind: task.kind,
          url: task.target.url,
          retryAt,
          message: blocked.message,
        });
      }
    }
    if (paused.length) deps.failed?.(paused);
    const due = [...tasks.values()]
      .filter((task) => task.observed && !task.pending && task.due <= now() && (pause(task)?.retryAt ?? 0) <= now())
      .sort(
        (a, b) =>
          Number(followingUp(b)) - Number(followingUp(a)) ||
          Number(b.priority === 'active') - Number(a.priority === 'active') ||
          Number(!!b.boosted) - Number(!!a.boosted) ||
          a.due - b.due
      );
    await Promise.all(
      (Object.keys(intervals) as GitHubSyncKind[]).map(async (kind) => {
        if (pendingKinds.has(kind)) return;
        const candidates = due.filter((task) => task.kind === kind);
        if (!candidates.length) return;
        const followUp = followingUp(candidates[0]);
        const priority = followUp ? 'active' : candidates[0].priority;
        // Rows the reader just switched to are read together, apart from routine visible rows.
        const refresh = !followUp && priority === 'visible' && !!candidates[0].boosted;
        // Batch light signals and bounded check pages; leave capacity for newly active PRs. Discussions share one
        // GraphQL preload of five PRs; metadata reads run as parallel conditional REST reads, which stay free on a 304.
        const batch = candidates
          .filter((task) => followingUp(task) === followUp && (followUp || task.priority === priority) && (!refresh || !!task.boosted))
          .slice(0, SYNC_BATCH[kind]);
        const versions = batch.map((task) => task.version);
        pendingKinds.add(kind);
        batch.forEach((task) => {
          task.pending = true;
          task.boosted = false;
          task.lastAttempt = now();
          if (followUp) task.followUpRemaining = (task.followUpRemaining ?? 1) - 1;
        });
        const fail = (error: unknown, only?: Set<string>) => {
          const failures: GitHubSyncFailure[] = [];
          for (const [index, task] of batch.entries()) {
            if (task.version !== versions[index] || (only && !only.has(task.target.url))) continue;
            task.failures++;
            task.due = Math.max(
              deps.backoff(kind, !followUp)?.retryAt ?? 0,
              now() + Math.min(300_000, 15_000 * 2 ** Math.min(task.failures, 5))
            );
            failures.push({
              kind,
              url: task.target.url,
              message: error instanceof Error ? error.message : String(error),
              retryAt: task.due,
            });
          }
          if (failures.length) deps.failed?.(failures);
        };
        try {
          const read = await deps.read(
            kind,
            batch.map((task) => task.target),
            priority,
            followUp,
            refresh
          );
          if (generation !== epoch || deps.account() !== account) return;
          const updates = Array.isArray(read) ? read : read.updates;
          const failed = Array.isArray(read) ? [] : read.failed;
          for (const { url, error } of failed) fail(error, new Set([url]));
          const acceptStarted = performance.now();
          const accepted: GitHubSyncUpdate[] = [];
          for (const [index, task] of batch.entries()) {
            if (!task.observed || tasks.get(`${kind}:${task.target.url}`) !== task || task.version !== versions[index])
              continue;
            if (failed.some((failure) => failure.url === task.target.url)) continue;
            const update = updates.find((update) => update.url === task.target.url && update.kind === kind);
            if (!update) {
              task.due = now() + 60_000;
              continue;
            }
            const next = signature(update);
            const changed = next !== task.signature;
            const busy =
              update.kind === 'signals'
                ? update.value.checks.state === 'pending'
                : update.kind === 'checks' && update.value.checks.some((check) => check.status !== 'completed');
            task.interval = changed || busy ? intervals[kind] : Math.min(intervals[kind] * 4, task.interval * 2);
            const recovered = task.failures > 0 || !!task.blockedUntil;
            task.blockedUntil = undefined;
            task.signature = next;
            task.failures = 0;
            task.due =
              now() +
              Math.max(
                followUp && followingUp(task) ? (kind === 'checks' ? 5_000 : intervals[kind]) : task.interval,
                priority === 'visible' ? 120_000 : 0
              );
            // Discussion content may be unchanged, but its successful observation time is new.
            if (changed || recovered || kind === 'signals' || kind === 'checks' || kind === 'discussion') accepted.push(update);
          }
          if (accepted.length) deps.publish(accepted);
          noteWork(`github-sync accept ${kind}`, acceptStarted);
        } catch (error) {
          if (generation !== epoch || deps.account() !== account) return;
          fail(error);
        } finally {
          batch.forEach((task) => {
            task.pending = false;
          });
          if (generation === epoch) pendingKinds.delete(kind);
        }
      })
    );
  }
  return {
    observe(id: string, interest: GitHubSyncInterest | null) {
      if (interest) interests.set(id, { account: deps.account(), interest });
      else interests.delete(id);
      reconcile();
    },
    removeOwner(owner: string) {
      for (const id of interests.keys()) if (id.startsWith(`${owner}:`)) interests.delete(id);
      reconcile();
    },
    invalidate(
      urls: string[],
      kinds: GitHubSyncKind[] = Object.keys(intervals) as GitHubSyncKind[],
      options: { followUp?: boolean } = {}
    ) {
      const wanted = new Set(urls);
      for (const task of tasks.values())
        if (wanted.has(task.target.url) && kinds.includes(task.kind)) {
          task.due = 0;
          task.version++;
          if (options.followUp) {
            // Only explicit writes get a bounded allowance; passive invalidation cannot spend the reserve.
            task.followUpUntil = now() + 120_000;
            task.followUpRemaining = 4;
          }
          task.interval = intervals[task.kind];
        }
    },
    /** Returning to the app, resuming or becoming visible again: everything watched is read, at most every 30 s. */
    wake(floor = 30_000) {
      for (const task of tasks.values()) task.due = Math.min(task.due, Math.max(now(), task.lastAttempt + floor));
    },
    /**
     * The reader switched to these PRs or returned to them: read their watched kinds now, unless a read started within
     * `floor`. Returns the URLs that will be read.
     */
    refresh(urls: string[], kinds: GitHubSyncKind[], floor = 30_000) {
      const wanted = new Set(urls);
      const refreshed = new Set<string>();
      for (const task of tasks.values()) {
        if (!task.observed || !wanted.has(task.target.url) || !kinds.includes(task.kind)) continue;
        if (now() - task.lastAttempt < floor) continue;
        task.due = Math.min(task.due, now());
        refreshed.add(task.target.url);
      }
      return [...refreshed];
    },
    /**
     * The reader switched to a queue view: read its first screenful of rows now, at foreground automatic priority,
     * unless a read started within `floor`. At most `limit` PRs. Rows whose subscription has not arrived yet are read
     * when it does, within a few seconds. Returns the URLs that will be read; an empty list means everything is fresh.
     */
    refreshRows(urls: string[], kinds: GitHubSyncKind[], floor = 30_000, limit = ROW_REFRESH_LIMIT) {
      reconcile(); // An account change first, so it cannot drop this request.
      const wanted = [...new Set(urls)].slice(0, limit);
      const refreshed = new Set<string>();
      for (const url of wanted)
        for (const kind of kinds) {
          const key = `${kind}:${url}`;
          const task = tasks.get(key);
          if (!task) {
            rowRefreshes.set(key, now() + ROW_REFRESH_WAIT_MS);
            refreshed.add(url);
            continue;
          }
          if (task.pending || now() - task.lastAttempt < floor) continue;
          task.due = Math.min(task.due, now());
          task.boosted = true;
          refreshed.add(url);
        }
      while (rowRefreshes.size > 200) rowRefreshes.delete(rowRefreshes.keys().next().value as string);
      return [...refreshed];
    },
    tick,
  };
}
