import type { Octokit } from '@octokit/rest';
import { chunked, mapBounded } from './bounded';
import { githubRateLimit } from './github-client';

/**
 * An aliased GraphQL answer. GitHub answers a query whose aliases partly fail with the data it has and an `errors`
 * list whose paths name the failed fields; those fields are null. `failed` says whether an error sits at or under a
 * path, so a caller trusts only the aliases without one.
 */
export interface AliasedAnswer<T> {
  data: T;
  /** True when GitHub reported an error at or under this path, such as `('p3')` or `('repository', 'f0')`. */
  failed: (...path: (string | number)[]) => boolean;
  /** The first error at or under this path, as an Error. */
  error: (...path: (string | number)[]) => Error | undefined;
  /** Every error's path; empty for a complete answer. */
  errorPaths: (string | number)[][];
  /** True when the only errors at or under this path are GitHub's NOT_FOUND exactly at it, as for a missing PR. */
  notFound: (...path: (string | number)[]) => boolean;
}
type GraphError = { message?: string; type?: string; path?: (string | number)[] };
const under = (path: readonly (string | number)[], prefix: readonly (string | number)[]) =>
  prefix.every((key, i) => path[i] === key);

/**
 * Runs an aliased query and keeps a partial answer. Throws when GitHub gave no data, or when an error has no path
 * (such as a rate limit), since such an error says nothing about which aliases are sound.
 */
export async function aliasedGraphql<T extends object>(
  client: Octokit,
  query: string,
  variables: Record<string, unknown> = {}
): Promise<AliasedAnswer<T>> {
  try {
    const data = await client.graphql<T>(query, variables);
    return { data, failed: () => false, error: () => undefined, errorPaths: [], notFound: () => false };
  } catch (thrown) {
    const partial = thrown as { data?: T | null; errors?: GraphError[] };
    const errors = Array.isArray(partial.errors) ? partial.errors : [];
    if (!partial.data || !errors.length || errors.some((e) => !Array.isArray(e.path) || !e.path.length)) throw thrown;
    const find = (prefix: (string | number)[]) => errors.find((e) => under(e.path ?? [], prefix));
    return {
      data: partial.data,
      errorPaths: errors.map((e) => e.path ?? []),
      notFound: (...prefix) => {
        const found = errors.filter((e) => under(e.path ?? [], prefix));
        return !!found.length && found.every((e) => e.type === 'NOT_FOUND' && e.path?.length === prefix.length);
      },
      failed: (...prefix) => !!find(prefix),
      error: (...prefix) => {
        const found = find(prefix);
        return found ? new Error(found.message ?? 'GitHub could not answer part of this request.') : undefined;
      },
    };
  }
}

/** Aliases per blob query. A query also lists each distinct parent directory once, for its entries' modes. */
export const BLOB_ALIASES_PER_QUERY = 50;
/** Above this, GraphQL may truncate a blob's text; callers read such files another way. */
export const BLOB_TEXT_LIMIT = 256_000;
/** Git tree entry modes, as GraphQL's `TreeEntry.mode` reports them. */
export const TREE_MODE = 0o040000;
export const SYMLINK_MODE = 0o120000;
export const REGULAR_FILE_MODES: ReadonlySet<number> = new Set([0o100644, 0o100755]);

export interface BlobRequest {
  owner: string;
  repo: string;
  ref: string;
  path: string;
  /** The tree entry's mode when the caller listed it already; otherwise the parent directory is listed for it. */
  mode?: number;
}
export type BlobAnswer =
  | { kind: 'text'; text: string }
  /** No file here: a missing path, a directory or a submodule. */
  | { kind: 'absent' }
  /** GraphQL cannot give this file's text exactly. `symlink`: its text would be the link target, not the file. */
  | { kind: 'other'; reason: 'binary' | 'truncated' | 'large' | 'symlink' | 'failed' };

type Blob = { __typename?: string; text?: string | null; byteSize?: number; isBinary?: boolean | null; isTruncated?: boolean } | null;
type Dir = { __typename?: string; entries?: { name: string; mode: number }[] } | null;
const parentOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1);

/** Queries that run at once; each carries up to 50 aliases. */
const QUERIES_AT_ONCE = 2;
type RepoAnswer = AliasedAnswer<Record<string, Record<string, Blob | Dir> | null>>;

/**
 * One aliased query over several repositories: `rN: repository(...) { <alias>: <selection> }` for each repository's
 * fields. Undefined when the query failed outright, except for a rate limit, which is thrown.
 */
