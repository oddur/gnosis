// Performance tests run locally only; see "Performance tests" in docs/continuous-integration.md.
import { AssertionError } from 'node:assert';

/**
 * Timing budgets are calibrated on a quiet machine. Shared CI runners are too noisy for them: the checks kept failing
 * on runner load, not on regressions. So timing assertions are enforced only outside CI:
 *
 * - `GNOSIS_PERF=1` enforces them (`npm run test:perf` sets it), `GNOSIS_PERF=0` reports them only.
 * - Without GNOSIS_PERF, they are enforced unless `CI` is set (GitHub Actions sets `CI=true`). Docker does not set CI.
 * - Report-only means the measured value and its budget are logged, and a value over budget is a warning, not a failure.
 *
 * Outside strict runs each budget is scaled by a documented factor, 1.6 by default, for a busy laptop or Docker on a
 * Mac. Set GNOSIS_PERF_STRICT=1 to enforce the budgets as written, or GNOSIS_PERF_BUDGET_SCALE to choose another
 * factor. The factor keeps regressions visible: the slowdowns these checks were written for were 2.5x or more over budget.
 */
export const PERF_BUDGET_SCALE = process.env.GNOSIS_PERF_STRICT === '1' ? 1 : Number(process.env.GNOSIS_PERF_BUDGET_SCALE ?? 1.6);

const flag = (value: string | undefined) => !!value && value !== '0' && value.toLowerCase() !== 'false';

/** True when timing assertions fail the run; false when they only report (CI). */
export const PERF_ENFORCED = process.env.GNOSIS_PERF !== undefined && process.env.GNOSIS_PERF !== '' ? flag(process.env.GNOSIS_PERF) : !flag(process.env.CI);

export function perfBudget(ms: number) {
  return Math.round(ms * PERF_BUDGET_SCALE);
}

type PerfOptions = { unit?: string; detail?: string };

const shown = (value: number) => (Number.isFinite(value) ? Math.round(value * 10) / 10 : value);

/**
 * Logs `value` against `budget` and returns whether the check passes: always true when timing is report-only, else
 * `value <= budget`. For suites that collect failures before they fail; others use assertPerf.
 */
export function withinPerf(name: string, value: number, budget: number, { unit = 'ms', detail }: PerfOptions = {}) {
  const over = !(value <= budget);
  const line = `[perf] ${name}: ${shown(value)} ${unit} (budget ${budget} ${unit})${over ? (PERF_ENFORCED ? ' OVER BUDGET' : ' over budget (report-only)') : ''}${over && detail ? ` ${detail}` : ''}`;
  console.log(line);
  if (over && !PERF_ENFORCED && process.env.GITHUB_ACTIONS) console.log(`::warning title=Perf budget (report-only)::${line.replace(/\r?\n/g, ' ')}`);
  return !over || !PERF_ENFORCED;
}

/** A timing or memory assertion: fails when `value` is over `budget` and timing is enforced, and only logs otherwise. */
export function assertPerf(name: string, value: number, budget: number, options: PerfOptions = {}) {
  if (!withinPerf(name, value, budget, options))
    throw new AssertionError({ message: `${name}: ${shown(value)} ${options.unit ?? 'ms'} is over the budget of ${budget} ${options.unit ?? 'ms'}${options.detail ? ` ${options.detail}` : ''}`, actual: value, expected: budget, operator: '<=' });
}
