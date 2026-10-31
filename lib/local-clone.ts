import { execFile } from 'node:child_process';
import path from 'node:path';
import { githubPriority, githubReadSignal } from './github-scheduler';
import type { PrCommit } from './pr-commits';

export interface LocalCloneEntry {
  /** GitHub `owner/name` this clone can answer for. */
  repo: string;
  path: string;
  remote: string;
}
export interface LocalCloneStatus extends LocalCloneEntry {
  reads: number;
  fallbacks: number;
  lastError?: string;
}
/** Same shape as GitHub's file entries, so callers share one mapping for both sources. */
export interface LocalCloneFile {
  filename: string;
  previous_filename?: string;
  status: 'added' | 'modified' | 'removed' | 'renamed';
  additions: number;
  deletions: number;
  sha: string | null;
  patch?: string;
}
export interface LocalCloneChanges {
  mergeBase: string;
  files: LocalCloneFile[];
}
export interface LocalCloneFileHistory {
  filename: string;
  commitCount: number;
  lastModified: string | null;
}

const GIT_MAX_BUFFER = 256 * 1024 * 1024;
const BLOB_MAX_BUFFER = 64 * 1024 * 1024;
const MAX_GIT_PROCESSES = 8;
const FETCH_BATCH = 100;
const FETCH_TIMEOUT_MS = 5 * 60_000;
const INTERACTIVE_FETCH_WAIT_MS = 30_000;
const FETCH_RETRY_MS = 5 * 60_000;
const SHALLOW_CHECK_MS = 60_000;
const NULL_BLOB = '0'.repeat(40);
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
// GitHub merges hunks separated by one unchanged line. Matching it keeps patches byte-identical across sources.
const PATCH_ARGS = ['--no-color', '--inter-hunk-context=1', '-p'];
const isSha = (value: string) => /^[a-f0-9]{40}$/i.test(value);

/** Inherited GIT_DIR-style variables would point every command at another repository. */
function gitEnvironment() {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    SSH_ASKPASS_REQUIRE: 'never',
    LC_ALL: 'C',
  };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  return env;
}
function run(
  cwd: string,
  args: string[],
  options: { maxBuffer?: number; timeout?: number; signal?: AbortSignal } = {}
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['--literal-pathspecs', '-c', 'core.fsmonitor=false', '-c', 'core.quotePath=false', ...args],
      {
        cwd,
        encoding: 'buffer',
        env: gitEnvironment(),
        maxBuffer: options.maxBuffer ?? GIT_MAX_BUFFER,
        timeout: options.timeout,
        signal: options.signal,
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve(stdout);
          return;
        }
        // Settings shows this text: Git's last line says more than the command that failed.
        const detail =
          error.code === 'ENOENT' ? `Cannot open ${cwd}.` : stderr.toString('utf8').trim().split('\n').at(-1);
        reject(Object.assign(new Error(detail || error.message), { code: error.code, killed: error.killed }));
      }
    );
  });
}
const gitText = async (cwd: string, args: string[]) => (await run(cwd, args)).toString('utf8');

