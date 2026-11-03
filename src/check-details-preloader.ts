import {
  checkGroup,
  checkKey,
  checkVersion,
  type CheckTarget,
  type CheckDetails,
  type PrChecks,
  type PrCheck,
} from '../lib/pr-checks';

/** One background job at a time; observations replace queued work when selection changes. */
export function createCheckDetailsPreloader(deps: {
  canRun: () => boolean;
  fresh: (snapshot: PrChecks, check: PrCheck) => boolean;
  read: (snapshot: PrChecks, check: PrCheck) => Promise<CheckDetails | undefined>;
  publish: (snapshot: PrChecks) => void;
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  let targets = new Set<string>();
  const snapshots = new Map<string, PrChecks>();
  const retries = new Map<string, number>();
  const completed = new Set<string>();
  let running = false,
    epoch = 0;
  const rank = { attention: 0, running: 1, passed: 2, skipped: 3 };
  return {
    clear() {
      epoch++;
      targets.clear();
      snapshots.clear();
      retries.clear();
      completed.clear();
    },
    setTargets(next: CheckTarget[]) {
      targets = new Set(next.map(checkKey));
      for (const key of snapshots.keys()) if (!targets.has(key)) snapshots.delete(key);
      for (const key of completed)
        if (![...targets].some((target) => key.startsWith(target + ':'))) completed.delete(key);
      for (const key of retries.keys())
        if (![...targets].some((target) => key.startsWith(target + ':'))) retries.delete(key);
    },
    observe(snapshot: PrChecks) {
      const key = checkKey(snapshot);
      if (targets.has(key) && snapshot.checkedAt >= (snapshots.get(key)?.checkedAt ?? -1))
        snapshots.set(key, { ...snapshot, details: undefined });
    },
    async tick() {
      if (running || !deps.canRun()) return;
      running = true;
      const generation = epoch,
        visited = new Set<string>();
      try {
        while (generation === epoch && deps.canRun()) {
          const candidates = [...snapshots.values()]
            .flatMap((snapshot) =>
              snapshot.checks
                .filter((check) => check.kind === 'check')
                .map((check) => ({ snapshot, check, key: `${checkKey(snapshot)}:${check.id}:${checkVersion(check)}` }))
            )
            .filter(
              ({ snapshot, check, key }) =>
                !visited.has(key) &&
                !completed.has(key) &&
                (retries.get(key) ?? 0) <= now() &&
                !deps.fresh(snapshot, check)
            )
            .sort((a, b) => rank[checkGroup(a.check)] - rank[checkGroup(b.check)]);
          const next = candidates.at(0);
          if (!next) break;
          visited.add(next.key);
          try {
            const result = await deps.read(next.snapshot, next.check);
            // A large stack can exceed cache capacity. Do not repeatedly download
            // completed jobs after eviction; explicit selection can reload one.
            if (
              generation === epoch &&
              targets.has(checkKey(next.snapshot)) &&
              next.check.status === 'completed' &&
              result?.state?.status === 'completed' &&
              !result.warning
            )
              completed.add(next.key);
            retries.delete(next.key);
            const latest = snapshots.get(checkKey(next.snapshot));
            if (generation === epoch && latest) deps.publish(latest);
          } catch {
            if (generation === epoch) retries.set(next.key, now() + 60_000);
          }
        }
      } finally {
        running = false;
      }
    },
  };
}
