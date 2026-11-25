import { useCallback, useMemo, useRef, useState } from 'react';
import { readReviewState, scheduleReviewStateWrite, writeReviewState } from './renderer-review-state';
import { subjectForReview } from './workbench';
import type { ReviewGuide } from './types';
import { explanationFileParts, partCheckbox, readViewedParts, togglePart, viewedPartsKey } from './viewed-parts';

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
  const parts = useMemo(() => explanationFileParts(review), [review.slides, review.focusedSections]);
  const revision = review.snapshot?.fingerprint ?? review.headSha ?? review.reviewId ?? '';
  const key = viewedPartsKey(subjectForReview(review), revision);
  const read = () => {
    try {
      return readViewedParts(readReviewState(key), revision);
    } catch {
      // Saved progress may still be loading: start with no parts seen (fail closed).
      return new Set<string>();
    }
  };
  const [state, setState] = useState(() => ({ key, seen: read() }));
  const seen = state.key === key ? state.seen : read();
  if (state.key !== key) setState({ key, seen });
  // The pending save, per key: a newer save of the same key replaces it; one of another key still runs.
  const pending = useRef<{ key: string; cancel: () => void } | undefined>(undefined);
  const save = useCallback(
    (next: Set<string>) => {
      setState({ key, seen: next });
      if (pending.current?.key === key) pending.current.cancel();
      // Quit runs a pending save at once.
      const cancel = scheduleReviewStateWrite(
        () => writeReviewState(key, next.size ? { revision, units: [...next] } : null).catch(() => {}),
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
  const change = useCallback(
    (filePath: string, section: number, next: boolean) => {
      const result = togglePart(parts?.get(filePath), section, next, seen, viewedFiles.has(filePath));
      if (parts) save(result.seen);
      if (result.viewed !== undefined) void setFileViewed(filePath, result.viewed);
    },
    [parts, seen, viewedFiles, setFileViewed, save]
  );
  return { parts, checkbox, change };
}
