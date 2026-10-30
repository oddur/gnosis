import type {
  GitHubSyncInterest,
  GitHubSyncKind,
  GitHubSyncTarget,
  GitHubSyncUpdate,
  GitHubSyncFailure,
} from '../lib/github-sync';
const intervals: Record<GitHubSyncKind, number> = {
  metadata: 30_000,
  signals: 25_000,
  checks: 30_000,
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
}
interface Deps {
  account: () => string | null;
  enabled: () => boolean;
  backoff: (kind?: GitHubSyncKind) => number;
  read: (
    kind: GitHubSyncKind,
    targets: GitHubSyncTarget[],
    priority: 'active' | 'visible'
  ) => Promise<GitHubSyncUpdate[]>;
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
  function reconcile() {
    const nextAccount = deps.account();
    if (account !== nextAccount) {
      account = nextAccount;
      epoch++;
      tasks.clear();
      pendingKinds.clear();
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
        });
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
  }
  async function tick() {
    reconcile();
    if (!account || !deps.enabled()) return;
    const generation = epoch;
    const paused: GitHubSyncFailure[] = [];
    for (const task of tasks.values()) {
      const retryAt = deps.backoff(task.kind);
      if (task.observed && !task.pending && task.due <= now() && retryAt > now() && task.blockedUntil !== retryAt) {
        task.blockedUntil = retryAt;
        paused.push({
          kind: task.kind,
          url: task.target.url,
          retryAt,
          message:
            'GitHub updates are paused by the API limit. Saved data is still available; updates will resume automatically.',
        });
      }
    }
    if (paused.length) deps.failed?.(paused);
    const due = [...tasks.values()]
      .filter((task) => task.observed && !task.pending && task.due <= now() && deps.backoff(task.kind) <= now())
      .sort((a, b) => Number(b.priority === 'active') - Number(a.priority === 'active') || a.due - b.due);
    await Promise.all(
      (Object.keys(intervals) as GitHubSyncKind[]).map(async (kind) => {
        if (pendingKinds.has(kind)) return;
        const candidates = due.filter((task) => task.kind === kind);
        if (!candidates.length) return;
        const priority = candidates[0].priority;
        // Only signals have a batched GraphQL endpoint. Keep other work small so newly active PRs can run next.
        const batch = candidates.filter((task) => task.priority === priority).slice(0, kind === 'signals' ? 25 : 1);
        const versions = batch.map((task) => task.version);
        pendingKinds.add(kind);
        batch.forEach((task) => {
          task.pending = true;
          task.lastAttempt = now();
        });
        try {
          const updates = await deps.read(
            kind,
            batch.map((task) => task.target),
            priority
          );
          if (generation !== epoch || deps.account() !== account) return;
          const accepted: GitHubSyncUpdate[] = [];
          for (const [index, task] of batch.entries()) {
            if (!task.observed || tasks.get(`${kind}:${task.target.url}`) !== task || task.version !== versions[index])
              continue;
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
            task.due = now() + Math.max(task.interval, priority === 'visible' ? 120_000 : 0);
            if (changed || recovered || kind === 'signals' || kind === 'checks') accepted.push(update);
          }
          if (accepted.length) deps.publish(accepted);
        } catch (error) {
          if (generation !== epoch || deps.account() !== account) return;
          const failures: GitHubSyncFailure[] = [];
          for (const [index, task] of batch.entries()) {
            if (task.version !== versions[index]) continue;
            task.failures++;
            task.due = Math.max(
              deps.backoff(kind),
              now() + Math.min(300_000, 15_000 * 2 ** Math.min(task.failures, 5))
            );
            failures.push({
              kind,
              url: task.target.url,
              message: error instanceof Error ? error.message : String(error),
              retryAt: task.due,
            });
          }
          deps.failed?.(failures);
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
    invalidate(urls: string[], kinds: GitHubSyncKind[] = Object.keys(intervals) as GitHubSyncKind[]) {
      const wanted = new Set(urls);
      for (const task of tasks.values())
        if (wanted.has(task.target.url) && kinds.includes(task.kind)) {
          task.due = 0;
          task.version++;
          task.interval = intervals[task.kind];
        }
    },
    wake() {
      for (const task of tasks.values()) task.due = Math.min(task.due, Math.max(now(), task.lastAttempt + 10_000));
    },
    tick,
  };
}
