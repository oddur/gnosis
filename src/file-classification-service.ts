import type { Octokit } from '@octokit/rest';
import type { PrChanges, PrChangeFile, PrFileContents } from '../lib/pr-changes';
import { classificationKey, fileSource, generatedHeader, pathFileKinds, type FileKinds } from '../lib/file-kinds';
import { generatedAttribute, type AttributeFile } from '../lib/git-attributes';
import { githubCacheFor } from '../lib/github-client';
import { withGitHubPriority } from '../lib/github-scheduler';
interface RecordValue {
  version: 1;
  kinds: Record<string, FileKinds>;
  headers: Record<string, boolean>;
  declared: Record<string, boolean>;
  complete?: boolean;
}
const valid = (v: unknown): v is RecordValue =>
  !!v &&
  typeof v === 'object' &&
  (v as Partial<RecordValue>).version === 1 &&
  !!(v as Partial<RecordValue>).kinds &&
  !!(v as Partial<RecordValue>).headers &&
  !!(v as Partial<RecordValue>).declared;
const attributePaths = (path: string) => [
  '.gitattributes',
  ...path
    .split('/')
    .slice(0, -1)
    .map((_, i, all) => all.slice(0, i + 1).join('/') + '/.gitattributes'),
];
/** Revision-pinned evidence; one background batch at a time, sharing the authenticated API scheduler. */
export function createFileClassificationService(
  notify: (key: string, kinds: Record<string, FileKinds>) => void = () => {}
) {
  const clients = new WeakMap<
    Octokit,
    {
      records: Map<string, Promise<RecordValue>>;
      jobs: Map<string, () => Promise<void>>;
      running: boolean;
      retry: Map<string, number>;
    }
  >();
  function state(client: Octokit) {
    let s = clients.get(client);
    if (!s) {
      s = { records: new Map(), jobs: new Map(), running: false, retry: new Map() };
      clients.set(client, s);
    }
    return s;
  }
  const storageKey = (s: PrChanges) => 'file-kinds:v1:' + classificationKey(s);
  async function record(client: Octokit, snapshot: PrChanges) {
    const s = state(client),
      key = storageKey(snapshot);
    let value = s.records.get(key);
    if (!value) {
      value = (async () =>
        (await githubCacheFor(client)?.getPrepared(key, valid)) ?? {
          version: 1 as const,
          kinds: {},
          headers: {},
          declared: {},
        })();
      s.records.set(key, value);
      while (s.records.size > 150) {
        const oldest = s.records.keys().next().value;
        if (oldest === undefined) break;
        s.records.delete(oldest);
      }
    }
    return value;
  }
  function save(client: Octokit, snapshot: PrChanges, value: RecordValue, version: number | undefined) {
    const cache = githubCacheFor(client);
    if (cache?.version() !== version) return;
    cache?.set(storageKey(snapshot), value);
    notify(classificationKey(snapshot), value.kinds);
  }
  async function attributes(client: Octokit, repoName: string, ref: string, paths: string[]): Promise<AttributeFile[]> {
    const cache = githubCacheFor(client),
      version = cache?.version();
    const found: AttributeFile[] = [];
    const missing: string[] = [];
    for (const path of paths) {
      const known = await cache?.getPrepared(
        `attributes:v1:${repoName}:${ref}:${path}`,
        (v): v is { text: string } => !!v && typeof v === 'object' && typeof (v as { text?: unknown }).text === 'string'
      );
      if (known) found.push({ path, text: known.text });
      else missing.push(path);
    }
    const [owner, name] = repoName.split('/');
    for (let i = 0; i < missing.length; i += 32) {
      const batch = missing.slice(i, i + 32);
      const fields = batch
        .map((p, j) => `a${j}: object(expression:${JSON.stringify(ref + ':' + p)}) { ... on Blob { text byteSize } }`)
        .join('\n');
      const response = await client.graphql<{
        repository: Record<string, { text: string | null; byteSize: number } | null> | null;
      }>(`query($owner:String!,$name:String!){repository(owner:$owner,name:$name){${fields}}}`, { owner, name });
      if (!response.repository) throw Error('Repository attributes are unavailable');
      for (const [j, path] of batch.entries()) {
        const blob = response.repository[`a${j}`];
        if (blob && (blob.byteSize > 256_000 || blob.text === null))
          throw Error('Repository attributes are too large to inspect');
        const text = blob?.text ?? '';
        found.push({ path, text });
        if (cache?.version() === version) cache?.set(`attributes:v1:${repoName}:${ref}:${path}`, { text });
      }
    }
    return found;
  }
  async function drain(client: Octokit) {
    const s = state(client);
    if (s.running) return;
    s.running = true;
    try {
      while (s.jobs.size) {
        const next = s.jobs.entries().next().value;
        if (!next) break;
        const [key, job] = next;
        s.jobs.delete(key);
        try {
          await withGitHubPriority('background', job);
        } catch {
          s.retry.set(key, Date.now() + 60_000);
        }
      }
    } finally {
      s.running = false;
    }
  }
  function prepare(client: Octokit, snapshot: PrChanges, value: RecordValue) {
    const s = state(client),
      key = storageKey(snapshot);
    if (value.complete || s.jobs.has(key) || (s.retry.get(key) ?? 0) > Date.now()) return;
    // Mark the active job as pending too, so foreground reads do not enqueue duplicates.
    s.retry.set(key, Infinity);
    s.jobs.set(key, async () => {
      const version = githubCacheFor(client)?.version();
      const groups = new Map<string, { repo: string; ref: string; files: PrChangeFile[] }>();
      for (const file of snapshot.files) {
        const source = fileSource(snapshot, file),
          id = JSON.stringify([source.repo, source.ref]);
        const group = groups.get(id) ?? { ...source, files: [] };
        group.files.push(file);
        groups.set(id, group);
      }
      for (const group of groups.values()) {
        const attrs = await attributes(client, group.repo, group.ref, [
          ...new Set(group.files.flatMap((f) => attributePaths(f.path))),
        ]);
        for (const file of group.files) {
          const kinds = pathFileKinds(file.path),
            declaration = generatedAttribute(file.path, attrs);
          if (declaration) {
            kinds.generated = declaration;
            value.declared[file.path] = true;
          } else if (value.headers[file.path]) kinds.generated = { value: true, reason: 'Generated-code header' };
          value.kinds[file.path] = kinds;
        }
      }
      value.complete = true;
      s.retry.delete(key);
      save(client, snapshot, value, version);
    });
    void drain(client);
  }
  return {
    async read(client: Octokit, snapshot: PrChanges) {
      const value = await record(client, snapshot);
      prepare(client, snapshot, value);
      return Object.fromEntries(snapshot.files.map((f) => [f.path, value.kinds[f.path] ?? pathFileKinds(f.path)]));
    },
    async observe(client: Octokit, snapshot: PrChanges, file: PrChangeFile, contents: PrFileContents) {
      const side = file.status === 'deleted' ? contents.before : contents.after;
      if (side.kind !== 'text' || !generatedHeader(side.content)) return;
      const version = githubCacheFor(client)?.version(),
        value = await record(client, snapshot);
      if (value.headers[file.path]) return;
      value.headers[file.path] = true;
      if (!value.declared[file.path])
        value.kinds[file.path] = {
          ...pathFileKinds(file.path),
          generated: { value: true, reason: 'Generated-code header' },
        };
      save(client, snapshot, value, version);
    },
  };
}
let listener: (key: string, kinds: Record<string, FileKinds>) => void = () => {};
export const fileClassifications = createFileClassificationService((key, kinds) => listener(key, kinds));
export const onClassificationUpdate = (callback: (key: string, kinds: Record<string, FileKinds>) => void) => {
  listener = callback;
};
