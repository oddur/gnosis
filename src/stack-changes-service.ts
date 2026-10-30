import { readError } from '../lib/shared-read';
import { createHash } from 'node:crypto';
import type { Octokit } from '@octokit/rest';
import { githubCacheFor } from '../lib/github-client';
import { isCacheRecord } from '../lib/github-cache';
import { createByteCache } from '../lib/byte-cache';
import { createSharedGitHubRead, githubReadSignal } from '../lib/github-scheduler';
import { compactInventory, INVENTORY_MEMORY_BYTES } from '../lib/inspection-limits';
import { linearStack, stackRevisionKey, stackFileSources } from '../lib/stack-changes';
import { loadInspectionBatch } from '../lib/inspection-batch';
import type { ReviewSubject } from '../lib/workbench';
import type { PrChanges, PrFileRequest } from '../lib/pr-changes';
import { createPrChangesService } from './pr-changes-service';
import { createSnapshotFileLoader } from './snapshot-file-loader';
import { localClones } from '../lib/local-clone';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const storageKey = (key: string) => `stack-changes:v1:${key}`;
const isSnapshot = (v: unknown): v is PrChanges =>
  isCacheRecord(v) &&
  v.version === 1 &&
  isCacheRecord(v.stackComparison) &&
  typeof v.stackComparison.key === 'string' &&
  Array.isArray(v.stackComparison.members) &&
  Array.isArray(v.files) &&
  isCacheRecord(v.metadata);

