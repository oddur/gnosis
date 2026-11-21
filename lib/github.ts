import { sourceChunks } from './prompt-budget';
import { extractImports, TS_EXTENSIONS } from './import-paths';
import { readCommitChecks } from './github-checks';
import type { Octokit } from '@octokit/rest';
import { parseGitHubLabels } from './github-labels';
import { getGitHubClient, GitHubBackoffError, githubRateLimit } from './github-client';
import { localClones, type LocalClone, type LocalCloneFile, type LocalClones } from './local-clone';
import { preparedChanges, preparedFile, preparedDiff } from './prepared-pr';
import { GITHUB_PR_FILE_LIMIT } from './inspection-limits';
import { readGitHubFile } from '../src/github-file-content';
import { filesOfUnifiedDiff } from './diff-files';
import { githubReadSignal } from './github-scheduler';
import { reportPrHead } from './pr-heads';
import { mapBounded } from './bounded';
import {
  aliasedGraphql,
  readBlobs,
  REGULAR_FILE_MODES,
  TREE_MODE,
  type AliasedAnswer,
  type BlobAnswer,
  type BlobRequest,
} from './github-graphql-batch';
export { GITHUB_PR_FILE_LIMIT } from './inspection-limits';
import { getProvider } from './provider';
import type { DiffSource } from './diffSource';
import type {
  ChangedFile,
  CiCheck,
  FileMetadata,
  PrMetadata,
  PrSearchResult,
  ProjectClaudeContext,
  Provider,
  RepoSearchResult,
  ReviewSummary,
} from './types';

export function parsePrUrl(url: string): { owner: string; repo: string; pullNumber: number } {
  const match = url.match(/github\.com\/([^/]+)\/([^/]+)\/pulls?\/(\d+)/);
  if (!match) {
    throw new Error(`Invalid GitHub PR URL: ${url}`);
  }
  return {
    owner: match[1],
    repo: match[2],
    pullNumber: parseInt(match[3], 10),
  };
}

/** Names in a stable order that does not depend on the API that listed them. */
export const sortedNames = (names: string[]) =>
  [...names].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()) || (a < b ? -1 : a > b ? 1 : 0));

export async function getPrMetadata(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
  fresh = false
): Promise<PrMetadata> {
  const { data } = await octokit.pulls.get({ owner, repo, pull_number: pullNumber, ...(fresh ? { headers: { 'cache-control': 'no-cache' } } : {}) });
  // Every PR read reports its head: a new one invalidates what belonged to the old one (lib/pr-heads.ts).
  reportPrHead(octokit, data.html_url, data.head.sha, { updatedAt: data.updated_at, source: 'metadata' });
  return {
    title: data.title,
    commentCount: data.comments,
    reviewCommentCount: data.review_comments,
    description: data.body ?? '',
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- GitHub API can return null
    author: data.user?.login ?? 'unknown',
    assignees: (data.assignees ?? []).map((user) => user.login),
    baseBranch: data.base.ref,
    baseRepo: data.base.repo.full_name,
    repoArchived: data.base.repo.archived,
    // GitHub can return null after a fork is deleted, despite the generated type.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    headRepo: data.head.repo?.full_name ?? data.base.repo.full_name,
    headBranch: data.head.ref,
    baseSha: data.base.sha,
    headSha: data.head.sha,
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- GitHub API can return null
    merged: data.merged ?? false,
    state: data.state,
    createdAt: data.created_at,
    updatedAt: data.updated_at,
    url: data.html_url,
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- GitHub API can return null
    labels: (data.labels ?? []).map((l) => (typeof l === 'string' ? l : (l.name ?? ''))).filter(Boolean),
    // Keep names compatible with older filters and snapshots; details are optional.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- GitHub can omit labels
    labelDetails: parseGitHubLabels(data.labels ?? []),
    mergeable: data.mergeable ?? null,
    isDraft: data.draft ?? false,
    commitCount: data.commits,
    changedFileCount: data.changed_files,
    additions: data.additions,
    deletions: data.deletions,
    // Sorted, as the GraphQL reader sorts them, so the order never depends on which API answered.
    requestedReviewers: sortedNames((data.requested_reviewers ?? []).map((u) => u.login)),
    requestedTeams: sortedNames((data.requested_teams ?? []).map((t) => t.name)),
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- GitHub API can return null
    mergeableState: data.mergeable_state ?? null,
    autoMerge: data.auto_merge ? { method: data.auto_merge.merge_method } : null,
    milestone: data.milestone ? { title: data.milestone.title, dueOn: data.milestone.due_on } : null,
    // Explicit, so a REST copy spread over a GraphQL one never keeps the GraphQL tag.
    source: 'rest',
  };
}

const isCompleteMetadata = (known: Partial<PrMetadata> | undefined): known is PrMetadata =>
  typeof known?.title === 'string' &&
  typeof known.headRepo === 'string' &&
  typeof known.baseSha === 'string' &&
  typeof known.headSha === 'string';

/** With a clone, a queue member already pins everything a read needs. Only an explicit refresh has to wait for GitHub. */
export const knownMetadataForClone = (
  known: Partial<PrMetadata> | undefined,
  repo: string,
  refresh: boolean,
  clones: LocalClones
): PrMetadata | undefined => (!refresh && isCompleteMetadata(known) && clones.has(repo) ? known : undefined);

/** A registered clone only needs the revision, so a paused API must not stop reads the caller can describe itself. */
export async function getPrMetadataForClone(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
  known: Partial<PrMetadata> | undefined,
  clones: LocalClones
): Promise<PrMetadata> {
  try {
    return await getPrMetadata(octokit, owner, repo, pullNumber, true);
  } catch (error) {
    if (error instanceof GitHubBackoffError && isCompleteMetadata(known) && clones.has(`${owner}/${repo}`)) return known;
    throw error;
  }
}

