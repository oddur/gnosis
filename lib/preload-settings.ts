/**
 * Settings › Integrations › Preloading. Pure, so main, the renderer and unit tests share one reading of
 * `preferences.json`. Missing or invalid values fall back to the defaults.
 */
export type PreloadAmount = 'light' | 'normal' | 'eager';
export const PRELOAD_AMOUNTS = ['light', 'normal', 'eager'] as const satisfies readonly PreloadAmount[];
export const DEFAULT_PRELOAD_AMOUNT: PreloadAmount = 'normal';
/** Share of each hourly GitHub limit that preloading may spend, in percent. */
export const PRELOAD_BUDGET_PERCENTS = [3, 6, 10, 15] as const;
export const DEFAULT_PRELOAD_BUDGET_PERCENT = 6;

export interface PreloadPreferences {
  /** "Preload likely next pages": predictions and every hover or focus intent, queue rows included. */
  predictNavigation?: boolean;
  /** "Amount": how much an opened PR warms. */
  preloadAmount?: PreloadAmount;
  /** "Prepare the top of the queue": background preparation of queue PRs for their position alone. */
  prepareQueue?: boolean;
  /** "Hourly GitHub budget for preloading", in percent of each hourly limit. */
  preloadBudgetPercent?: number;
}
export interface PreloadSettings {
  predictNavigation: boolean;
  amount: PreloadAmount;
  prepareQueue: boolean;
  budgetPercent: number;
}

export const normalizePreloadAmount = (value: unknown): PreloadAmount =>
  PRELOAD_AMOUNTS.find((amount) => amount === value) ?? DEFAULT_PRELOAD_AMOUNT;
export const normalizePreloadBudgetPercent = (value: unknown): number =>
  PRELOAD_BUDGET_PERCENTS.find((percent) => percent === value) ?? DEFAULT_PRELOAD_BUDGET_PERCENT;

/** The four settings from saved preferences. Switches are on unless saved as `false`. */
export function preloadSettings(preferences: unknown): PreloadSettings {
  const p = (preferences && typeof preferences === 'object' ? preferences : {}) as Record<string, unknown>;
  return {
    predictNavigation: p.predictNavigation !== false,
    amount: normalizePreloadAmount(p.preloadAmount),
    prepareQueue: p.prepareQueue !== false,
    budgetPercent: normalizePreloadBudgetPercent(p.preloadBudgetPercent),
  };
}

/** What an opened PR warms at each amount. */
export interface AmountPlan {
  /** File bodies Changes opens on. */
  files: number;
  /** The workflow graph of the preferred run (failed, then running) of the member Checks opens on. */
  graph: boolean;
  /** Details of failing checks, at most five. */
  details: boolean;
  /** Logs of failing jobs in the preferred run. */
  logs: number;
  /** Graphs of other stack members with failing checks. */
  members: number;
}
export const AMOUNT_PLANS: Readonly<Record<PreloadAmount, Readonly<AmountPlan>>> = {
  light: { files: 1, graph: false, details: false, logs: 0, members: 0 },
  normal: { files: 3, graph: true, details: true, logs: 0, members: 0 },
  eager: { files: 6, graph: true, details: true, logs: 3, members: 2 },
};
/** On battery or near the hourly cap, one level less. Light stays Light. */
export function effectiveAmount(amount: PreloadAmount, reduced: boolean): PreloadAmount {
  if (!reduced) return amount;
  return amount === 'eager' ? 'normal' : 'light';
}
export const amountPlan = (amount: unknown): Readonly<AmountPlan> => AMOUNT_PLANS[normalizePreloadAmount(amount)];
/** The saved form: every field present and valid. */
export function normalizePreloadPreferences(preferences: unknown): Required<PreloadPreferences> {
  const settings = preloadSettings(preferences);
  return {
    predictNavigation: settings.predictNavigation,
    preloadAmount: settings.amount,
    prepareQueue: settings.prepareQueue,
    preloadBudgetPercent: settings.budgetPercent,
  };
}
