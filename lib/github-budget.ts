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