/**
 * The merge base of `base...head`, without the files. `per_page` limits commits, not files, so page 1 of a
 * comparison carries up to 300 files with their patches. Page 2 still carries `merge_base_commit` and no files.
 * That is observed behaviour, not a documented guarantee, so a missing SHA falls back to page 1.
 */
export async function getMergeBase(octokit: Octokit, owner: string, repo: string, base: string, head: string): Promise<string> {
  const read = async (page?: number) => {
    const { data } = await octokit.repos.compareCommits({ owner, repo, base, head, per_page: 1, ...(page ? { page } : {}) });
    const sha = (data as { merge_base_commit?: { sha?: unknown } | null }).merge_base_commit?.sha;
    return typeof sha === 'string' && sha ? sha : undefined;
  };
  const sha = (await read(2)) ?? (await read());
  if (!sha) throw new Error('GitHub did not return the merge base of this comparison. Retry, or open it on GitHub.');
  return sha;
}

export const changedFileFromClone = (file: LocalCloneFile): ChangedFile => ({
  filename: file.filename,
  sha: file.sha ?? undefined,
  status: file.status === 'removed' ? 'deleted' : file.status,
  additions: file.additions,
  deletions: file.deletions,
  previous_filename: file.previous_filename,
  patch: file.patch,
});

export async function getPrDiff(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
  changedFiles?: ChangedFile[],
  fresh = false,
): Promise<string> {
  try {
    const response = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
      owner,
      repo,
      pull_number: pullNumber,
      headers: {
        accept: 'application/vnd.github.v3.diff',
        ...(fresh ? { 'cache-control': 'no-cache' } : {}),
      },
    });
    return response.data as unknown as string;
  } catch (err) {
    // GitHub returns 'too_large' for diffs over 20k lines.
    // Fall back to assembling from individual file patches.
    const isTooLarge =
      err instanceof Error && (err.message.includes('too_large') || err.message.includes('diff is too large'));
    if (!isTooLarge) throw err;

    console.warn('[github] Full diff too large, assembling from file patches');
    if (!changedFiles) {
      changedFiles = await getChangedFiles(octokit, owner, repo, pullNumber, fresh);
    }
    return assembleUnifiedDiff(changedFiles);
  }
}

/**
 * The whole diff of `base...head`, for every file. GitHub's JSON lists stop at 300 files for a comparison and 3,000 for
 * a PR; this answer has no file limit, though GitHub may refuse a very large one.
 */
export async function getCompareDiff(octokit: Octokit, owner: string, repo: string, base: string, head: string): Promise<string> {
  const response = await octokit.request('GET /repos/{owner}/{repo}/compare/{basehead}', {
    owner,
    repo,
    basehead: `${base}...${head}`,
    headers: { accept: 'application/vnd.github.diff' },
  });
  const data: unknown = response.data;
  if (typeof data === 'string') return data;
  // Octokit answers with bytes when the media type has no charset.
  if (data instanceof ArrayBuffer || ArrayBuffer.isView(data))
    return Buffer.from(data instanceof ArrayBuffer ? data : data.buffer, data instanceof ArrayBuffer ? 0 : data.byteOffset, data.byteLength).toString('utf8');
  throw new Error('GitHub did not return a diff for this comparison.');
}

/**
 * When a JSON file list hit GitHub's cap, the complete list from the whole diff of the same pinned SHAs, or undefined
 * when GitHub refuses it or its files do not cover the capped list. Files the JSON list has keep its entry, with the
 * full blob SHA, unless it lacks a patch the diff has. The others come from the diff, with counted lines and
 * abbreviated blob SHAs.
 */
// Approach from quarterdeck crates/github/src/changed_file_requests.rs and
// crates/app/src/pull_request_detail/fetch_changed_files.rs, `FileSource` (used with permission).
export async function wholeDiffFiles<T extends { filename: string; additions: number; deletions: number; patch?: string }>(
  octokit: Octokit,
  owner: string,
  repo: string,
  base: string,
  head: string,
  listed: T[]
): Promise<{ files: (T | ChangedFile)[]; added: Set<T | ChangedFile> } | undefined> {
  let diff: string;
  try {
    diff = await getCompareDiff(octokit, owner, repo, base, head);
  } catch (error) {
    // Waiting and cancellation are not answers; a refusal (too large, unavailable) keeps the capped list.
    const limited = githubRateLimit(error);
    if (limited) throw limited;
    if (githubReadSignal()?.aborted || (error instanceof Error && /abort/i.test(error.name + error.message))) throw error;
    console.warn('[github] Whole comparison diff unavailable:', error instanceof Error ? error.message : String(error));
    return;
  }
  const parsed = filesOfUnifiedDiff(diff);
  const json = new Map(listed.map((file) => [file.filename, file]));
  if (parsed.length <= listed.length || new Set(parsed.map((file) => file.filename)).size !== parsed.length) return;
  const covered = new Set(parsed.map((file) => file.filename));
  if (listed.some((file) => !covered.has(file.filename))) return;
  const added = new Set<T | ChangedFile>();
  const files = parsed.map((file) => {
    const entry = json.get(file.filename);
    if (!entry) {
      added.add(file);
      return file;
    }
    // Past a size budget, GitHub's JSON comparison lists files without a patch and with zero counts. The diff has both.
    return !entry.patch && file.patch ? { ...entry, additions: file.additions, deletions: file.deletions, patch: file.patch } : entry;
  });
  /** `added` holds the files only the diff has; the rest are the listed entries. */
  return { files, added };
}

