import { parseLfsPointer } from '../lib/git-lfs';
import { lfsResources } from './git-lfs-service';
import type { Octokit } from '@octokit/rest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  imageMimeType,
  isLfsReviewFile,
  reviewImageFiles,
  type ReviewImageComparison,
  type ReviewImageSide,
} from '../lib/review-images';
import type { ReviewGuide } from '../lib/types';
import { sourceForPath } from '../lib/workbench';
import { parsePrUrl } from '../lib/github';
import { parseLocalUrl } from '../lib/localGit';

const execFileAsync = promisify(execFile);
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_CACHE_BYTES = 32 * 1024 * 1024;
const shaPattern = /^[a-f0-9]{40,64}$/i;

function cache() {
  const values = new Map<string, string>();
  const pending = new Map<string, Promise<string>>();
  let bytes = 0;
  return async (key: string, load: () => Promise<string>): Promise<string> => {
    const saved = values.get(key);
    if (saved !== undefined) return saved;
    const running = pending.get(key);
    if (running) return running;
    const promise = load().then((value) => {
      while (values.size && (values.size >= 100 || bytes + value.length > MAX_CACHE_BYTES)) {
        const oldest = values.entries().next().value;
        if (!oldest) break;
        bytes -= oldest[1].length;
        values.delete(oldest[0]);
      }
      values.set(key, value);
      bytes += value.length;
      return value;
    });
    pending.set(key, promise);
    try {
      return await promise;
    } finally {
      pending.delete(key);
    }
  };
}
function validPath(value: string) {
  return (
    value.length > 0 &&
    !value.startsWith('/') &&
    !value.includes('\\') &&
    !value.includes('\0') &&
    !value.split('/').some((part) => part === '..' || part === '.')
  );
}
function dataUrl(data: unknown, mime: string) {
  const bytes =
    typeof data === 'string'
      ? Buffer.from(data)
      : data instanceof ArrayBuffer
        ? Buffer.from(data)
        : ArrayBuffer.isView(data)
          ? Buffer.from(data.buffer, data.byteOffset, data.byteLength)
          : null;
  if (!bytes) throw new Error('The file could not be read as an image.');
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error('This image exceeds the 8 MB preview limit.');
  // SVG stays an image resource, never HTML inserted into the renderer document.
  return `data:${mime};base64,${bytes.toString('base64')}`;
}

