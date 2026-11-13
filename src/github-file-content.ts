import type { Octokit } from '@octokit/rest';
import { createHash } from 'node:crypto';
import { githubCacheFor } from '../lib/github-client';
import { isCacheRecord, type GitHubCache } from '../lib/github-cache';
import { createGitHubWork, joinGitHubWork, type GitHubWork } from '../lib/github-scheduler';

interface Source {
  owner: string;
  repo: string;
  path: string;
  ref: string;
  /**
   * The file's blob SHA at `ref`, when the file list gave one. A full SHA reads the blob itself; an abbreviated one
   * (from a whole diff) only finds bytes already cached.
   */
  blobSha?: string;
  /**
   * Checks bytes found by an abbreviated SHA, which another blob could share. A refused match is read by ref and path.
   */
  verify?: (bytes: Buffer) => boolean;
}
const pending = new WeakMap<Octokit, Map<string, GitHubWork<Buffer>>>();
const MAX_SOURCE_BYTES = 8_000_000;
const validBytes = (value: unknown): value is { base64: string } =>
  isCacheRecord(value) &&
  typeof value.base64 === 'string' &&
  value.base64.length <= Math.ceil(MAX_SOURCE_BYTES / 3) * 4;
const FULL_SHA = /^[a-f\d]{40}$/;
const SHA_PREFIX = /^[a-f\d]{7,40}$/;
/**
 * Index entries group a repository's blobs by their first seven digits, the shortest abbreviation git writes. Git makes
 * an abbreviation unique within its repository, so the index is per repository too.
 */
const INDEX_DIGITS = 7;
const isShaList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((v) => typeof v === 'string' && FULL_SHA.test(v));
const isHint = (value: unknown): value is { blob: string } =>
  isCacheRecord(value) && typeof value.blob === 'string' && FULL_SHA.test(value.blob);

/** Bytes are stored once, under their blob SHA. Path reads at a pinned ref keep only a hint that names the blob. */
export const blobKey = (sha: string) => `git-blob:v1:${sha.toLowerCase()}`;
const indexKey = (repo: string, sha: string) => `git-blob-index:v1:${repo}:${sha.slice(0, INDEX_DIGITS).toLowerCase()}`;
const sourceKey = (source: Source) =>
  `git-source:v2:${JSON.stringify([source.owner, source.repo, source.ref, source.path])}`;

/** Git's object ID for a blob: SHA-1 over `blob <size>\0` and the bytes. */
export const gitBlobSha = (bytes: Buffer) =>
  createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');

// Approach from quarterdeck crates/cache/src/file_text_storage.rs (used with permission): content keyed by blob SHA,
// found by a full SHA or by an abbreviation that only one cached blob starts with. Several matches are ambiguous and
// count as a miss.
async function cachedBlob(cache: GitHubCache | undefined, repo: string, sha: string): Promise<Buffer | undefined> {
  const prefix = sha.toLowerCase();
  if (!cache || !SHA_PREFIX.test(prefix)) return;
  let full = prefix;
  if (!FULL_SHA.test(prefix)) {
    const index = (await cache.getPrepared(indexKey(repo, prefix), isShaList)) ?? [];
    const matches = index.filter((candidate) => candidate.startsWith(prefix));
    if (matches.length !== 1) return;
    full = matches[0];
  }
  const saved = await cache.getPrepared(blobKey(full), validBytes);
  return saved && Buffer.from(saved.base64, 'base64');
}
async function storeBlob(
  cache: GitHubCache | undefined,
  version: number | undefined,
  repo: string,
  sha: string,
  bytes: Buffer
) {
  if (!cache || bytes.length > MAX_SOURCE_BYTES || cache.version() !== version) return false;
  const full = sha.toLowerCase();
  cache.set(blobKey(full), { base64: bytes.toString('base64') });
  const index = (await cache.getPrepared(indexKey(repo, full), isShaList)) ?? [];
  if (!index.includes(full) && cache.version() === version) cache.set(indexKey(repo, full), [...index, full]);
  return true;
}
function bytesOf(data: unknown) {
  return typeof data === 'string'
    ? Buffer.from(data)
    : data instanceof ArrayBuffer
      ? Buffer.from(data)
      : ArrayBuffer.isView(data)
        ? Buffer.from(data.buffer, data.byteOffset, data.byteLength)
        : undefined;
}

