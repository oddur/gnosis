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
