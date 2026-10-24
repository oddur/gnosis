import { createHash } from 'node:crypto';
import type { Octokit } from '@octokit/rest';
import { githubCacheFor } from './github-client';
import { isCacheRecord } from './github-cache';
import { changesRevision, type PrChanges, type PrFileContents, type PrFileRequest } from './pr-changes';
import type { PrMetadata } from './types';

/** The inspection tabs and guided reviews read the same immutable revision entries. */
export function preparedChanges(client: Octokit, url: string, revision: Pick<PrMetadata, 'baseSha' | 'headSha'>) {
  return githubCacheFor(client)?.get(
    `pr-changes:v2:${url}:${changesRevision(revision)}`,
    (value): value is PrChanges =>
      isCacheRecord(value) &&
      value.version === 1 &&
      isCacheRecord(value.metadata) &&
      value.metadata.headSha === revision.headSha &&
      value.metadata.baseSha === revision.baseSha &&
      Array.isArray(value.files) &&
      typeof value.comparisonBase === 'string'
  )?.value;
}
export function preparedFileKey(req: PrFileRequest) {
  return `pr-file:v1:${createHash('sha256')
    .update(
      JSON.stringify({
        url: req.url,
        path: req.path,
        baseSha: req.baseSha,
        headSha: req.headSha,
        ...(req.comparison ? { scope: 'commit' } : {}),
      })
    )
    .digest('hex')}`;
}
export const preparedFile = (client: Octokit, req: PrFileRequest) =>
  githubCacheFor(client)?.get(
    preparedFileKey(req),
    (value): value is PrFileContents =>
      isCacheRecord(value) && isCacheRecord(value.before) && isCacheRecord(value.after)
  )?.value;
export const preparedDiffKey = (url: string, revision: Pick<PrMetadata, 'baseSha' | 'headSha'>) =>
  `pr-review-diff:v1:${url}:${changesRevision(revision)}`;
export const preparedDiff = (client: Octokit, url: string, revision: Pick<PrMetadata, 'baseSha' | 'headSha'>) =>
  githubCacheFor(client)?.get(preparedDiffKey(url, revision), (value): value is string => typeof value === 'string')
    ?.value;
