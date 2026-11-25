import { createContext } from 'react';
import { explainedMarkers, type ExplainedMarker } from './explained-markers';
import type { ExplanationDestination } from './explanation-workspace';
import type { ReviewGuide } from './types';
import { sourceForPath } from './workbench';

/**
 * Focused sections' markers for Changes (#564): the PR's current explanation says, per file, which section explains
 * each part. A PR view provides it; Changes reads a file's markers by its PR, path and head, so an explanation of
 * another head marks nothing (its lines would not match).
 */
export interface ExplainedChanges {
  markersFor: (url: string, path: string, headSha: string) => readonly ExplainedMarker[] | undefined;
  open: (marker: ExplainedMarker) => void;
}

export const ExplainedChangesContext = createContext<ExplainedChanges | undefined>(undefined);

const fileKey = (url: string, path: string) => `${url}\u0000${path}`;

/**
 * The markers of an explanation by Changes' file (its PR and path), and the jump to a marker's section. Undefined when
 * the explanation has no Focused sections. `open` gets the Explanation destination for a marker's section.
 */
export function explainedChanges(
  review: ReviewGuide | undefined,
  open: (destination: ExplanationDestination) => void
): ExplainedChanges | undefined {
  const markers = explainedMarkers(review);
  const reviewId = review?.reviewId;
  if (!review || !markers?.size || !reviewId) return undefined;
  const files = new Map<string, { headSha: string; markers: ExplainedMarker[] }>();
  for (const [filePath, list] of markers) {
    const { member, path } = sourceForPath(review, filePath);
    const headSha = member?.headSha ?? review.headSha;
    if (headSha) files.set(fileKey(member?.url ?? review.prUrl, path), { headSha, markers: list });
  }
  return {
    markersFor: (url, path, headSha) => {
      const file = files.get(fileKey(url, path));
      return file && file.headSha === headSha ? file.markers : undefined;
    },
    open: (marker) => {
      if (!marker.target) return;
      open({
        review,
        command: {
          destination: {
            kind: 'review',
            reviewId,
            slideId: marker.slideId,
            filePath: marker.target.filePath,
            line: marker.target.line,
            side: marker.target.side,
          },
          nonce: Date.now(),
        },
      });
    },
  };
}
