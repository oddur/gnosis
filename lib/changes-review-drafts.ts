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
export function useChangesReviewDrafts(account: string, url: string) {
  const key = `gnosis-changes-drafts:${account}:${url}`;
  const read = () => {
    if (!account || !url) return empty;
    if (!values.has(key)) {
      try {
        const data: unknown = JSON.parse(localStorage.getItem(key) ?? '[]');
        values.set(
          key,
          Array.isArray(data)
            ? (data as unknown[]).filter((value): value is ChangesReviewDraft => {
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
  };
  const drafts = useSyncExternalStore((callback) => {
    listeners.add(callback);
    return () => listeners.delete(callback);
  }, read);
  const update = (fn: (current: ChangesReviewDraft[]) => ChangesReviewDraft[]) => {
    const next = fn(read());
    // Persist before reporting success; a full disk must not silently lose a review.
    localStorage.setItem(key, JSON.stringify(next));
    values.set(key, next);
    listeners.forEach((callback) => callback());
  };
  return { drafts, update };
}
