import { useEffect, useState } from 'react';
import { CircleAlert, Network } from 'lucide-react';

/** Only shown without a graph; cached graphs stay visible during refresh. */
export function WorkflowGraphState({
  loading,
  readingRuns,
  failed,
}: {
  loading: boolean;
  readingRuns: boolean;
  failed: boolean;
}) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    setElapsed(0);
    if (!loading) return;
    const started = Date.now();
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [loading]);
  return (
    <div className="workflow-graph-state" data-loading={loading || undefined}>
      <div className="workflow-graph-state-content">
        {loading ? (
          <svg className="workflow-loading-motif" viewBox="0 0 160 64" fill="none" aria-hidden="true">
            <path className="workflow-loading-track" d="M32 32H128" />
            <path className="workflow-loading-signal" pathLength="100" d="M32 32H128" />
            {[16, 64, 112].map((x) => (
              <g key={x}>
                <rect x={x} y="16" width="32" height="32" rx="6" />
                <circle cx={x + 16} cy="32" r="3" />
              </g>
            ))}
          </svg>
        ) : failed ? (
          <CircleAlert size={28} aria-hidden="true" />
        ) : (
          <Network size={28} aria-hidden="true" />
        )}
        <div role="status" aria-atomic="true" className="workflow-graph-state-copy">
          <h2>
            {loading
              ? 'Preparing workflow graph'
              : failed
                ? 'Could not load this workflow'
                : 'No workflow jobs reported'}
          </h2>
          <p>
            {loading
              ? readingRuns
                ? 'Finding workflow runs on GitHub.'
                : 'Loading jobs and workflow definitions.'
              : failed
                ? 'Use Retry workflow above to try again.'
                : 'GitHub Actions workflows appear here. External checks are available in List view.'}
          </p>
        </div>
        {loading && (
          <p className="workflow-graph-state-hint" aria-live="off">
            {elapsed >= 5 && <span className="workflow-loading-elapsed">{elapsed}s elapsed · </span>}
            You can keep browsing.
          </p>
        )}
      </div>
    </div>
  );
}
