import crypto from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { runConflictProcess } from './conflict-process';
import { hasConflictMarkers, type ConflictFile } from '../lib/conflict-resolution';
import { markersLeft } from '../lib/conflict-carry';

/** Git's resolution memory is local to one account/repository, never the user's Git configuration. */
export function createConflictMemory(directory: () => string) {
  const locks = new Map<string, Promise<unknown>>();
  const cachePath = (scope: string) => path.join(directory(), crypto.createHash('sha256').update(scope).digest('hex'));
  /**
   * One task per scope at a time. `signal` stops a wait for the lock: the caller gets the abort at once, and the task
   * never runs. The lock passes on only once the task before it settled, so a stopped wait never lets two run.
   */
  async function withCache<T>(scope: string, task: (cache: string) => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    const previous = locks.get(scope) ?? Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(async () => {
        signal?.throwIfAborted();
        const cache = cachePath(scope);
        await fs.mkdir(cache, { recursive: true, mode: 0o700 });
        return task(cache);
      });
    locks.set(scope, next);
    void next.then(
      () => {},
      () => {}
    ).finally(() => {
      if (locks.get(scope) === next) locks.delete(scope);
    });
    if (!signal) return next;
    let stop: (() => void) | undefined;
    const stopped = new Promise<never>((_, reject) => {
      stop = () => reject(signal.reason instanceof Error ? signal.reason : new Error('Stopped.'));
      signal.addEventListener('abort', stop, { once: true });
    });
    try {
      return await Promise.race([next, stopped]);
    } finally {
      if (stop) signal.removeEventListener('abort', stop);
    }
  }
  async function attach(repo: string, cache: string) {
    const target = path.join(repo, 'rr-cache');
    const current = await fs.lstat(target).catch(() => undefined);
    // A preview's private copy left behind by a quit: the repository uses the shared memory again.
    if (current?.isSymbolicLink() && isPreviewCopy(repo, await fs.readlink(target))) {
      await fs.rm(path.resolve(repo, await fs.readlink(target)), { recursive: true, force: true });
      await fs.unlink(target);
      return attach(repo, cache);
    }
    if (current) {
      if (!current.isSymbolicLink() || path.resolve(await fs.readlink(target)) !== path.resolve(cache))
        throw new Error('The private resolution cache has an unexpected location.');
    } else await fs.symlink(cache, target, process.platform === 'win32' ? 'junction' : 'dir');
  }
  const PREVIEW_COPY = 'rr-cache-preview-';
  const isPreviewCopy = (repo: string, link: string) => {
    const resolved = path.resolve(repo, link);
    return path.dirname(resolved) === path.resolve(repo) && path.basename(resolved).startsWith(PREVIEW_COPY);
  };
  /**
   * A private copy of the resolution memory for a dry run (#445 item 22): the shared lock is held only while it is
   * copied. The repository's `rr-cache` points at the copy until `release`, which restores the shared memory and
   * deletes the copy with whatever the dry run recorded in it. Each file is a copy-on-write clone where the file system
   * has them (APFS, Btrfs), so the copy costs almost nothing; elsewhere it is a plain copy. A copy that fails or is
   * stopped (`signal`) is deleted at once.
   */
  async function snapshot(scope: string, repo: string, signal?: AbortSignal) {
    const copy = path.join(repo, `${PREVIEW_COPY}${crypto.randomBytes(8).toString('hex')}`);
    const cache = await withCache(
      scope,
      async (cache) => {
        try {
          await fs.cp(cache, copy, { recursive: true, mode: constants.COPYFILE_FICLONE });
          // Stopped while it copied: the caller already gave up on it, and nothing else would delete it until startup.
          signal?.throwIfAborted();
        } catch (error) {
          await fs.rm(copy, { recursive: true, force: true });
          throw error;
        }
        return cache;
      },
      signal
    );
    const target = path.join(repo, 'rr-cache');
    const current = await fs.lstat(target).catch(() => undefined);
    if (current && !current.isSymbolicLink()) {
      await fs.rm(copy, { recursive: true, force: true });
      throw new Error('The private resolution cache has an unexpected location.');
    }
    if (current) await fs.unlink(target);
    await fs.symlink(copy, target, process.platform === 'win32' ? 'junction' : 'dir');
    return async () => {
      await fs.unlink(target).catch(() => {});
      await fs.symlink(cache, target, process.platform === 'win32' ? 'junction' : 'dir').catch(() => {});
      await fs.rm(copy, { recursive: true, force: true });
    };
  }
  async function useFiles(scope: string, files: ConflictFile[], record: boolean, signal: AbortSignal) {
    if (!files.length) return new Map<string, string>();
    return withCache(scope, async (cache) => {
      const temp = await fs.mkdtemp(path.join(path.dirname(cache), 'rerere-'));
      const env = {
        ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      };
      const git = async (args: string[], input?: string) => {
        const result = await runConflictProcess(
          'git',
          [
            '-c',
            'core.hooksPath=/dev/null',
            '-c',
            'core.autocrlf=false',
            '-c',
            'rerere.enabled=true',
            '-c',
            'rerere.autoupdate=false',
            ...args,
          ],
          { cwd: temp, env, input, signal }
        );
        if (result.code) throw new Error('Git could not reuse the saved conflict resolution.');
        return result.stdout.toString('utf8').trim();
      };
      try {
        await git(['init', '--template=', '.']);
        await attach(path.join(temp, '.git'), cache);
        const proposals = new Map<string, string>();
        for (const file of files) {
          signal.throwIfAborted();
          if (file.unsupported || !hasConflictMarkers(file.original)) continue;
          if (record && (!file.resolved || markersLeft(file, file.result))) continue;
          // A synthetic path avoids checking out any repository-controlled paths or attributes.
          const stages = [];
          for (const [index, text] of [file.base, file.ours, file.theirs].entries()) {
            const sha = await git(['hash-object', '-w', '--stdin'], text);
            stages.push(`100644 ${sha} ${index + 1}\tconflict.txt\n`);
          }
          await fs.rm(path.join(temp, '.git', 'MERGE_RR'), { force: true });
          await git(['read-tree', '--empty']);
          await git(['update-index', '--index-info'], stages.join(''));
          await fs.writeFile(path.join(temp, 'conflict.txt'), file.original);
          if (record) await git(['rerere', 'forget', 'conflict.txt']);
          await git(['rerere']);
          if (record) {
            await fs.writeFile(path.join(temp, 'conflict.txt'), file.result);
            await git(['rerere']);
          } else {
            const contents = await fs.readFile(path.join(temp, 'conflict.txt'), 'utf8');
            if (contents !== file.original && !markersLeft(file, contents)) proposals.set(file.path, contents);
          }
        }
        return proposals;
      } finally {
        await fs.rm(temp, { recursive: true, force: true });
      }
    });
  }
  return {
    apply: (scope: string, files: ConflictFile[], signal: AbortSignal) => useFiles(scope, files, false, signal),
    record: (scope: string, files: ConflictFile[], signal: AbortSignal) => useFiles(scope, files, true, signal),
    snapshot,
    /**
     * Leftover preview copies (a quit during a dry run): the repository uses the shared memory again. Never waits for
     * the shared lock: while another PR of the scope holds it, such as for a whole restack, the link is left for the
     * repository's next use to restore (`attach`).
     */
    async repair(scope: string, repo: string) {
      const target = path.join(repo, 'rr-cache');
      const link = await fs.readlink(target).catch(() => undefined);
      if (link && isPreviewCopy(repo, link) && !locks.has(scope)) await withCache(scope, (cache) => attach(repo, cache));
      for (const name of await fs.readdir(repo).catch(() => [] as string[]))
        if (name.startsWith(PREVIEW_COPY)) await fs.rm(path.join(repo, name), { recursive: true, force: true });
    },
    withRepository: <T>(scope: string, repo: string, task: () => Promise<T>) =>
      withCache(scope, async (cache) => {
        await attach(repo, cache);
        return task();
      }),
  };
}
