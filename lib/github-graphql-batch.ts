import type { Octokit } from '@octokit/rest';
import { chunked } from './bounded';
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
}
type GraphError = { message?: string; path?: (string | number)[] };
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
    return { data, failed: () => false, error: () => undefined, errorPaths: [] };
  } catch (thrown) {
    const partial = thrown as { data?: T | null; errors?: GraphError[] };
    const errors = Array.isArray(partial.errors) ? partial.errors : [];
    if (!partial.data || !errors.length || errors.some((e) => !Array.isArray(e.path) || !e.path.length)) throw thrown;
    const find = (prefix: (string | number)[]) => errors.find((e) => under(e.path ?? [], prefix));
    return {
      data: partial.data,
      errorPaths: errors.map((e) => e.path ?? []),
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
const SYMLINK_MODE = 0o120000;
const REGULAR_FILE_MODES = new Set([0o100644, 0o100755]);

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

/**
 * File texts through aliased `object(expression:)` queries, 50 files per query, answers in request order. A file's
 * mode comes from its parent directory's entries, so a symlink is reported as one instead of as its target path.
 * Never throws, except for a rate limit; a failed query or alias answers `failed`.
 */
export async function readBlobs(client: Octokit, requests: readonly BlobRequest[]): Promise<BlobAnswer[]> {
  const answers = new Array<BlobAnswer>(requests.length);
  const indexed = requests.map((request, index) => ({ request, index }));
  await Promise.all(
    chunked(indexed, BLOB_ALIASES_PER_QUERY).map(async (batch) => {
      const repos = [...new Set(batch.map(({ request }) => `${request.owner}/${request.repo}`))];
      const dirs = new Map<string, string>();
      const fields = repos.map((name, r) => {
        const [owner, repo] = name.split('/');
        const selections: string[] = [];
        for (const [f, { request }] of batch.entries()) {
          if (`${request.owner}/${request.repo}` !== name) continue;
          selections.push(
            `f${f}: object(expression:${JSON.stringify(`${request.ref}:${request.path}`)}) { __typename ... on Blob { text byteSize isBinary isTruncated } }`
          );
          if (request.mode !== undefined) continue;
          const dir = `${request.ref}:${parentOf(request.path)}`;
          if (dirs.has(`r${r}|${dir}`)) continue;
          const alias = `d${dirs.size}`;
          dirs.set(`r${r}|${dir}`, alias);
          selections.push(`${alias}: object(expression:${JSON.stringify(dir)}) { __typename ... on Tree { entries { name mode } } }`);
        }
        return `r${r}: repository(owner:${JSON.stringify(owner)},name:${JSON.stringify(repo)}) { ${selections.join(' ')} }`;
      });
      let answer: AliasedAnswer<Record<string, Record<string, Blob | Dir> | null>>;
      try {
        answer = await aliasedGraphql(client, `query { rateLimit { cost } ${fields.join('\n')} }`);
      } catch (error) {
        const limited = githubRateLimit(error);
        if (limited) throw limited;
        for (const { index } of batch) answers[index] = { kind: 'other', reason: 'failed' };
        return;
      }
      for (const [f, { request, index }] of batch.entries()) {
        const r = `r${repos.indexOf(`${request.owner}/${request.repo}`)}`;
        const repository = answer.data[r];
        const blob = repository?.[`f${f}`] as Blob | undefined;
        if (!repository || blob === undefined || answer.failed(r, `f${f}`)) {
          answers[index] = { kind: 'other', reason: 'failed' };
          continue;
        }
        if (blob === null || blob.__typename !== 'Blob') {
          answers[index] = { kind: 'absent' };
          continue;
        }
        let mode = request.mode;
        if (mode === undefined) {
          const alias = dirs.get(`${r}|${request.ref}:${parentOf(request.path)}`) ?? '';
          const dir = repository[alias] as Dir | undefined;
          mode = answer.failed(r, alias) ? undefined : dir?.entries?.find((e) => e.name === nameOf(request.path))?.mode;
        }
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
    })
  );
  return answers;
}
