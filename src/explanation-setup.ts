import { explanationFile, type ExplanationFile, type ExplanationOptions, type ExplanationSetup } from '../lib/explanation-options';
import { fileOverrideKey, type FileKindOverride, type FileKinds } from '../lib/file-kinds';
import { memberPrefix, type ReviewSnapshot } from '../lib/workbench';
import type { DiffSource } from '../lib/diffSource';
import type { PrChanges } from '../lib/pr-changes';
import type { ChangedFile, GenerateReviewRequest, PrMetadata } from '../lib/types';

/** What the setup needs to know about a source: its kind and its key. */
export type SourceIdentity = Pick<DiffSource, 'kind' | 'key' | 'cwd'>;

export function explanationRepository(source: SourceIdentity): string {
  if (source.kind === 'local') return `local:${source.cwd ?? source.key.split('#')[0].slice(6)}`;
  return new URL(source.key).pathname.split('/').slice(1, 3).join('/').toLowerCase();
}

export interface ExplanationFileDeps {
  overrides: () => Partial<Record<string, FileKindOverride>>;
  /** The Changes inventory of a PR at a revision. Its classifications mark generated and test files. */
  inventory: (url: string, revision?: PrMetadata) => Promise<PrChanges | undefined>;
  kinds: (inventory: PrChanges) => Promise<Record<string, FileKinds>>;
}

/** Changed files as the setup dialog and generation filter them. Stack paths keep their PR prefix. */
export async function explanationFiles(
  deps: ExplanationFileDeps,
  source: SourceIdentity,
  files: ChangedFile[],
  snapshot?: ReviewSnapshot,
): Promise<ExplanationFile[]> {
  const overrides = deps.overrides();
  const members = snapshot?.subject.members ?? [];
  const sources =
    source.kind === 'local'
      ? []
      : members.length
        ? members.map((m) => ({
            url: m.url,
            repo: m.repo,
            prefix: members.length > 1 ? memberPrefix(m) : '',
            revision: m as PrMetadata | undefined,
          }))
        : [{ url: source.key, repo: explanationRepository(source), prefix: '', revision: undefined }];
  const classifications = await Promise.all(
    sources.map(async (entry) => {
      const inventory = await deps.inventory(entry.url, entry.revision);
      return { ...entry, kinds: inventory ? await deps.kinds(inventory) : {} };
    }),
  );
  return files.map((file) => {
    const origin = classifications.find((entry) => file.filename.startsWith(entry.prefix));
    const displayPath = origin ? file.filename.slice(origin.prefix.length) : file.filename;
    const repo = origin?.repo ?? explanationRepository(source);
    const member = members.find((m) => m.url === origin?.url);
    const group = member ? `#${member.number} ${member.title}` : repo;
    return explanationFile(
      file,
      displayPath,
      group,
      origin?.kinds[displayPath],
      overrides[fileOverrideKey(repo, displayPath)],
    );
  });
}

export interface PreparedSource {
  source: DiffSource;
  prData: PrMetadata;
  reviewSnapshot?: ReviewSnapshot;
}

export interface ExplanationSetupDeps {
  /** Verifies access and loads the requested scope, as generation does. */
  prepare: (request: GenerateReviewRequest) => Promise<PreparedSource>;
  files: ExplanationFileDeps;
  /** Saved or default options, and whether they came from the previous explanation. */
  options: (
    request: GenerateReviewRequest,
    source: SourceIdentity,
    snapshot?: ReviewSnapshot,
  ) => { options: ExplanationOptions; restored: boolean };
}

export async function loadExplanationSetup(
  request: GenerateReviewRequest,
  deps: ExplanationSetupDeps,
): Promise<ExplanationSetup> {
  const { source, prData, reviewSnapshot } = await deps.prepare(request);
  const files = await source.getChangedFiles();
  return {
    title: prData.title,
    repository: explanationRepository(source),
    files: await explanationFiles(deps.files, source, files, reviewSnapshot),
    ...deps.options(request, source, reviewSnapshot),
  };
}
