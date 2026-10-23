import type { Octokit } from '@octokit/rest';
import { parsePrUrl } from './github';
import { githubRateLimit } from './github-client';

export interface GitHubDevicePrompt {
  id: string;
  userCode: string;
  verificationUri: string;
  expiresAt: number;
}

/** Explain access failures without exposing request headers or credentials. */
export function githubAccessMessage(error: unknown, repository?: string): string {
  const limited = githubRateLimit(error);
  if (limited) return limited.message;
  const e = error as { status?: number; message?: string } | null;
  if (e?.status === 401) return 'GitHub sign-in has expired or the token is invalid. Connect GitHub again.';
  if (
    e?.status === 403 ||
    e?.status === 404 ||
    /Resource not accessible by personal access token/i.test(e?.message ?? '')
  ) {
    return `GitHub could not grant access${repository ? ` to ${repository}` : ''}. Connect GitHub again, or update your token: select this repository and allow Pull requests: Read and Contents: Read. Your organization may also require approval or SSO authorization. A 404 can also mean the PR or revision no longer exists.`;
  }
  return 'GitHub could not verify access. Check your connection and try again.';
}

/** Validate actual PR and revision access before spending an AI generation. Shared API cache applies. */
export async function checkGitHubPrAccess(client: Octokit, prUrl: string): Promise<void> {
  const { owner, repo, pullNumber } = parsePrUrl(prUrl);
  let checkedRepo = `${owner}/${repo}`;
  try {
    const { data } = await client.pulls.get({ owner, repo, pull_number: pullNumber });
    const revisions = [
      { repo: data.base.repo.full_name, sha: data.base.sha },
      // GitHub returns null when a fork has been deleted, despite its generated API type.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      { repo: data.head.repo?.full_name ?? `${owner}/${repo}`, sha: data.head.sha },
    ];
    for (const revision of revisions) {
      checkedRepo = revision.repo;
      const [revisionOwner, revisionRepo] = revision.repo.split('/');
      await client.git.getCommit({ owner: revisionOwner, repo: revisionRepo, commit_sha: revision.sha });
    }
  } catch (error) {
    throw new Error(githubAccessMessage(error, checkedRepo));
  }
}
