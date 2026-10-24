import { changesRevision, type InspectionRevision, type PrChanges, type PrChangeFile } from './pr-changes';
import type { PrCommits } from './pr-commits';

const key = (revision: InspectionRevision) => `${revision.url}@${changesRevision(revision)}`;
interface Dependencies {
  changes: (revision: InspectionRevision, refresh: boolean, background: boolean) => Promise<PrChanges>;
  commits: (revision: InspectionRevision, refresh: boolean, background: boolean) => Promise<PrCommits>;
  file: (snapshot: PrChanges, file: PrChangeFile) => Promise<unknown>;
  comparison: (list: PrCommits) => Promise<unknown>;
  review: (snapshot: PrChanges) => Promise<unknown>;
  visible: () => boolean;
  now?: () => number;
  reset?: () => void;
  prioritize?: (urls: string[]) => void;
}
interface Entry {
  changes?: PrChanges;
  commits?: PrCommits;
}
interface Job {
  revision: InspectionRevision;
  stage: number;
  file: number;
  retryAt: number;
  failures: number;
}
/** Revision-aware tab data and one background work step at a time. No React mount is required. */
export function createPrInspectionCache(deps: Dependencies) {
  const now = deps.now ?? Date.now;
  const values = new Map<string, Entry>();
  const latest = new Map<string, Entry>();
  const jobs = new Map<string, Job>();
  const completed = new Set<string>();
  const pending = new Map<string, { promise: Promise<PrChanges | PrCommits>; background: boolean }>();
  let scope: string | null = null,
    epoch = 0;
  let order: string[] = [];
  let running: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  function remember(value: PrChanges | PrCommits, kind: keyof Entry) {
    const id = key({ url: value.url, baseSha: value.metadata.baseSha, headSha: value.metadata.headSha });
    const entry = values.get(id) ?? {};
    if (kind === 'changes') entry.changes = value as PrChanges;
    else entry.commits = value as PrCommits;
    const current = latest.get(value.url)?.[kind];
    if (!current || value.fetchedAt >= current.fetchedAt)
      latest.set(value.url, { ...latest.get(value.url), [kind]: value });
    values.delete(id);
    values.set(id, entry);
    while (values.size > 1000) {
      const first = values.keys().next().value;
      if (first === undefined) break;
      values.delete(first);
      completed.delete(first);
    }
    while (latest.size > 1000) {
      const first = latest.keys().next().value;
      if (first === undefined) break;
      latest.delete(first);
    }
  }
  function read<T extends PrChanges | PrCommits>(
    kind: keyof Entry,
    revision: InspectionRevision,
    refresh = false,
    background = false
  ): Promise<T> {
    const saved = values.get(key(revision))?.[kind];
    if (saved && !refresh) return Promise.resolve(saved as T);
    const id = `${kind}:${key(revision)}:${refresh}`;
    const previous = pending.get(id);
    if (previous)
      return previous.background && !background
        ? (previous.promise.catch(() => read<T>(kind, revision, refresh, false)) as Promise<T>)
        : (previous.promise as Promise<T>);
    const generation = epoch;
    const promise = deps[kind](revision, refresh, background)
      .then((value) => {
        if (generation === epoch) remember(value, kind);
        return value;
      })
      .finally(() => {
        if (pending.get(id)?.promise === promise) pending.delete(id);
      });
    pending.set(id, { promise, background });
    return promise as Promise<T>;
  }
  const readChanges = (r: InspectionRevision, refresh = false, background = false) =>
    read<PrChanges>('changes', r, refresh, background);
  const readCommits = (r: InspectionRevision, refresh = false, background = false) =>
    read<PrCommits>('commits', r, refresh, background);
  async function step(job: Job, generation: number) {
    const r = job.revision;
    if (job.stage === 0) {
      await readChanges(r, false, true);
      job.stage++;
      return;
    }
    if (job.stage === 1) {
      await readCommits(r, false, true);
      job.stage++;
      return;
    }
    const saved = values.get(key(r));
    // Discovery moved while GitHub supplied a newer consistent snapshot. Wait for its new identity.
    if (!saved?.changes || !saved.commits) {
      completed.add(key(r));
      jobs.delete(key(r));
      return;
    }
    if (job.stage === 2) {
      await deps.comparison(saved.commits);
      job.stage++;
      return;
    }
    if (job.stage === 3) {
      const file = saved.changes.files.at(job.file);
      if (!file) {
        job.stage++;
        return;
      }
      try {
        await deps.file(saved.changes, file);
      } catch (error) {
        // Unsupported binary/oversized files must not block other files. Network errors retry.
        if (!/too large|binary file|not UTF-8|no text preview|Not Found|\b404\b/i.test(String(error))) throw error;
      }
      job.file++;
      return;
    }
    await deps.review(saved.changes);
    if (generation === epoch && jobs.get(key(r)) === job) {
      completed.add(key(r));
      jobs.delete(key(r));
    }
  }
  function kick(delay = 100) {
    if (!scope || timer || running || !jobs.size || !deps.visible()) return;
    timer = setTimeout(() => {
      timer = undefined;
      void drain();
    }, delay);
  }
  function drain(): Promise<void> {
    if (running) return running;
    const generation = epoch;
    const promise = (async () => {
      while (scope && generation === epoch && deps.visible()) {
        const job = order.map((id) => jobs.get(id)).find((job) => job && job.retryAt <= now());
        if (!job) break;
        try {
          await step(job, generation);
          job.failures = 0;
        } catch {
          job.failures++;
          job.retryAt = now() + Math.min(300_000, 30_000 * 2 ** Math.min(job.failures - 1, 4));
        }
      }
    })().finally(() => {
      if (running === promise) running = undefined;
      if (scope && jobs.size && deps.visible()) {
        const next = Math.min(...[...jobs.values()].map((job) => job.retryAt));
        kick(Math.max(100, next - now()));
      }
    });
    running = promise;
    return promise;
  }
  return {
    readChanges,
    readCommits,
    peekChanges: (r: InspectionRevision) => values.get(key(r))?.changes ?? latest.get(r.url)?.changes,
    peekCommits: (r: InspectionRevision) => values.get(key(r))?.commits ?? latest.get(r.url)?.commits,
    setTargets(account: string | null, targets: InspectionRevision[]) {
      if (scope !== account) {
        epoch++;
        scope = account;
        values.clear();
        latest.clear();
        jobs.clear();
        completed.clear();
        pending.clear();
        deps.reset?.();
      }
      const unique = new Map<string, InspectionRevision>();
      for (const r of targets) if (!unique.has(r.url)) unique.set(r.url, r);
      const nextOrder = account ? [...unique.values()].map(key) : [];
      // A newly selected PR may have fallen out of the bounded file cache.
      if (nextOrder[0] && nextOrder[0] !== order[0]) completed.delete(nextOrder[0]);
      order = nextOrder;
      deps.prioritize?.(account ? [...unique.keys()] : []);
      const wanted = new Set(order);
      for (const id of jobs.keys()) if (!wanted.has(id)) jobs.delete(id);
      for (const r of unique.values())
        if (account && !completed.has(key(r)) && !jobs.has(key(r)))
          jobs.set(key(r), { revision: r, stage: 0, file: 0, retryAt: 0, failures: 0 });
      // Bound bookkeeping too; deleted/replaced revisions cannot stay forever.
      for (const id of completed) if (!wanted.has(id)) completed.delete(id);
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      kick();
    },
    flush: drain,
    stop() {
      epoch++;
      scope = null;
      jobs.clear();
      values.clear();
      latest.clear();
      completed.clear();
      pending.clear();
      deps.reset?.();
      order = [];
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}