/** Reconstruct a unified diff from individual file patches returned by listFiles. */
function assembleUnifiedDiff(files: ChangedFile[]): string {
  const parts: string[] = [];
  for (const f of files) {
    if (!f.patch) continue;
    const a = f.status === 'added' ? '/dev/null' : `a/${f.previous_filename ?? f.filename}`;
    const b = f.status === 'deleted' ? '/dev/null' : `b/${f.filename}`;
    parts.push(`diff --git ${a} ${b}`);
    if (f.status === 'renamed' && f.previous_filename) {
      parts.push(`rename from ${f.previous_filename}`);
      parts.push(`rename to ${f.filename}`);
    }
    parts.push(`--- ${a}`);
    parts.push(`+++ ${b}`);
    parts.push(f.patch);
  }
  return parts.join('\n') + '\n';
}

export const LARGE_PR_EXPLANATION_ERROR = 'GitHub exposes at most 3,000 changed files for a PR. Gnosis cannot generate a complete explanation for this PR. Browse the available files in Changes, review smaller PRs individually, or use a local checkout.';

const FILE_PAGE_SIZE = 100;
const FILE_PAGE_LIMIT = GITHUB_PR_FILE_LIMIT / FILE_PAGE_SIZE;

/**
 * The PR's changed files, up to GitHub's 3,000-file cap. With a known `count`, pages `1..ceil(count/100)` are requested
 * together. Each request still goes through the GitHub scheduler, whose slots bound the burst. The pages are assembled
 * in order. A full last page means the count was stale, so reading continues one page at a time. Callers compare the
 * total with the PR's count and re-check its revision, as before.
 */
export async function getChangedFiles(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
  fresh = false,
  count?: number
): Promise<ChangedFile[]> {
  const read = async (page: number) => {
    const { data } = await octokit.pulls.listFiles({
      ...(fresh ? { headers: { 'cache-control': 'no-cache' } } : {}),
      owner,
      repo,
      pull_number: pullNumber,
      per_page: FILE_PAGE_SIZE,
      page,
    });
    return data.map((f): ChangedFile => ({
      filename: f.filename,
      sha: f.sha ?? undefined,
      status: f.status === 'removed' ? 'deleted' : f.status === 'added' || f.status === 'renamed' ? f.status : 'modified',
      additions: f.additions,
      deletions: f.deletions,
      previous_filename: f.previous_filename,
      patch: f.patch,
    }));
  };
  const known = count !== undefined && Number.isInteger(count) && count > 0
    ? Math.min(FILE_PAGE_LIMIT, Math.ceil(count / FILE_PAGE_SIZE))
    : 1;
  const pages = await Promise.all(Array.from({ length: known }, (_, i) => read(i + 1)));
  const files: ChangedFile[] = [];
  let last = pages[0];
  for (const data of pages) {
    last = data;
    files.push(...data);
    // A short page is the end. Later pages of a stale count are empty, or belong to a newer revision.
    if (data.length < FILE_PAGE_SIZE) break;
  }
  for (let page = known + 1; last.length === FILE_PAGE_SIZE && files.length < GITHUB_PR_FILE_LIMIT; page++) {
    last = await read(page);
    files.push(...last);
  }
  return files.slice(0, GITHUB_PR_FILE_LIMIT);
}

export async function getFileContent(
  octokit: Octokit,
  owner: string,
  repo: string,
  path: string,
  ref: string,
  signal?: AbortSignal
): Promise<string | null> {
  try {
    signal?.throwIfAborted();
    const { data } = await octokit.repos.getContent({ owner, repo, path, ref, ...(signal ? { request: { signal } } : {}) });
    if (Array.isArray(data) || data.type !== 'file') return null;
    if ('content' in data && data.content) {
      return Buffer.from(data.content, 'base64').toString('utf-8');
    }
    return null;
  } catch (error) {
    signal?.throwIfAborted();
    const limited = githubRateLimit(error);
    if (limited) throw limited;
    return null;
  }
}

/** `getFileContent`'s answer for a blob batch answer, or undefined when only the contents API can give it. */
const restEquivalent = (answer: BlobAnswer): string | null | undefined =>
  answer.kind === 'text'
    ? // The contents API answers an empty file with empty content, which `getFileContent` reads as null.
      answer.text || null
    : answer.kind === 'absent'
      ? null
      : undefined;

export async function searchPullRequests(octokit: Octokit, login: string, limit = 30): Promise<PrSearchResult[]> {
  const queries = [
    { q: `is:pr is:open archived:false author:${login}`, role: 'author' as const },
    { q: `is:pr is:open archived:false review-requested:${login}`, role: 'review-requested' as const },
  ];

  const results = await Promise.all(
    queries.map(async ({ q, role }) => {
      const { data } = await octokit.search.issuesAndPullRequests({
        q,
        sort: 'updated',
        order: 'desc',
        per_page: limit,
      });
      return data.items.map((item) => {
        // repository_url looks like "https://api.github.com/repos/owner/name"
        const repoParts = item.repository_url.split('/');
        const repoName = repoParts.at(-1) ?? '';
        const repoOwner = repoParts.at(-2) ?? '';
        return {
          number: item.number,
          title: item.title,
          url: item.html_url,
          repoOwner,
          repoName,
          author: item.user?.login ?? 'unknown',
          updatedAt: item.updated_at,
          isDraft: item.draft ?? false,
          role,
        };
      });
    })
  );

  // Deduplicate by URL (a PR can appear in both queries), prefer 'review-requested' role
  const seen = new Map<string, PrSearchResult>();
  for (const list of results) {
    for (const pr of list) {
      const existing = seen.get(pr.url);
      if (!existing || (existing.role === 'author' && pr.role === 'review-requested')) {
        seen.set(pr.url, pr);
      }
    }
  }

  return Array.from(seen.values())
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, limit);
}

