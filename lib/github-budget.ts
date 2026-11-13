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
 * allowance: 6% per hour, separate from the automatic 20% and not paced. Predictions never use search.
 */
export const PREDICTED_SHARE = 0.06;
export const predictedLimit = (resource: string, budget?: GitHubBudget, authenticated = true) =>
  resource === 'search' ? 0 : Math.max(1, Math.floor((budget?.limit || (authenticated ? 5000 : 60)) * PREDICTED_SHARE));
export function predictedDeadline(
  resource: string,
  usage: AutomaticUsage | undefined,
  now: number,
  budget?: GitHubBudget,
  authenticated = true
) {
  if (!usage || now >= usage.startedAt + automaticWindow(resource)) return 0;
  return usage.spent >= predictedLimit(resource, budget, authenticated) ? usage.startedAt + automaticWindow(resource) : 0;
}
/** Near the cap, predictions read fewer file bodies before they stop. */
export const PREDICTED_LIGHT_SHARE = 0.75;

/** What main tells the renderer's predictor. Mirrors `PredictionState` in lib/navigation-predictor.ts. */
export interface PredictionState {
  off: boolean;
  paused: boolean;
  battery: boolean;
  hot: boolean;
  light: boolean;
  spend?: unknown;
}
/**
 * On battery, predictions keep running but read one file body instead of three. Near the predicted cap they do
 * the same before they stop. Serious or critical heat leaves committed predictions only.
 */
export function predictionStateFor(input: {
  enabled: boolean;
  allowed: boolean;
  battery: boolean;
  thermal: string;
  usage: { spent: number; limit: number }[];
  spend?: unknown;
}): PredictionState {
  const nearCap = input.usage.some(({ spent, limit }) => spent >= PREDICTED_LIGHT_SHARE * limit);
  return {
    off: !input.enabled,
    paused: !input.enabled || !input.allowed,
    battery: input.battery,
    hot: input.thermal === 'serious' || input.thermal === 'critical',
    light: input.battery || nearCap,
    ...(input.spend !== undefined ? { spend: input.spend } : {}),
  };
}
