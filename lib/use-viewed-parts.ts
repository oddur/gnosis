import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { readReviewState, scheduleReviewStateWrite, writeReviewState } from './renderer-review-state';
import { subjectForReview } from './workbench';
import type { ReviewGuide } from './types';
import {
  clearUnviewed,
  explanationFileParts,
  partCheckbox,
  readViewedParts,
  sectionPartSeen,
  togglePart,
  viewedPartsKey,
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
  const partSeen = useCallback(
    (filePath: string, section: number) => sectionPartSeen(parts?.get(filePath), section, seen, viewedFiles.has(filePath)),
    [parts, seen, viewedFiles]
  );
  // Files a section's checkbox un-views keep their other parts seen; files un-viewed elsewhere lose them (#564).
  const ownUnview = useRef(new Set<string>());
  const change = useCallback(
    (filePath: string, section: number, next: boolean) => {
      const result = togglePart(parts, filePath, section, next, seen, (path) => viewedFiles.has(path));
      if (parts) save(result.seen);
      for (const [path, value] of result.viewed) {
        if (!value) ownUnview.current.add(path);
        void setFileViewed(path, value);
      }
    },
    [parts, seen, viewedFiles, setFileViewed, save]
  );
  const before = useRef<ReadonlySet<string>>(viewedFiles);
  useEffect(() => {
    const previous = before.current;
    before.current = viewedFiles;
    if (!parts) return;
    const unviewed = [...previous].filter((path) => !viewedFiles.has(path) && !ownUnview.current.delete(path));
    const next = unviewed.length ? clearUnviewed(parts, seen, unviewed) : seen;
    if (next.size !== seen.size) save(next);
  });
  return { parts, checkbox, partSeen, change };
}
