import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import type { Octokit } from '@octokit/rest';
import { createGitHubWork, joinGitHubWork, type GitHubWork } from '../lib/github-scheduler';
import type { LfsPointer } from '../lib/git-lfs';

export const MAX_LFS_PREVIEW_BYTES = 8 * 1024 * 1024;
function verify(bytes: Buffer, pointer: LfsPointer) {
  if (bytes.length !== pointer.size || createHash('sha256').update(bytes).digest('hex') !== pointer.oid)
    throw new Error('The download does not match this Git LFS revision. Try downloading again.');
  return bytes;
}
function validate(pointer: LfsPointer) {
  if (!/^[a-f0-9]{64}$/.test(pointer.oid) || !Number.isSafeInteger(pointer.size) || pointer.size < 0)
    throw new Error('Invalid Git LFS pointer.');
  if (pointer.size > MAX_LFS_PREVIEW_BYTES)
    throw new Error('This Git LFS resource exceeds the 8 MB preview limit. Open it on GitHub or in your checkout.');
}
function trustedDownload(value: string) {
  const url = new URL(value);
  return (
    url.protocol === 'https:' &&
    !url.username &&
    !url.password &&
    !url.port &&
    (url.hostname === 'github.com' ||
      url.hostname.endsWith('.githubusercontent.com') ||
      /^github-cloud\.s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com$/.test(url.hostname))
  );
}

/** Explicit, bounded downloads, with account-scoped reuse by immutable object identity. */
export function createLfsService(fetchObject: typeof fetch = fetch) {
  function scope() {
    const values = new Map<string, Buffer>();
    const pending = new Map<string, GitHubWork<Buffer>>();
    let size = 0;
    return {
      peek: (key: string) => values.get(key),
      read(key: string, load: () => Promise<Buffer>) {
        const saved = values.get(key);
        if (saved) return Promise.resolve(saved);
        const running = pending.get(key);
        if (running) return joinGitHubWork(running);
        const job = createGitHubWork(async () => {
          try {
            const bytes = await load();
            while (values.size && (size + bytes.length > 32 * 1024 * 1024 || values.size >= 64)) {
              const oldest = values.entries().next().value;
              if (!oldest) break;
              values.delete(oldest[0]);
              size -= oldest[1].length;
            }
            values.set(key, bytes);
            size += bytes.length;
            return bytes;
          } finally {
            pending.delete(key);
          }
        });
        pending.set(key, job);
        return job.promise;
      },
    };
  }
  const accounts = new WeakMap<Octokit, ReturnType<typeof scope>>();
  const local = scope();
  const account = (client: Octokit) => {
    let value = accounts.get(client);
    if (!value) {
      value = scope();
      accounts.set(client, value);
    }
    return value;
  };
  return {
    async remote(client: Octokit, repo: string, pointer: LfsPointer, download: boolean) {
      const key = `${repo}:${pointer.oid}:${pointer.size}`;
      const saved = account(client).peek(key);
      if (saved || !download) return saved;
      validate(pointer);
      if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('Invalid Git LFS repository.');
      return account(client).read(key, async () => {
        const auth = (await client.auth()) as { token?: string };
        const transport = (client.request.endpoint.DEFAULTS.request?.fetch as typeof fetch | undefined) ?? fetch;
        const authorization = auth.token
          ? `Basic ${Buffer.from(`x-access-token:${auth.token}`).toString('base64')}`
          : undefined;
        const batchResponse = await client.request({
          method: 'POST',
          url: `https://github.com/${repo}.git/info/lfs/objects/batch`,
          headers: {
            accept: 'application/vnd.git-lfs+json',
            'content-type': 'application/vnd.git-lfs+json',
            ...(auth.token
              ? { authorization: `Basic ${Buffer.from(`x-access-token:${auth.token}`).toString('base64')}` }
              : {}),
          },
          data: { operation: 'download', transfers: ['basic'], objects: [pointer] },
          request: {
            cache: 'no-store',
            signal: AbortSignal.timeout(30_000),
            // Octokit's token hook replaces Authorization. LFS uses HTTP Basic;
            // apply it at the transport boundary after the shared scheduler/hooks.
            fetch: (input: string | URL | Request, init?: RequestInit) => {
              const headers = new Headers(init?.headers);
              if (authorization) headers.set('authorization', authorization);
              return transport(input, { ...init, headers });
            },
          },
        });
        const data: unknown = batchResponse.data;
        // Octokit does not decode application/vnd.git-lfs+json as JSON.
        const payload: unknown =
          data instanceof ArrayBuffer
            ? JSON.parse(Buffer.from(data).toString('utf8'))
            : typeof data === 'string'
              ? JSON.parse(data)
              : data;
        const object = (
          payload as {
            objects?: {
              oid: string;
              size: number;
              error?: unknown;
              actions?: { download?: { href: string; header?: Record<string, string> } };
            }[];
          }
        ).objects?.find((o) => o.oid === pointer.oid);
        const action = object?.actions?.download;
        if (!object || object.size !== pointer.size || object.error || !action)
          throw new Error(
            'This Git LFS object is unavailable. Check repository access and LFS storage on GitHub, then retry.'
          );
        if (!trustedDownload(action.href)) throw new Error('GitHub returned an unsupported Git LFS download location.');
        // Only the batch action's scoped headers go to object storage, never the GitHub token.
        const response = await fetchObject(action.href, {
          headers: action.header,
          redirect: 'error',
          signal: AbortSignal.timeout(60_000),
        });
        if (!response.ok || !response.body) throw new Error('The Git LFS download failed. Try again.');
        const reader = response.body.getReader(),
          chunks: Uint8Array[] = [];
        let length = 0;
        try {
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- stream ends on done
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            length += value.length;
            if (length > pointer.size || length > MAX_LFS_PREVIEW_BYTES)
              throw new Error('The Git LFS download is larger than expected.');
            chunks.push(value);
          }
        } finally {
          await reader.cancel();
        }
        return verify(Buffer.concat(chunks), pointer);
      });
    },
    async local(repoPath: string, pointer: LfsPointer, download: boolean) {
      const key = `${repoPath}:${pointer.oid}:${pointer.size}`;
      const saved = local.peek(key);
      if (saved || !download) return saved;
      validate(pointer);
      return local.read(key, async () => {
        // Smudge only the selected pointer to stdout; leave the working tree untouched.
        const bytes = await new Promise<Buffer>((resolve, reject) => {
          const child = execFile(
            'git',
            ['-c', 'lfs.skipdownloaderrors=false', 'lfs', 'smudge'],
            {
              cwd: repoPath,
              timeout: 60_000,
              maxBuffer: MAX_LFS_PREVIEW_BYTES,
              encoding: 'buffer',
              env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '0' },
            },
            (error, stdout) =>
              error
                ? reject(
                    new Error(
                      'Could not download Git LFS content. Install Git LFS and check access to this checkout’s remote, then retry.'
                    )
                  )
                : resolve(stdout)
          );
          child.stdin?.on('error', () => {});
          child.stdin?.end(
            `version https://git-lfs.github.com/spec/v1\noid sha256:${pointer.oid}\nsize ${pointer.size}\n`
          );
        });
        return verify(bytes, pointer);
      });
    },
  };
}
export const lfsResources = createLfsService();
