import { inspectionFailure } from './inspection-batch';
import type { ActivityTask } from './activity';
import { changesRevision, type InspectionRevision, type PrChanges, type PrChangeFile } from './pr-changes';
import type { PrCommits, PrCommit } from './pr-commits';
import { createSharedRead, readError } from './shared-read';
import { createByteCache } from './byte-cache';
import { INVENTORY_MEMORY_BYTES } from './inspection-limits';

const key = (revision: InspectionRevision) => `${revision.url}@${changesRevision(revision)}`;
export interface PreparedInventories {
  changes: PrChanges[];
  commits: PrCommits[];
}
interface Dependencies {
  restore?: (revisions: InspectionRevision[]) => Promise<PreparedInventories>;
  changes: (revision: InspectionRevision, refresh: boolean, background: boolean, signal?: AbortSignal) => Promise<PrChanges>;
  commits: (revision: InspectionRevision, refresh: boolean, background: boolean, signal?: AbortSignal) => Promise<PrCommits>;
  file: (snapshot: PrChanges, file: PrChangeFile) => Promise<unknown>;
  comparison: (list: PrCommits, commit: PrCommit) => Promise<PrChanges | undefined>;
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
  commit: number;
  comparison?: PrChanges;
  comparisonFile: number;
  retryAt: number;
  failures: number;
  rateLimited?: boolean;
}
export interface InspectionPriorities {
  active?: string[];
  visible?: string[];
  unread?: string[];
  view?: string[];
}