/** Search GitHub repos by query string. Returns owner/name pairs for autocomplete. */
export async function searchRepos(
  octokit: Octokit,
  query: string,
  limit = 10
): Promise<RepoSearchResult[]> {
  if (!query.trim()) return [];
  const { data } = await octokit.search.repos({
    q: `${query} archived:false`,
    sort: 'updated',
    order: 'desc',
    per_page: limit,
  });
  return data.items.map((repo) => ({
    fullName: repo.full_name,
    description: repo.description,
  }));
}

/** List open PRs in a specific repo. Used by proactive mode to watch repos. */
export async function listRepoPullRequests(
  octokit: Octokit,
  owner: string,
  repo: string,
  limit = 30
): Promise<PrSearchResult[]> {
  const { data } = await octokit.pulls.list({
    owner,
    repo,
    state: 'open',
    sort: 'updated',
    direction: 'desc',
    per_page: limit,
  });

  return data.filter(pr => !pr.base.repo.archived).map((pr) => ({
    number: pr.number,
    title: pr.title,
    url: pr.html_url,
    repoOwner: owner,
    repoName: repo,
    author: pr.user?.login ?? 'unknown',
    updatedAt: pr.updated_at,
    isDraft: pr.draft ?? false,
    role: 'watched' as const,
  }));
}

export async function getCiStatus(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref: string
): Promise<{ checks: CiCheck[]; conclusion: 'success' | 'failure' | 'pending' | 'neutral' }> {
  return readCommitChecks(octokit, owner, repo, ref);
}

/** The review fields both status paths read. GitHub selects them; `summarizeLatestReviews` counts them. */
export const LATEST_REVIEW_FIELDS =
  'latestOpinionatedReviews(first:100,writersOnly:true) { nodes { state author { login } } } latestReviews(first:100) { nodes { state author { login } } }';
type ReviewNodes = { nodes?: ({ state: string; author: { login: string } | null } | null)[] | null } | null | undefined;
export interface LatestReviews {
  latestOpinionatedReviews?: ReviewNodes;
  latestReviews?: ReviewNodes;
}

/**
 * Reads the reviews that count, as GitHub selects them: one per reviewer, from the whole review history.
 * REST `listReviews` returns only the oldest 100 reviews and does not say who has write access.
 */
export async function getReviewStatus(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number
): Promise<ReviewSummary> {
  const data = await octokit.graphql<{ repository: { pullRequest: LatestReviews | null } | null }>(
    `query($owner:String!,$repo:String!,$number:Int!) { repository(owner:$owner,name:$repo) { pullRequest(number:$number) { ${LATEST_REVIEW_FIELDS} } } }`,
    { owner, repo, number: pullNumber }
  );
  const pr = data.repository?.pullRequest;
  if (!pr) throw new Error(`Pull request ${owner}/${repo}#${pullNumber} was not found.`);
  return summarizeLatestReviews(pr);
}

/**
 * GitHub's opinionated reviews from writers decide approvals and requests for changes. A reviewer whose latest
 * review is a comment, and who has no opinion that counts, is a commenter.
 */
export function summarizeLatestReviews(pr: LatestReviews): ReviewSummary {
  const entries = (nodes: ReviewNodes) =>
    (nodes?.nodes ?? []).flatMap((review) =>
      review ? [{ login: review.author?.login ?? 'unknown', state: review.state }] : []
    );
  return summarizeReviews([
    ...entries(pr.latestReviews).filter((review) => review.state === 'COMMENTED'),
    ...entries(pr.latestOpinionatedReviews),
  ]);
}

/**
 * Reduces reviews in submission order with GitHub's rule: each reviewer's latest opinionated review counts.
 * `APPROVED` and `CHANGES_REQUESTED` set the opinion, `DISMISSED` clears it, and `COMMENTED` never replaces it.
 * Opinions of a reviewer without write access (`canPush: false`) do not count.
 */
export function summarizeReviews(reviews: { login: string; state: string; canPush?: boolean }[]): ReviewSummary {
  const opinions = new Map<string, string | null>();
  const commenters = new Set<string>();
  for (const { login, state, canPush } of reviews) {
    const key = login.toLowerCase();
    if (state === 'COMMENTED') commenters.add(key);
    else if (canPush === false) continue;
    else if (state === 'APPROVED' || state === 'CHANGES_REQUESTED') opinions.set(key, state);
    else if (state === 'DISMISSED') opinions.set(key, null);
  }

  let approved = 0;
  let changesRequested = 0;
  for (const state of opinions.values()) {
    if (state === 'APPROVED') approved++;
    else if (state === 'CHANGES_REQUESTED') changesRequested++;
  }
  const commented = [...commenters].filter((login) => !opinions.get(login)).length;

  return { approved, changesRequested, commented };
}

const SMART_IMPORTS_SYSTEM_PROMPT = `You are a code analysis tool. Given source files from a repository, identify all local/internal file imports. Return repo-relative file paths as a JSON array of strings. Nothing else.

Rules:
- Only include imports that reference files within the same repository
- Skip standard library, external packages, and framework imports
- Resolve relative imports to repo-relative paths using each file's location
- For C# \`using\` statements, infer the likely file path from the namespace (use the file's own namespace declaration for context)
- Include file extensions (e.g., .cs, .rs, .py, .go, .ts)
- Return unique paths only`;