/** Immutable revision reads, coalesced and bounded separately for each GitHub account. */
export function createReviewImageService(io: {
  loadReview: (id: string) => Promise<ReviewGuide> | ReviewGuide;
  client: () => Octokit;
  allowLocal?: (id: string) => boolean;
  lfs?: typeof lfsResources;
}) {
  const accounts = new WeakMap<Octokit, ReturnType<typeof cache>>();
  const localCache = cache();
  return async (reviewId: string, filePath: string, downloadLfs = false): Promise<ReviewImageComparison> => {
    if (typeof reviewId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(reviewId)) throw new Error('Invalid review ID.');
    const review = await io.loadReview(reviewId);
    const file = review.changedFiles?.find((f) => f.filename === filePath);
    if (!file || (!reviewImageFiles(review).includes(filePath) && !isLfsReviewFile(review, filePath)))
      throw new Error('This image is not part of the saved review.');
    const source = sourceForPath(review, filePath);
    if (review.snapshot?.subject.members.length && !source.member)
      throw new Error('The source PR for this image is unavailable.');
    const url = source.member?.url ?? review.prUrl;
    const local = url.startsWith('local:');
    if (local && io.allowLocal && !io.allowLocal(reviewId))
      throw new Error('Local image files are unavailable for imported reviews.');
    const client = local ? undefined : io.client();
    if (client && !accounts.has(client)) accounts.set(client, cache());
    const cached = client ? (accounts.get(client) ?? localCache) : localCache;
    const head = source.member?.headSha ?? review.headSha;
    const base = source.member?.baseSha ?? review.baseSha;
    const localSource = local ? parseLocalUrl(url) : undefined;
    const pr = local ? undefined : parsePrUrl(url);
    const baseRepo = source.member?.baseRepo ?? review.baseRepo ?? (pr && `${pr.owner}/${pr.repo}`);
    const headRepo = source.member?.headRepo ?? review.headRepo ?? baseRepo;
    const mergeBase = () =>
      cached(JSON.stringify(['merge-base', localSource?.repoPath ?? baseRepo, base, head]), async () => {
        if (!base || !head || !shaPattern.test(base) || !shaPattern.test(head))
          throw new Error(
            'This saved review has no pinned base revision. Regenerate it to compare the previous image.'
          );
        if (localSource) {
          const { stdout } = await execFileAsync('git', ['merge-base', base, head], { cwd: localSource.repoPath });
          return stdout.trim();
        }
        if (!baseRepo || !client) throw new Error('The source repository is unavailable.');
        const [owner, repo] = baseRepo.split('/');
        const { data } = await client.repos.compareCommits({ owner, repo, base, head });
        return data.merge_base_commit.sha;
      });
    const metadata = file;
    async function side(before: boolean): Promise<ReviewImageSide> {
      if ((before && metadata.status === 'added') || (!before && metadata.status === 'deleted'))
        return { status: 'absent' };
      try {
        if (before && metadata.status === 'renamed' && !metadata.previousFilename)
          throw new Error('The previous filename was not saved. Regenerate this review to compare the renamed image.');
        const imagePath =
          before && metadata.previousFilename ? sourceForPath(review, metadata.previousFilename).path : source.path;
        if (!validPath(imagePath)) throw new Error('The saved image path is invalid.');
        const mime = imageMimeType(imagePath);
        const revision = before ? await mergeBase() : head;
        if (!revision || !shaPattern.test(revision))
          throw new Error('This saved review has no pinned image revision. Regenerate it to view the image.');
        const repoName = before ? baseRepo : headRepo;
        const image = await cached(
          JSON.stringify(['image', localSource?.repoPath ?? repoName, revision, imagePath]),
          async () => {
            if (localSource) {
              const { stdout } = await execFileAsync('git', ['show', `${revision}:${imagePath}`], {
                cwd: localSource.repoPath,
                encoding: 'buffer',
                maxBuffer: MAX_IMAGE_BYTES,
                env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
              });
              return dataUrl(stdout, mime ?? 'application/octet-stream');
            }
            if (!repoName || !client) throw new Error('The source repository is unavailable.');
            const [owner, repo] = repoName.split('/');
            const response = await client.request('GET /repos/{owner}/{repo}/contents/{path}', {
              owner,
              repo,
              path: imagePath,
              ref: revision,
              headers: { accept: 'application/vnd.github.raw+json' },
              request: { cache: 'no-store', responseType: 'arraybuffer' },
            });
            return dataUrl(response.data, mime ?? 'application/octet-stream');
          }
        );
        const raw = Buffer.from(image.slice(image.indexOf(',') + 1), 'base64');
        const ready = (bytes: Buffer): ReviewImageSide => {
          if (mime) return { status: 'ready', dataUrl: dataUrl(bytes, mime), path: imagePath, revision };
          if (bytes.includes(0)) throw new Error('This binary resource has no preview. Open it in your checkout.');
          try {
            return {
              status: 'text',
              content: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
              path: imagePath,
              revision,
            };
          } catch {
            throw new Error('This resource is not UTF-8 text. Open it in your checkout.');
          }
        };
        const pointer = parseLfsPointer(raw.toString('utf8'));
        if (pointer) {
          try {
            const resource = localSource
              ? await (io.lfs ?? lfsResources).local(localSource.repoPath, pointer, downloadLfs)
              : client && repoName
                ? await (io.lfs ?? lfsResources).remote(client, repoName, pointer, downloadLfs)
                : undefined;
            if (resource) return ready(resource);
            return { status: 'lfs', pointer, path: imagePath, revision };
          } catch (error) {
            return {
              status: 'lfs',
              pointer,
              path: imagePath,
              revision,
              error: error instanceof Error ? error.message : 'Could not download this Git LFS resource.',
            };
          }
        }
        return ready(raw);
      } catch (error) {
        const status = (error as { status?: number }).status;
        return {
          status: 'error',
          message:
            status === 404
              ? 'This image revision is unavailable, or your account cannot access it.'
              : error instanceof Error
                ? error.message
                : 'Could not load this image revision.',
        };
      }
    }
    const [before, after] = await Promise.all([side(true), side(false)]);
    return { before, after };
  };
}
