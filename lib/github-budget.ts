import { effectiveAmount, DEFAULT_PRELOAD_BUDGET_PERCENT, type PreloadAmount } from './preload-settings';
/** Automatic work gets a minority of the user's shared allowance, even on a cold cache. */
export interface AutomaticUsage {
  startedAt: number;
  spent: number;
}
export interface GitHubBudget {
  remaining: number;
  limit: number;
  reset: number;
}
export const automaticWindow = (resource: string) => (resource === 'search' ? 60_000 : 3_600_000);
export const automaticLimit = (resource: string, budget?: GitHubBudget, authenticated = true) =>
  Math.max(1, Math.floor((budget?.limit || (resource === 'search' ? 30 : authenticated ? 5000 : 60)) * 0.2));
export function automaticDeadline(
  resource: string,
  usage: AutomaticUsage | undefined,
  now: number,
  budget?: GitHubBudget,
  authenticated = true
) {
  if (!usage || now >= usage.startedAt + automaticWindow(resource)) return 0;
  return usage.spent >= automaticLimit(resource, budget, authenticated)
    ? usage.startedAt + automaticWindow(resource)
    : 0;
}
export function automaticSpacing(
  resource: string,
  usage: AutomaticUsage,
  now: number,
  budget?: GitHubBudget,
  authenticated = true
) {
  return Math.ceil(
    Math.max(0, usage.startedAt + automaticWindow(resource) - now) /
      Math.max(1, automaticLimit(resource, budget, authenticated) - usage.spent + 1)
  );
}

/**
 * Navigation predictions, such as warming the tabs of the PR the reader just opened, get their own share of each
 * allowance, separate from the automatic 20% and not paced. Settings › Preloading chooses the share (6% unless
 * changed); it scales with the real limit. Predictions never use search.
 */
export const PREDICTED_SHARE = DEFAULT_PRELOAD_BUDGET_PERCENT / 100;
export const predictedLimit = (resource: string, budget?: GitHubBudget, authenticated = true, share = PREDICTED_SHARE) =>
  resource === 'search' ? 0 : Math.max(1, Math.floor((budget?.limit || (authenticated ? 5000 : 60)) * share));
export function predictedDeadline(
  resource: string,
  usage: AutomaticUsage | undefined,
  now: number,
  budget?: GitHubBudget,
  authenticated = true,
  share = PREDICTED_SHARE
) {
  if (!usage || now >= usage.startedAt + automaticWindow(resource)) return 0;
  return usage.spent >= predictedLimit(resource, budget, authenticated, share) ? usage.startedAt + automaticWindow(resource) : 0;
}
/** Near the cap, predictions step down one amount before they stop. */
export const PREDICTED_LIGHT_SHARE = 0.75;

/** Spend this hour against the predicted limit, per resource. */
export interface PredictedUsage {
  spent: number;
  limit: number;
}
/** What main tells the renderer's predictor. Mirrors `PredictionState` in lib/navigation-predictor.ts. */
export interface PredictionState {
  off: boolean;
  paused: boolean;
  battery: boolean;
  hot: boolean;
  /** On battery or near the predicted cap: `amount` is one level below the chosen one. */
  light: boolean;
  /** The amount predictions use now: the chosen one, stepped down when `light`. Missing means normal. */
  amount?: PreloadAmount;
  /** REST and GraphQL spend this hour, for Settings. */
  usage?: { core: PredictedUsage; graphql: PredictedUsage };
  spend?: unknown;
}
/**
 * On battery, or near the predicted cap, predictions keep running one amount lower (Eager → Normal → Light, never
 * below Light) before they stop. Serious or critical heat leaves committed predictions only.
 */
export function predictionStateFor(input: {
  enabled: boolean;
  allowed: boolean;
  battery: boolean;
  thermal: string;
  /** Spend per resource; any at 75% of its limit is near the cap. Core and GraphQL are shown in Settings. */
  usage: PredictedUsage[] | { core: PredictedUsage; graphql: PredictedUsage };
  amount?: PreloadAmount;
  spend?: unknown;
}): PredictionState {
  const usage = Array.isArray(input.usage) ? input.usage : [input.usage.core, input.usage.graphql];
  const nearCap = usage.some(({ spent, limit }) => spent >= PREDICTED_LIGHT_SHARE * limit);
  const light = input.battery || nearCap;
  return {
    off: !input.enabled,
    paused: !input.enabled || !input.allowed,
    battery: input.battery,
    hot: input.thermal === 'serious' || input.thermal === 'critical',
    light,
    amount: effectiveAmount(input.amount ?? 'normal', light),
    ...(!Array.isArray(input.usage) ? { usage: input.usage } : {}),
    ...(input.spend !== undefined ? { spend: input.spend } : {}),
  };
}
