import { CircleAlert, Network } from 'lucide-react';
import { LoadingState } from './LoadingState';

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
  return (
    <div className="workflow-graph-state" data-loading={loading || undefined}>
      {loading ? (
        <LoadingState
          title="Preparing workflow graph"
          description={readingRuns ? 'Finding workflow runs on GitHub.' : 'Loading jobs and workflow definitions.'}
          hint="You can keep browsing."
        />
      ) : (
        <div className="workflow-graph-state-content">
          {failed ? <CircleAlert size={28} aria-hidden="true" /> : <Network size={28} aria-hidden="true" />}
          <div role="status" aria-atomic="true" className="workflow-graph-state-copy">
            <h2>{failed ? 'Could not load this workflow' : 'No workflow jobs reported'}</h2>
            <p>
              {failed
                ? 'Use Retry workflow above to try again.'
                : 'GitHub Actions workflows appear here. External checks are available in List view.'}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
