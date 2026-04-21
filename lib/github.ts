import { Octokit } from '@octokit/rest';
import { getProvider } from './provider';
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

export async function getPrDiff(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
  changedFiles?: ChangedFile[],
): Promise<string> {
  try {
    const response = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
      owner,
      repo,
      pull_number: pullNumber,
      headers: {
        accept: 'application/vnd.github.v3.diff',
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
      changedFiles = await getChangedFiles(octokit, owner, repo, pullNumber);
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
        patch: f.patch,
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

/** Search GitHub repos by query string. Returns owner/name pairs for autocomplete. */
export async function searchRepos(
  octokit: Octokit,
  query: string,
  limit = 10
): Promise<RepoSearchResult[]> {
  if (!query.trim()) return [];
  const { data } = await octokit.search.repos({
    q: query,
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

  return data.map((pr) => ({
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
  const { data } = await octokit.checks.listForRef({ owner, repo, ref, per_page: 100 });
  const checks: CiCheck[] = data.check_runs.map((run) => ({
    name: run.name,
    status: run.status as CiCheck['status'],
    conclusion: run.conclusion ?? null,
    url: run.html_url ?? run.details_url ?? null,
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

// ── File metadata (age + churn) ───────────────────────────────

// Fetch the last commit date for a file BEFORE the PR's base ref.
// Returns an ISO date string or null if the file is new.
async function getFileLastModified(
  octokit: Octokit,
  owner: string,
  repo: string,
  filePath: string,
  baseSha: string
): Promise<string | null> {
  try {
    const { data } = await octokit.repos.listCommits({
      owner,
      repo,
      path: filePath,
      sha: baseSha,
      per_page: 1,
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
  pullNumber: number
): Promise<Map<string, number>> {
  const churn = new Map<string, number>();
  try {
    const commits = await octokit.paginate(octokit.pulls.listCommits, {
      owner,
      repo,
      pull_number: pullNumber,
      per_page: 100,
    });
    // For each commit, fetch its files and increment the counter.
    // Limit to first 30 commits to avoid API rate limit issues on
    // very large PRs.
    const toFetch = commits.slice(0, 30);
    for (const commit of toFetch) {
      try {
        const { data } = await octokit.repos.getCommit({
          owner,
          repo,
          ref: commit.sha,
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
  changedFiles: ChangedFile[]
): Promise<FileMetadata[]> {
  // Fetch churn data once for the whole PR
  const churnMap = await getPrFileChurn(octokit, owner, repo, pullNumber);

  // Fetch last-modified dates in parallel, batched 10 at a time to
  // stay well under GitHub's rate limit.
  const metadata: FileMetadata[] = changedFiles.map((f) => ({
    filename: f.filename,
    status: f.status,
    additions: f.additions,
    deletions: f.deletions,
    prCommitCount: churnMap.get(f.filename) ?? 1,
  }));

  const BATCH_SIZE = 10;
  for (let i = 0; i < metadata.length; i += BATCH_SIZE) {
    const batch = metadata.slice(i, i + BATCH_SIZE);
    await Promise.all(
      batch.map(async (fm) => {
        if (fm.status === 'added') {
          fm.lastModified = null;
        } else {
          fm.lastModified = await getFileLastModified(octokit, owner, repo, fm.filename, baseSha);
        }
      })
    );
  }

  return metadata;
}

// ── Claude Code project conventions ─────────────────────────────

const CLAUDE_MD_MAX_CHARS = 8 * 1024;
const CLAUDE_ENTRY_SUMMARY_CHARS = 240;
const CLAUDE_PATHS = {
  md: 'CLAUDE.md',
  root: '.claude',
  commands: 'commands',
  agents: 'agents',
  skills: 'skills',
} as const;

type DirEntry = { type: string; name: string; path: string };

async function listDirEntries(
  octokit: Octokit,
  owner: string,
  repo: string,
  path: string,
  ref: string,
  predicate: (entry: DirEntry) => boolean
): Promise<string[]> {
  try {
    const { data } = await octokit.repos.getContent({ owner, repo, path, ref });
    if (!Array.isArray(data)) return [];
    return data.filter(predicate).map((e) => e.path);
  } catch {
    return [];
  }
}

const isMarkdown = (e: DirEntry) => e.type === 'file' && e.name.endsWith('.md');
const isDir = (e: DirEntry) => e.type === 'dir';

// Prefers a front-matter `description:` field, then the first
// non-empty paragraph. Hard-truncated so a verbose file can't eat
// the context budget.
function summariseClaudeEntry(content: string): string {
  const fmMatch = /^---\n([\s\S]*?)\n---\n?/.exec(content);
  let body = content;
  if (fmMatch) {
    body = content.slice(fmMatch[0].length);
    const descMatch = /^description:\s*(.+)$/m.exec(fmMatch[1]);
    if (descMatch) {
      return descMatch[1].trim().slice(0, CLAUDE_ENTRY_SUMMARY_CHARS);
    }
  }
  const firstPara = body
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .find((p) => p.length > 0 && !p.startsWith('#'));
  return (firstPara ?? body.trim()).replace(/\s+/g, ' ').slice(0, CLAUDE_ENTRY_SUMMARY_CHARS);
}

function entryName(path: string): string {
  const base = path.split('/').pop() ?? path;
  return base.replace(/\.md$/, '');
}

// Whitelist of review-signal keywords. Expressed as an array so
// adding / removing a term doesn't risk breaking regex escaping or
// accidental alternation boundaries.
const CLAUDE_REVIEW_KEYWORDS = [
  'review', 'audit', 'lint', 'security', 'accessib', 'convention', 'coding\\s*style',
  'style\\s*guide', 'architecture', 'refactor', 'critique', 'invariant', 'contract',
  'type\\s*safety', 'quality', 'design\\s*(system|pattern|principle|quality)', 'correctness',
  'harden', 'simplify', 'polish', 'distill', 'normalize', 'responsive', 'a11y', 'performance',
  'optim', 'vulnerab', 'best\\s*practice', 'anti[- ]?pattern', 'testing', 'test\\s*strategy',
  'naming\\s*convention', 'frontend', 'ui\\s+(design|component)', 'visual', 'typograph',
];
const CLAUDE_REVIEW_POSITIVE = new RegExp(`\\b(${CLAUDE_REVIEW_KEYWORDS.join('|')})\\b`);
const CLAUDE_REVIEW_HARD_NEGATIVE = /\bmcp\b|\bapi[- ]?key\b/;

function isReviewRelevantClaudeEntry(name: string, content: string): boolean {
  // Scan name + first 2 KB only — summaries are up top, and a pass
  // match buried 20 KB into a body isn't a trustworthy signal.
  const lower = (name + ' ' + content.slice(0, 2000)).toLowerCase();
  if (CLAUDE_REVIEW_HARD_NEGATIVE.test(lower)) return false;
  return CLAUDE_REVIEW_POSITIVE.test(lower);
}

async function fetchSummarisedEntries(
  octokit: Octokit,
  owner: string,
  repo: string,
  paths: string[],
  ref: string,
  filter: (name: string, content: string) => boolean = () => true
): Promise<{ included: { name: string; summary: string }[]; droppedCount: number }> {
  const included: { name: string; summary: string }[] = [];
  let droppedCount = 0;
  const concurrency = 5;
  for (let i = 0; i < paths.length; i += concurrency) {
    const batch = paths.slice(i, i + concurrency);
    await Promise.all(
      batch.map(async (p) => {
        const content = await getFileContent(octokit, owner, repo, p, ref);
        if (!content) return;
        const name = entryName(p);
        if (!filter(name, content)) {
          droppedCount += 1;
          return;
        }
        included.push({ name, summary: summariseClaudeEntry(content) });
      })
    );
  }
  included.sort((a, b) => a.name.localeCompare(b.name));
  return { included, droppedCount };
}

// Probe the PR repo for Claude-Code conventions at the given ref.
// Returns `null` when nothing is found. All errors swallow to null
// so a missing `.claude/` or a 403 never fails the review.
export async function getProjectClaudeContext(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref: string
): Promise<ProjectClaudeContext | null> {
  // First pass: CLAUDE.md + one listing of `.claude/` itself. Skips
  // the three subdir requests on repos that have no Claude setup
  // (the common case in public repos).
  const [claudeMdRaw, claudeRootEntries] = await Promise.all([
    getFileContent(octokit, owner, repo, CLAUDE_PATHS.md, ref),
    listDirEntries(octokit, owner, repo, CLAUDE_PATHS.root, ref, isDir),
  ]);

  const hasRoot = claudeRootEntries.some((p) => p.endsWith(`/${CLAUDE_PATHS.commands}`)
    || p.endsWith(`/${CLAUDE_PATHS.agents}`)
    || p.endsWith(`/${CLAUDE_PATHS.skills}`));

  // Second pass: fetch the subdir listings, but only for ones that
  // actually exist in the root listing.
  const hasCommands = claudeRootEntries.some((p) => p.endsWith(`/${CLAUDE_PATHS.commands}`));
  const hasAgents = claudeRootEntries.some((p) => p.endsWith(`/${CLAUDE_PATHS.agents}`));
  const hasSkills = claudeRootEntries.some((p) => p.endsWith(`/${CLAUDE_PATHS.skills}`));

  const [commandPaths, agentPaths, skillDirs] = await Promise.all([
    hasCommands
      ? listDirEntries(octokit, owner, repo, `${CLAUDE_PATHS.root}/${CLAUDE_PATHS.commands}`, ref, isMarkdown)
      : Promise.resolve<string[]>([]),
    hasAgents
      ? listDirEntries(octokit, owner, repo, `${CLAUDE_PATHS.root}/${CLAUDE_PATHS.agents}`, ref, isMarkdown)
      : Promise.resolve<string[]>([]),
    hasSkills
      ? listDirEntries(octokit, owner, repo, `${CLAUDE_PATHS.root}/${CLAUDE_PATHS.skills}`, ref, isDir)
      : Promise.resolve<string[]>([]),
  ]);

  const hasAny = !!claudeMdRaw || hasRoot;
  if (!hasAny) return null;

  let projectInstructions: string | null = null;
  let projectInstructionsBytes: number | undefined;
  if (claudeMdRaw) {
    projectInstructionsBytes = Buffer.byteLength(claudeMdRaw, 'utf-8');
    projectInstructions =
      claudeMdRaw.length > CLAUDE_MD_MAX_CHARS
        ? claudeMdRaw.slice(0, CLAUDE_MD_MAX_CHARS) + `\n\n… [truncated, original ${projectInstructionsBytes} bytes]`
        : claudeMdRaw;
  }

  const [cmdResult, agentResult, skillResult] = await Promise.all([
    fetchSummarisedEntries(octokit, owner, repo, commandPaths, ref, isReviewRelevantClaudeEntry),
    fetchSummarisedEntries(octokit, owner, repo, agentPaths, ref, isReviewRelevantClaudeEntry),
    fetchSummarisedEntries(
      octokit,
      owner,
      repo,
      skillDirs.map((d) => `${d}/SKILL.md`),
      ref,
      isReviewRelevantClaudeEntry
    ),
  ]);

  const totalDropped = cmdResult.droppedCount + agentResult.droppedCount + skillResult.droppedCount;
  if (totalDropped > 0) {
    console.log(
      `[claude-context] Filtered out ${totalDropped} non-review entries (commands: ${cmdResult.droppedCount}, agents: ${agentResult.droppedCount}, skills: ${skillResult.droppedCount})`
    );
  }

  // If post-filter nothing of substance remains (no CLAUDE.md and
  // every command/agent/skill got dropped as non-review), drop the
  // whole context so the UI doesn't render an empty disclosure.
  const postFilterHasAny =
    !!projectInstructions ||
    cmdResult.included.length > 0 ||
    agentResult.included.length > 0 ||
    skillResult.included.length > 0;
  if (!postFilterHasAny) return null;

  return {
    projectInstructions,
    projectInstructionsBytes,
    commands: cmdResult.included,
    agents: agentResult.included,
    skills: skillResult.included,
  };
}
