import type { DiffSource } from './diffSource';
import { GitHubDiffSource } from './github';
import { memberPrefix, type ReviewSubject } from './workbench';
import type { ChangedFile, FileMetadata, Provider } from './types';

// Namespaced paths keep repeated files in different PRs distinct throughout planning,
// hunk assignment, code links, and comments. The UI resolves them back to source paths.
export class StackDiffSource implements DiffSource {
  readonly kind = 'github' as const;
  readonly key: string;
  private sources: Map<string, GitHubDiffSource>;
  constructor(
    readonly subject: ReviewSubject,
    token: string | null
  ) {
    this.key = subject.members[0].url;
    this.sources = new Map(subject.members.map((m) => [memberPrefix(m), new GitHubDiffSource(m.url, token)]));
  }
  async getMetadata() {
    const results = await Promise.all([...this.sources.values()].map((s) => s.getMetadata()));
    // Snapshot metadata is the same metadata used by the underlying sources.
    this.subject.members = this.subject.members.map((m, i) => ({
      ...m,
      ...results[i],
      headRepo: results[i].headRepo ?? m.headRepo,
      baseRepo: results[i].baseRepo ?? m.baseRepo,
    }));
    return {
      ...results[0],
      title: this.subject.title,
      description: `This is one coherent stack of ${results.length} PRs. Explain the overall purpose and organize topics across PR boundaries. Prefixes such as PR-repo-number/ identify source PRs, not real directories. Never treat inherited changes as new changes. Preserve source attribution.\n\n${this.subject.members.map((m) => `${memberPrefix(m)} → ${m.url}\n${m.title}\n${m.description}`).join('\n\n')}\nDependencies: ${JSON.stringify(this.subject.edges)}`,
    };
  }
  async getChangedFiles(): Promise<ChangedFile[]> {
    return (
      await Promise.all(
        [...this.sources].map(async ([prefix, s]) =>
          (await s.getChangedFiles()).map((f) => ({
            ...f,
            filename: prefix + f.filename,
            previous_filename: f.previous_filename ? prefix + f.previous_filename : undefined,
          }))
        )
      )
    ).flat();
  }
  async getDiff(): Promise<string> {
    return (
      await Promise.all([...this.sources].map(async ([prefix, s]) => namespaceDiff(await s.getDiff(), prefix)))
    ).join('\n');
  }
  private resolve(file: string) {
    const entry = [...this.sources].find(([prefix]) => file.startsWith(prefix));
    return entry ? { source: entry[1], path: file.slice(entry[0].length) } : undefined;
  }
  getFileContent(file: string, ref: 'base' | 'head') {
    const target = this.resolve(file);
    return target ? target.source.getFileContent(target.path, ref) : Promise.resolve(null);
  }
  async getFileMetadata(files: ChangedFile[]): Promise<FileMetadata[]> {
    return (
      await Promise.all(
        [...this.sources].map(async ([prefix, s]) =>
          (
            await s.getFileMetadata(
              files
                .filter((f) => f.filename.startsWith(prefix))
                .map((f) => ({ ...f, filename: f.filename.slice(prefix.length) }))
            )
          ).map((f) => ({ ...f, filename: prefix + f.filename }))
        )
      )
    ).flat();
  }
  async getNeighborFiles(paths: string[], contents: Record<string, string>, ref: 'base' | 'head', provider?: Provider) {
    const out: Record<string, string> = {};
    for (const [prefix, s] of this.sources) {
      const local = Object.fromEntries(
        Object.entries(contents)
          .filter(([p]) => p.startsWith(prefix))
          .map(([p, c]) => [p.slice(prefix.length), c])
      );
      const files = await s.getNeighborFiles(
        paths.filter((p) => p.startsWith(prefix)).map((p) => p.slice(prefix.length)),
        local,
        ref,
        provider
      );
      for (const [p, c] of Object.entries(files)) out[prefix + p] = c;
    }
    return out;
  }
  getProjectClaudeContext(opts?: { unfiltered?: boolean }) {
    return [...this.sources.values()][0].getProjectClaudeContext(opts);
  }
  async assertCurrent() {
    await Promise.all([...this.sources.values()].map((s) => s.assertCurrent()));
  }
}
export function namespaceDiff(diff: string, prefix: string): string {
  return diff
    .split('\n')
    .map((line) => {
      if (line.startsWith('diff --git ')) return line.replace(/ a\//, ' a/' + prefix).replace(/ b\//, ' b/' + prefix);
      if (line.startsWith('--- a/') || line.startsWith('+++ b/')) return line.slice(0, 6) + prefix + line.slice(6);
      if (line.startsWith('rename from ')) return 'rename from ' + prefix + line.slice(12);
      if (line.startsWith('rename to ')) return 'rename to ' + prefix + line.slice(10);
      return line;
    })
    .join('\n');
}
