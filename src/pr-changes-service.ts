import { createHash } from 'node:crypto';
import type { Octokit } from '@octokit/rest';
import { getChangedFiles, getPrMetadata, parsePrUrl } from '../lib/github';
import { githubCacheFor } from '../lib/github-client';
import { isCacheRecord } from '../lib/github-cache';
import { imageMimeType } from '../lib/review-images';
import {
  changesRevision,
  type PrChanges,
  type PrFileRequest,
  type PrFileContents,
  type PrFileSide,
} from '../lib/pr-changes';

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
  const snapshotKey = (url: string, revision: string) => `pr-changes:v1:${url}:${revision}`;
  function remember(client: Octokit, snapshot: PrChanges) {
    let values = snapshots.get(client);
    if (!values) {
      values = new Map();
      snapshots.set(client, values);
    }
    values.set(snapshotKey(snapshot.url, changesRevision(snapshot.metadata)), snapshot);
    const oldest = values.keys().next().value;
    if (values.size > 100 && oldest) values.delete(oldest);
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
      const saved = cache?.get(latestKey, isSnapshot)?.value;
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
  async function content(client: Octokit, req: PrFileRequest): Promise<PrFileContents> {
    const { snapshot, file } = find(client, req);
    const identity = { url: req.url, path: req.path, baseSha: req.baseSha, headSha: req.headSha };
    return share(client, `file:${hash(identity)}`, async () => {
      const cache = githubCacheFor(client),
        version = cache?.version();
      const key = `pr-file:v1:${hash(identity)}`;
      const saved = cache?.get(
        key,
        (v): v is PrFileContents => isCacheRecord(v) && isCacheRecord(v.before) && isCacheRecord(v.after)
      );
      if (saved) return saved.value;
      async function side(before: boolean): Promise<PrFileSide> {
        if ((before && file.status === 'added') || (!before && file.status === 'deleted')) return { kind: 'absent' };
        const path = before ? (file.previousPath ?? file.path) : file.path;
        const repoName =
          (before ? snapshot.metadata.baseRepo : snapshot.metadata.headRepo) ??
          `${parsePrUrl(req.url).owner}/${parsePrUrl(req.url).repo}`;
        const [owner, repo] = repoName.split('/');
        const ref = before ? snapshot.comparisonBase : snapshot.metadata.headSha;
        const { data } = await client.request('GET /repos/{owner}/{repo}/contents/{path}', {
          owner,
          repo,
          path,
          ref,
          headers: { accept: 'application/vnd.github.raw+json' },
          request: { responseType: 'arraybuffer', cache: 'no-store' },
        });
        const bytes =
          typeof data === 'string'
            ? Buffer.from(data)
            : data instanceof ArrayBuffer
              ? Buffer.from(data)
              : ArrayBuffer.isView(data)
                ? Buffer.from(data.buffer, data.byteOffset, data.byteLength)
                : null;
        if (!bytes) throw new Error('GitHub did not return file contents. Open the file on GitHub.');
        const mime = imageMimeType(path);
        if (bytes.length > (mime ? 8_000_000 : 1_000_000))
          throw new Error('This file is too large to preview. Open it on GitHub.');
        if (mime) return { kind: 'image', dataUrl: `data:${mime};base64,${bytes.toString('base64')}` };
        if (bytes.includes(0)) throw new Error('This binary file has no text preview. Open it on GitHub.');
        try {
          return { kind: 'text', content: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
        } catch {
          throw new Error('This file is not UTF-8 text. Open it on GitHub.');
        }
      }
      const before = await side(true),
        after = await side(false);
      const result = { before, after };
      if (cache?.version() === version) cache?.set(key, result);
      return result;
    });
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
