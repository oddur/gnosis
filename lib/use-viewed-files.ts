import { useState } from 'react';
import { subjectForReview } from './workbench';
import type { ReviewGuide } from './types';

function loadViewedFiles(key: string | null): Set<string> {
  try {
    const stored: unknown = key ? JSON.parse(localStorage.getItem(key) ?? '[]') : [];
    return new Set(Array.isArray(stored) ? stored.filter((path): path is string => typeof path === 'string') : []);
  } catch {
    return new Set();
  }
}

/** Local progress, shared by every topic showing the same source-qualified file. */
export function useViewedFiles(review: ReviewGuide) {
  const revision = review.snapshot?.fingerprint ?? review.headSha ?? review.reviewId;
  const key = revision ? `gnosis-viewed-files:${subjectForReview(review)}:${revision}` : null;
  const [state, setState] = useState(() => ({ key, paths: loadViewedFiles(key) }));
  // Reset before rendering a different revision; never copy old marks into it.
  if (state.key !== key) setState({ key, paths: loadViewedFiles(key) });

  function setFileViewed(filePath: string, viewed: boolean) {
    const paths = new Set(state.paths);
    if (viewed) paths.add(filePath);
    else paths.delete(filePath);
    setState({ key, paths });
    try {
      if (key) localStorage.setItem(key, JSON.stringify([...paths]));
    } catch {
      // Keep session progress when storage is unavailable.
    }
  }
  return { viewedFiles: state.paths, setFileViewed };
}
