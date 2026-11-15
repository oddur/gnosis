/** A GitHub account as GraphQL and REST report it. `__typename` is absent in older saved data. */
export interface GitHubActor {
  login: string;
  __typename?: string;
}

export const sameLogin = (a: string | null | undefined, b: string | null | undefined) =>
  !!a && !!b && a.toLowerCase() === b.toLowerCase();

/**
 * GitHub Apps and `[bot]` accounts. GraphQL reports an App as a `Bot` without the `[bot]` suffix that
 * REST adds, so `github-actions` is matched by name for data saved without its type.
 */
export function isAutomationActor(actor: GitHubActor | null | undefined): boolean {
  if (!actor) return false;
  return actor.__typename === 'Bot' || /\[bot\]$/i.test(actor.login) || /^github-actions$/i.test(actor.login);
}