export function createStackChangesService(prs: Pick<ReturnType<typeof createPrChangesService>, 'manifest'>, clones = localClones) {
  const memory = new WeakMap<Octokit, ReturnType<typeof createByteCache<string, PrChanges>>>();
  const pending = new WeakMap<Octokit, Map<string, ReturnType<typeof createSharedGitHubRead<PrChanges>>>>();
  function cache(client: Octokit) {
    let saved = memory.get(client);
    if (!saved) {
      saved = createByteCache(INVENTORY_MEMORY_BYTES, 50);
      memory.set(client, saved);
    }
    return saved;
  }
  async function read(client: Octokit, subject: ReviewSubject, refresh = false, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const ordered = linearStack(subject);
    const requestKey = hash(stackRevisionKey(subject));
    if (!refresh) {
      const saved =
        cache(client).get(requestKey) ??
        (await githubCacheFor(client)?.getPrepared(storageKey(requestKey), isSnapshot));
      if (saved) {
        cache(client).set(requestKey, saved);
        return saved;
      }
    }
    let jobs = pending.get(client);
    if (!jobs) {
      jobs = new Map();
      pending.set(client, jobs);
    }
    const jobKey = `${requestKey}:${refresh}`;
    const existing = jobs.get(jobKey);
    if (existing && !existing.signal.aborted) return existing.read(signal);
    const job = createSharedGitHubRead(async () => {
      try {
        const signal = githubReadSignal();
        if (!signal) throw new Error('Missing comparison cancellation scope.');
        const store = githubCacheFor(client),
          version = store?.version();
        const sources = new Map<string, PrChanges>();
        let failure: unknown;
        // Coalesces with existing PR preloads; no new copy of every file's contents.
        await loadInspectionBatch(
          ordered,
          (m, signal) => prs.manifest(client, m.url, refresh, { revision: m }, signal),
          (m, result) => {
            if ('value' in result) sources.set(m.url, result.value);
            else failure = result.error;
          },
          signal
        );
        signal.throwIfAborted();
        if (failure) throw readError(failure);
        const snapshots = ordered.map((m) => {
          const source = sources.get(m.url);
          if (!source) throw new Error('A stack member could not be loaded. Review by PR.');
          return source;
        });
        const actual = { ...subject, members: ordered.map((m, i) => ({ ...m, ...snapshots[i].metadata })) };
        linearStack(actual);
        const root = snapshots[0],
          tip = snapshots[snapshots.length - 1];
        const [owner, repo] = (root.metadata.baseRepo ?? '').split('/');
        for (let i = 1; i < snapshots.length; i++) {
          const parent = snapshots[i - 1],
            child = snapshots[i];
          const base =
            (await clones.read(root.metadata.baseRepo, (clone) => clone.mergeBase(parent.metadata.headSha, child.metadata.headSha))) ??
            (await client.repos.compareCommits({
              owner,
              repo,
              base: parent.metadata.headSha,
              head: child.metadata.headSha,
              per_page: 1,
            })).data.merge_base_commit.sha;
          if (base !== parent.metadata.headSha)
            throw new Error(
              `PR #${child.url.split('/').pop()} does not include the current commits from PR #${parent.url.split('/').pop()}. Update its branch or review by PR.`
            );
        }
        const local = await clones.read(root.metadata.baseRepo, (clone) => clone.changes(root.metadata.baseSha, tip.metadata.headSha));
        const data = local
          ? { files: local.files, merge_base_commit: { sha: local.mergeBase } }
          : (await client.repos.compareCommits({
              owner,
              repo,
              base: root.metadata.baseSha,
              head: tip.metadata.headSha,
              per_page: 1,
            })).data;
        if (!data.files) throw new Error('GitHub did not return this comparison’s files. Retry or review by PR.');
        const key = hash(stackRevisionKey(actual));
        const snapshot = compactInventory({
          version: 1,
          url: tip.url,
          metadata: {
            ...tip.metadata,
            title: subject.name ?? subject.title,
            baseSha: root.metadata.baseSha,
            baseBranch: root.metadata.baseBranch,
            baseRepo: root.metadata.baseRepo,
          },
          comparisonBase: data.merge_base_commit.sha,
          fetchedAt: Date.now(),
          stackComparison: {
            key,
            subjectId: subject.id,
            members: snapshots.map((s) => ({ metadata: s.metadata, comparisonBase: s.comparisonBase })),
            fileSources: Object.fromEntries(
              data.files.map((f) => [f.filename, stackFileSources(f.filename, snapshots).map((s) => s.url)])
            ),
            fileSourcePaths: Object.fromEntries(
              data.files.map((f) => [
                f.filename,
                Object.fromEntries(stackFileSources(f.filename, snapshots).map((s) => [s.url, s.path])),
              ])
            ),
          },
          filesTruncated: !local && data.files.length >= 300,
          files: data.files.map((f) => ({
            path: f.filename,
            previousPath: f.previous_filename,
            status:
              f.status === 'removed'
                ? 'deleted'
                : f.status === 'added'
                  ? 'added'
                  : f.status === 'renamed'
                    ? 'renamed'
                    : 'modified',
            additions: f.additions,
            deletions: f.deletions,
            patch: f.patch,
            changeId: hash([f.filename, f.previous_filename, f.status, f.sha, f.patch ?? data.merge_base_commit.sha]),
          })),
        } satisfies PrChanges);
        cache(client).set(key, snapshot);
        if (store?.version() === version) store?.set(storageKey(key), snapshot);
        return snapshot;
      } finally {
        if (jobs.get(jobKey) === job) jobs.delete(jobKey);
      }
    });
    jobs.set(jobKey, job);
    return job.read(signal);
  }
  async function find(client: Octokit, req: PrFileRequest) {
    if (!req.stackComparison || !/^[a-f0-9]{64}$/.test(req.stackComparison))
      throw new Error('Invalid stack comparison.');
    const snapshot =
      cache(client).get(req.stackComparison) ??
      (await githubCacheFor(client)?.getPrepared(storageKey(req.stackComparison), isSnapshot));
    const file = snapshot?.files.find((f) => f.path === req.path);
    if (
      !snapshot ||
      !file ||
      snapshot.url !== req.url ||
      snapshot.metadata.baseSha !== req.baseSha ||
      snapshot.metadata.headSha !== req.headSha
    )
      throw new Error('Reload the combined changes before opening this file.');
    return { snapshot, file };
  }
  const load = createSnapshotFileLoader(undefined, clones);
  return {
    read,
    find,
    content: async (client: Octokit, req: PrFileRequest, guard?: () => void) => {
      const { snapshot, file } = await find(client, req);
      return load(client, req, snapshot, file, guard);
    },
  };
}
