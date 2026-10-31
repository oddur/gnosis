import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { runConflictProcess } from './conflict-process';
import { hasConflictMarkers, type ConflictFile } from '../lib/conflict-resolution';

/** Git's resolution memory is local to one account/repository, never the user's Git configuration. */
export function createConflictMemory(directory: () => string) {
  const locks = new Map<string, Promise<unknown>>();
  const cachePath = (scope: string) => path.join(directory(), crypto.createHash('sha256').update(scope).digest('hex'));
  async function withCache<T>(scope: string, task: (cache: string) => Promise<T>): Promise<T> {
    const previous = locks.get(scope) ?? Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(async () => {
        const cache = cachePath(scope);
        await fs.mkdir(cache, { recursive: true, mode: 0o700 });
        return task(cache);
      });
    locks.set(scope, next);
    try {
      return await next;
    } finally {
      if (locks.get(scope) === next) locks.delete(scope);
    }
  }
  async function attach(repo: string, cache: string) {
    const target = path.join(repo, 'rr-cache');
    const current = await fs.lstat(target).catch(() => undefined);
    if (current) {
      if (!current.isSymbolicLink() || path.resolve(await fs.readlink(target)) !== path.resolve(cache))
        throw new Error('The private resolution cache has an unexpected location.');
    } else await fs.symlink(cache, target, process.platform === 'win32' ? 'junction' : 'dir');
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
          if (record && (!file.resolved || hasConflictMarkers(file.result))) continue;
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
            if (contents !== file.original && !hasConflictMarkers(contents)) proposals.set(file.path, contents);
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
    withRepository: <T>(scope: string, repo: string, task: () => Promise<T>) =>
      withCache(scope, async (cache) => {
        await attach(repo, cache);
        return task();
      }),
  };
}
