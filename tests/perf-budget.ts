/**
 * Timing budgets in browser checks are calibrated on a quiet machine. Shared CI runners are slower and noisier,
 * so outside strict runs each budget is scaled by a documented factor. Set GNOSIS_PERF_STRICT=1 to enforce the
 * budgets as written, or GNOSIS_PERF_BUDGET_SCALE to choose another factor. The factor keeps regressions visible:
 * the slowdowns these checks were written for were 2.5x or more over budget.
 */
export const PERF_BUDGET_SCALE = process.env.GNOSIS_PERF_STRICT === '1' ? 1 : Number(process.env.GNOSIS_PERF_BUDGET_SCALE ?? 1.6);

export function perfBudget(ms: number) {
  return Math.round(ms * PERF_BUDGET_SCALE);
}
