import { createHash } from 'node:crypto';
import type { Octokit } from '@octokit/rest';
import { getPrMetadata, parsePrUrl } from '../lib/github';
import { githubCacheFor } from '../lib/github-client';
import { isCacheRecord } from '../lib/github-cache';
import { createSnapshotFileLoader } from './snapshot-file-loader';
import {
  selectedCommits,
  commitSelectionKey,
  type PrCommit,
  type PrCommits,
  type CommitSelection,
} from '../lib/pr-commits';
import type { PrChanges, PrChangeFile, PrFileRequest } from '../lib/pr-changes';
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function target(url: string) {
  if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(url)) throw new Error('Choose a GitHub PR.');
  const { owner, repo, pullNumber } = parsePrUrl(url);
  return { owner, repo, pull_number: pullNumber };
}
const isSha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{40}$/i.test(value);
const isList = (value: unknown): value is PrCommits =>
  isCacheRecord(value) &&
  value.version === 1 &&
  typeof value.url === 'string' &&
  isCacheRecord(value.metadata) &&
  isSha(value.metadata.headSha) &&
  isSha(value.metadata.baseSha) &&
  Array.isArray(value.commits) &&
  value.commits.every(
    (c) =>
      isCacheRecord(c) &&
      isSha(c.sha) &&
      typeof c.message === 'string' &&
      Array.isArray(c.parents) &&
      c.parents.every(isSha) &&
      isCacheRecord(c.author) &&
      typeof c.author.name === 'string' &&
      typeof c.url === 'string' &&
      typeof c.authoredAt === 'string' &&
      typeof c.committedAt === 'string' &&
      typeof c.committer === 'string' &&
      typeof c.verified === 'boolean'
  );
const isComparison = (value: unknown): value is PrChanges =>
  isCacheRecord(value) &&
  value.version === 1 &&
  isCacheRecord(value.comparison) &&
  isCacheRecord(value.metadata) &&
  isSha(value.comparisonBase) &&
  isSha(value.metadata.headSha) &&
  isSha(value.metadata.baseSha) &&
  typeof value.url === 'string' &&
  isSha(value.comparison.firstSha) &&
  isSha(value.comparison.lastSha) &&
  Array.isArray(value.files) &&
  value.files.every(
    (f) =>
      isCacheRecord(f) &&
      typeof f.path === 'string' &&
      typeof f.changeId === 'string' &&
      ['added', 'modified', 'deleted', 'renamed'].includes(String(f.status)) &&
      typeof f.additions === 'number' &&
      typeof f.deletions === 'number'
  );