/**
 * Share immutable source across PR revisions, pushes, commits, stack views, and explanations. A file with a known
 * full blob SHA is read by that SHA, so a push only downloads the files it changed. Other reads use the ref and path.
 */
export function readGitHubFile(client: Octokit, source: Source, beforeRequest?: () => void): Promise<Buffer> {
  const requested = source.blobSha?.toLowerCase();
  const blobSha = requested && SHA_PREFIX.test(requested) ? requested : undefined;
  const byBlob = blobSha !== undefined && FULL_SHA.test(blobSha);
  const key = byBlob ? blobKey(blobSha) : `${sourceKey(source)}:${blobSha ?? ''}`;
  const immutable = /^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(source.ref);
  const repo = `${source.owner}/${source.repo}`;
  let reads = pending.get(client);
  if (!reads) {
    reads = new Map();
    pending.set(client, reads);
  }
  const existing = reads.get(key);
  if (existing) return joinGitHubWork(existing);
  const work = createGitHubWork(async () => {
    const cache = githubCacheFor(client),
      version = cache?.version();
    if (blobSha) {
      const saved = await cachedBlob(cache, repo, blobSha);
      if (saved && (byBlob || !source.verify || source.verify(saved))) return saved;
    }
    if (byBlob) {
      // Approach from quarterdeck crates/github/src/file_text_requests.rs (used with permission): a full blob SHA is
      // one raw read of the blob. GitHub serves blobs up to 100 MB here; callers keep their own size limits.
      beforeRequest?.();
      const { data } = await client.request('GET /repos/{owner}/{repo}/git/blobs/{file_sha}', {
        owner: source.owner,
        repo: source.repo,
        file_sha: blobSha,
        headers: { accept: 'application/vnd.github.raw+json' },
        request: { responseType: 'arraybuffer', cache: 'no-store' },
      });
      const bytes = bytesOf(data);
      if (!bytes) throw new Error('GitHub did not return file contents. Open the file on GitHub.');
      // Only bytes that hash to the requested SHA may answer later lookups.
      if (gitBlobSha(bytes) === blobSha) await storeBlob(cache, version, repo, blobSha, bytes);
      return bytes;
    }
    if (immutable) {
      const hint = await cache?.getPrepared(sourceKey(source), isHint);
      const saved = hint && (await cachedBlob(cache, repo, hint.blob));
      if (saved) return saved;
    }
    beforeRequest?.();
    const { data, headers } = await client.request('GET /repos/{owner}/{repo}/contents/{path}', {
      owner: source.owner,
      repo: source.repo,
      path: source.path,
      ref: source.ref,
      headers: { accept: 'application/vnd.github.raw+json' },
      request: { responseType: 'arraybuffer', cache: 'no-store' },
    });
    const bytes = bytesOf(data);
    if (!bytes) throw new Error('GitHub did not return file contents. Open the file on GitHub.');
    if (immutable && !/\bno-store\b/i.test(headers['cache-control'] ?? '')) {
      // The bytes go under the blob SHA they hash to. The ref and path keep only that SHA, so nothing is stored twice.
      const sha = gitBlobSha(bytes);
      if (cache && (await storeBlob(cache, version, repo, sha, bytes)) && cache.version() === version)
        cache.set(sourceKey(source), { blob: sha });
    }
    return bytes;
  });
  reads.set(key, work);
  void work.promise
    .finally(() => {
      if (reads.get(key) === work) reads.delete(key);
    })
    .catch(() => {});
  return work.promise;
}