export async function extractImportsWithLLM(
  changedFileContents: Record<string, string>,
  changedFilePaths: string[],
  providerName: Provider
): Promise<string[]> {
  const entries = changedFilePaths.flatMap((file) =>
    sourceChunks(changedFileContents[file] ?? '', 150_000).map(
      (source, index) => `--- ${file} (section ${index + 1}) ---\n${source}`
    )
  );
  if (!entries.length) return [];
  const provider = getProvider(providerName);
  const quickModel = (provider.models.find((model) => model.quick) ?? provider.models[0]).id;
  const batches: string[] = [];
  for (const entry of entries) {
    if (batches.length && batches[batches.length - 1].length + entry.length < 180_000)
      batches[batches.length - 1] += '\n\n' + entry;
    else batches.push(entry);
  }
  const paths = new Set<string>();
  for (const content of batches) {
    try {
      const result = await provider.quick({ content, systemPrompt: SMART_IMPORTS_SYSTEM_PROMPT, model: quickModel });
      const start = result.indexOf('['),
        end = result.lastIndexOf(']');
      if (start < 0 || end <= start) continue;
      const parsed: unknown = JSON.parse(result.slice(start, end + 1));
      if (Array.isArray(parsed)) for (const file of parsed) if (typeof file === 'string') paths.add(file);
    } catch (error) {
      console.warn('[github] Import analysis section failed; retaining other results:', error);
    }
  }
  return [...paths];
}

/**
 * Files the changed files import, at `ref`. Every candidate path (each import with each of `TS_EXTENSIONS`) is read in
 * one batch of aliased GraphQL queries, and each import keeps the first extension that resolves. `readFile`, such as a
 * local clone, reads one path at a time instead and stops at the first extension that resolves.
 */
export async function getNeighborFiles(
  octokit: Octokit,
  owner: string,
  repo: string,
  changedFilePaths: string[],
  changedFileContents: Record<string, string>,
  ref: string,
  smartImportsProvider?: Provider,
  readFile?: (path: string) => Promise<string | null>
): Promise<Record<string, string>> {
  let candidates: string[][];
  if (smartImportsProvider) {
    console.log(`[github] Using smart (${smartImportsProvider}) import extraction`);
    const importPaths = await extractImportsWithLLM(changedFileContents, changedFilePaths, smartImportsProvider);
    console.log(`[github] ${smartImportsProvider} found ${importPaths.length} import(s):`, importPaths);

    // Filter out paths already in the changed set
    const neighborPaths = importPaths.filter((p) => !changedFilePaths.includes(p));
    console.log(`[github] ${neighborPaths.length} neighbor file(s) to fetch (after excluding changed files)`);
    candidates = neighborPaths.slice(0, 30).map((path) => [path]);
  } else {
    // Default: regex-based extraction
    const neighborPaths = new Set<string>();
    for (const filePath of changedFilePaths) {
      const content = changedFileContents[filePath];
      if (!content) continue;

      const imports = extractImports(content, filePath);
      for (const imp of imports) {
        const alreadyChanged = changedFilePaths.some((p) => p === imp || TS_EXTENSIONS.some((ext) => p === imp + ext));
        if (!alreadyChanged) {
          neighborPaths.add(imp);
        }
      }
    }
    candidates = Array.from(neighborPaths)
      .slice(0, 30)
      .map((basePath) => TS_EXTENSIONS.map((ext) => basePath + ext));
  }

  const results: Record<string, string> = {};
  if (readFile) {
    // One path at a time, stopping at the first extension that resolves.
    await mapBounded(candidates, 5, async (paths) => {
      for (const path of paths) {
        const content = await readFile(path);
        if (content !== null) {
          results[path] = content;
          return;
        }
      }
    });
  } else {
    const unique = [...new Set(candidates.flat())];
    const answers = await readBlobs(octokit, unique.map((path) => ({ owner, repo, ref, path })));
    const known = new Map(unique.map((path, i) => [path, restEquivalent(answers[i])]));
    // Extensions in order, stopping at the first that resolves. A candidate the batch could not settle is read through
    // REST right there, so a failed batch reads as the old one-path-at-a-time reader did.
    await mapBounded(candidates, 5, async (paths) => {
      for (const path of paths) {
        const settled = known.get(path);
        const content = settled === undefined ? await getFileContent(octokit, owner, repo, path, ref) : settled;
        if (content !== null) {
          results[path] = content;
          return;
        }
      }
    });
  }
  if (smartImportsProvider)
    console.log(`[github] Fetched ${Object.keys(results).length} neighbor file(s):`, Object.keys(results));
  return results;
}

// ── File metadata (age + churn) ───────────────────────────────

// Fetch the last commit date for a file BEFORE the PR's base ref.
// Returns an ISO date string or null if the file is new.
async function getFileLastModified(
  octokit: Octokit,
  owner: string,
  repo: string,
  filePath: string,
  baseSha: string,
  signal?: AbortSignal
): Promise<string | null> {
  try {
    const { data } = await octokit.repos.listCommits({
      owner,
      repo,
      path: filePath,
      sha: baseSha,
      per_page: 1,
      ...(signal ? { request: { signal } } : {}),
    });
    return data[0]?.commit?.committer?.date ?? null;
  } catch {
    return null;
  }
}

// Count how many commits in the PR touch each file. >1 = churn
// (the file was revised across multiple commits, indicating
// iteration or complexity).
async function getPrFileChurn(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
  signal?: AbortSignal
): Promise<Map<string, number>> {
  const churn = new Map<string, number>();
  try {
    const { data: commits } = await octokit.pulls.listCommits({
      owner,
      repo,
      pull_number: pullNumber,
      per_page: 30,
      ...(signal ? { request: { signal } } : {}),
    });
    // For each commit, fetch its files and increment the counter.
    // Limit to first 30 commits to avoid API rate limit issues on
    // very large PRs. The reads are independent, so they run 10 at a time.
    const toFetch = commits.slice(0, 30);
    const files = await mapBounded(toFetch, 10, async (commit) => {
      signal?.throwIfAborted();
      try {
        const { data } = await octokit.repos.getCommit({
          owner,
          repo,
          ref: commit.sha,
          ...(signal ? { request: { signal } } : {}),
        });
        return data.files ?? [];
      } catch {
        // Individual commit fetch failed — skip silently
        return [];
      }
    });
    for (const list of files) for (const f of list) churn.set(f.filename, (churn.get(f.filename) ?? 0) + 1);
  } catch {
    // Commit listing failed — return empty map
  }
  return churn;
}

