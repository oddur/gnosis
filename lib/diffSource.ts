import type {
  ChangedFile,
  FileMetadata,
  PrMetadata,
  ProjectClaudeContext,
  Provider,
} from './types';

/**
 * Abstract source of diff + repo data for the review pipeline. Concrete
 * implementations back this with either the GitHub API or a local git
 * checkout. Constructed via `createDiffSource(url)`.
 */
export interface DiffSource {
  readonly kind: 'github' | 'local';
  /** Canonical URL used as history key and display label. */
  readonly key: string;
  /** Absolute path to the working directory, when one exists. Local sources
   *  expose the repo path; GitHub sources return undefined. Used to run the
   *  CLI with cwd set to the repo when tool-mode is enabled. */
  readonly cwd?: string;

  getMetadata(): Promise<PrMetadata>;
  getDiff(changedFiles?: ChangedFile[]): Promise<string>;
  getChangedFiles(): Promise<ChangedFile[]>;
  getFileContent(path: string, ref: 'base' | 'head'): Promise<string | null>;
  getFileMetadata(changedFiles: ChangedFile[]): Promise<FileMetadata[]>;
  getNeighborFiles(
    paths: string[],
    contents: Record<string, string>,
    ref: 'base' | 'head',
    smartImportsProvider?: Provider,
  ): Promise<Record<string, string>>;
  getProjectClaudeContext(opts?: { unfiltered?: boolean }): Promise<ProjectClaudeContext | null>;

  /** Optional pre-flight check for non-fatal issues (e.g. dirty working tree
   *  on a local source). Returned strings are surfaced as review-phase
   *  warnings; an empty array means everything is clean. */
  checkRuntimeWarnings?(): Promise<string[]>;
}

export function isLocalUrl(url: string): boolean {
  return url.startsWith('local:');
}

/**
 * Dispatch on URL prefix: `local:/abs/path#base..head` → local git source,
 * anything else → GitHub source.
 */
export async function createDiffSource(
  url: string,
  opts: { token?: string | null } = {},
): Promise<DiffSource> {
  if (isLocalUrl(url)) {
    const { LocalGitDiffSource } = await import('./localGit');
    return new LocalGitDiffSource(url);
  }
  const { GitHubDiffSource } = await import('./github');
  return new GitHubDiffSource(url, opts.token ?? null);
}
