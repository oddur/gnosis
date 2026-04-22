import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs/promises';
import type { DiffSource } from './diffSource';
import { probeClaudeContext, type ClaudeContextIO } from './claude-context';
import type {
  ChangedFile,
  FileMetadata,
  PrMetadata,
  ProjectClaudeContext,
  Provider,
} from './types';

const execFileP = promisify(execFile);

// `git diff` output can be enormous for big branches — bump the default
// child_process buffer (1 MB) well out of the way.
const GIT_MAX_BUFFER = 256 * 1024 * 1024;

interface ParsedLocalUrl {
  repoPath: string;
  baseRef: string;
  headRef: string;
}

export function parseLocalUrl(url: string): ParsedLocalUrl {
  if (!url.startsWith('local:')) {
    throw new Error(`Not a local URL: ${url}`);
  }
  const body = url.slice('local:'.length);
  const hashIdx = body.lastIndexOf('#');
  if (hashIdx === -1) {
    throw new Error(`Local URL missing commit range (expected local:/path#base..head): ${url}`);
  }
  const repoPath = body.slice(0, hashIdx);
  const range = body.slice(hashIdx + 1);
  // Support both `base..head` and `base...head` (three-dot = merge base diff).
  // Normalize to two-dot; the user-facing docs say "two commits".
  const dotIdx = range.indexOf('..');
  if (dotIdx === -1) {
    throw new Error(`Local URL range must be base..head: ${url}`);
  }
  const baseRef = range.slice(0, dotIdx);
  let headRef = range.slice(dotIdx + 2);
  if (headRef.startsWith('.')) headRef = headRef.slice(1); // handle `...`
  if (!repoPath || !baseRef || !headRef) {
    throw new Error(`Local URL malformed: ${url}`);
  }
  return { repoPath, baseRef, headRef };
}

