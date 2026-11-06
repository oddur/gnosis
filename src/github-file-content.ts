import type { Octokit } from '@octokit/rest';
import { githubCacheFor } from '../lib/github-client';
import { isCacheRecord } from '../lib/github-cache';
import { createGitHubWork, joinGitHubWork, type GitHubWork } from '../lib/github-scheduler';

interface Source {
  owner: string;
  repo: string;
  path: string;
  ref: string;
}
const pending = new WeakMap<Octokit, Map<string, GitHubWork<Buffer>>>();
const MAX_SOURCE_BYTES = 8_000_000;
const validSource = (value: unknown): value is { base64: string } =>
  isCacheRecord(value) &&
  typeof value.base64 === 'string' &&
  value.base64.length <= Math.ceil(MAX_SOURCE_BYTES / 3) * 4;

/** Share immutable source across PR revisions, commits, stack views, and explanations. */
export function readGitHubFile(client: Octokit, source: Source, beforeRequest?: () => void): Promise<Buffer> {
  const key = `git-source:v1:${JSON.stringify([source.owner, source.repo, source.ref, source.path])}`;
  const immutable = /^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(source.ref);
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
    const saved = immutable && (await cache?.getPrepared(key, validSource));
    if (saved) return Buffer.from(saved.base64, 'base64');
    beforeRequest?.();
    const { data, headers } = await client.request('GET /repos/{owner}/{repo}/contents/{path}', {
      ...source,
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
            : undefined;
    if (!bytes) throw new Error('GitHub did not return file contents. Open the file on GitHub.');
    if (
      immutable &&
      bytes.length <= MAX_SOURCE_BYTES &&
      cache?.version() === version &&
      !/\bno-store\b/i.test(headers['cache-control'] ?? '')
    )
      cache?.set(key, { base64: bytes.toString('base64') });
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
