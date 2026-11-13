import { explanationFile, type ExplanationFile, type ExplanationOptions, type ExplanationSetup } from '../lib/explanation-options';
import { fileOverrideKey, type FileKindOverride, type FileKinds } from '../lib/file-kinds';
import { memberPrefix, snapshot, type ReviewSnapshot, type ReviewSubject } from '../lib/workbench';
import { GITHUB_PR_FILE_LIMIT } from '../lib/inspection-limits';
import { isLocalUrl } from '../lib/local-url';
import { MUTED_PR_MESSAGE, reviewSubjectFor, singlePrRequest } from './review-start-source';
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

type Revision = Pick<PrMetadata, 'baseSha' | 'headSha'>;

/** What the app already knows about a PR or stack. Reading it never sends a GitHub request. */
export interface SavedSetupDeps {
  muted: () => ReadonlySet<string>;
  /** The queue's saved subject of a stack request, without discovery. */
  subject: (request: GenerateReviewRequest) => ReviewSubject | undefined;
  /** The newest saved metadata of a PR: background sync, the queue, or its Changes inventory. */
  metadata: (url: string) => PrMetadata | undefined;
  /** The saved Changes inventory of a PR at exactly this revision. */
  inventory: (url: string, revision: Revision) => Promise<PrChanges | undefined>;
}

export interface ExplanationSetupDeps {
  /** Verifies access and loads the requested scope, as generation does. */
  prepare: (request: GenerateReviewRequest) => Promise<PreparedSource>;
  saved: SavedSetupDeps;
  /** Loads a Changes inventory, from GitHub when it is not saved. Only the background update uses it. */
  inventory: (url: string, revision: Revision) => Promise<PrChanges | undefined>;
  overrides: ExplanationFileDeps['overrides'];
  kinds: ExplanationFileDeps['kinds'];
  /** Saved or default options, and whether they came from the previous explanation. */
  options: (
    request: GenerateReviewRequest,
    source: SourceIdentity,
    snapshot?: ReviewSnapshot,
  ) => { options: ExplanationOptions; restored: boolean };
}

export interface LoadedExplanationSetup {
  setup: ExplanationSetup;
  /**
   * Present when the setup came from saved data. Checks the scope on GitHub, with access, and resolves to a new
   * setup when a PR moved or the stack changed. Resolves to undefined when the saved answer is current.
   */
  revalidate?: () => Promise<ExplanationSetup | undefined>;
}

/** An inventory the setup can list in full. GitHub caps file lists, and explanations refuse capped PRs. */
const usable = (inventory: PrChanges | undefined): inventory is PrChanges =>
  !!inventory &&
  !inventory.filesTruncated &&
  (inventory.metadata.changedFileCount === undefined || inventory.metadata.changedFileCount <= GITHUB_PR_FILE_LIMIT);

const changedFiles = (inventory: PrChanges, prefix: string): ChangedFile[] =>
  inventory.files.map((file) => ({
    filename: prefix + file.path,
    previous_filename: file.previousPath ? prefix + file.previousPath : undefined,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
  }));

/** The PRs and revisions of a scope. A push or a new stack member changes it. */
const revisions = (snapshot?: ReviewSnapshot) =>
  JSON.stringify(snapshot?.subject.members.map((m) => [m.url, m.baseSha, m.headSha]) ?? []);

async function assemble(
  request: GenerateReviewRequest,
  deps: ExplanationSetupDeps,
  source: SourceIdentity,
  title: string,
  files: ChangedFile[],
  inventories: ReadonlyMap<string, PrChanges>,
  reviewSnapshot?: ReviewSnapshot,
): Promise<ExplanationSetup> {
  return {
    title,
    repository: explanationRepository(source),
    files: await explanationFiles(
      { overrides: deps.overrides, kinds: deps.kinds, inventory: (url) => Promise.resolve(inventories.get(url)) },
      source,
      files,
      reviewSnapshot,
    ),
    ...deps.options(request, source, reviewSnapshot),
  };
}

/** A setup from a prepared source. Inventories, when all are usable, list the files without another request. */
async function build(
  request: GenerateReviewRequest,
  deps: ExplanationSetupDeps,
  { source, prData, reviewSnapshot }: PreparedSource,
  inventory: (url: string, revision: Revision) => Promise<PrChanges | undefined>,
) {
  const members = source.kind === 'local' ? [] : (reviewSnapshot?.subject.members ?? []);
  const inventories = await Promise.all(members.map((m) => inventory(m.url, m)));
  const known = new Map<string, PrChanges>();
  members.forEach((m, i) => {
    const value = inventories[i];
    if (value) known.set(m.url, value);
  });
  const files =
    members.length && inventories.every(usable)
      ? members.flatMap((m, i) => changedFiles(inventories[i], members.length > 1 ? memberPrefix(m) : ''))
      : await source.getChangedFiles();
  return assemble(request, deps, source, prData.title, files, known, reviewSnapshot);
}

/** The requested scope from saved data only, or undefined when something is missing. */
function savedScope(request: GenerateReviewRequest, saved: SavedSetupDeps) {
  if (isLocalUrl(request.prUrl)) return;
  if (saved.muted().has(request.prUrl)) throw new Error(MUTED_PR_MESSAGE);
  const singlePr = singlePrRequest(request);
  // The full path reports contradictory scopes and stacks that are gone.
  if (singlePr && request.subjectId && request.subjectId !== request.prUrl) return;
  const queued = singlePr ? undefined : saved.subject(request);
  if (!singlePr && request.subjectId && !queued) return;
  if (queued && queued.members.length > 1) {
    const subject: ReviewSubject = { ...queued, members: queued.members.map((m) => ({ ...m })) };
    return { title: subject.title, key: subject.members[0].url, reviewSnapshot: snapshot(subject) };
  }
  const metadata = saved.metadata(request.prUrl);
  if (!metadata) return;
  const subject = reviewSubjectFor(
    request,
    metadata,
    queued && { ...queued, members: queued.members.map((m) => ({ ...m })) },
  );
  return subject && { title: metadata.title, key: request.prUrl, reviewSnapshot: snapshot(subject) };
}

/**
 * The setup dialog's options and files. An open PR or stack answers from saved metadata and Changes inventories
 * without a GitHub request, then `revalidate` checks it. Otherwise the scope loads as generation loads it, with one
 * read per PR. Generation always verifies access and freshness again.
 */
export async function loadExplanationSetup(
  request: GenerateReviewRequest,
  deps: ExplanationSetupDeps,
): Promise<LoadedExplanationSetup> {
  const saved = savedScope(request, deps.saved);
  if (saved) {
    const members = saved.reviewSnapshot.subject.members;
    const inventories = await Promise.all(members.map((m) => deps.saved.inventory(m.url, m)));
    if (inventories.every(usable)) {
      const files = members.flatMap((m, i) =>
        changedFiles(inventories[i], members.length > 1 ? memberPrefix(m) : ''),
      );
      const known = new Map(members.map((m, i) => [m.url, inventories[i]]));
      const setup = await assemble(
        request,
        deps,
        { kind: 'github', key: saved.key },
        saved.title,
        files,
        known,
        saved.reviewSnapshot,
      );
      return {
        setup,
        revalidate: async () => {
          const prepared = await deps.prepare(request);
          if (revisions(prepared.reviewSnapshot) === revisions(saved.reviewSnapshot)) return undefined;
          return build(request, deps, prepared, deps.inventory);
        },
      };
    }
  }
  return { setup: await build(request, deps, await deps.prepare(request), deps.saved.inventory) };
}