// Build FileMetadata[] for all changed files in a PR. Fetches file
// age (last modified before the PR) and churn (commit count within
// the PR) in parallel. Designed to be called during review
// generation and stored in ReviewGuide.changedFiles.
export async function getFileMetadata(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
  baseSha: string,
  changedFiles: ChangedFile[],
  signal?: AbortSignal
): Promise<FileMetadata[]> {
  // Churn (once for the whole PR) and every file's last-modified date are independent reads, so they run together.
  // The dates run 10 at a time to stay well under GitHub's rate limit.
  const [churnMap, lastModified] = await Promise.all([
    getPrFileChurn(octokit, owner, repo, pullNumber, signal),
    mapBounded(changedFiles, 10, async (f) => {
      signal?.throwIfAborted();
      return f.status === 'added' ? null : getFileLastModified(octokit, owner, repo, f.filename, baseSha, signal);
    }),
  ]);
  const metadata: FileMetadata[] = changedFiles.map((f, i) => ({
    filename: f.filename,
    previousFilename: f.previous_filename,
    status: f.status,
    additions: f.additions,
    deletions: f.deletions,
    prCommitCount: churnMap.get(f.filename) ?? 1,
    lastModified: lastModified[i],
  }));

  return metadata;
}

// ── Claude Code project conventions ─────────────────────────────
//
// Shared probe lives in `lib/claude-context.ts` — this function only
// wires up the GitHub-backed IO.

import { probeClaudeContext, type ClaudeContextIO } from './claude-context';

export function makeGithubClaudeIO(octokit: Octokit, owner: string, repo: string, ref: string): ClaudeContextIO {
  return {
    readFile: (p) => getFileContent(octokit, owner, repo, p, ref),
    listDir: async (p, kind) => {
      try {
        const { data } = await octokit.repos.getContent({ owner, repo, path: p, ref });
        if (!Array.isArray(data)) return [];
        return data.filter((e) => (kind === 'dir' ? e.type === 'dir' : e.type === 'file')).map((e) => e.path);
      } catch {
        return [];
      }
    },
  };
}

type ClaudeTreeEntry = { path: string; type: string; mode: number; object?: { entries?: ClaudeTreeEntry[] } | null };

/**
 * The Claude-context probe's reads at `ref`, in two GraphQL queries. The first lists the root and `.claude/` three
 * levels deep, names and modes only. The second reads the texts the probe uses: CLAUDE.md, `commands/*.md`, `agents/*.md` and
 * each `skills/<name>/SKILL.md`. Whatever they cannot settle exactly (a symlink, submodule, binary or large blob, a
 * failed alias or query) goes through the REST reads in `makeGithubClaudeIO`, which follow symlinks.
 */
async function githubClaudeSnapshotIO(octokit: Octokit, owner: string, repo: string, ref: string): Promise<ClaudeContextIO> {
  const rest = makeGithubClaudeIO(octokit, owner, repo, ref);
  const entry = (inner: string) => `entries { path type mode${inner ? ` object { ${inner} }` : ''} }`;
  type Response = {
    repository?: {
      root?: { __typename?: string; entries?: ClaudeTreeEntry[] } | null;
      top?: { entries?: { name: string; type: string; mode: number }[] } | null;
    } | null;
  };
  let answer: AliasedAnswer<Response>;
  try {
    answer = await aliasedGraphql<Response>(
      octokit,
      `query($owner:String!,$name:String!){ rateLimit { cost } repository(owner:$owner,name:$name){
        top: object(expression:${JSON.stringify(`${ref}:`)}) { ... on Tree { entries { name type mode } } }
        root: object(expression:${JSON.stringify(`${ref}:.claude`)}) { __typename ... on Tree { ${entry(
          `... on Tree { ${entry(`... on Tree { ${entry('')} }`)} }`
        )} } }
      } }`,
      { owner, name: repo }
    );
  } catch (error) {
    const limited = githubRateLimit(error);
    if (limited) throw limited;
    return rest;
  }
  if (!answer.data.repository || answer.failed('repository')) return rest;
  const texts = new Map<string, string | null>();
  const listings = new Map<string, { file: string[]; dir: string[] } | undefined>();
  /** A listing the contents API would give; undefined when an entry is neither a plain file nor a directory. */
  const listing = (entries: ClaudeTreeEntry[]) =>
    entries.every((e) => e.mode === TREE_MODE || REGULAR_FILE_MODES.has(e.mode))
      ? {
          file: entries.filter((e) => e.type === 'blob').map((e) => e.path),
          dir: entries.filter((e) => e.type === 'tree').map((e) => e.path),
        }
      : undefined;
  // CLAUDE.md's mode comes from the root listing above, so the texts take one more query, not two.
  const reads: BlobRequest[] = [];
  const top = answer.data.repository.top?.entries;
  const md = top?.find((e) => e.name === 'CLAUDE.md');
  if (!top) reads.push({ owner, repo, ref, path: 'CLAUDE.md' });
  else if (md?.type === 'blob') reads.push({ owner, repo, ref, path: 'CLAUDE.md', mode: md.mode });
  // Absent, or a directory: the contents API gives no text.
  else texts.set('CLAUDE.md', null);
  const root = answer.data.repository.root;
  if (root === null || (root && root.__typename !== 'Tree')) listings.set('.claude', { file: [], dir: [] });
  else if (root?.entries) {
    listings.set('.claude', listing(root.entries));
    for (const dir of root.entries) {
      const name = dir.path.slice('.claude/'.length);
      if (dir.type !== 'tree' || !dir.object?.entries || !['commands', 'agents', 'skills'].includes(name)) continue;
      listings.set(dir.path, listing(dir.object.entries));
      for (const child of dir.object.entries) {
        // Only the texts the probe reads: `*.md` in commands and agents, and each skill's SKILL.md.
        if (name !== 'skills') {
          if (child.type === 'blob' && child.path.endsWith('.md')) reads.push({ owner, repo, ref, path: child.path, mode: child.mode });
          continue;
        }
        if (child.type !== 'tree' || !child.object?.entries) continue;
        const children = listing(child.object.entries);
        listings.set(child.path, children);
        if (!children) continue;
        const skill = child.object.entries.find((e) => e.path === `${child.path}/SKILL.md`);
        if (skill?.type === 'blob') reads.push({ owner, repo, ref, path: skill.path, mode: skill.mode });
        // No SKILL.md file in a listed directory: the contents API would answer 404, or a directory listing.
        else texts.set(`${child.path}/SKILL.md`, null);
      }
    }
  }
  const answers = await readBlobs(octokit, reads);
  for (const [i, { path }] of reads.entries()) {
    const value = restEquivalent(answers[i]);
    if (value !== undefined) texts.set(path, value);
  }
  return {
    readFile: (path) => {
      const known = texts.get(path);
      return known !== undefined ? Promise.resolve(known) : rest.readFile(path);
    },
    listDir: (path, kind) => {
      const known = listings.get(path);
      return known ? Promise.resolve(known[kind]) : rest.listDir(path, kind);
    },
  };
}

