import { createHash } from 'node:crypto';
import type { Octokit } from '@octokit/rest';
import { getChangedFiles, getPrMetadata, parsePrUrl } from '../lib/github';
import { githubCacheFor } from '../lib/github-client';
import { isCacheRecord } from '../lib/github-cache';
import { createSnapshotFileLoader } from './snapshot-file-loader';
import { changesRevision, type PrChanges, type PrFileRequest } from '../lib/pr-changes';

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
export function createPrChangesService() {
  const pending = new WeakMap<Octokit, Map<string, Promise<unknown>>>();
  const snapshots = new WeakMap<Octokit, Map<string, PrChanges>>();
  function share<T>(client: Octokit, key: string, run: () => Promise<T>): Promise<T> {
    let work = pending.get(client);
    if (!work) {
      work = new Map();
      pending.set(client, work);
    }
    const previous = work.get(key);
    if (previous) return previous as Promise<T>;
    const promise = run().finally(() => work.delete(key));
    work.set(key, promise);
    return promise;
  }
  const snapshotKey = (url: string, revision: string) => `pr-changes:v2:${url}:${revision}`;
  function remember(client: Octokit, snapshot: PrChanges) {
    let values = snapshots.get(client);
    if (!values) {
      values = new Map();
      snapshots.set(client, values);
    }
    values.set(snapshotKey(snapshot.url, changesRevision(snapshot.metadata)), snapshot);
    values.set(snapshotKey(snapshot.url, 'latest'), snapshot);
    const oldest = values.keys().next().value;
    if (values.size > 200 && oldest) values.delete(oldest);
  }
  function find(client: Octokit, req: PrFileRequest) {
    validateURL(req.url);
    const key = snapshotKey(req.url, `${req.baseSha}:${req.headSha}`);
    const snapshot = snapshots.get(client)?.get(key) ?? githubCacheFor(client)?.get(key, isSnapshot)?.value;
    const file = snapshot?.files.find((f) => f.path === req.path);
    if (!snapshot || !file) throw new Error('Reload this PR’s file list before opening the file.');
    return { snapshot, file };
  }
  async function manifest(client: Octokit, url: string, refresh = false): Promise<PrChanges> {
    const { owner, repo, pullNumber } = validateURL(url);
    return share(client, `manifest:${url}:${refresh}`, async () => {
      const cache = githubCacheFor(client),
        version = cache?.version();
      const latestKey = snapshotKey(url, 'latest');
      const saved = snapshots.get(client)?.get(latestKey) ?? cache?.get(latestKey, isSnapshot)?.value;
      if (saved && !refresh) {
        remember(client, saved);
        return saved;
      }
      const metadata = await getPrMetadata(client, owner, repo, pullNumber, true);
      const key = snapshotKey(url, changesRevision(metadata));
      const existing = cache?.get(key, isSnapshot)?.value;
      if (existing) {
        remember(client, existing);
        if (cache.version() === version) cache.set(latestKey, existing);
        return existing;
      }
      const files = await getChangedFiles(client, owner, repo, pullNumber, true);
      if (metadata.changedFileCount !== undefined && files.length !== metadata.changedFileCount)
        throw new Error('GitHub returned an incomplete file list. Open this PR on GitHub to inspect all files.');
      const { data: comparison } = await client.repos.compareCommits({
        owner,
        repo,
        base: metadata.baseSha,
        head: metadata.headSha,
      });
      const after = await getPrMetadata(client, owner, repo, pullNumber, true);
      if (changesRevision(after) !== changesRevision(metadata))
        throw new Error('This PR changed while its file list was loading. Retry to load a consistent version.');
      const value: PrChanges = {
        version: 1,
        url,
        metadata,
        comparisonBase: comparison.merge_base_commit.sha,
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
            file.patch ?? comparison.merge_base_commit.sha,
          ]),
        })),
      };
      remember(client, value);
      if (cache?.version() === version) {
        cache?.set(key, value);
        cache?.set(latestKey, value);
      }
      return value;
    });
  }
  const loadFile = createSnapshotFileLoader();
  async function content(client: Octokit, req: PrFileRequest) {
    const { snapshot, file } = find(client, req);
    return loadFile(client, req, snapshot, file);
  }

  return {
    manifest,
    content,
    find,
    async revision(client: Octokit, url: string) {
      const { owner, repo, pullNumber } = validateURL(url);
      const m = await getPrMetadata(client, owner, repo, pullNumber);
      return { baseSha: m.baseSha, headSha: m.headSha };
    },
  };
}