/** GitHub remotes only: `github.com.example.org` and similar hosts must not match. */
export function parseGitHubRemote(url: string): string | undefined {
  const match =
    /^(?:[\w+.-]+:\/\/)?(?:[^@/]+@)?(?:ssh\.)?github\.com(?::\d+)?[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(
      url.trim()
    );
  return match ? `${match[1]}/${match[2]}` : undefined;
}

export function parseRawDiff(output: string) {
  const fields = output.split('\0');
  const entries: { status: string; path: string; previousPath?: string; oldBlob: string; newBlob: string }[] = [];
  for (let i = 0; i < fields.length; i++) {
    if (!fields[i].startsWith(':')) continue;
    const [, , oldBlob, newBlob, status] = fields[i].slice(1).split(' ');
    if (status.startsWith('R') || status.startsWith('C')) {
      entries.push({ status, previousPath: fields[i + 1], path: fields[i + 2], oldBlob, newBlob });
      i += 2;
    } else {
      entries.push({ status, path: fields[i + 1], oldBlob, newBlob });
      i++;
    }
  }
  return entries;
}
export function parseNumstat(output: string) {
  const fields = output.split('\0');
  const stats = new Map<string, { additions: number; deletions: number }>();
  for (let i = 0; i < fields.length; i++) {
    const parts = fields[i].split('\t');
    if (parts.length < 3) continue;
    const [additions, deletions, name] = parts;
    // A rename leaves the path empty and supplies both names in the next two fields.
    const filename = name || fields[(i += 2)];
    stats.set(filename, { additions: Number(additions) || 0, deletions: Number(deletions) || 0 });
  }
  return stats;
}
/** One section per `diff --git` header. Content lines always carry a prefix, so they cannot match. */
export function splitPatches(diff: string) {
  const starts = [...diff.matchAll(/^diff --git /gm)].map((match) => match.index);
  return starts.map((start, i) => {
    const section = diff.slice(start, starts[i + 1] ?? diff.length);
    const hunk = /^@@ /m.exec(section);
    // Only the final newline: a blank context line at the end of a hunk is part of the patch.
    return hunk ? section.slice(hunk.index).replace(/\n$/, '') : undefined;
  });
}
export function parseCommits(output: string, repo: string): PrCommit[] {
  const fields = output.split('\0');
  const commits: PrCommit[] = [];
  const iso = (value: string) => {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toISOString().replace('.000Z', 'Z');
  };
  for (let i = 0; i + 7 < fields.length; i += 8) {
    const [hash, parents, name, email, authoredAt, committer, committedAt, message] = fields.slice(i, i + 8);
    const sha = hash.trim();
    commits.push({
      sha,
      message: message.trimEnd(),
      parents: parents ? parents.split(' ') : [],
      url: `https://github.com/${repo}/commit/${sha}`,
      author: { name, login: /^(?:\d+\+)?([^@+]+)@users\.noreply\.github\.com$/i.exec(email)?.[1] },
      authoredAt: iso(authoredAt),
      committer,
      committedAt: iso(committedAt),
      // Signature state is GitHub's verdict; the commits list only displays a positive result.
      verified: false,
    });
  }
  return commits;
}

/** The fields callers can rely on after a clone is registered. No method writes a ref or the working tree. */
export class LocalClone {
  private active = 0;
  private readonly slots: (() => void)[] = [];
  private readonly present = new Set<string>();
  private readonly waiting = new Map<
    string,
    { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void }
  >();
  private readonly unavailable = new Map<string, number>();
  private pumping = false;
  private completeUntil = 0;

  constructor(
    readonly entry: LocalCloneEntry,
    private readonly options: { interactiveFetchWaitMs?: number; now?: () => number } = {}
  ) {}

  forgetPresence() {
    this.present.clear();
  }

  private async git(args: string[], maxBuffer?: number) {
    if (this.active >= MAX_GIT_PROCESSES) await new Promise<void>((resolve) => this.slots.push(resolve));
    this.active++;
    try {
      return await run(this.entry.path, args, { maxBuffer, signal: githubReadSignal() });
    } finally {
      this.active--;
      this.slots.shift()?.();
    }
  }
  private async text(args: string[]) {
    return (await this.git(args)).toString('utf8');
  }

  private now() {
    return (this.options.now ?? Date.now)();
  }
  private async fetchBatch(shas: string[]) {
    await run(
      this.entry.path,
      [
        'fetch',
        '--quiet',
        '--no-tags',
        '--no-write-fetch-head',
        '--no-prune',
        '--recurse-submodules=no',
        this.entry.remote,
        ...shas,
      ],
      { timeout: FETCH_TIMEOUT_MS }
    );
  }
  /** Readers arriving during a fetch join the next batch, so a stack costs a few fetches rather than one per PR. */
  private async pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.waiting.size) {
        const batch = [...this.waiting.keys()].slice(0, FETCH_BATCH);
        let failure: unknown;
        await this.fetchBatch(batch).catch((reason: unknown) => {
          failure = reason;
        });
        for (const sha of batch) {
          let error = failure;
          // One force-pushed SHA fails its whole batch. Retry individually so the rest still
          // arrive, unless the remote is hanging, where each retry would wait for the timeout.
          if (failure && batch.length > 1 && !(failure as { killed?: boolean }).killed) {
            error = undefined;
            await this.fetchBatch([sha]).catch((reason: unknown) => {
              error = reason;
            });
          }
          const waiter = this.waiting.get(sha);
          this.waiting.delete(sha);
          if (error) {
            this.unavailable.set(sha, this.now() + FETCH_RETRY_MS);
            waiter?.reject(
              error instanceof Error ? error : new Error(`Could not fetch ${sha} from ${this.entry.remote}.`)
            );
          } else {
            this.present.add(sha);
            waiter?.resolve();
          }
        }
      }
    } finally {
      this.pumping = false;
    }
  }
  private request(sha: string) {
    const retryAt = this.unavailable.get(sha);
    if (retryAt && retryAt > this.now())
      return Promise.reject(new Error(`${sha} recently failed to fetch from ${this.entry.remote}.`));
    this.unavailable.delete(sha);
    let waiter = this.waiting.get(sha);
    if (!waiter) {
      let resolve!: () => void, reject!: (error: Error) => void;
      const promise = new Promise<void>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      void promise.catch(() => {});
      waiter = { promise, resolve, reject };
      this.waiting.set(sha, waiter);
    }
    return waiter.promise;
  }
  /** A depth-limited fetch can shallow a clone after registration, and cut history gives wrong parents and merge bases. */
  private async assertComplete() {
    if (this.completeUntil > this.now()) return;
    if ((await this.text(['rev-parse', '--is-shallow-repository'])).trim() === 'true')
      throw new Error('This clone is now shallow, so Gnosis is using GitHub for it.');
    this.completeUntil = this.now() + SHALLOW_CHECK_MS;
  }
  /** Network only when a commit is absent. A fetch that outlasts an interactive reader keeps going for the next one. */
  private async ensure(...shas: string[]) {
    for (const sha of shas) if (!isSha(sha)) throw new Error(`Invalid commit reference: ${sha}`);
    await this.assertComplete();
    const missing: string[] = [];
    await Promise.all(
      [...new Set(shas)].map(async (sha) => {
        if (this.present.has(sha)) return;
        try {
          await this.git(['cat-file', '-e', `${sha}^{commit}`]);
          this.present.add(sha);
        } catch {
          githubReadSignal()?.throwIfAborted();
          missing.push(sha);
        }
      })
    );
    if (!missing.length) return;
    const fetched = Promise.all(missing.map((sha) => this.request(sha)));
    void this.pump();
    if (githubPriority() === 'background') {
      await fetched;
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        fetched,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`Fetching from ${this.entry.remote} is taking a while.`)),
            this.options.interactiveFetchWaitMs ?? INTERACTIVE_FETCH_WAIT_MS
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async treeChanges(from: string, to: string): Promise<LocalCloneFile[]> {
    const shared = ['diff-tree', '-r', '-M', '--no-ext-diff', '--no-textconv'];
    const [raw, numstat, diff] = await Promise.all([
      this.text([...shared, '-z', '--no-abbrev', '--raw', from, to]),
      this.text([...shared, '-z', '--numstat', from, to]),
      this.text([...shared, ...PATCH_ARGS, from, to]),
    ]);
    const entries = parseRawDiff(raw);
    const stats = parseNumstat(numstat);
    const patches = splitPatches(diff);
    // Git writes a type change as a deletion and an addition: two sections for one raw entry.
    const sections = entries.reduce((total, entry) => total + (entry.status === 'T' ? 2 : 1), 0);
    const aligned = patches.length === sections;
    let section = 0;
    const files: LocalCloneFile[] = [];
    entries.forEach((entry) => {
      const letter = entry.status[0];
      const patch = letter === 'T' ? undefined : patches[section];
      section += letter === 'T' ? 2 : 1;
      const status =
        letter === 'A'
          ? 'added'
          : letter === 'D'
            ? 'removed'
            : letter === 'R'
              ? 'renamed'
              : letter === 'M' || letter === 'T'
                ? 'modified'
                : undefined;
      if (!status) return;
      const blob = letter === 'D' ? entry.oldBlob : entry.newBlob;
      files.push({
        filename: entry.path,
        ...(entry.previousPath ? { previous_filename: entry.previousPath } : {}),
        status,
        additions: stats.get(entry.path)?.additions ?? 0,
        deletions: stats.get(entry.path)?.deletions ?? 0,
        sha: blob === NULL_BLOB ? null : blob,
        patch: aligned ? patch : undefined,
      });
    });
    return files;
  }

  async mergeBase(base: string, head: string) {
    await this.ensure(base, head);
    return (await this.text(['merge-base', base, head])).trim();
  }
  /** The PR comparison: merge base to head, as GitHub's Files tab shows it. */
  async changes(base: string, head: string): Promise<LocalCloneChanges> {
    const mergeBase = await this.mergeBase(base, head);
    return { mergeBase, files: await this.treeChanges(mergeBase, head) };
  }
  /** An exact tree comparison. `from` can be the empty tree for a repository's first commit. */
  async between(from: string, to: string): Promise<LocalCloneFile[]> {
    await this.ensure(...(from === EMPTY_TREE ? [to] : [from, to]));
    return this.treeChanges(from, to);
  }
  async diff(base: string, head: string) {
    const mergeBase = await this.mergeBase(base, head);
    return this.text(['diff-tree', '-r', '-M', '--no-ext-diff', '--no-textconv', ...PATCH_ARGS, mergeBase, head]);
  }
  async commits(base: string, head: string): Promise<PrCommit[]> {
    await this.ensure(base, head);
    const output = await this.text([
      'log',
      '--no-show-signature',
      '--reverse',
      '--topo-order',
      '--format=%H%x00%P%x00%an%x00%ae%x00%aI%x00%cn%x00%cI%x00%B%x00',
      `${base}..${head}`,
    ]);
    return parseCommits(output, this.entry.repo);
  }
  /** Raw bytes, so LFS pointers stay pointers. Null means the path does not exist at this commit. */
  async blob(sha: string, filePath: string): Promise<Buffer | null> {
    await this.ensure(sha);
    try {
      return await this.git(['cat-file', 'blob', `${sha}:${filePath}`], BLOB_MAX_BUFFER);
    } catch (error) {
      if ((error as { code?: unknown }).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw error;
      githubReadSignal()?.throwIfAborted();
      return null;
    }
  }
  async listDirectory(sha: string, directory: string, kind: 'file' | 'dir') {
    await this.ensure(sha);
    let output: string;
    try {
      output = await this.text(['ls-tree', '-z', `${sha}:${directory}`]);
    } catch {
      githubReadSignal()?.throwIfAborted();
      return [];
    }
    return output
      .split('\0')
      .filter(Boolean)
      .map((line) => {
        const tab = line.indexOf('\t');
        return { type: line.slice(0, tab).split(' ')[1], name: line.slice(tab + 1) };
      })
      .filter((item) => item.type === (kind === 'dir' ? 'tree' : 'blob'))
      .map((item) => `${directory}/${item.name}`);
  }
  async fileHistory(
    base: string,
    head: string,
    files: { filename: string; status: string }[]
  ): Promise<LocalCloneFileHistory[]> {
    await this.ensure(base, head);
    const touched = await this.text(['log', '--format=', '--name-only', '-z', '--no-renames', `${base}..${head}`]);
    const churn = new Map<string, number>();
    for (const name of touched.split('\0').map((value) => value.trim()))
      if (name) churn.set(name, (churn.get(name) ?? 0) + 1);
    return Promise.all(
      files.map(async ({ filename, status }) => {
        const last = status === 'added' ? '' : await this.text(['log', '-1', '--format=%cI', base, '--', filename]);
        const date = new Date(last.trim());
        return {
          filename,
          commitCount: churn.get(filename) ?? 1,
          lastModified: Number.isNaN(date.getTime()) ? null : date.toISOString().replace('.000Z', 'Z'),
        };
      })
    );
  }
}
export function normalizeLocalClones(value: unknown): LocalCloneEntry[] {
  if (!Array.isArray(value)) return [];
  const entries = new Map<string, LocalCloneEntry>();
  for (const item of value as unknown[]) {
    if (!item || typeof item !== 'object') continue;
    const { repo, path: directory, remote } = item as Record<string, unknown>;
    if (typeof repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(repo)) continue;
    if (typeof directory !== 'string' || !path.isAbsolute(directory)) continue;
    if (typeof remote !== 'string' || !/^[\w./-]+$/.test(remote) || remote.startsWith('-')) continue;
    entries.set(repo.toLowerCase(), { repo, path: directory, remote });
  }
  return [...entries.values()];
}