export async function getProjectClaudeContext(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref: string,
  opts?: { unfiltered?: boolean },
): Promise<ProjectClaudeContext | null> {
  return probeClaudeContext(await githubClaudeSnapshotIO(octokit, owner, repo, ref), opts);
}

// ── DiffSource adapter ──────────────────────────────────────────
//
// Thin wrapper around the exported functions above. The underlying
// functions stay exported so callers that aren't on the review pipeline
// path yet (proactive watch, PR picker, freshness checks) keep working
// without migration.

export class GitHubDiffSource implements DiffSource {
  readonly kind = 'github' as const;
  readonly key: string;
  private readonly octokit: Octokit;
  private readonly owner: string;
  private readonly repo: string;
  private readonly pullNumber: number;
  private metadataPromise: Promise<PrMetadata> | null = null;

  /** `metadata` is a fresh read the caller just made, such as the access check, so it is not read twice. */
  constructor(url: string, token: string | null, client?: Octokit, metadata?: PrMetadata) {
    this.key = url;
    this.octokit = client ?? getGitHubClient(token);
    const parsed = parsePrUrl(url);
    this.owner = parsed.owner;
    this.repo = parsed.repo;
    this.pullNumber = parsed.pullNumber;
    if (metadata) this.metadataPromise = Promise.resolve(metadata);
  }

  getMetadata(): Promise<PrMetadata> {
    this.metadataPromise ??= getPrMetadata(this.octokit, this.owner, this.repo, this.pullNumber, true);
    return this.metadataPromise;
  }

  private fromClone<T>(operation: (clone: LocalClone) => Promise<T>) {
    return localClones.read(`${this.owner}/${this.repo}`, operation);
  }
  /** Clone first; null there means the path is absent, which GitHub would only confirm at a cost. */
  private async readAt(owner: string, repo: string, filePath: string, ref: string, signal?: AbortSignal) {
    const local = await this.fromClone((clone) => clone.blob(ref, filePath));
    if (local !== undefined) return local && local.toString('utf-8');
    return getFileContent(this.octokit, owner, repo, filePath, ref, signal);
  }

  private comparisonBase: Promise<string> | null = null;
  getComparisonBase(): Promise<string> {
    this.comparisonBase ??= this.getMetadata().then(async meta => {
      const prepared = await preparedChanges(this.octokit, this.key, meta);
      if (prepared) return prepared.comparisonBase;
      const local = await this.fromClone((clone) => clone.mergeBase(meta.baseSha, meta.headSha));
      if (local) return local;
      return getMergeBase(this.octokit, this.owner, this.repo, meta.baseSha, meta.headSha);
    }).catch((error: unknown) => {
      // Keep successful revision pins, but allow a rate-limited lookup to resume.
      this.comparisonBase = null;
      throw error;
    });
    return this.comparisonBase;
  }
  async assertCurrent(): Promise<void> {
    const before = await this.getMetadata();
    const after = await getPrMetadata(this.octokit, this.owner, this.repo, this.pullNumber, true);
    if (before.headSha !== after.headSha || before.baseSha !== after.baseSha || before.baseBranch !== after.baseBranch) {
      throw new Error('This PR changed during generation. Refresh and try again.');
    }
  }

  async getDiff(changedFiles?: ChangedFile[]): Promise<string> {
    const metadata = await this.getMetadata();
    const cached = await preparedDiff(this.octokit, this.key, metadata);
    if (cached !== undefined) return cached;
    const local = await this.fromClone((clone) => clone.diff(metadata.baseSha, metadata.headSha));
    if (local !== undefined) return local;
    if (metadata.changedFileCount !== undefined && metadata.changedFileCount > GITHUB_PR_FILE_LIMIT)
      throw new Error(LARGE_PR_EXPLANATION_ERROR);
    return getPrDiff(this.octokit, this.owner, this.repo, this.pullNumber, changedFiles, true);
  }

