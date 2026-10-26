import { readReviewState, writeReviewState } from './renderer-review-state';
import { useSyncExternalStore } from 'react';
import type { PendingReviewComment } from './types';
import { isLocalUrl } from './local-url';
export interface ChangesReviewDraft extends PendingReviewComment {
  headSha: string;
  baseSha: string;
  baseBranch: string;
}
const values = new Map<string, ChangesReviewDraft[]>();
const listeners = new Set<() => void>();
const empty: ChangesReviewDraft[] = [];
let version = 0;
// Local notes belong to the working copy, independently of GitHub sign-in.
const keyFor = (account: string, url: string) => `gnosis-changes-drafts:${isLocalUrl(url) ? 'local' : account}:${url}`;
export function readReviewDrafts(account: string, url: string): ChangesReviewDraft[] {
  if (!url || (!account && !isLocalUrl(url))) return empty;
  const key = keyFor(account, url);
  if (!values.has(key)) {
    try {
      const data: unknown = readReviewState(key) ?? [];
      values.set(
        key,
        Array.isArray(data)
          ? data.filter((value): value is ChangesReviewDraft => {
              if (!value || typeof value !== 'object') return false;
              const d = value as ChangesReviewDraft;
              return (
                typeof d.id === 'string' &&
                typeof d.body === 'string' &&
                typeof d.filePath === 'string' &&
                typeof d.headSha === 'string' &&
                typeof d.baseSha === 'string' &&
                typeof d.baseBranch === 'string' &&
                Number.isSafeInteger(d.line) &&
                d.line > 0 &&
                ['LEFT', 'RIGHT'].includes(d.side)
              );
            })
          : []
      );
    } catch {
      values.set(key, []);
    }
  }
  return values.get(key) ?? empty;
}
const pending = new Map<string, Promise<void>>();
export async function updateReviewDrafts(
  account: string,
  url: string,
  fn: (current: ChangesReviewDraft[]) => ChangesReviewDraft[]
): Promise<void> {
  if (!url || (!account && !isLocalUrl(url))) throw new Error('Connect GitHub to save review comments.');
  const key = keyFor(account, url);
  const save = (pending.get(key) ?? Promise.resolve())
    .catch(() => {})
    .then(async () => {
      const next = fn(readReviewDrafts(account, url));
      await writeReviewState(key, next);
      values.set(key, next);
      version++;
      listeners.forEach((callback) => callback());
    });
  pending.set(key, save);
  try {
    await save;
  } finally {
    if (pending.get(key) === save) pending.delete(key);
  }
}
export const subscribeReviewDrafts = (callback: () => void) => {
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
  };
};
export const reviewDraftVersion = () => version;
export function useChangesReviewDrafts(account: string, url: string) {
  const drafts = useSyncExternalStore(subscribeReviewDrafts, () => readReviewDrafts(account, url));
  return {
    drafts,
    update: (fn: (current: ChangesReviewDraft[]) => ChangesReviewDraft[]) => updateReviewDrafts(account, url, fn),
  };
}