/** Reads the identity of a chosen folder. Any GitHub remote qualifies, so a fork clone also serves upstream. */
export async function inspectLocalClone(directory: string): Promise<LocalCloneEntry[]> {
  const resolved = path.resolve(directory);
  let root: string, shallow: boolean;
  try {
    const flags = (await gitText(resolved, ['rev-parse', '--is-bare-repository', '--is-shallow-repository']))
      .trim()
      .split('\n');
    shallow = flags[1] === 'true';
    root = flags[0] === 'true' ? resolved : (await gitText(resolved, ['rev-parse', '--show-toplevel'])).trim();
  } catch {
    throw new Error('This folder is not a Git repository.');
  }
  if (shallow) throw new Error('This clone is shallow. Run `git fetch --unshallow` in it, then add it again.');
  const remotes = (await gitText(resolved, ['remote'])).split('\n').filter(Boolean);
  const entries = new Map<string, LocalCloneEntry>();
  for (const remote of remotes) {
    const repo = parseGitHubRemote(await gitText(resolved, ['remote', 'get-url', remote]));
    if (repo && (!entries.has(repo.toLowerCase()) || remote === 'origin'))
      entries.set(repo.toLowerCase(), { repo, path: root, remote });
  }
  if (!entries.size) throw new Error('This repository has no github.com remote.');
  return [...entries.values()];
}