async function queryRepos(
  client: Octokit,
  fields: { owner: string; repo: string; alias: string; selection: string }[]
): Promise<{ answer: RepoAnswer; repoAlias: (owner: string, repo: string) => string } | undefined> {
  const repos = [...new Set(fields.map((f) => `${f.owner}/${f.repo}`))];
  const body = repos
    .map((name, r) => {
      const [owner, repo] = name.split('/');
      const selections = fields.filter((f) => `${f.owner}/${f.repo}` === name).map((f) => `${f.alias}: ${f.selection}`);
      return `r${r}: repository(owner:${JSON.stringify(owner)},name:${JSON.stringify(repo)}) { ${selections.join(' ')} }`;
    })
    .join('\n');
  try {
    const answer: RepoAnswer = await aliasedGraphql(client, `query { rateLimit { cost } ${body} }`);
    return { answer, repoAlias: (owner, repo) => `r${repos.indexOf(`${owner}/${repo}`)}` };
  } catch (error) {
    const limited = githubRateLimit(error);
    if (limited) throw limited;
    return undefined;
  }
}

/**
 * File texts through aliased `object(expression:)` queries, 50 files per query and two queries at once, answers in
 * request order. A file's mode comes from its parent directory's entries, listed in a second query only for files
 * that exist and whose mode the caller did not give, so a symlink is reported as one instead of as its target path.
 * Never throws, except for a rate limit; a failed query or alias answers `failed`.
 */
export async function readBlobs(client: Octokit, requests: readonly BlobRequest[]): Promise<BlobAnswer[]> {
  const answers = new Array<BlobAnswer>(requests.length);
  const blobs = new Array<Blob | undefined>(requests.length);
  const indexed = requests.map((request, index) => ({ request, index }));
  // The blobs first.
  await mapBounded(chunked(indexed, BLOB_ALIASES_PER_QUERY), QUERIES_AT_ONCE, async (batch) => {
    const result = await queryRepos(
      client,
      batch.map(({ request }, f) => ({
        owner: request.owner,
        repo: request.repo,
        alias: `f${f}`,
        selection: `object(expression:${JSON.stringify(`${request.ref}:${request.path}`)}) { __typename ... on Blob { text byteSize isBinary isTruncated } }`,
      }))
    );
    for (const [f, { request, index }] of batch.entries()) {
      const r = result?.repoAlias(request.owner, request.repo) ?? '';
      const blob = result?.answer.data[r]?.[`f${f}`] as Blob | undefined;
      if (!result || blob === undefined || result.answer.failed(r, `f${f}`)) answers[index] = { kind: 'other', reason: 'failed' };
      else if (blob === null || blob.__typename !== 'Blob') answers[index] = { kind: 'absent' };
      else blobs[index] = blob;
    }
  });
  // Then the modes of the files that exist, from each parent directory listed once.
  const modes = new Map<number, number | undefined>();
  const unlisted = indexed.filter(({ request, index }) => blobs[index] && request.mode === undefined);
  const dirOf = ({ request }: (typeof indexed)[number]) => JSON.stringify([request.owner, request.repo, request.ref, parentOf(request.path)]);
  const dirs = [...new Map(unlisted.map((item) => [dirOf(item), item.request])).entries()];
  await mapBounded(chunked(dirs, BLOB_ALIASES_PER_QUERY), QUERIES_AT_ONCE, async (batch) => {
    const result = await queryRepos(
      client,
      batch.map(([, request], d) => ({
        owner: request.owner,
        repo: request.repo,
        alias: `d${d}`,
        selection: `object(expression:${JSON.stringify(`${request.ref}:${parentOf(request.path)}`)}) { __typename ... on Tree { entries { name mode } } }`,
      }))
    );
    for (const [d, [key, request]] of batch.entries()) {
      const r = result?.repoAlias(request.owner, request.repo) ?? '';
      const dir = result && !result.answer.failed(r, `d${d}`) ? (result.answer.data[r]?.[`d${d}`] as Dir | undefined) : undefined;
      for (const item of unlisted)
        if (dirOf(item) === key) modes.set(item.index, dir?.entries?.find((e) => e.name === nameOf(item.request.path))?.mode);
    }
  });
  for (const { request, index } of indexed) {
    const blob = blobs[index];
    if (!blob) continue;
    const mode = request.mode ?? modes.get(index);
    answers[index] =
      mode === SYMLINK_MODE
        ? { kind: 'other', reason: 'symlink' }
        : mode === undefined || !REGULAR_FILE_MODES.has(mode)
          ? { kind: 'other', reason: 'failed' }
          : blob.isBinary || typeof blob.text !== 'string'
            ? { kind: 'other', reason: 'binary' }
            : blob.isTruncated
              ? { kind: 'other', reason: 'truncated' }
              : (blob.byteSize ?? Infinity) > BLOB_TEXT_LIMIT
                ? { kind: 'other', reason: 'large' }
                : { kind: 'text', text: blob.text };
  }
  return answers;
}
