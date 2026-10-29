import { createHash } from 'node:crypto';
import type { Octokit } from '@octokit/rest';
import { githubCacheFor } from './github-client';
import { isCacheRecord } from './github-cache';
import { changesRevision, type PrChanges, type PrFileContents, type PrFileRequest } from './pr-changes';
import type { PrMetadata } from './types';

/** The inspection tabs and guided reviews read the same immutable revision entries. */
export async function preparedChanges(client: Octokit, url: string, revision: Pick<PrMetadata, 'baseSha' | 'headSha'>) {
  return githubCacheFor(client)?.getPrepared(
    `pr-changes:v2:${url}:${changesRevision(revision)}`,
    (value): value is PrChanges =>
      isCacheRecord(value) &&
      value.version === 1 &&
      isCacheRecord(value.metadata) &&
      value.metadata.headSha === revision.headSha &&
      value.metadata.baseSha === revision.baseSha &&
      Array.isArray(value.files) &&
      typeof value.comparisonBase === 'string'
  );
}
export function preparedFileKey(req: PrFileRequest) {
  return `pr-file:v2:${createHash('sha256')
    .update(
      JSON.stringify({
        url: req.url,
        path: req.path,
        baseSha: req.baseSha,
        headSha: req.headSha,
        ...(req.comparison ? { scope: 'commit' } : {}),
        ...(req.stackComparison ? { scope: 'stack', stackComparison: req.stackComparison } : {}),
      })
    )
    .digest('hex')}`;
}
export const preparedFile = async (client: Octokit, req: PrFileRequest) =>
  githubCacheFor(client)?.getPrepared(
    preparedFileKey(req),
    (value): value is PrFileContents =>
      isCacheRecord(value) && isCacheRecord(value.before) && isCacheRecord(value.after)
  );
export const preparedDiffKey = (url: string, revision: Pick<PrMetadata, 'baseSha' | 'headSha'>) =>
  `pr-review-diff:v1:${url}:${changesRevision(revision)}`;
export const preparedDiff = async (client: Octokit, url: string, revision: Pick<PrMetadata, 'baseSha' | 'headSha'>) =>
  githubCacheFor(client)?.getPrepared(preparedDiffKey(url, revision), (value): value is string => typeof value === 'string')
;
