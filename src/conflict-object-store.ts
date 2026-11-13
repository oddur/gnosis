import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const hash = (value: string) => crypto.createHash('sha256').update(value).digest('hex');

/** A session directory that borrows its commits and trees from a shared store carries this file. */
export const SHARED_LAYOUT_FILE = 'gnosis-objects.json';
export const STORES_DIRECTORY = 'stores';

/**
 * One bare repository per account and base repository. Sessions borrow its objects through Git alternates, so a
 * second PR in the same repository only fetches what is new. A fork's head is fetched into its base repository's
 * store, because the two share almost all history.
 */
export function conflictStoreDirectory(root: string, account: string, repo: string) {
  return path.join(root, STORES_DIRECTORY, hash(JSON.stringify([account.toLowerCase(), repo.toLowerCase()])));
}

/** Store refs keep one session's commits from pruning. They are named by session, never by branch. */
export function conflictStoreRefPrefix(account: string, id: string) {
  return `refs/gnosis/${hash(JSON.stringify([account, id]))}/`;
}

/** Remote names in a store, one per GitHub repository. */
export function conflictStoreRemote(repo: string) {
  return `gh-${hash(repo.toLowerCase()).slice(0, 16)}`;
}

export interface SharedLayout {
  version: 1;
  /** The store directory, relative to the conflict cache root. */
  store: string;
  mergeBase: string;
}

export async function readSharedLayout(directory: string): Promise<SharedLayout | undefined> {
  try {
    const value: unknown = JSON.parse(await fs.readFile(path.join(directory, SHARED_LAYOUT_FILE), 'utf8'));
    if (!value || typeof value !== 'object') return;
    const { version, store, mergeBase } = value as Record<string, unknown>;
    if (version !== 1 || typeof store !== 'string' || typeof mergeBase !== 'string') return;
    return { version, store, mergeBase };
  } catch {
    return undefined;
  }
}

/**
 * The object directory of a linked local clone, found without running Git in it: its configuration may run
 * programs, and Gnosis never writes there. Handles a normal checkout, a linked worktree and a bare repository.
 */
export async function localCloneObjectDirectory(clone: string | undefined): Promise<string | undefined> {
  if (!clone || !path.isAbsolute(clone)) return;
  const commonObjects = async (gitDir: string) => {
    let common = gitDir;
    try {
      const pointer = (await fs.readFile(path.join(gitDir, 'commondir'), 'utf8')).trim();
      if (pointer) common = path.resolve(gitDir, pointer);
    } catch {
      /* Not a linked worktree. */
    }
    const objects = path.join(common, 'objects');
    const stat = await fs.stat(path.join(objects, 'pack')).catch(() => undefined);
    return stat?.isDirectory() ? objects : undefined;
  };
  const dotGit = path.join(clone, '.git');
  const stat = await fs.lstat(dotGit).catch(() => undefined);
  if (stat?.isDirectory()) return commonObjects(dotGit);
  if (stat?.isFile()) {
    const match = /^gitdir:\s*(.+)$/m.exec(await fs.readFile(dotGit, 'utf8').catch(() => ''));
    return match ? commonObjects(path.resolve(clone, match[1].trim())) : undefined;
  }
  // A bare clone.
  if (await fs.stat(path.join(clone, 'HEAD')).catch(() => undefined)) return commonObjects(clone);
  return undefined;
}

/** Serializes fetches, ref updates and cleanup per store. Git's own lock files fail rather than wait. */
export function createStoreLocks() {
  const locks = new Map<string, Promise<unknown>>();
  return async function withStore<T>(store: string, task: () => Promise<T>): Promise<T> {
    const previous = locks.get(store) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(task);
    locks.set(store, next);
    try {
      return await next;
    } finally {
      if (locks.get(store) === next) locks.delete(store);
    }
  };
}