export function buildLocalUrl(repoPath: string, baseRef: string, headRef: string): string {
  return `local:${path.resolve(repoPath)}#${baseRef}..${headRef}`;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileP('git', args, {
    cwd,
    maxBuffer: GIT_MAX_BUFFER,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return stdout;
}

async function gitOrNull(cwd: string, args: string[]): Promise<string | null> {
  try {
    return await git(cwd, args);
  } catch {
    return null;
  }
}

/** Runs `git rev-parse <ref>` — throws with a helpful message if the ref is unknown. */
async function resolveSha(repoPath: string, ref: string): Promise<string> {
  const out = await gitOrNull(repoPath, ['rev-parse', '--verify', `${ref}^{commit}`]);
  if (!out) {
    throw new Error(`git: unknown revision "${ref}" in ${repoPath}`);
  }
  return out.trim();
}

interface NameStatusEntry {
  status: ChangedFile['status'];
  filename: string;
  previous_filename?: string;
}

function parseNameStatus(out: string): NameStatusEntry[] {
  const entries: NameStatusEntry[] = [];
  for (const line of out.split('\n')) {
    if (!line) continue;
    const parts = line.split('\t');
    const code = parts[0];
    if (!code) continue;
    // R100, C95 etc — rename/copy similarity score suffix.
    const letter = code[0];
    switch (letter) {
      case 'A':
        entries.push({ status: 'added', filename: parts[1] });
        break;
      case 'M':
      case 'T': // type change — treat as modified
        entries.push({ status: 'modified', filename: parts[1] });
        break;
      case 'D':
        entries.push({ status: 'deleted', filename: parts[1] });
        break;
      case 'R':
        entries.push({ status: 'renamed', filename: parts[2], previous_filename: parts[1] });
        break;
      case 'C':
        entries.push({ status: 'added', filename: parts[2], previous_filename: parts[1] });
        break;
      default:
        // Unmerged, unknown — skip.
        break;
    }
  }
  return entries;
}

function parseNumstat(out: string): Map<string, { additions: number; deletions: number }> {
  const map = new Map<string, { additions: number; deletions: number }>();
  for (const line of out.split('\n')) {
    if (!line) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    // Binary files show "-\t-\tpath"
    const additions = parts[0] === '-' ? 0 : parseInt(parts[0], 10) || 0;
    const deletions = parts[1] === '-' ? 0 : parseInt(parts[1], 10) || 0;
    // For renames, numstat uses "old => new" or "{dir => dir}/file" syntax.
    // Strip those to the destination path; matched against name-status below.
    let filename = parts[2];
    const arrowIdx = filename.indexOf(' => ');
    if (arrowIdx !== -1) {
      const braceOpen = filename.indexOf('{');
      const braceClose = filename.indexOf('}');
      if (braceOpen !== -1 && braceClose !== -1 && braceOpen < arrowIdx && arrowIdx < braceClose) {
        const before = filename.slice(0, braceOpen);
        const newPart = filename.slice(arrowIdx + 4, braceClose);
        const after = filename.slice(braceClose + 1);
        filename = before + newPart + after;
      } else {
        filename = filename.slice(arrowIdx + 4);
      }
    }
    map.set(filename, { additions, deletions });
  }
  return map;
}

export class LocalGitDiffSource implements DiffSource {
  readonly kind = 'local' as const;
  readonly key: string;
  readonly cwd: string;
  private readonly repoPath: string;
  private readonly baseRefRaw: string;
  private readonly headRefRaw: string;
  private metadataPromise: Promise<PrMetadata> | null = null;
  private shaPromise: Promise<{ baseSha: string; headSha: string }> | null = null;

  constructor(url: string) {
    const { repoPath, baseRef, headRef } = parseLocalUrl(url);
    this.repoPath = path.resolve(repoPath);
    this.cwd = this.repoPath;
    this.baseRefRaw = baseRef;
    this.headRefRaw = headRef;
    this.key = buildLocalUrl(this.repoPath, baseRef, headRef);
  }

  private resolveRefs(): Promise<{ baseSha: string; headSha: string }> {
    this.shaPromise ??= (async () => {
      const [baseSha, headSha] = await Promise.all([
        resolveSha(this.repoPath, this.baseRefRaw),
        resolveSha(this.repoPath, this.headRefRaw),
      ]);
      return { baseSha, headSha };
    })();
    return this.shaPromise;
  }

  async getMetadata(): Promise<PrMetadata> {
    this.metadataPromise ??= (async () => {
      const { baseSha, headSha } = await this.resolveRefs();
      // Head commit: subject, author, author-date, body.
      const headInfo = await git(this.repoPath, [
        'log',
        '-1',
        '--format=%H%n%an%n%aI%n%cI%n%s%n%b',
        headSha,
      ]);
      const [, author, authorDate, commitDate, subject, ...bodyLines] = headInfo.split('\n');
      const body = bodyLines.join('\n').trim();
      // Commits between base and head — used for description + count.
      const logBetween = await gitOrNull(this.repoPath, [
        'log',
        '--format=%s%n%n%b%n---',
        `${baseSha}..${headSha}`,
      ]);
      const countOut = await gitOrNull(this.repoPath, [
        'rev-list',
        '--count',
        `${baseSha}..${headSha}`,
      ]);
      const commitCount = countOut ? parseInt(countOut.trim(), 10) || 1 : 1;
      const description = logBetween ? logBetween.trim() : body;

      return {
        title: subject || `${this.baseRefRaw}..${this.headRefRaw}`,
        description,
        author: author || 'unknown',
        baseBranch: this.baseRefRaw,
        headBranch: this.headRefRaw,
        baseSha,
        headSha,
        merged: false,
        state: 'open',
        createdAt: authorDate || new Date().toISOString(),
        updatedAt: commitDate || authorDate || new Date().toISOString(),
        url: this.key,
        labels: [],
        mergeable: null,
        isDraft: false,
        commitCount,
        requestedReviewers: [],
        requestedTeams: [],
        mergeableState: null,
        autoMerge: null,
        milestone: null,
      };
    })();
    return this.metadataPromise;
  }

  async getChangedFiles(): Promise<ChangedFile[]> {
    const range = await this.threeDotRange();
    // Diagnostic: log the resolved range so the user can spot a bad base
    // (e.g. stale local main causing a huge merge-base diff) in the console.
    const mergeBase = await gitOrNull(this.repoPath, ['merge-base', ...range.split('...')]);
    console.log(
      `[localGit] diff range ${this.baseRefRaw}…${this.headRefRaw} (${range}); merge-base=${mergeBase?.trim().slice(0, 10) ?? '?'}`,
    );
    const [nameStatusOut, numstatOut] = await Promise.all([
      git(this.repoPath, ['diff', '--name-status', '-M', '-C', range]),
      git(this.repoPath, ['diff', '--numstat', range]),
    ]);

    const entries = parseNameStatus(nameStatusOut);
    const stats = parseNumstat(numstatOut);

    // Per-file `patch` is intentionally left undefined. It exists on the
    // `ChangedFile` interface for GitHub's fallback path (reassemble unified
    // diff when the API's full-diff endpoint returns `too_large`). Locally we
    // always have the full diff from `getDiff()`, so computing per-file
    // patches would mean N extra `git diff` subprocesses for zero benefit.
    return entries.map((e) => {
      const s = stats.get(e.filename) ?? { additions: 0, deletions: 0 };
      const file: ChangedFile = {
        filename: e.filename,
        status: e.status,
        additions: s.additions,
        deletions: s.deletions,
      };
      if (e.previous_filename) file.previous_filename = e.previous_filename;
      return file;
    });
  }

  async getDiff(): Promise<string> {
    const range = await this.threeDotRange();
    return git(this.repoPath, ['diff', '-M', '-C', range]);
  }

  /** Resolve the three-dot range `base...head` — the diff from the merge-base
   *  to head, matching GitHub PR semantics. Using two-dot (`base..head`)
   *  would also include changes that landed on base since the branch
   *  diverged, which is usually not what the reviewer wants. */
  private async threeDotRange(): Promise<string> {
    const { baseSha, headSha } = await this.resolveRefs();
    return `${baseSha}...${headSha}`;
  }

  async getFileContent(filePath: string, ref: 'base' | 'head'): Promise<string | null> {
    const { baseSha, headSha } = await this.resolveRefs();
    const sha = ref === 'base' ? baseSha : headSha;
    return gitOrNull(this.repoPath, ['show', `${sha}:${filePath}`]);
  }

  async getFileMetadata(changedFiles: ChangedFile[]): Promise<FileMetadata[]> {
    const { baseSha, headSha } = await this.resolveRefs();

    return Promise.all(
      changedFiles.map(async (f) => {
        const meta: FileMetadata = {
          filename: f.filename,
          status: f.status,
          additions: f.additions,
          deletions: f.deletions,
        };

        // Churn: commits in base..head touching this file.
        const churnOut = await gitOrNull(this.repoPath, [
          'rev-list',
          '--count',
          `${baseSha}..${headSha}`,
          '--',
          f.filename,
        ]);
        meta.prCommitCount = churnOut ? parseInt(churnOut.trim(), 10) || 1 : 1;

        // Last modified before the range — only meaningful for non-added files.
        if (f.status === 'added') {
          meta.lastModified = null;
        } else {
          const refForHistory = f.status === 'renamed' && f.previous_filename ? f.previous_filename : f.filename;
          const lastOut = await gitOrNull(this.repoPath, [
            'log',
            '-1',
            '--format=%aI',
            baseSha,
            '--',
            refForHistory,
          ]);
          meta.lastModified = lastOut ? lastOut.trim() || null : null;
        }

        return meta;
      }),
    );
  }

  async getNeighborFiles(
    paths: string[],
    contents: Record<string, string>,
    ref: 'base' | 'head',
    smartImportsProvider?: Provider,
  ): Promise<Record<string, string>> {
    if (smartImportsProvider) {
      const { extractImportsWithLLM } = await import('./github');
      console.log(`[localGit] Using smart (${smartImportsProvider}) import extraction`);
      const importPaths = await extractImportsWithLLM(contents, paths, smartImportsProvider);
      const neighborPaths = importPaths.filter((p) => !paths.includes(p));
      const pathsToFetch = neighborPaths.slice(0, 30);
      const result: Record<string, string> = {};
      await Promise.all(
        pathsToFetch.map(async (p) => {
          const content = await this.getFileContent(p, ref);
          if (content !== null) result[p] = content;
        }),
      );
      return result;
    }

    // Default: regex-based extraction, mirroring the GitHub fallback path.
    const neighbors = new Set<string>();
    for (const p of paths) {
      const content = contents[p];
      if (!content) continue;
      for (const imp of extractRelativeImports(content, p)) {
        if (!paths.includes(imp)) neighbors.add(imp);
      }
    }

    const pathsToFetch = Array.from(neighbors).slice(0, 30);
    const result: Record<string, string> = {};
    const TS_EXT = ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js'];
    await Promise.all(
      pathsToFetch.map(async (base) => {
        for (const ext of TS_EXT) {
          const full = base + ext;
          const content = await this.getFileContent(full, ref);
          if (content !== null) {
            result[full] = content;
            return;
          }
        }
      }),
    );
    return result;
  }

  async getProjectClaudeContext(opts?: { unfiltered?: boolean }): Promise<ProjectClaudeContext | null> {
    return probeClaudeContext(makeFsClaudeIO(this.repoPath), opts);
  }

  async checkRuntimeWarnings(): Promise<string[]> {
    const warnings: string[] = [];
    const usesHead = this.baseRefRaw === 'HEAD' || this.headRefRaw === 'HEAD';
    if (usesHead) {
      const out = await gitOrNull(this.repoPath, ['status', '--porcelain']);
      if (out && out.trim().length > 0) {
        warnings.push('Working tree has uncommitted changes — reviewing committed state only');
      }
    }
    return warnings;
  }

  get refs(): { baseRef: string; headRef: string; repoPath: string } {
    return { baseRef: this.baseRefRaw, headRef: this.headRefRaw, repoPath: this.repoPath };
  }
}

function makeFsClaudeIO(repoPath: string): ClaudeContextIO {
  return {
    readFile: async (p) => {
      try {
        return await fs.readFile(path.join(repoPath, p), 'utf-8');
      } catch {
        return null;
      }
    },
    listDir: async (p, kind) => {
      try {
        const entries = await fs.readdir(path.join(repoPath, p), { withFileTypes: true });
        return entries
          .filter((e) => (kind === 'dir' ? e.isDirectory() : e.isFile()))
          .map((e) => `${p}/${e.name}`);
      } catch {
        return [];
      }
    },
  };
}

function extractRelativeImports(content: string, filePath: string): string[] {
  const dir = filePath.split('/').slice(0, -1).join('/');
  const imports: string[] = [];
  const re = /import\s+(?:.*?\s+from\s+)?['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    const spec = m[1];
    if (!spec.startsWith('.')) continue;
    const parts = (dir ? dir + '/' + spec : spec).split('/');
    const normalized: string[] = [];
    for (const part of parts) {
      if (part === '..') normalized.pop();
      else if (part !== '.') normalized.push(part);
    }
    imports.push(normalized.join('/'));
  }
  return imports;
}
