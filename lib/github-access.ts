/**
 * The OAuth scopes Gnosis asks for when you sign in, by sign-in code (device flow) or through the browser (web flow).
 * `read:org` lets GitHub evaluate organization rules (rulesets, code owners, team review requests) for Gnosis's
 * sign-in the way it does on github.com. `workflow` lets Gnosis merge a PR that changes `.github/workflows/`: GitHub
 * reports such a PR as BLOCKED to a token without it (klanggames/seed#35392), and refuses the merge.
 */
export const GITHUB_OAUTH_SCOPES = ['repo', 'read:org', 'workflow'] as const;
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

/** The scopes Gnosis asks for beyond `repo`, which older sign-ins may lack. */
export type RecommendedScope = 'read:org' | 'workflow';
export const RECOMMENDED_SCOPES: readonly RecommendedScope[] = ['read:org', 'workflow'];

/**
 * The recommended scopes this token lacks, in `RECOMMENDED_SCOPES` order. Empty when GitHub reported no scopes (null
 * or undefined): a fine-grained token has no `X-OAuth-Scopes`, and its access is set on GitHub, so it never prompts.
 * `write:org` and `admin:org` include `read:org`.
 */
export function missingScopes(scopes: readonly string[] | null | undefined): RecommendedScope[] {
  if (!scopes) return [];
  return RECOMMENDED_SCOPES.filter((scope) => (scope === 'read:org' ? !canReadOrg(scopes) : !scopes.includes(scope)));
}

/** True only when GitHub reported this token's scopes and they leave out organization reads. */
export const lacksOrgRead = (scopes: readonly string[] | null | undefined): boolean =>
  missingScopes(scopes).includes('read:org');
/** True only when GitHub reported this token's scopes and they leave out `workflow`. */
export const lacksWorkflow = (scopes: readonly string[] | null | undefined): boolean =>
  missingScopes(scopes).includes('workflow');

/**
 * "Not now" on the sign-in prompt stores the scopes that were missing then. The prompt returns once when a scope
 * missing now was not part of that set. `'1'` is the earlier boolean form, from when only `read:org` was asked for.
 */
export function parseDismissedScopes(raw: string | null | undefined): string[] {
  if (!raw) return [];
  if (raw === '1') return ['read:org'];
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((scope): scope is string => typeof scope === 'string') : [];
  } catch {
    return [];
  }
}
export const serializeDismissedScopes = (missing: readonly string[]) => JSON.stringify([...missing]);
/** Ask when a scope is missing that "Not now" did not cover. */
export const shouldAskScopes = (missing: readonly string[], dismissed: readonly string[]) =>
  missing.some((scope) => !dismissed.includes(scope));

/** "repo, read:org", or how GitHub described this sign-in's access when it reported no scopes. */
export function accessLabel(scopes: readonly string[] | null | undefined): string {
  if (scopes === undefined) return 'not checked yet';
  if (scopes === null) return 'not reported by GitHub (fine-grained token or app)';
  return scopes.length ? scopes.join(', ') : 'no scopes';
}

/** The copy shown wherever Gnosis asks you to sign in again for the recommended scopes. */
export const GITHUB_SCOPE_PROMPT =
  'Gnosis now asks for two more GitHub permissions: reading your organization membership, so team review requests match GitHub, and updating workflow files, so it can merge PRs that change GitHub Actions workflows.';

/** GitHub needs `workflow` to merge or rewrite changes under this directory. */
export const WORKFLOW_DIRECTORY = '.github/workflows/';
/** The changed paths, old or new, under `.github/workflows/`. */
export const workflowPaths = (paths: readonly string[]) => paths.filter((path) => path.startsWith(WORKFLOW_DIRECTORY));

/**
 * The workflow files a PR revision changes, from the Changes tab's inventory (`PrChanges`), old and new paths both.
 * Undefined when that revision's inventory is not loaded, is a commit or stack comparison, or GitHub capped the list
 * before any workflow file appeared.
 */
export function changedWorkflowFiles(
  snapshot:
    | {
        metadata: { headSha: string };
        files: readonly { path: string; previousPath?: string }[];
        filesTruncated?: boolean;
        comparison?: unknown;
        stackComparison?: unknown;
      }
    | undefined,
  revision: { headSha: string }
): string[] | undefined {
  if (!snapshot || snapshot.comparison || snapshot.stackComparison || snapshot.metadata.headSha !== revision.headSha)
    return undefined;
  const paths = snapshot.files.flatMap((f) => (f.previousPath ? [f.path, f.previousPath] : [f.path]));
  const found = [...new Set(workflowPaths(paths))];
  return found.length || !snapshot.filesTruncated ? found : undefined;
}

/** Main → renderer: the signed-in account and the scopes GitHub last reported for its token. */
export interface GitHubAccess {
  login: string | null;
  /** Undefined: no GitHub response seen yet. Null: GitHub sent no `X-OAuth-Scopes` (not a classic token). */
  scopes?: string[] | null;
}
