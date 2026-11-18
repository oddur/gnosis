/**
 * The OAuth scopes Gnosis asks for when you sign in, by sign-in code (device flow) or through the browser (web flow).
 * `read:org` lets GitHub evaluate organization rules (rulesets, code owners, team review requests) for Gnosis's
 * sign-in the way it does on github.com. Without it GitHub can report a PR as BLOCKED to Gnosis while its website
 * shows it ready to merge.
 */
export const GITHUB_OAUTH_SCOPES = ['repo', 'read:org'] as const;
/** The `scope` parameter both sign-in flows send. */
export const GITHUB_OAUTH_SCOPE = GITHUB_OAUTH_SCOPES.join(' ');

/**
 * The scopes of a classic token from GitHub's `X-OAuth-Scopes` response header, in GitHub's order. Undefined when
 * the header is absent: fine-grained tokens, GitHub App tokens and anonymous requests report no scopes. An empty
 * header is a classic token with no scopes.
 */
export function parseOAuthScopes(header: unknown): string[] | undefined {
  if (header === undefined || header === null) return undefined;
  if (typeof header !== 'string' && typeof header !== 'number') return undefined;
  return [
    ...new Set(
      String(header)
        .split(',')
        .map((scope) => scope.trim())
        .filter(Boolean)
    ),
  ];
}

/** `admin:org` and `write:org` include `read:org`. */
export const canReadOrg = (scopes: readonly string[]) =>
  scopes.some((scope) => scope === 'read:org' || scope === 'write:org' || scope === 'admin:org');

/**
 * True only when GitHub reported this token's scopes and they leave out organization reads. Unknown scopes (null or
 * undefined) never prompt: a fine-grained token has no `X-OAuth-Scopes`, and its access is set on GitHub.
 */
export const lacksOrgRead = (scopes: readonly string[] | null | undefined): boolean => !!scopes && !canReadOrg(scopes);

/** "repo, read:org", or how GitHub described this sign-in's access when it reported no scopes. */
export function accessLabel(scopes: readonly string[] | null | undefined): string {
  if (scopes === undefined) return 'not checked yet';
  if (scopes === null) return 'not reported by GitHub (fine-grained token or app)';
  return scopes.length ? scopes.join(', ') : 'no scopes';
}

/** The copy shown wherever Gnosis asks you to sign in again for `read:org`. */
export const ORG_SCOPE_PROMPT =
  'Gnosis now asks to read your organization membership. It needs it to check merge rules and team review requests the way GitHub does.';

/** Main → renderer: the signed-in account and the scopes GitHub last reported for its token. */
export interface GitHubAccess {
  login: string | null;
  /** Undefined: no GitHub response seen yet. Null: GitHub sent no `X-OAuth-Scopes` (not a classic token). */
  scopes?: string[] | null;
}