  async getChangedFiles(): Promise<ChangedFile[]> {
    const metadata = await this.getMetadata();
    const cached = await preparedChanges(this.octokit, this.key, metadata);
    if (cached && !cached.filesTruncated && !cached.patchesDeferred) return cached.files.map(file => ({ filename: file.path, previous_filename: file.previousPath,
      status: file.status, additions: file.additions, deletions: file.deletions, patch: file.patch, sha: file.blobSha }));
    const local = await this.fromClone((clone) => clone.changes(metadata.baseSha, metadata.headSha));
    if (local) return local.files.map(changedFileFromClone);
    if (cached?.filesTruncated || (metadata.changedFileCount !== undefined && metadata.changedFileCount > GITHUB_PR_FILE_LIMIT))
      throw new Error(LARGE_PR_EXPLANATION_ERROR);
    const files = await getChangedFiles(this.octokit, this.owner, this.repo, this.pullNumber, true, metadata.changedFileCount);
    for (const file of files) if (file.sha && file.status !== 'deleted') this.blobs.set(file.filename, file.sha);
    return files;
  }

  async getFileContent(filePath: string, ref: 'base' | 'head', signal?: AbortSignal): Promise<string | null> {
    signal?.throwIfAborted();
    const meta = await this.getMetadata();
    const snapshot = await preparedChanges(this.octokit, this.key, meta);
    const file = snapshot?.files.find(file => file.path === filePath || (ref === 'base' && file.previousPath === filePath));
    const contents = file && await preparedFile(this.octokit, { url: this.key, path: file.path, baseSha: meta.baseSha, headSha: meta.headSha });
    if (contents) {
      const side = ref === 'base' ? contents.before : contents.after;
      if (side.kind === 'text') return side.content;
      if (side.kind === 'image' && side.dataUrl.startsWith('data:image/svg+xml;base64,'))
        return Buffer.from(side.dataUrl.split(',')[1], 'base64').toString('utf-8');
      return null;
    }
    const gitRef = ref === 'base' ? await this.getComparisonBase() : meta.headSha;
    const [owner, repo] = ((ref === 'base' ? meta.baseRepo : meta.headRepo) ?? `${this.owner}/${this.repo}`).split('/');
    const blobSha = ref === 'head' ? ((file?.path === filePath ? file.blobSha : undefined) ?? this.blobs.get(filePath)) : undefined;
    return this.readSource(owner, repo, filePath, gitRef, signal, blobSha && /^[a-f\d]{40}$/i.test(blobSha) ? blobSha : undefined);
  }

  /** Blob SHAs from the last file list, so a push only downloads the files it changed. */
  private blobs = new Map<string, string>();
  /**
   * A changed file's text, from the clone or from the source store that Changes shares. That store keys bytes by blob
   * SHA, so text read for one revision, PR, or stack layer serves every other with the same content.
   */
  private async readSource(owner: string, repo: string, filePath: string, ref: string, signal?: AbortSignal, blobSha?: string) {
    const local = await this.fromClone((clone) => clone.blob(ref, filePath));
    if (local !== undefined) return local && local.toString('utf-8');
    if (!blobSha && !/^[a-f\d]{40}$/i.test(ref)) return getFileContent(this.octokit, owner, repo, filePath, ref, signal);
    try {
      signal?.throwIfAborted();
      const bytes = await readGitHubFile(this.octokit, { owner, repo, path: filePath, ref, blobSha });
      signal?.throwIfAborted();
      // The contents API, used before, gives no inline text above 1 MB. Keep that limit for prompts.
      return bytes.length > 1_000_000 ? null : bytes.toString('utf-8');
    } catch (error) {
      signal?.throwIfAborted();
      const limited = githubRateLimit(error);
      if (limited) throw limited;
      return null;
    }
  }

  async getFileMetadata(changedFiles: ChangedFile[], signal?: AbortSignal): Promise<FileMetadata[]> {
    const meta = await this.getMetadata();
    const local = await this.fromClone((clone) => clone.fileHistory(meta.baseSha, meta.headSha, changedFiles));
    if (local) {
      const history = new Map(local.map((item) => [item.filename, item]));
      return changedFiles.map((file) => ({
        filename: file.filename,
        previousFilename: file.previous_filename,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        prCommitCount: history.get(file.filename)?.commitCount ?? 1,
        lastModified: history.get(file.filename)?.lastModified ?? null,
      }));
    }
    return getFileMetadata(this.octokit, this.owner, this.repo, this.pullNumber, meta.baseSha, changedFiles, signal);
  }

  async getNeighborFiles(
    paths: string[],
    contents: Record<string, string>,
    ref: 'base' | 'head',
    smartImportsProvider?: Provider,
  ): Promise<Record<string, string>> {
    const meta = await this.getMetadata();
    const gitRef = ref === 'base' ? await this.getComparisonBase() : meta.headSha;
    // Without a clone, every candidate path is read in one batch of GraphQL queries.
    return getNeighborFiles(this.octokit, this.owner, this.repo, paths, contents, gitRef, smartImportsProvider,
      localClones.has(`${this.owner}/${this.repo}`) ? (filePath) => this.readAt(this.owner, this.repo, filePath, gitRef) : undefined);
  }

  async getProjectClaudeContext(opts?: { unfiltered?: boolean }): Promise<ProjectClaudeContext | null> {
    const meta = await this.getMetadata();
    if (!localClones.has(`${this.owner}/${this.repo}`))
      return getProjectClaudeContext(this.octokit, this.owner, this.repo, meta.headSha, opts);
    const github = makeGithubClaudeIO(this.octokit, this.owner, this.repo, meta.headSha);
    return probeClaudeContext({
      readFile: (p) => this.readAt(this.owner, this.repo, p, meta.headSha),
      listDir: async (p, kind) => (await this.fromClone((clone) => clone.listDirectory(meta.headSha, p, kind))) ?? github.listDir(p, kind),
    }, opts);
  }
}
