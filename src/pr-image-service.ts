import type { Octokit } from '@octokit/rest';
import { isGitHubImageUrl } from '../lib/github-image';

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_CACHE_BYTES = 24 * 1024 * 1024;

/** On-demand authenticated fallback. Account isolation follows the shared client. */
export function createPrImageService() {
  const accounts = new WeakMap<
    Octokit,
    {
      images: Map<string, string>;
      pending: Map<string, Promise<string>>;
      bytes: number;
    }
  >();
  return async (client: Octokit, url: string): Promise<string> => {
    if (!isGitHubImageUrl(url)) throw new Error('This is not a supported GitHub image URL.');
    let cache = accounts.get(client);
    if (!cache) {
      cache = { images: new Map(), pending: new Map(), bytes: 0 };
      accounts.set(client, cache);
    }
    const saved = cache.images.get(url);
    if (saved) return saved;
    const pending = cache.pending.get(url);
    if (pending) return pending;
    const load = (async () => {
      // The shared client supplies authentication, request spacing and rate-limit backoff.
      const response = await client.request({
        method: 'GET',
        url,
        headers: { accept: 'application/octet-stream' },
        request: { cache: 'no-store' },
      });
      const type = response.headers['content-type']?.split(';')[0].toLowerCase();
      if (!type || !/^image\/(?:png|jpeg|gif|webp|avif|svg\+xml)$/.test(type))
        throw new Error('GitHub did not return a supported image.');
      const data: unknown = response.data;
      const bytes =
        typeof data === 'string'
          ? Buffer.from(data)
          : data instanceof ArrayBuffer
            ? Buffer.from(data)
            : ArrayBuffer.isView(data)
              ? Buffer.from(data.buffer, data.byteOffset, data.byteLength)
              : undefined;
      if (!bytes || bytes.length > MAX_IMAGE_BYTES) throw new Error('This image is too large to display here.');
      const image = `data:${type};base64,${bytes.toString('base64')}`;
      while (cache.images.size && (cache.bytes + image.length > MAX_CACHE_BYTES || cache.images.size >= 40)) {
        const oldest = cache.images.entries().next().value;
        if (!oldest) break;
        cache.bytes -= oldest[1].length;
        cache.images.delete(oldest[0]);
      }
      cache.images.set(url, image);
      cache.bytes += image.length;
      return image;
    })();
    cache.pending.set(url, load);
    try {
      return await load;
    } finally {
      cache.pending.delete(url);
    }
  };
}