export function createLocalClones(options: { interactiveFetchWaitMs?: number; now?: () => number } = {}) {
  const clones = new Map<string, { clone: LocalClone; reads: number; fallbacks: number; lastError?: string }>();
  return {
    configure(entries: LocalCloneEntry[]) {
      const previous = new Map(clones);
      clones.clear();
      for (const entry of entries) {
        const key = entry.repo.toLowerCase();
        const existing = previous.get(key);
        clones.set(
          key,
          existing && existing.clone.entry.path === entry.path && existing.clone.entry.remote === entry.remote
            ? existing
            : { clone: new LocalClone(entry, options), reads: 0, fallbacks: 0 }
        );
      }
    },
    has: (repo: string) => clones.has(repo.toLowerCase()),
    status: (): LocalCloneStatus[] =>
      [...clones.values()].map(({ clone, reads, fallbacks, lastError }) => ({
        ...clone.entry,
        reads,
        fallbacks,
        ...(lastError ? { lastError } : {}),
      })),
    /** Undefined means "ask GitHub": no clone, or a clone that could not answer. A clone never fails a read. */
    async read<T>(repo: string | undefined, operation: (clone: LocalClone) => Promise<T>): Promise<T | undefined> {
      const state = repo ? clones.get(repo.toLowerCase()) : undefined;
      if (!state) return undefined;
      const signal = githubReadSignal();
      try {
        const value = await operation(state.clone);
        state.reads++;
        delete state.lastError;
        return value;
      } catch (error) {
        signal?.throwIfAborted();
        state.fallbacks++;
        state.lastError = error instanceof Error ? error.message : String(error);
        // Git may have pruned an unreferenced commit since it was last seen.
        state.clone.forgetPresence();
        console.warn(`[local-clone] ${state.clone.entry.repo}: using GitHub instead. ${state.lastError}`);
        return undefined;
      }
    },
  };
}
export type LocalClones = ReturnType<typeof createLocalClones>;
export const localClones = createLocalClones();
