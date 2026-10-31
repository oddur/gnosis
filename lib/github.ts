import { sourceChunks } from './prompt-budget';
import { readCommitChecks } from './github-checks';
import type { Octokit } from '@octokit/rest';
import { parseGitHubLabels } from './github-labels';
import { getGitHubClient, GitHubBackoffError, githubRateLimit } from './github-client';
import { localClones, type LocalClone, type LocalCloneFile, type LocalClones } from './local-clone';
import { preparedChanges, preparedFile, preparedDiff } from './prepared-pr';
import { GITHUB_PR_FILE_LIMIT } from './inspection-limits';
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

export async function getPrMetadata(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
  fresh = false
): Promise<PrMetadata> {
  const { data } = await octokit.pulls.get({ owner, repo, pull_number: pullNumber, ...(fresh ? { headers: { 'cache-control': 'no-cache' } } : {}) });
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
    requestedReviewers: (data.requested_reviewers ?? []).map((u) => u.login),
    requestedTeams: (data.requested_teams ?? []).map((t) => t.name),
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- GitHub API can return null
    mergeableState: data.mergeable_state ?? null,
    autoMerge: data.auto_merge ? { method: data.auto_merge.merge_method } : null,
    milestone: data.milestone ? { title: data.milestone.title, dueOn: data.milestone.due_on } : null,
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

export async function getChangedFiles(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
  fresh = false
): Promise<ChangedFile[]> {
  const files: ChangedFile[] = [];
  let page = 1;
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- pagination loop
  while (true) {
    const { data } = await octokit.pulls.listFiles({
      ...(fresh ? { headers: { 'cache-control': 'no-cache' } } : {}),
      owner,
      repo,
      pull_number: pullNumber,
      per_page: 100,
      page,
    });
    for (const f of data) {
      files.push({
        filename: f.filename,
        sha: f.sha ?? undefined,
        status: f.status === 'removed' ? 'deleted' : f.status === 'added' || f.status === 'renamed' ? f.status : 'modified',
        additions: f.additions,
        deletions: f.deletions,
        previous_filename: f.previous_filename,
        patch: f.patch,
      });
    }
    if (data.length < 100 || files.length >= GITHUB_PR_FILE_LIMIT) break;
    page++;
  }
  return files;
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

export async function getReviewStatus(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number
): Promise<ReviewSummary> {
  const { data: reviews } = await octokit.pulls.listReviews({
    owner,
    repo,
    pull_number: pullNumber,
    per_page: 100,
  });

  // Keep only the latest review per reviewer
  const latestByUser = new Map<string, string>();
  for (const r of reviews) {
    const login = r.user?.login ?? 'unknown';
    const state = r.state;
    if (state === 'DISMISSED' || state === 'PENDING') continue;
    latestByUser.set(login, state);
  }

  let approved = 0;
  let changesRequested = 0;
  let commented = 0;
  for (const state of latestByUser.values()) {
    if (state === 'APPROVED') approved++;
    else if (state === 'CHANGES_REQUESTED') changesRequested++;
    else if (state === 'COMMENTED') commented++;
  }

  return { approved, changesRequested, commented };
}

function extractImports(content: string, filePath: string): string[] {
  const imports: string[] = [];
  const dir = filePath.split('/').slice(0, -1).join('/');

  // Match ES import statements
  const importRegex = /import\s+(?:.*?\s+from\s+)?['"]([^'"]+)['"]/g;
  let match;
  while ((match = importRegex.exec(content)) !== null) {
    const importPath = match[1];
    if (importPath.startsWith('.')) {
      // Relative import — resolve to a file path
      const resolved = resolveRelativePath(dir, importPath);
      if (resolved) imports.push(resolved);
    }
  }

  return imports;
}

function resolveRelativePath(dir: string, importPath: string): string | null {
  const parts = (dir ? dir + '/' + importPath : importPath).split('/');
  const normalized: string[] = [];
  for (const part of parts) {
    if (part === '..') normalized.pop();
    else if (part !== '.') normalized.push(part);
  }
  const base = normalized.join('/');
  // Return without extension — caller will try common extensions
  return base;
}

const TS_EXTENSIONS = ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js'];

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

export async function getNeighborFiles(
  octokit: Octokit,
  owner: string,
  repo: string,
  changedFilePaths: string[],
  changedFileContents: Record<string, string>,
  ref: string,
  smartImportsProvider?: Provider,
  readFile: (path: string) => Promise<string | null> = (path) => getFileContent(octokit, owner, repo, path, ref)
): Promise<Record<string, string>> {
  if (smartImportsProvider) {
    console.log(`[github] Using smart (${smartImportsProvider}) import extraction`);
    const importPaths = await extractImportsWithLLM(changedFileContents, changedFilePaths, smartImportsProvider);
    console.log(`[github] ${smartImportsProvider} found ${importPaths.length} import(s):`, importPaths);

    // Filter out paths already in the changed set
    const neighborPaths = importPaths.filter((p) => !changedFilePaths.includes(p));
    console.log(`[github] ${neighborPaths.length} neighbor file(s) to fetch (after excluding changed files)`);
    const pathsToFetch = neighborPaths.slice(0, 30);

    const results: Record<string, string> = {};
    const concurrency = 5;
    for (let i = 0; i < pathsToFetch.length; i += concurrency) {
      const batch = pathsToFetch.slice(i, i + concurrency);
      await Promise.all(
        batch.map(async (filePath) => {
          const content = await readFile(filePath);
          if (content !== null) {
            results[filePath] = content;
          }
        })
      );
    }
    console.log(`[github] Fetched ${Object.keys(results).length} neighbor file(s):`, Object.keys(results));
    return results;
  }

  // Default: existing regex-based extraction
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

  const results: Record<string, string> = {};
  const pathsToFetch = Array.from(neighborPaths).slice(0, 30);

  const concurrency = 5;
  for (let i = 0; i < pathsToFetch.length; i += concurrency) {
    const batch = pathsToFetch.slice(i, i + concurrency);
    await Promise.all(
      batch.map(async (basePath) => {
        for (const ext of TS_EXTENSIONS) {
          const fullPath = basePath + ext;
          const content = await readFile(fullPath);
          if (content !== null) {
            results[fullPath] = content;
            break;
          }
        }
      })
    );
  }

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
    // very large PRs.
    const toFetch = commits.slice(0, 30);
    for (const commit of toFetch) {
      signal?.throwIfAborted();
      try {
        const { data } = await octokit.repos.getCommit({
          owner,
          repo,
          ref: commit.sha,
          ...(signal ? { request: { signal } } : {}),
        });
        for (const f of data.files ?? []) {
          churn.set(f.filename, (churn.get(f.filename) ?? 0) + 1);
        }
      } catch {
        // Individual commit fetch failed — skip silently
      }
    }
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
  // Fetch churn data once for the whole PR
  const churnMap = await getPrFileChurn(octokit, owner, repo, pullNumber, signal);

  // Fetch last-modified dates in parallel, batched 10 at a time to
  // stay well under GitHub's rate limit.
  const metadata: FileMetadata[] = changedFiles.map((f) => ({
    filename: f.filename,
    previousFilename: f.previous_filename,
    status: f.status,
    additions: f.additions,
    deletions: f.deletions,
    prCommitCount: churnMap.get(f.filename) ?? 1,
  }));

  const BATCH_SIZE = 10;
  for (let i = 0; i < metadata.length; i += BATCH_SIZE) {
    signal?.throwIfAborted();
    const batch = metadata.slice(i, i + BATCH_SIZE);
    await Promise.all(
      batch.map(async (fm) => {
        if (fm.status === 'added') {
          fm.lastModified = null;
        } else {
          fm.lastModified = await getFileLastModified(octokit, owner, repo, fm.filename, baseSha, signal);
        }
      })
    );
  }

  return metadata;
}

// ── Claude Code project conventions ─────────────────────────────
//
// Shared probe lives in `lib/claude-context.ts` — this function only
// wires up the GitHub-backed IO.

import { probeClaudeContext, type ClaudeContextIO } from './claude-context';

function makeGithubClaudeIO(octokit: Octokit, owner: string, repo: string, ref: string): ClaudeContextIO {
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

export function getProjectClaudeContext(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref: string,
  opts?: { unfiltered?: boolean },
): Promise<ProjectClaudeContext | null> {
  return probeClaudeContext(makeGithubClaudeIO(octokit, owner, repo, ref), opts);
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

  constructor(url: string, token: string | null, client?: Octokit) {
    this.key = url;
    this.octokit = client ?? getGitHubClient(token);
    const parsed = parsePrUrl(url);
    this.owner = parsed.owner;
    this.repo = parsed.repo;
    this.pullNumber = parsed.pullNumber;
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
      const { data } = await this.octokit.repos.compareCommits({ owner: this.owner, repo: this.repo, base: meta.baseSha, head: meta.headSha });
      return data.merge_base_commit.sha;
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
      status: file.status, additions: file.additions, deletions: file.deletions, patch: file.patch }));
    const local = await this.fromClone((clone) => clone.changes(metadata.baseSha, metadata.headSha));
    if (local) return local.files.map(changedFileFromClone);
    if (cached?.filesTruncated || (metadata.changedFileCount !== undefined && metadata.changedFileCount > GITHUB_PR_FILE_LIMIT))
      throw new Error(LARGE_PR_EXPLANATION_ERROR);
    return getChangedFiles(this.octokit, this.owner, this.repo, this.pullNumber, true);
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
    return this.readAt(owner, repo, filePath, gitRef, signal);
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
    return getNeighborFiles(this.octokit, this.owner, this.repo, paths, contents, gitRef, smartImportsProvider,
      (filePath) => this.readAt(this.owner, this.repo, filePath, gitRef));
  }

  async getProjectClaudeContext(opts?: { unfiltered?: boolean }): Promise<ProjectClaudeContext | null> {
    const meta = await this.getMetadata();
    const github = makeGithubClaudeIO(this.octokit, this.owner, this.repo, meta.headSha);
    return probeClaudeContext({
      readFile: (p) => this.readAt(this.owner, this.repo, p, meta.headSha),
      listDir: async (p, kind) => (await this.fromClone((clone) => clone.listDirectory(meta.headSha, p, kind))) ?? github.listDir(p, kind),
    }, opts);
  }
}
