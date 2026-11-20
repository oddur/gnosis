import type { Octokit } from '@octokit/rest';

/** A synthetic repository at one ref, served through the REST contents API and through GraphQL `object(expression:)`. */
export interface FakeFile {
  text: string;
  /** GraphQL reports the blob as binary and gives no text; REST still returns the bytes. */
  binary?: boolean;
  /** GraphQL reports the text as truncated. */
  truncated?: boolean;
  mode?: number;
}

export function fakeRepo(files: Record<string, string | FakeFile>, ref = 'ref') {
  const all = new Map(Object.entries(files).map(([path, f]) => [path, typeof f === 'string' ? { text: f } : f]));
  const counts = { graphql: 0, getContent: 0, contentPaths: [] as string[] };
  const isDir = (path: string) => [...all.keys()].some((p) => p.startsWith(path + '/'));
  const children = (dir: string) => {
    const names = new Set<string>();
    for (const p of all.keys()) if (p.startsWith(dir + '/')) names.add(p.slice(dir.length + 1).split('/')[0]);
    return [...names].sort().map((name) => `${dir}/${name}`);
  };
  const blob = (f: FakeFile) => ({
    __typename: 'Blob',
    text: f.binary ? null : f.truncated ? f.text.slice(0, 1) : f.text,
    byteSize: Buffer.byteLength(f.text),
    isBinary: !!f.binary,
    isTruncated: !!f.truncated,
  });
  const node = (path: string, depth: number): unknown => {
    const file = all.get(path);
    if (file) return blob(file);
    if (!isDir(path)) return null;
    return {
      __typename: 'Tree',
      entries: children(path).map((child) => ({
        path: child,
        type: all.has(child) ? 'blob' : 'tree',
        mode: all.get(child)?.mode ?? (all.has(child) ? 0o100644 : 0o040000),
        ...(depth > 0 ? { object: node(child, depth - 1) } : {}),
      })),
    };
  };
  const octokit = {
    graphql: (query: string) => {
      counts.graphql++;
      const repository: Record<string, unknown> = {};
      for (const [, alias, expression] of query.matchAll(/(\w+): object\(expression:("(?:[^"\\]|\\.)*")\)/g)) {
        const [at, ...rest] = (JSON.parse(expression) as string).split(':');
        const path = rest.join(':');
        repository[alias] = at === ref ? node(path, 2) : null;
      }
      return Promise.resolve({ rateLimit: { cost: 1 }, repository });
    },
    repos: {
      getContent: ({ path, ref: at }: { path: string; ref: string }) => {
        counts.getContent++;
        counts.contentPaths.push(path);
        const file = all.get(path);
        if (at === ref && file) return Promise.resolve({ data: { type: 'file', path, content: Buffer.from(file.text).toString('base64') } });
        if (at === ref && isDir(path))
          return Promise.resolve({ data: children(path).map((p) => ({ path: p, type: all.has(p) ? 'file' : 'dir' })) });
        return Promise.reject(Object.assign(new Error('Not Found'), { status: 404 }));
      },
    },
  };
  return { octokit: octokit as unknown as Octokit, counts };
}
