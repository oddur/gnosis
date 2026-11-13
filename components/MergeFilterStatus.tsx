import { LoadingIndicator } from './LoadingState';
import type { MergeLoadPhase } from '../lib/use-queue-signals';

const prs = (count: number) => `${count} ${count === 1 ? 'PR' : 'PRs'}`;

/**
 * Explains PRs the merge filter cannot place yet. They are not listed: an unknown PR is not known to
 * conflict. Counting them here keeps them from vanishing silently.
 */
export function MergeFilterStatus({ phase, computing, unchecked }: { phase: MergeLoadPhase; computing: number; unchecked: number }) {
  if (phase === 'loading' && unchecked > 0)
    return (
      <div className="queue-response-status queue-merge-status">
        <LoadingIndicator>Checking merge state for {prs(unchecked)}…</LoadingIndicator>
      </div>
    );
  if (!computing && !unchecked) return null;
  const pending = phase !== 'done';
  return (
    <div className="queue-response-status queue-merge-status">
      <span role="status">
        {computing > 0 &&
          `${prs(computing)}${computing === 1 ? '’s' : '’'} merge state is still being computed by GitHub. ${
            pending ? 'Checking again shortly.' : 'Not listed until GitHub finishes.'
          }`}
        {computing > 0 && unchecked > 0 && ' '}
        {unchecked > 0 && `Could not check merge state for ${prs(unchecked)}. Not listed.`}
      </span>
    </div>
  );
}