/** Revision-aware tab data and one background work step at a time. No React mount is required. */
export function createPrInspectionCache(deps: Dependencies) {
  const now = deps.now ?? Date.now;
  const values = createByteCache<string, Entry>(INVENTORY_MEMORY_BYTES, 1000);
  const listeners = new Set<() => void>();
  let version = 0;
  const changed = () => { version++; listeners.forEach(listener => listener()); };
  const latest = new Map<string, Partial<Record<keyof Entry, string>>>();
  const latestEntry = (url: string): Entry => ({
    changes: values.get(latest.get(url)?.changes ?? '')?.changes,
    commits: values.get(latest.get(url)?.commits ?? '')?.commits,
  });
  const jobs = new Map<string, Job>();
  const completed = new Set<string>();
  const restored = new Set<string>();
  const pending = new Map<string, { task: ReturnType<typeof createSharedRead<PrChanges | PrCommits>>; background: boolean }>();
  let scope: string | null = null,
    epoch = 0;
  let order: string[] = [];
  let priorities = new Map<string, number>();
  let activeUrls = new Set<string>();
  let currentJob: Job | undefined;
  let pausedUntil = 0;
  let activitySignature = '';
  let activityUpdatedAt = new Date(now()).toISOString();
  let stopped = false;
  let running: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  function remember(value: PrChanges | PrCommits, kind: keyof Entry) {
    const id = key({ url: value.url, baseSha: value.metadata.baseSha, headSha: value.metadata.headSha });
    const entry = { ...values.get(id) };
    if (kind === 'changes') entry.changes = value as PrChanges;
    else entry.commits = value as PrCommits;
    const current = latestEntry(value.url)[kind];
    if (!current || value.fetchedAt >= current.fetchedAt)
      latest.set(value.url, { ...latest.get(value.url), [kind]: id });
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
    changed();
  }
  function read<T extends PrChanges | PrCommits>(
    kind: keyof Entry,
    revision: InspectionRevision,
    refresh = false,
    background = false,
    signal?: AbortSignal
  ): Promise<T> {
    if (signal?.aborted) return Promise.reject(readError(signal.reason));
    const saved = values.get(key(revision))?.[kind];
    if (saved && !refresh) return Promise.resolve(saved as T);
    const id = `${kind}:${key(revision)}:${refresh}`;
    const previous = pending.get(id);
    if (previous && !previous.task.signal.aborted && (!previous.background || background)) return previous.task.read(signal) as Promise<T>;
    const generation = epoch;
    const task = createSharedRead(sharedSignal => deps[kind](revision, refresh, background, sharedSignal)
      .then((value) => {
        if (generation === epoch) remember(value, kind);
        return value;
      })
      .finally(() => {
        if (pending.get(id)?.task === task) pending.delete(id);
      }));
    pending.set(id, { task, background });
    return task.read(signal) as Promise<T>;
  }
  const readChanges = (r: InspectionRevision, refresh = false, background = false, signal?: AbortSignal) =>
    read<PrChanges>('changes', r, refresh, background, signal);
  const readCommits = (r: InspectionRevision, refresh = false, background = false, signal?: AbortSignal) =>
    read<PrCommits>('commits', r, refresh, background, signal);
  async function step(job: Job, generation: number) {
    const r = job.revision;
    if (job.stage === 0) {
      await readChanges(r, false, true);
      if (!values.get(key(r))) { finish(job, generation); return; }
      job.stage++;
      return;
    }
    if (job.stage === 1) {
      await readCommits(r, false, true);
      if (!values.get(key(r))) { finish(job, generation); return; }
      job.stage++;
      return;
    }
    const saved = values.get(key(r));
    if (!saved?.changes || !saved.commits) {
      const current = latestEntry(r.url);
      if ([current.changes, current.commits].some(value => value && changesRevision(value.metadata) !== changesRevision(r))) {
        // Discovery moved while GitHub supplied a newer snapshot; wait for its identity.
        finish(job, generation);
      } else {
        // A large queue can evict an inventory from memory before its files run.
        // Restore that inventory from disk instead of treating it as completed.
        job.stage = 0;
      }
      return;
    }
    if (saved.changes.filesTruncated || saved.changes.patchesDeferred) {
      // Keep both tab inventories. Load files on demand for oversized PRs, instead
      // of flooding GitHub or repeatedly trying to prepare an incomplete review.
      finish(job, generation);
      return;
    }
    if (job.stage === 2 || job.stage === 5) {
      // Newest first, with a scheduling boundary after each comparison and file.
      const commit = saved.commits.commits.at(-1 - job.commit);
      if (!commit) {
        if (job.stage === 2) job.stage++;
        else finish(job, generation);
        return;
      }
      if (!job.comparison) {
        try {
          job.comparison = (await deps.comparison(saved.commits, commit)) || undefined;
        } catch (error) {
          if (!unsupported(error)) throw error;
        }
        if (job.comparison && !job.comparison.filesTruncated && !job.comparison.patchesDeferred) return;
        job.comparison = undefined;
      } else {
        const file = job.comparison.files.at(job.comparisonFile);
        if (file) {
          await prepareFile(job.comparison, file);
          job.comparisonFile++;
          return;
        }
      }
      job.comparison = undefined;
      job.comparisonFile = 0;
      job.commit++;
      if (job.stage === 2) job.stage++;
      return;
    }
    if (job.stage === 3) {
      const file = saved.changes.files.at(job.file);
      if (!file) {
        job.stage++;
        return;
      }
      await prepareFile(saved.changes, file);
      job.file++;
      return;
    }
    await deps.review(saved.changes);
    job.stage++;
  }
  function unsupported(error: unknown) {
    return /too large|binary file|not UTF-8|no text preview|Not Found|\b404\b|file limit/i.test(String(error));
  }
  async function prepareFile(snapshot: PrChanges, file: PrChangeFile) {
    try { await deps.file(snapshot, file); }
    catch (error) { if (!unsupported(error)) throw error; }
  }
  function finish(job: Job, generation: number) {
    if (generation === epoch && jobs.get(key(job.revision)) === job) {
      completed.add(key(job.revision));
      jobs.delete(key(job.revision));
    }
  }

  function kick(delay = 100) {
    if (stopped || !scope || timer || running || !jobs.size || !deps.visible()) return;
    timer = setTimeout(() => {
      timer = undefined;
      void drain();
    }, delay);
  }
  function drain(): Promise<void> {
    if (running) return running;
    const generation = epoch;
    const active = () => !stopped && !!scope && generation === epoch && deps.visible();
    const promise = (async () => {
      let steps = 0;
      while (active() && pausedUntil <= now()) {
        // Disk/memory hits can resolve immediately. Let navigation and viewport
        // updates run instead of consuming a long chain of renderer microtasks.
        if (++steps % 16 === 0) {
          await new Promise(resolve => setTimeout(resolve, 0));
          if (!active()) break;
        }
        // Bound disk reads and IPC payloads too, rather than restoring a whole
        // queue's patches into a single transient array.
        const missing = order.filter((id) => !restored.has(id)).flatMap((id) => jobs.get(id)?.revision ?? []).slice(0, 8);
        if (deps.restore && missing.length) {
          try {
            const inventories = await deps.restore(missing);
            if (generation !== epoch) return;
            inventories.changes.forEach((value) => remember(value, 'changes'));
            inventories.commits.forEach((value) => remember(value, 'commits'));
          } catch {
            /* Foreground and background reads can still load individual inventories. */
          }
          if (generation !== epoch) return;
          missing.forEach((revision) => restored.add(key(revision)));
          if (!active()) break;
        }
        const ready = order.map((id) => jobs.get(id)).filter((job): job is Job => !!job && job.retryAt <= now());
        // Re-evaluate intent between every operation. Within a tier, make both tab
        // inventories available before deep downloads; never let the backlog delay an active PR.
        const tier = (job: Job) => priorities.get(job.revision.url) ?? 4;
        const highest = ready.reduce((best, job) => Math.min(best, tier(job)), Infinity);
        const preferred = ready.filter(job => tier(job) === highest);
        const job = preferred.find(job => job.stage < 2) ?? preferred.at(0);
        if (!job) break;
        currentJob = job;
        try {
          await step(job, generation);
          job.failures = 0;
          job.rateLimited = false;
        } catch (error) {
          if (generation !== epoch) return;
          job.failures++;
          // Electron preserves the error message, but not custom Error properties.
          job.rateLimited = /rate.?limit|API (?:allowance|limit)|GitHub allowance|GitHub requests can resume/i.test(String(error));
          const deadline = inspectionFailure(job.revision.url, error).retryAt;
          job.retryAt = deadline && deadline > now() ? deadline
            : now() + Math.min(300_000, 30_000 * 2 ** Math.min(job.failures - 1, 4));
          if (job.rateLimited) pausedUntil = Math.max(pausedUntil, job.retryAt);
        } finally {
          if (currentJob === job) currentJob = undefined;
        }
      }
    })().finally(() => {
      if (running === promise) running = undefined;
      if (!stopped && scope && jobs.size && deps.visible()) {
        const next = Math.min(...[...jobs.values()].map((job) => job.retryAt));
        kick(Math.max(100, Math.max(next, pausedUntil) - now()));
      }
    });
    running = promise;
    return promise;
  }
  function activity(): ActivityTask | undefined {
    if (!scope || stopped || !jobs.size) return;
    const pending = order.flatMap(id => jobs.get(id) ?? []);
    if (!pending.length) return;
    const activeJob = currentJob && jobs.get(key(currentJob.revision)) === currentJob ? currentJob : undefined;
    const waiting = pending.filter(job => job.retryAt > now());
    const budgetPaused = pausedUntil > now();
    const paused = !activeJob && (budgetPaused || waiting.length === pending.length);
    const job = activeJob ?? pending[0];
    const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)$/.exec(job.revision.url);
    const identity = match ? `${match[1]} #${match[2]}` : 'PR';
    const phase = ['Changed-file list', 'Commit list', 'Newest commit', 'Changed files', 'Review diff', 'Earlier commits'][job.stage] ?? 'Saved content';
    let detail = `${identity} · ${phase}`;
    if (paused) detail = budgetPaused || waiting.some(job => job.rateLimited)
      ? 'Waiting for GitHub’s API allowance. Retrying automatically.'
      : 'Some PRs could not be prepared. Retrying automatically.';
    else if (waiting.length) detail += ` · ${waiting.length} waiting to retry`;
    const progress = { completed: order.length - pending.length, total: order.length, unit: 'PRs' };
    const status = paused ? 'paused' : 'running';
    const signature = JSON.stringify({ scope, detail, progress, status });
    if (signature !== activitySignature) {
      activitySignature = signature;
      activityUpdatedAt = new Date(now()).toISOString();
    }
    return { id: 'pr-preload', kind: 'preload', account: scope, title: 'Preparing PRs for instant opening',
      detail, status, progress, updatedAt: activityUpdatedAt, canCancel: false, canRetry: false };
  }
  return {
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getVersion: () => version,
    activity,
    readChanges,
    readCommits,
    peekChanges: (r: InspectionRevision) => values.get(key(r))?.changes ?? latestEntry(r.url).changes,
    peekCommits: (r: InspectionRevision) => values.get(key(r))?.commits ?? latestEntry(r.url).commits,
    setTargets(account: string | null, targets: InspectionRevision[], intent: InspectionPriorities = {}) {
      stopped = false;
      if (scope !== account) {
        epoch++;
        scope = account;
        values.clear();
        latest.clear();
        jobs.clear();
        completed.clear();
        restored.clear();
        pending.clear();
        activeUrls.clear();
        changed();
        currentJob = undefined;
        pausedUntil = 0;
        deps.reset?.();
      }
      const unique = new Map<string, InspectionRevision>();
      for (const r of targets) if (!unique.has(r.url)) unique.set(r.url, r);
      priorities = new Map();
      [intent.active, intent.visible, intent.unread, intent.view].forEach((urls, tier) => {
        for (const url of urls ?? []) if (!priorities.has(url)) priorities.set(url, tier);
      });
      const ranked = [...unique.values()].sort((a, b) =>
        (priorities.get(a.url) ?? 4) - (priorities.get(b.url) ?? 4));
      const nextOrder = account ? ranked.map(key) : [];
      // Rehydrate a newly active PR from disk if it has left the bounded memory cache.
      for (const url of intent.active ?? []) {
        const revision = unique.get(url);
        if (revision && !activeUrls.has(url)) completed.delete(key(revision));
      }
      activeUrls = new Set(intent.active);
      order = nextOrder;
      deps.prioritize?.(account ? ranked.map(r => r.url) : []);
      const wanted = new Set(order);
      for (const id of jobs.keys()) if (!wanted.has(id)) jobs.delete(id);
      for (const r of unique.values())
        if (account && !completed.has(key(r)) && !jobs.has(key(r)))
          jobs.set(key(r), { revision: r, stage: 0, file: 0, commit: 0, comparisonFile: 0, retryAt: 0, failures: 0 });
      // Bound bookkeeping too; deleted/replaced revisions cannot stay forever.
      for (const id of completed) if (!wanted.has(id)) completed.delete(id);
      for (const id of restored) if (!wanted.has(id)) restored.delete(id);
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      kick();
    },
    flush: drain,
    stop() {
      // Navigation pauses the worker; only an account change invalidates cached content.
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}