interface ApiCommit {
  sha: string;
  html_url: string;
  parents: { sha: string }[];
  author: { login?: string; avatar_url?: string } | null;
  commit: {
    message: string;
    author: { name?: string; date?: string } | null;
    committer: { name?: string; date?: string } | null;
    verification?: { verified: boolean };
  };
}
function normalize(commit: ApiCommit): PrCommit {
  return {
    sha: commit.sha,
    message: commit.commit.message,
    parents: commit.parents.map((p) => p.sha),
    url: commit.html_url,
    author: {
      name: commit.commit.author?.name ?? commit.author?.login ?? 'Unknown author',
      login: commit.author?.login,
      avatarUrl: commit.author?.avatar_url,
    },
    authoredAt: commit.commit.author?.date ?? '',
    committer: commit.commit.committer?.name ?? '',
    committedAt: commit.commit.committer?.date ?? '',
    verified: commit.commit.verification?.verified ?? false,
  };
}
interface ApiFile {
  filename: string;
  previous_filename?: string;
  status: string;
  additions: number;
  deletions: number;
  sha: string | null;
  patch?: string;
}
function fileValue(file: ApiFile): PrChangeFile {
  return {
    path: file.filename,
    previousPath: file.previous_filename,
    status:
      file.status === 'added'
        ? 'added'
        : file.status === 'removed'
          ? 'deleted'
          : file.status === 'renamed'
            ? 'renamed'
            : 'modified',
    additions: file.additions,
    deletions: file.deletions,
    patch: file.patch,
    changeId: hash(file),
  };
}
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
export function createPrCommitsService() {
  const memory = new WeakMap<Octokit, Map<string, unknown>>(),
    pending = new WeakMap<Octokit, Map<string, Promise<unknown>>>();
  const loadFile = createSnapshotFileLoader();
  function map(client: Octokit) {
    let m = memory.get(client);
    if (!m) {
      m = new Map();
      memory.set(client, m);
    }
    return m;
  }
  function read<T>(client: Octokit, key: string, valid: (value: unknown) => value is T): T | undefined {
    const value = map(client).get(key) ?? githubCacheFor(client)?.get(key, valid)?.value;
    return valid(value) ? value : undefined;
  }
  function save(client: Octokit, key: string, value: unknown, version: number | undefined) {
    const m = map(client);
    m.set(key, value);
    while (m.size > 150) {
      const first = m.keys().next().value;
      if (first === undefined) break;
      m.delete(first);
    }
    const cache = githubCacheFor(client);
    if (cache?.version() === version) cache?.set(key, value);
  }
  function share<T>(client: Octokit, key: string, run: () => Promise<T>): Promise<T> {
    let m = pending.get(client);
    if (!m) {
      m = new Map();
      pending.set(client, m);
    }
    const previous = m.get(key);
    if (previous) return previous as Promise<T>;
    const result = run().finally(() => m.delete(key));
    m.set(key, result);
    return result;
  }
  const listKey = (url: string, base: string, head: string) => `pr-commits:v1:${url}:${base}:${head}`;
  const latestKey = (url: string) => `pr-commits:v1:${url}:latest`;
  async function list(client: Octokit, url: string, refresh = false): Promise<PrCommits> {
    const t = target(url);
    return share(client, `list:${url}:${refresh}`, async () => {
      const version = githubCacheFor(client)?.version();
      const saved = read(client, latestKey(url), isList);
      if (saved && !refresh) {
        map(client).set(listKey(url, saved.metadata.baseSha, saved.metadata.headSha), saved);
        return saved;
      }
      const metadata = await getPrMetadata(client, t.owner, t.repo, t.pull_number, true);
      const key = listKey(url, metadata.baseSha, metadata.headSha);
      const known = read(client, key, isList);
      if (known) {
        map(client).set(key, known);
        const current = { ...known, metadata };
        save(client, latestKey(url), current, version);
        return current;
      }
      let commits: PrCommit[] = [];
      // GitHub's PR-commits endpoint is capped at 250. Comparison pagination covers larger PRs.
      if (metadata.commitCount > 250) {
        let page = 1;
        for (;;) {
          const { data, headers } = await client.repos.compareCommits({
            owner: t.owner,
            repo: t.repo,
            base: metadata.baseSha,
            head: metadata.headSha,
            per_page: 100,
            page,
          });
          commits.push(...data.commits.map(normalize));
          if (!headers.link?.includes('rel="next"')) break;
          page++;
        }
      } else {
        commits = (
          await client.paginate(client.pulls.listCommits, {
            ...t,
            per_page: 100,
            headers: { 'cache-control': 'no-cache' },
          })
        ).map(normalize);
      }
      if (new Set(commits.map((c) => c.sha)).size !== commits.length || commits.length !== metadata.commitCount)
        throw new Error(
          'GitHub returned an incomplete commit list. Update commits to retry, or open the PR on GitHub.'
        );
      const after = await getPrMetadata(client, t.owner, t.repo, t.pull_number, true);
      if (
        after.headSha !== metadata.headSha ||
        after.baseSha !== metadata.baseSha ||
        after.commitCount !== metadata.commitCount
      )
        throw new Error('This PR changed while commits were loading. Update commits to retry.');
      const value: PrCommits = { version: 1, url, metadata, commits, fetchedAt: Date.now() };
      save(client, key, value, version);
      save(client, latestKey(url), value, version);
      return value;
    });
  }
  async function comparison(client: Octokit, selection: CommitSelection): Promise<PrChanges> {
    const t = target(selection.url);
    for (const sha of [
      selection.prBaseSha,
      selection.prHeadSha,
      selection.firstSha,
      selection.lastSha,
      ...(selection.parentSha ? [selection.parentSha] : []),
    ])
      if (!/^[a-f0-9]{40}$/i.test(sha)) throw new Error('Choose full commit references from the PR commit list.');
    const key = `commit-comparison:v1:${hash(commitSelectionKey(selection))}`;
    return share(client, key, async () => {
      const cached = read(client, key, isComparison);
      if (cached) return cached;
      const version = githubCacheFor(client)?.version();
      const catalog = read(client, listKey(selection.url, selection.prBaseSha, selection.prHeadSha), isList);
      if (!catalog) throw new Error('Reload the PR commit list before opening this comparison.');
      const chosen = selectedCommits(catalog, selection),
        first = chosen[0],
        last = chosen[chosen.length - 1];
      const parent = selection.parentSha ?? first.parents.at(0) ?? EMPTY_TREE;
      let files: ApiFile[] = [];
      if (chosen.length === 1 && (!selection.parentSha || selection.parentSha === first.parents[0])) {
        let page = 1;
        for (;;) {
          const { data, headers } = await client.repos.getCommit({
            owner: t.owner,
            repo: t.repo,
            ref: last.sha,
            per_page: 100,
            page,
          });
          if (data.sha !== last.sha) throw new Error('GitHub returned a different commit. Reload the commit list.');
          files.push(...(data.files ?? []));
          if (!headers.link?.includes('rel="next"')) break;
          page++;
        }
        if (files.length >= 3000)
          throw new Error(
            'This commit reaches GitHub’s 3,000-file limit. Open it on GitHub to inspect the complete change.'
          );
      } else {
        if (parent === EMPTY_TREE)
          throw new Error(
            'A range starting at the repository’s first commit cannot be compared here. Inspect its commits individually.'
          );
        const { data } = await client.repos.compareCommits({
          owner: t.owner,
          repo: t.repo,
          base: parent,
          head: last.sha,
          per_page: 1,
        });
        if (data.merge_base_commit.sha !== parent)
          throw new Error(
            'These commits are on different ancestry paths. Select a range on one path, or inspect them individually.'
          );
        files = data.files ?? [];
        if (files.length >= 300)
          throw new Error(
            'This comparison reaches GitHub’s 300-file limit. Inspect smaller ranges or open the comparison on GitHub.'
          );
      }
      const snapshot: PrChanges = {
        version: 1,
        url: selection.url,
        comparison: selection,
        comparisonBase: parent,
        fetchedAt: Date.now(),
        metadata: { ...catalog.metadata, baseSha: parent, headSha: last.sha, headRepo: catalog.metadata.baseRepo },
        files: files.map(fileValue),
      };
      save(client, key, snapshot, version);
      return snapshot;
    });
  }
  function find(client: Octokit, request: PrFileRequest) {
    if (!request.comparison || request.comparison.url !== request.url)
      throw new Error('Select a commit comparison first.');
    const key = `commit-comparison:v1:${hash(commitSelectionKey(request.comparison))}`;
    const snapshot = read(client, key, isComparison),
      file = snapshot?.files.find((f) => f.path === request.path);
    if (
      !snapshot ||
      !file ||
      snapshot.comparisonBase !== request.baseSha ||
      snapshot.metadata.headSha !== request.headSha
    )
      throw new Error('Reload this commit comparison before opening the file.');
    return { snapshot, file };
  }
  return {
    list,
    comparison,
    find,
    async content(client: Octokit, request: PrFileRequest) {
      const { snapshot, file } = find(client, request);
      return loadFile(client, request, snapshot, file);
    },
  };
}
