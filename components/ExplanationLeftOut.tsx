import { leftOutLabel, type LeftOutHunk } from '../lib/explanation-noise';
import { outsideByFile, outsideLines } from '../lib/explanation-ranges';
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

/**
 * The end of a focused explanation (#563): "Code outside the explanation" lists the code no section shows, per file,
 * each entry with its lines and a link that opens them in Changes.
 */
export function ExplanationOutsideCode({
  review,
  onOpen,
}: {
  review: ReviewGuide;
  onOpen?: (target: ChangesFileTarget) => void;
}) {
  const files = outsideByFile(review.focusedSections?.outside);
  if (!files.length) return null;
  const count = files.reduce((n, file) => n + file.code.length, 0);
  return (
    <details className="explanation-outside-code">
      <summary>Code outside the explanation</summary>
      <p className="text-muted-foreground">
        {count.toLocaleString()} {count === 1 ? 'part' : 'parts'} of changed files no section shows. Changes shows every line.
      </p>
      <ul aria-label="Code outside the explanation">
        {files.map(({ filePath, code }) => {
          const { member, path } = sourceForPath(review, filePath);
          return (
            <li key={filePath} data-file-path={filePath}>
              <span className="explanation-outside-file">{path}</span>
              <ul>
                {code.map((entry) => {
                  const where = outsideLines(entry);
                  const name = `${path}:${where.label}`;
                  return (
                    <li key={entry.id}>
                      <button
                        type="button"
                        disabled={!onOpen}
                        aria-label={`Open ${entry.label}${entry.movedTo ? `, moved to ${sourceForPath(review, entry.movedTo.filePath).path},` : ''} at ${name} in Changes`}
                        title={onOpen ? `Open ${name} in Changes` : name}
                        onClick={() =>
                          onOpen?.({
                            url: member?.url ?? review.prUrl,
                            headSha: member?.headSha ?? review.headSha,
                            path,
                            line: where.start,
                            endLine: where.end,
                            side: where.side,
                          })
                        }
                      >
                        <span className="explanation-left-out-location">{where.label}</span>
                        <span className="explanation-left-out-reason">
                          {entry.label}
                          {entry.movedTo && (
                            <span className="explanation-outside-moved" data-moved-to={entry.movedTo.filePath}>
                              {' '}
                              · moved to <code>{sourceForPath(review, entry.movedTo.filePath).path}</code>
                            </span>
                          )}
                        </span>
                        <span className="explanation-outside-counts">
                          +{entry.additions.toLocaleString()} −{entry.deletions.toLocaleString()}
                        </span>
                        <span aria-hidden="true">↗</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </li>
          );
        })}
      </ul>
    </details>
  );
}
