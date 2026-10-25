import { useSyncExternalStore } from 'react';
import type { PendingReviewComment } from './types';
export interface ChangesReviewDraft extends PendingReviewComment {
  headSha: string;
  baseSha: string;
  baseBranch: string;
}
const values = new Map<string, ChangesReviewDraft[]>();
const listeners = new Set<() => void>();
const empty: ChangesReviewDraft[] = [];
let version = 0;
const keyFor = (account: string, url: string) => `gnosis-changes-drafts:${account}:${url}`;
export function readReviewDrafts(account: string, url: string): ChangesReviewDraft[] {
  if (!account || !url) return empty;
  const key = keyFor(account, url);
  if (!values.has(key)) {
    try {
      const data: unknown = JSON.parse(localStorage.getItem(key) ?? '[]');
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
export function updateReviewDrafts(
  account: string,
  url: string,
  fn: (current: ChangesReviewDraft[]) => ChangesReviewDraft[]
) {
  if (!account || !url) throw new Error('Connect GitHub to save review comments.');
  const key = keyFor(account, url),
    next = fn(readReviewDrafts(account, url));
  localStorage.setItem(key, JSON.stringify(next));
  values.set(key, next);
  version++;
  listeners.forEach((callback) => callback());
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
