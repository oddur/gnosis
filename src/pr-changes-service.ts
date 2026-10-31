import { createSharedGitHubRead } from '../lib/github-scheduler';
import { createByteCache } from '../lib/byte-cache';
import { compactInventory, INVENTORY_MEMORY_BYTES } from '../lib/inspection-limits';
import { createHash } from 'node:crypto';
import type { Octokit } from '@octokit/rest';
import { getChangedFiles, getPrMetadata, getPrMetadataForClone, knownMetadataForClone, getPrDiff, parsePrUrl, changedFileFromClone, GITHUB_PR_FILE_LIMIT } from '../lib/github';
import { preparedDiff, preparedDiffKey } from '../lib/prepared-pr';
import { githubCacheFor } from '../lib/github-client';
import { isCacheRecord } from '../lib/github-cache';
import { localClones } from '../lib/local-clone';
import { createSnapshotFileLoader } from './snapshot-file-loader';
import { changesRevision, type PrChanges, type PrFileRequest, type InspectionLoadOptions } from '../lib/pr-changes';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function isSnapshot(value: unknown): value is PrChanges {
  return (
    isCacheRecord(value) &&
    value.version === 1 &&
    typeof value.url === 'string' &&
    isCacheRecord(value.metadata) &&
    typeof value.metadata.headSha === 'string' &&
    typeof value.metadata.baseSha === 'string' &&
    typeof value.comparisonBase === 'string' &&
    Array.isArray(value.files) &&
    typeof value.fetchedAt === 'number'
  );
}
function validateURL(url: string) {
  if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(url)) throw new Error('Invalid pull request URL.');
  return parsePrUrl(url);
}
/** Snapshots pin both comparison revisions. No generation, filtering, or silent version swaps. */
export function createPrChangesService(clones = localClones) {
  const pending = new WeakMap<Octokit, Map<string, ReturnType<typeof createSharedGitHubRead<unknown>>>>();
  const snapshots = new WeakMap<Octokit, ReturnType<typeof createByteCache<string, PrChanges>>>();
  function share<T>(client: Octokit, key: string, run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    let work = pending.get(client);
    if (!work) {
      work = new Map();
      pending.set(client, work);
    }
    const previous = work.get(key);
    if (previous && !previous.signal.aborted) return previous.read(signal) as Promise<T>;
    const job = createSharedGitHubRead(() => run().finally(() => { if (work.get(key) === job) work.delete(key); }));
    work.set(key, job);
    return job.read(signal);
  }
  const snapshotKey = (url: string, revision: string) => `pr-changes:v2:${url}:${revision}`;
  function remember(client: Octokit, snapshot: PrChanges) {
    let values = snapshots.get(client);
    if (!values) {
      values = createByteCache<string, PrChanges>(INVENTORY_MEMORY_BYTES, 200);
      snapshots.set(client, values);
    }
    values.set(snapshotKey(snapshot.url, changesRevision(snapshot.metadata)), snapshot);
    values.set(snapshotKey(snapshot.url, 'latest'), snapshot);
    const oldest = values.keys().next().value;
    if (values.size > 200 && oldest) values.delete(oldest);
  }
  async function find(client: Octokit, req: PrFileRequest) {
    validateURL(req.url);
    const key = snapshotKey(req.url, `${req.baseSha}:${req.headSha}`);
    const snapshot = snapshots.get(client)?.get(key) ?? await githubCacheFor(client)?.getPrepared(key, isSnapshot);
    const file = snapshot?.files.find((f) => f.path === req.path);
    if (!snapshot || !file) throw new Error('Reload this PR’s file list before opening the file.');
    return { snapshot, file };
  }
  async function manifest(client: Octokit, url: string, refresh = false, options: InspectionLoadOptions = {}, signal?: AbortSignal): Promise<PrChanges> {
    const { owner, repo, pullNumber } = validateURL(url);
    return share(client, `manifest:${url}:${refresh}:${options.revision ? changesRevision(options.revision) : ''}`, async () => {
      const cache = githubCacheFor(client),
        version = cache?.version();
      const latestKey = snapshotKey(url, 'latest');
      const exact = options.revision && await cache?.getPrepared(snapshotKey(url, changesRevision(options.revision)), isSnapshot);
      const saved = exact ?? snapshots.get(client)?.get(latestKey) ?? cache?.get(latestKey, isSnapshot)?.value;
      if (saved && !refresh && (!options.revision || changesRevision(saved.metadata) === changesRevision(options.revision))) {
        remember(client, saved);
        return saved;
      }
      const member = knownMetadataForClone(options.revision, `${owner}/${repo}`, refresh, clones);
      const memberChanges = member && await clones.read(`${owner}/${repo}`, (clone) => clone.changes(member.baseSha, member.headSha));
      const metadata = member && memberChanges ? member : await getPrMetadataForClone(client, owner, repo, pullNumber, options.revision, clones);
      const key = snapshotKey(url, changesRevision(metadata));
      const existing = snapshots.get(client)?.get(key) ?? await cache?.getPrepared(key, isSnapshot);
      if (existing) {
        // File content is immutable at these SHAs; PR state and branch names are not.
        const refreshed = { ...existing, metadata, fetchedAt: Date.now() };
        remember(client, refreshed);
        if (cache?.version() === version) {
          cache?.set(key, refreshed);
          cache?.set(latestKey, refreshed);
        }
        return refreshed;
      }
      // Both sides are pinned by SHA, so a clone's answer cannot change during the read.
      const local = memberChanges ?? await clones.read(`${owner}/${repo}`, (clone) => clone.changes(metadata.baseSha, metadata.headSha));
      const files = local ? local.files.map(changedFileFromClone) : await getChangedFiles(client, owner, repo, pullNumber, true);
      const filesTruncated = !local && files.length === GITHUB_PR_FILE_LIMIT &&
        (metadata.changedFileCount === undefined || metadata.changedFileCount > files.length);
      if (!local && !filesTruncated && metadata.changedFileCount !== undefined && files.length !== metadata.changedFileCount)
        throw new Error('GitHub returned an incomplete file list. Open this PR on GitHub to inspect all files.');
      let comparisonBase = local?.mergeBase;
      if (!comparisonBase) {
        const { data: comparison } = await client.repos.compareCommits({
          owner,
          repo,
          base: metadata.baseSha,
          head: metadata.headSha,
          per_page: 1,
        });
        comparisonBase = comparison.merge_base_commit.sha;
        const after = await getPrMetadata(client, owner, repo, pullNumber, true);
        if (changesRevision(after) !== changesRevision(metadata))
          throw new Error('This PR changed while its file list was loading. Retry to load a consistent version.');
      }
      const value = compactInventory({
        version: 1,
        url,
        metadata,
        comparisonBase,
        fetchedAt: Date.now(),
        files: files.map((file) => ({
          path: file.filename,
          patch: file.patch,
          previousPath: file.previous_filename,
          status: file.status,
          additions: file.additions,
          deletions: file.deletions,
          // Unchanged patches/blobs retain progress across revisions; renames change review content.
          changeId: hash([
            file.filename,
            file.previous_filename,
            file.status,
            file.sha,
            file.patch ?? comparisonBase,
          ]),
        })),
        ...(filesTruncated ? { filesTruncated: true } : {}),
      });
      remember(client, value);
      if (cache?.version() === version) {
        cache?.set(key, value);
        cache?.set(latestKey, value);
      }
      return value;
    }, signal);
  }
  const loadFile = createSnapshotFileLoader(undefined, clones);
  async function content(client: Octokit, req: PrFileRequest, beforeRequest?: () => void) {
    const { snapshot, file } = await find(client, req);
    return loadFile(client, req, snapshot, file, beforeRequest);
  }

  return {
    async restore(client: Octokit, url: string, revision: { baseSha: string; headSha: string }) {
      const saved = await githubCacheFor(client)?.getPrepared(snapshotKey(url, changesRevision(revision)), isSnapshot);
      if (saved) remember(client, saved);
      return saved;
    },
    cached(client: Octokit, url: string, revision: { baseSha: string; headSha: string }) {
      const cache = githubCacheFor(client);
      const exact = snapshotKey(url, changesRevision(revision)), latest = snapshotKey(url, 'latest');
      return snapshots.get(client)?.get(exact) ?? cache?.get(exact, isSnapshot)?.value ??
        snapshots.get(client)?.get(latest) ?? cache?.get(latest, isSnapshot)?.value;
    },
    manifest,
    content,
    find,
    async prepareReview(client: Octokit, url: string, revision: Pick<PrChanges['metadata'], 'baseSha' | 'headSha'>) {
      if (await preparedDiff(client, url, revision) !== undefined) return;
      return share(client, `review:${url}:${changesRevision(revision)}`, async () => {
        const { owner, repo, pullNumber } = validateURL(url);
        const cache = githubCacheFor(client), version = cache?.version();
        const local = await clones.read(`${owner}/${repo}`, (clone) => clone.diff(revision.baseSha, revision.headSha));
        if (local !== undefined) {
          if (cache?.version() === version) cache?.set(preparedDiffKey(url, revision), local);
          return;
        }
        const before = await getPrMetadata(client, owner, repo, pullNumber);
        if (changesRevision(before) !== changesRevision(revision)) return;
        if (before.changedFileCount !== undefined && before.changedFileCount > GITHUB_PR_FILE_LIMIT) return;
        const diff = await getPrDiff(client, owner, repo, pullNumber, undefined, true);
        const after = await getPrMetadata(client, owner, repo, pullNumber, true);
        if (changesRevision(before) !== changesRevision(after)) throw new Error('This PR changed while its diff was being prepared.');
        if (cache?.version() === version) cache?.set(preparedDiffKey(url, revision), diff);
      });
    },
    async revision(client: Octokit, url: string) {
      const { owner, repo, pullNumber } = validateURL(url);
      const m = await getPrMetadata(client, owner, repo, pullNumber);
      return { baseSha: m.baseSha, headSha: m.headSha };
    },
  };
}
