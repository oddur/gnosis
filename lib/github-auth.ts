import type { Octokit } from '@octokit/rest';
import { getPrMetadata, parsePrUrl } from './github';
import type { PrMetadata } from './types';
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
    const problem =
      e?.status === 404
        ? `GitHub could not find the PR or code revision${repository ? ` in ${repository}` : ''}. It may no longer exist, or your account may not have access. Check the PR URL and GitHub access.`
        : `GitHub denied access${repository ? ` to ${repository}` : ''}. Check GitHub access for your account.`;
    return `${problem} If you use a token, include the repository and allow Pull requests: Read and Contents: Read. Your organization may require administrator approval or single sign-on (SSO) authorization.`;
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

/**
 * Verify access like `checkGitHubPrAccess`, from one fresh PR read that also serves as the PR's metadata. The two
 * revision checks run together.
 */
export async function readAccessiblePr(client: Octokit, prUrl: string): Promise<PrMetadata> {
  const { owner, repo, pullNumber } = parsePrUrl(prUrl);
  let metadata: PrMetadata;
  try {
    metadata = await getPrMetadata(client, owner, repo, pullNumber, true);
  } catch (error) {
    throw new Error(githubAccessMessage(error, `${owner}/${repo}`));
  }
  const revisions = [
    { repo: metadata.baseRepo ?? `${owner}/${repo}`, sha: metadata.baseSha },
    { repo: metadata.headRepo ?? `${owner}/${repo}`, sha: metadata.headSha },
  ];
  const results = await Promise.allSettled(
    revisions.map((revision) => {
      const [revisionOwner, revisionRepo] = revision.repo.split('/');
      return client.git.getCommit({ owner: revisionOwner, repo: revisionRepo, commit_sha: revision.sha });
    }),
  );
  // Report the first refused revision, base before head, as the sequential check does.
  const failed = results.findIndex((result) => result.status === 'rejected');
  if (failed >= 0) throw new Error(githubAccessMessage((results[failed] as PromiseRejectedResult).reason, revisions[failed].repo));
  return metadata;
}
