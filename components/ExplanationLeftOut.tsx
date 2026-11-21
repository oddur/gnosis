import { leftOutLabel, type LeftOutHunk } from '../lib/explanation-noise';
import { sourceForPath } from '../lib/workbench';
import type { ReviewGuide } from '../lib/types';
import type { ChangesFileTarget } from '../src/pages/ReviewPage';

/** Where a left-out hunk opens in Changes: its PR in a stack, its path there, and its changed lines. */
export function leftOutTarget(review: ReviewGuide, entry: LeftOutHunk): ChangesFileTarget {
  const { member, path } = sourceForPath(review, entry.filePath);
  return {
    url: member?.url ?? review.prUrl,
    headSha: member?.headSha ?? review.headSha,
    path,
    line: entry.startLine,
    endLine: entry.endLine,
    side: entry.side,
  };
}

/** The overview's "N changes left out as noise": each entry names its lines and reason, and opens them in Changes. */
export function ExplanationLeftOut({
  review,
  onOpen,
}: {
  review: ReviewGuide;
  onOpen?: (target: ChangesFileTarget) => void;
}) {
  const leftOut = review.noiseReduction?.leftOut ?? [];
  if (!leftOut.length) return null;
  return (
    <details className="explanation-context explanation-left-out">
      <summary>
        {leftOut.length.toLocaleString()} {leftOut.length === 1 ? 'change' : 'changes'} left out as noise
      </summary>
      <ul aria-label="Changes left out as noise">
        {leftOut.map((entry) => {
          const label = leftOutLabel(entry);
          return (
            <li key={`${entry.filePath}:${entry.side}:${entry.startLine}`}>
              <button
                type="button"
                disabled={!onOpen}
                title={onOpen ? `Open ${label} in Changes` : label}
                onClick={() => onOpen?.(leftOutTarget(review, entry))}
              >
                <span className="explanation-left-out-location">{label}</span>
                <span className="explanation-left-out-reason">{entry.reason}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </details>
  );
}
