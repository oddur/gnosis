import { fileClassifications } from './file-classification-service';
import { createGitHubWork, joinGitHubWork, type GitHubWork } from '../lib/github-scheduler';
import { createHash } from 'node:crypto';
import { preparedFileKey } from '../lib/prepared-pr';
import type { Octokit } from '@octokit/rest';
import { parsePrUrl } from '../lib/github';
import { githubCacheFor } from '../lib/github-client';
import { isCacheRecord } from '../lib/github-cache';
import { parseLfsPointer } from '../lib/git-lfs';
import { lfsResources } from './git-lfs-service';
import { localClones } from '../lib/local-clone';
import { imageMimeType } from '../lib/review-images';
import type { PrChanges, PrChangeFile, PrFileRequest, PrFileContents, PrFileSide } from '../lib/pr-changes';
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function createSnapshotFileLoader(lfs = lfsResources, clones = localClones) {
  const pending = new WeakMap<Octokit, Map<string, GitHubWork<PrFileContents>>>();
  return async (
    client: Octokit,
    req: PrFileRequest,
    snapshot: PrChanges,
    file: PrChangeFile,
    beforeRequest?: () => void
  ): Promise<PrFileContents> => {
    const identity = {
      url: req.url,
      path: req.path,
      downloadLfs: !!req.downloadLfs,
      baseSha: req.baseSha,
      headSha: req.headSha,
      ...(req.comparison ? { scope: 'commit' } : {}),
      ...(req.stackComparison ? { scope: 'stack', stackComparison: req.stackComparison } : {}),
    };
    const key = hash(identity);
    let work = pending.get(client);
    if (!work) {
      work = new Map();
      pending.set(client, work);
    }
    const existing = work.get(key);
    if (existing) return joinGitHubWork(existing);
    const job = createGitHubWork(() =>
      (async () => {
        const cache = githubCacheFor(client),
          version = cache?.version();
        const key = preparedFileKey(req);
        const savedValue = await cache?.getPrepared(key,
          (v): v is PrFileContents => isCacheRecord(v) && isCacheRecord(v.before) && isCacheRecord(v.after));
        const saved = savedValue ? { value: savedValue } : undefined;
        if (saved && (!req.downloadLfs || ![saved.value.before, saved.value.after].some((s) => s.kind === 'lfs')))
          { void fileClassifications.observe(client,snapshot,file,saved.value).catch(() => {}); return saved.value; }
        const lfsSides = new Set<boolean>();
        async function side(before: boolean): Promise<PrFileSide> {
          if ((before && file.status === 'added') || (!before && file.status === 'deleted')) return { kind: 'absent' };
          const path = before ? (file.previousPath ?? file.path) : file.path;
          const repoName =
            (before ? snapshot.metadata.baseRepo : snapshot.metadata.headRepo) ??
            `${parsePrUrl(req.url).owner}/${parsePrUrl(req.url).repo}`;
          const [owner, repo] = repoName.split('/');
          const ref = before ? snapshot.comparisonBase : snapshot.metadata.headSha;
          const savedSide = before ? saved?.value.before : saved?.value.after;
          if (savedSide && savedSide.kind !== 'lfs') return savedSide;
          let bytes: Buffer | undefined;
          let pointer = savedSide?.pointer;
          if (!pointer) {
            // Forks too: the base repository can fetch a PR's head commits by SHA.
            const { owner: baseOwner, repo: baseRepo } = parsePrUrl(req.url);
            bytes = (await clones.read(`${baseOwner}/${baseRepo}`, (clone) => clone.blob(ref, path))) ?? undefined;
          }
          if (!pointer && !bytes) {
            beforeRequest?.();
            const { data } = await client.request('GET /repos/{owner}/{repo}/contents/{path}', {
              owner,
              repo,
              path,
              ref,
              headers: { accept: 'application/vnd.github.raw+json' },
              request: { responseType: 'arraybuffer', cache: 'no-store' },
            });
            bytes =
              typeof data === 'string'
                ? Buffer.from(data)
                : data instanceof ArrayBuffer
                  ? Buffer.from(data)
                  : ArrayBuffer.isView(data)
                    ? Buffer.from(data.buffer, data.byteOffset, data.byteLength)
                    : undefined;
            if (!bytes) throw new Error('GitHub did not return file contents. Open the file on GitHub.');
          }
          if (!pointer && bytes) pointer = parseLfsPointer(bytes.toString('utf8'));
          if (pointer) {
            lfsSides.add(before);
            const resource = await lfs.remote(client, repoName, pointer, req.downloadLfs === true);
            if (!resource) return { kind: 'lfs', pointer };
            bytes = resource;
          }
          if (!bytes) throw new Error('This resource could not be read. Retry the download.');
          const mime = imageMimeType(path);
          if (bytes.length > (pointer ? 8 * 1024 * 1024 : mime ? 8_000_000 : 1_000_000))
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
        const result = { before, after, ...(lfsSides.size ? { lfs: true } : {}) };
        if (cache?.version() === version) {
          const current = cache?.get(
            key,
            (v): v is PrFileContents => isCacheRecord(v) && isCacheRecord(v.before) && isCacheRecord(v.after)
          )?.value;
          if (
            current?.lfs &&
            ![current.before, current.after].some((s) => s.kind === 'lfs') &&
            [result.before, result.after].some((s) => s.kind === 'lfs')
          )
            return current;
          cache?.set(key, result);
        }
        void fileClassifications.observe(client,snapshot,file,result).catch(() => {});
        return result;
      })().finally(() => work.delete(key))
    );
    work.set(key, job);
    return job.promise;
  };
}
