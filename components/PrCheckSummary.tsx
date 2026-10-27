import { CircleAlert, CircleCheck, Clock3 } from 'lucide-react';
import type { PrChecks } from '../lib/pr-checks';
import { checkCounts, checkGroup, checkLabel } from '../lib/pr-checks';
export function PrCheckSummary({
  value,
  error,
  busy,
  onOpen,
}: {
  value?: PrChecks;
  error?: string;
  busy?: boolean;
  onOpen: (id?: string) => void;
}) {
  if (!value)
    return (
      <div className="pr-check-summary">
        <button onClick={() => onOpen()}>
          {error ? 'Checks unavailable · View details' : busy ? 'Loading check results…' : 'View checks'}
        </button>
      </div>
    );
  const counts = checkCounts(value.checks);
  return (
    <div className="pr-check-summary" aria-label="Check results">
      <button className="pr-check-counts" onClick={() => onOpen()}>
        {counts.attention > 0 && (
          <strong className="check-attention">
            <CircleAlert size={15} />
            {counts.attention} need attention
          </strong>
        )}
        {counts.running > 0 && (
          <span className="check-running">
            <Clock3 size={15} />
            {counts.running} running
          </span>
        )}
        {counts.passed > 0 && (
          <span className="check-passed">
            <CircleCheck size={15} />
            {counts.passed} passed
          </span>
        )}
        {counts.skipped > 0 && <span>{counts.skipped} skipped or neutral</span>}
        {!value.checks.length && <span>No checks reported</span>}
      </button>
      <ul>
        {value.checks
          .filter((c) => checkGroup(c) === 'attention')
          .map((check) => (
            <li key={check.id}>
              <button onClick={() => onOpen(check.id)}>
                <CircleAlert size={14} />
                <span>{check.name}</span>
                <small>{checkLabel(check)}</small>
              </button>
            </li>
          ))}
      </ul>
      {error && <p role="status">Showing saved results. {error}</p>}
    </div>
  );
}
