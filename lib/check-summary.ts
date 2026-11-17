/**
 * One check state for one PR or several, as the queue row shows it (`components/QueueMetadata.tsx`): failing beats
 * running, running beats passing, and no checks at all is neutral. Unknown while any PR's status is not read yet.
 * The Overview words it compactly (`checkView`): "passing", "2 failed", "running", "no checks", "checking…".
 */
import type { QueueSignals } from './queue-signals';

export type CheckSummaryState = 'failure' | 'pending' | 'success' | 'neutral' | 'unknown';

export function checkSummaryState(values: readonly Pick<QueueSignals, 'checks'>[], complete: boolean): CheckSummaryState {
  if (!complete) return 'unknown';
  if (values.some((value) => value.checks.state === 'failure')) return 'failure';
  if (values.some((value) => value.checks.state === 'pending')) return 'pending';
  return values.reduce((total, value) => total + value.checks.total, 0) ? 'success' : 'neutral';
}

export interface CheckView {
  state: CheckSummaryState;
  /** "passing", "2 failed", "running", "no checks", "checking…". */
  label: string;
  /** For descriptions: "checks passing", "2 checks failed", "checks running", "no checks", "checks not read yet". */
  spoken: string;
}

/** The compact check state of these PRs' current revisions. `undefined` is a PR whose status is not read yet. */
export function checkView(values: readonly (Pick<QueueSignals, 'checks'> | undefined)[]): CheckView {
  const known = values.filter((value): value is Pick<QueueSignals, 'checks'> => !!value);
  const state = checkSummaryState(known, known.length === values.length && values.length > 0);
  if (state === 'unknown') return { state, label: 'checking…', spoken: 'checks not read yet' };
  if (state === 'failure') {
    const failed = known.reduce((total, value) => total + (value.checks.failed ?? 0), 0);
    return failed
      ? { state, label: `${failed} failed`, spoken: `${failed} ${failed === 1 ? 'check' : 'checks'} failed` }
      : { state, label: 'failing', spoken: 'checks failing' };
  }
  if (state === 'pending') return { state, label: 'running', spoken: 'checks running' };
  if (state === 'success') return { state, label: 'passing', spoken: 'checks passing' };
  return { state, label: 'no checks', spoken: 'no checks' };
}
