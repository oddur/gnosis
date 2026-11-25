import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { readReviewState, scheduleReviewStateWrite, writeReviewState } from './renderer-review-state';
import { subjectForReview } from './workbench';
import type { ReviewGuide } from './types';
import {
  explanationFileParts,
  partCheckbox,
  readViewedParts,
  reconcileParts,
  sectionPartSeen,
  togglePart,
  viewedPartsKey,
  viewedPartsValue,
  type SavedParts,
} from './viewed-parts';

/**
 * Viewed by parts (#564) for an explanation: its files' parts, the parts seen, and a section checkbox's state and
 * change. Seen parts persist per PR and head, like the other review state; a new head reads a new key, so they reset
 * as Viewed does. Without Focused sections, `parts` is undefined and the checkboxes work as before.
 */
export function useViewedParts(
  review: ReviewGuide,
  viewedFiles: ReadonlySet<string>,
  setFileViewed: (path: string, viewed: boolean) => unknown
) {
  const parts = useMemo(() => explanationFileParts(review), [review.slides, review.focusedSections, review.noiseReduction]);
  const revision = review.snapshot?.fingerprint ?? review.headSha ?? review.reviewId ?? '';
  const key = viewedPartsKey(subjectForReview(review), revision);
  const read = (): SavedParts => {
    try {
      return readViewedParts(readReviewState(key), revision);
    } catch {
      // Saved progress may still be loading: start with no parts seen (fail closed).
      return { seen: new Set(), viewed: new Set() };
    }
  };
  const [state, setState] = useState(() => ({ key, ...read() }));
  const current = state.key === key ? state : { key, ...read() };
  if (state.key !== key) setState(current);
  const seen = current.seen;
  // The pending save, per key: a newer save of the same key replaces it; one of another key still runs.
  const pending = useRef<{ key: string; cancel: () => void } | undefined>(undefined);
  const save = useCallback(
    (next: SavedParts) => {
      setState({ key, ...next });
      if (pending.current?.key === key) pending.current.cancel();
      // Quit runs a pending save at once.
      const cancel = scheduleReviewStateWrite(
        () => writeReviewState(key, viewedPartsValue(revision, next)).catch(() => {}),
        300
      );
      pending.current = { key, cancel };
    },
    [key, revision]
  );
  const checkbox = useCallback(
    (filePath: string, section: number) => partCheckbox(parts?.get(filePath), section, seen, viewedFiles.has(filePath)),
    [parts, seen, viewedFiles]
  );
  const partSeen = useCallback(
    (filePath: string, section: number) => sectionPartSeen(parts?.get(filePath), section, seen, viewedFiles.has(filePath)),
    [parts, seen, viewedFiles]
  );
  // This page's own Viewed changes until they apply: they are not un-views from elsewhere.
  const own = useRef(new Map<string, boolean>());
  const change = useCallback(
    (filePath: string, section: number, next: boolean) => {
      const result = togglePart(parts, filePath, section, next, seen, (path) => viewedFiles.has(path));
      for (const [path, value] of result.viewed) {
        own.current.set(path, value);
        void setFileViewed(path, value);
      }
      if (parts) save(reconcileParts(parts, { seen: result.seen, viewed: current.viewed }, viewedFiles, own.current));
    },
    [parts, seen, current.viewed, viewedFiles, setFileViewed, save]
  );
  // On load, and whenever Viewed changes: a file un-viewed elsewhere since the parts were saved loses them (#564).
  useEffect(() => {
    for (const [path, value] of own.current) if (viewedFiles.has(path) === value) own.current.delete(path);
    if (!parts) return;
    const next = reconcileParts(parts, current, viewedFiles, own.current);
    const same = (a: ReadonlySet<string>, b: ReadonlySet<string>) => a.size === b.size && [...a].every((x) => b.has(x));
    if (!same(next.seen, current.seen) || !same(next.viewed, current.viewed)) save(next);
  });
  return { parts, checkbox, partSeen, change };
}
