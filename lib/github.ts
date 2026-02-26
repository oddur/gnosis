import { Octokit } from '@octokit/rest';
import { getProvider } from './provider';
import type { ChangedFile, CiCheck, PrMetadata, PrSearchResult, Provider, ReviewSummary } from './types';

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
  pullNumber: number
): Promise<PrMetadata> {
  const { data } = await octokit.pulls.get({ owner, repo, pull_number: pullNumber });
  return {
    title: data.title,
    description: data.body ?? '',
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- GitHub API can return null
    author: data.user?.login ?? 'unknown',
    baseBranch: data.base.ref,
    headBranch: data.head.ref,
    headSha: data.head.sha,
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- GitHub API can return null
    merged: data.merged ?? false,
    state: data.state,
    createdAt: data.created_at,
    updatedAt: data.updated_at,
    url: data.html_url,
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- GitHub API can return null
    labels: (data.labels ?? []).map((l) => (typeof l === 'string' ? l : (l.name ?? ''))).filter(Boolean),
    mergeable: data.mergeable ?? null,
    isDraft: data.draft ?? false,
    commitCount: data.commits,
    requestedReviewers: (data.requested_reviewers ?? []).map((u) => u.login),
    requestedTeams: (data.requested_teams ?? []).map((t) => t.name),
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- GitHub API can return null
    mergeableState: data.mergeable_state ?? null,
    autoMerge: data.auto_merge ? { method: data.auto_merge.merge_method } : null,
    milestone: data.milestone ? { title: data.milestone.title, dueOn: data.milestone.due_on } : null,
  };
}

export async function getPrDiff(octokit: Octokit, owner: string, repo: string, pullNumber: number): Promise<string> {
  const response = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
    owner,
    repo,
    pull_number: pullNumber,
    headers: {
      accept: 'application/vnd.github.v3.diff',
    },
  });
  return response.data as unknown as string;
}

export async function getChangedFiles(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number
): Promise<ChangedFile[]> {
  const files: ChangedFile[] = [];
  let page = 1;
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- pagination loop
  while (true) {
    const { data } = await octokit.pulls.listFiles({
      owner,
      repo,
      pull_number: pullNumber,
      per_page: 100,
      page,
    });
    for (const f of data) {
      files.push({
        filename: f.filename,
        status: f.status as ChangedFile['status'],
        additions: f.additions,
        deletions: f.deletions,
        previous_filename: f.previous_filename,
      });
    }
    if (data.length < 100) break;
    page++;
  }
  return files;
}

export async function getFileContent(
  octokit: Octokit,
  owner: string,
  repo: string,
  path: string,
  ref: string
): Promise<string | null> {
  try {
    const { data } = await octokit.repos.getContent({ owner, repo, path, ref });
    if (Array.isArray(data) || data.type !== 'file') return null;
    if ('content' in data && data.content) {
      return Buffer.from(data.content, 'base64').toString('utf-8');
    }
    return null;
  } catch {
    return null;
  }
}

export async function searchPullRequests(octokit: Octokit, login: string, limit = 30): Promise<PrSearchResult[]> {
  const queries = [
    { q: `is:pr is:open author:${login}`, role: 'author' as const },
    { q: `is:pr is:open review-requested:${login}`, role: 'review-requested' as const },
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

export async function getCiStatus(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref: string
): Promise<{ checks: CiCheck[]; conclusion: 'success' | 'failure' | 'pending' | 'neutral' }> {
  const { data } = await octokit.checks.listForRef({ owner, repo, ref, per_page: 100 });
  const checks: CiCheck[] = data.check_runs.map((run) => ({
    name: run.name,
    status: run.status as CiCheck['status'],
    conclusion: run.conclusion ?? null,
  }));

  let conclusion: 'success' | 'failure' | 'pending' | 'neutral' = 'success';
  if (checks.length === 0) {
    conclusion = 'neutral';
  } else if (
    checks.some((c) => c.conclusion === 'failure' || c.conclusion === 'timed_out' || c.conclusion === 'cancelled')
  ) {
    conclusion = 'failure';
  } else if (checks.some((c) => c.status === 'in_progress' || c.status === 'queued')) {
    conclusion = 'pending';
  } else if (
    checks.every((c) => c.conclusion === 'success' || c.conclusion === 'skipped' || c.conclusion === 'neutral')
  ) {
    conclusion = 'success';
  } else {
    conclusion = 'neutral';
  }

  return { checks, conclusion };
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

async function extractImportsWithLLM(
  changedFileContents: Record<string, string>,
  changedFilePaths: string[],
  providerName: Provider
): Promise<string[]> {
  const fileEntries = changedFilePaths
    .filter((p) => changedFileContents[p])
    .map((p) => `--- ${p} ---\n${changedFileContents[p]}`)
    .join('\n\n');

  if (!fileEntries) return [];

  const provider = getProvider(providerName);
  const quickEntry = provider.models.find((m) => m.quick) ?? provider.models[0];
  const quickModel = quickEntry.id;

  try {
    const result = await provider.quick({
      content: fileEntries,
      systemPrompt: SMART_IMPORTS_SYSTEM_PROMPT,
      model: quickModel,
    });

    // Extract JSON array from response
    const start = result.indexOf('[');
    const end = result.lastIndexOf(']');
    if (start === -1 || end <= start) return [];

    const parsed: unknown = JSON.parse(result.slice(start, end + 1));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((p): p is string => typeof p === 'string');
  } catch (err) {
    console.warn('[github] Smart import extraction failed, returning empty:', err);
    return [];
  }
}

export async function getNeighborFiles(
  octokit: Octokit,
  owner: string,
  repo: string,
  changedFilePaths: string[],
  changedFileContents: Record<string, string>,
  ref: string,
  smartImportsProvider?: Provider
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
          const content = await getFileContent(octokit, owner, repo, filePath, ref);
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
          const content = await getFileContent(octokit, owner, repo, fullPath, ref);
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
