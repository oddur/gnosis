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

/**
 * What kind of credential the sign-in holds, from GitHub's token prefix. `oauth` is Gnosis's own sign-in (browser or
 * code); `classic` and `fine-grained` are personal access tokens pasted into the GitHub account dialog. Main derives
 * it; the token itself never leaves main.
 */
export type GitHubTokenKind = 'oauth' | 'classic' | 'fine-grained' | 'app' | 'unknown';
export function githubTokenKind(token: string): GitHubTokenKind {
  if (token.startsWith('gho_')) return 'oauth';
  if (token.startsWith('ghp_')) return 'classic';
  if (token.startsWith('github_pat_')) return 'fine-grained';
  if (/^gh[usr]_/.test(token)) return 'app';
  return 'unknown';
}

/** Main → renderer: the signed-in account and the scopes GitHub last reported for its token. */
export interface GitHubAccess {
  login: string | null;
  /** Undefined: no GitHub response seen yet. Null: GitHub sent no `X-OAuth-Scopes` (not a classic token). */
  scopes?: string[] | null;
  /** Undefined from fixtures and before the first read: treated as Gnosis's own sign-in. */
  tokenKind?: GitHubTokenKind;
}

/** GitHub's new classic token page with the scopes Gnosis asks for already selected. */
export const GITHUB_TOKEN_URL = 'https://github.com/settings/tokens/new?scopes=repo,read:org,workflow&description=Gnosis';

/**
 * What the prompt says, and what it offers. Signing in again cannot fix a personal access token: Gnosis would keep
 * asking while the token stays the same. So a classic token gets token instructions instead of "Sign in again".
 * With no missing scope known (GitHub refused a write first), it names the scopes Gnosis asks for. `message` says
 * what needs the permission; a token's instructions follow it.
 */
export type ScopePromptCopy = { kind: 'sign-in'; text: string } | { kind: 'token'; text: string; url: string };
export function scopePromptCopy(
  access: Pick<GitHubAccess, 'scopes' | 'tokenKind'> | undefined,
  message?: string
): ScopePromptCopy {
  if (access?.tokenKind !== 'classic') return { kind: 'sign-in', text: message ?? GITHUB_SCOPE_PROMPT };
  const missing = missingScopes(access.scopes);
  const instructions = `Your personal access token is missing: ${(missing.length ? missing : RECOMMENDED_SCOPES).join(', ')}. Create a token with repo, read:org and workflow, then sign in with it.`;
  return { kind: 'token', text: message ? `${message} ${instructions}` : instructions, url: GITHUB_TOKEN_URL };
}

/** The label wherever a missing `workflow` scope stops something: readiness, a refused write, the conflict push. */
export const WORKFLOW_PERMISSION_LABEL = 'Needs the workflow permission';
/** GitHub refused a write because it changes workflow files and the sign-in lacks `workflow`. */
export const WORKFLOW_WRITE_MESSAGE =
  'Needs the workflow permission. GitHub only accepts changes to GitHub Actions workflows (.github/workflows/…) from sign-ins with the workflow permission.';

/**
 * GitHub's refusal of a write that creates or updates a workflow file without `workflow`, as git push, REST and
 * GraphQL word it: "refusing to allow an OAuth App to create or update workflow `.github/workflows/ci.yml` without
 * `workflow` scope". Personal access tokens and GitHub Apps get the same sentence with their own subject.
 */
const WORKFLOW_REFUSAL =
  /refusing to allow an? (?:OAuth App|GitHub App|Personal Access Token|integration)\b[^\n]*?\bworkflows?\b|\bwithout [`'"]?workflows?[`'"]? (?:scope|permission)/i;

export interface GitHubWriteError {
  /** The copy to show: the mapped message, or GitHub's own reason without Electron's IPC wrapper. */
  message: string;
  /** GitHub refused because the sign-in lacks `workflow`: offer the sign-in prompt. */
  workflowPermission: boolean;
  /** The workflow files GitHub named, when it named any. */
  workflowFiles: string[];
  /** The text as it arrived, without the IPC wrapper, for Details. */
  raw: string;
}

/**
 * One mapping for every GitHub write that can change a branch: merge, update with a merge commit or rebase,
 * auto-merge and the conflict push. GitHub's workflow-scope refusal becomes "Needs the workflow permission"; anything
 * else is GitHub's own reason, unchanged apart from Electron's IPC wrapper.
 */
export function githubWriteError(error: unknown): GitHubWriteError {
  const text = error instanceof Error ? error.message : String(error);
  const raw = text.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '').trim();
  if (!WORKFLOW_REFUSAL.test(raw)) return { message: raw, workflowPermission: false, workflowFiles: [], raw };
  const workflowFiles = [...new Set([...raw.matchAll(/workflow [`'"]([^`'"\s]+)[`'"]/gi)].map((match) => match[1]))];
  return { message: WORKFLOW_WRITE_MESSAGE, workflowPermission: true, workflowFiles, raw };
}

/** The quiet note where team review requests show, for a sign-in that can't read organization teams. */
export const TEAM_REQUESTS_NOTE =
  'Team review requests may be incomplete: Gnosis can’t read your organization’s teams. Sign in again to allow it.';
export const TEAM_REQUESTS_TOKEN_NOTE =
  'Team review requests may be incomplete: your personal access token can’t read your organization’s teams. Create a token with repo, read:org and workflow, then sign in with it.';
/**
 * The team note shows when GitHub reported this token's scopes, they leave out `read:org`, the surface shows team
 * requests, and "Not now" on this surface did not already cover `read:org`.
 */
export function teamRequestsNoteVisible(input: {
  scopes: readonly string[] | null | undefined;
  /** The surface lists or counts team review requests. */
  showsTeamRequests: boolean;
  dismissed: readonly string[];
}): boolean {
  return input.showsTeamRequests && lacksOrgRead(input.scopes) && !input.dismissed.includes('read:org');
}

/**
 * A fine-grained token reports no scopes, so Gnosis can't tell whether it lacks workflow access. When GitHub says
 * BLOCKED, every visible requirement is met and the PR changes workflow files, a quiet line names the likely cause.
 */
export const FINE_GRAINED_WORKFLOW_NOTE =
  'If you signed in with a fine-grained token, it may need the Workflows permission (read and write) for this repository.';
export const fineGrainedWorkflowNote = (
  scopes: readonly string[] | null | undefined,
  workflowFiles: readonly string[] | undefined
) => scopes === null && !!workflowFiles?.length;

/** A conflict resolution's changed paths, old and new, under `.github/workflows/`. */
export const resolutionWorkflowFiles = (files: readonly { name: string; prevName?: string }[]) => [
  ...new Set(workflowPaths(files.flatMap((f) => (f.prevName ? [f.name, f.prevName] : [f.name])))),
];
/**
 * Push stays disabled while the resolution changes workflow files and GitHub reported scopes without `workflow`:
 * GitHub would refuse the push. Unknown scopes (fine-grained tokens) never block; GitHub's refusal maps instead.
 */
export const conflictPushNeedsWorkflow = (
  scopes: readonly string[] | null | undefined,
  files: readonly { name: string; prevName?: string }[] | undefined
) => !!files && lacksWorkflow(scopes) && resolutionWorkflowFiles(files).length > 0;
export const WORKFLOW_PUSH_WARNING =
  'This resolution changes GitHub Actions workflows (.github/workflows/…). GitHub only accepts pushes that change workflows from sign-ins with the workflow permission.';
