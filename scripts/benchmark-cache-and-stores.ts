// Times main-thread work for GitHub cache hits and for saving mutes, stars and read progress.
// Results and method: docs/benchmarks/cache-and-stores.md.
//
//   npx tsx scripts/benchmark-cache-and-stores.ts
//
// No network: Octokit reads a local fetch stub. The script also runs against commits before #258 and
// #259, where the stores still write whole JSON files; it detects which API it is running against.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import * as appDataModule from '../src/app-data-store';
import { createMutedPrStore } from '../src/muted-pr-store';
import { createStarredPrStore } from '../src/starred-pr-store';
import { createPrReadStore } from '../src/pr-read-store';
import { createGitHubCache } from '../lib/github-cache';
import { createGitHubClientPool } from '../lib/github-client';
import type { ReviewMember } from '../lib/workbench';
import { emptyReadVersions } from '../lib/pr-read-state';

const MUTED = 649,
  STARRED = 200,
  READ = 649,
  RUNS = 30;
const now = Date.now();
const account = 'me';
const accountHash = createHash('sha256').update(account).digest('hex');
/** Branch builds have row patches; older builds rewrite whole files. */
const rowPatches = 'createMemoryStorage' in appDataModule;
const text = (n: number, size: number) => `PR ${n} description. `.repeat(Math.ceil(size / 20)).slice(0, size);
const member = (n: number, description = 4_000): ReviewMember => ({
  number: n,
  repo: `owner/repo${n % 20}`,
  headRepo: `owner/repo${n % 20}`,
  baseRepo: `owner/repo${n % 20}`,
  url: `https://github.com/owner/repo${n % 20}/pull/${n}`,
  title: `PR ${n}`,
  description: text(n, description),
  author: 'author',
  role: 'watched',
  baseBranch: 'main',
  headBranch: `feature-${n}`,
  baseSha: 'b'.repeat(40),
  headSha: createHash('sha1').update(String(n)).digest('hex'),
  merged: false,
  state: 'open',
  createdAt: new Date(now - 86_400_000).toISOString(),
  updatedAt: new Date(now - n * 60_000).toISOString(),
  labels: ['bug'],
  mergeable: null,
  isDraft: false,
  commitCount: 3,
  requestedReviewers: ['me'],
  requestedTeams: [],
  mergeableState: null,
  autoMerge: null,
  milestone: null,
});
const ms = (value: number) => `${value.toFixed(2)} ms`;
function summary(label: string, times: number[]) {
  const sorted = [...times].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
  console.log(`${label.padEnd(44)} median ${ms(at(0.5)).padStart(10)}  p95 ${ms(at(0.95)).padStart(10)}  (n=${sorted.length})`);
}

/** The legacy files every build can read: older builds directly, newer ones through the one-time import. */
function seed(directory: string, muted: boolean) {
  fs.mkdirSync(directory, { recursive: true });
  if (muted)
    fs.writeFileSync(
      path.join(directory, `muted-prs-${accountHash}.json`),
      JSON.stringify(Array.from({ length: MUTED }, (_, i) => ({ member: member(10_000 + i), mutedAt: new Date(now).toISOString() })))
    );
  fs.writeFileSync(
    path.join(directory, `starred-prs-${accountHash}.json`),
    JSON.stringify(Array.from({ length: STARRED }, (_, i) => ({ member: member(20_000 + i), starredAt: new Date(now).toISOString() })))
  );
  const entries = Object.fromEntries(
    Array.from({ length: READ }, (_, i) => {
      const pr = member(30_000 + i, 0);
      return [
        pr.url,
        {
          basis: { headSha: pr.headSha, state: 'open:false:false', comments: 0, inlineComments: 0 },
          versions: emptyReadVersions(),
          read: emptyReadVersions(),
          since: now,
          metadataAt: pr.updatedAt,
        },
      ];
    })
  );
  fs.writeFileSync(path.join(directory, `pr-read-${accountHash}.json`), JSON.stringify({ initialized: true, entries }));
}

type Storage = ReturnType<typeof appDataModule.createAppDataStore>;
type Factory = (...args: unknown[]) => unknown;
const mutedStore = (directory: string, storage: Storage) =>
  (rowPatches
    ? (createMutedPrStore as unknown as Factory)(storage, () => now)
    : (createMutedPrStore as unknown as Factory)(() => directory, () => now)) as ReturnType<typeof createMutedPrStore>;
const starredStore = (directory: string, storage: Storage) =>
  (rowPatches
    ? (createStarredPrStore as unknown as Factory)(storage, () => now)
    : (createStarredPrStore as unknown as Factory)(() => directory, () => now)) as ReturnType<typeof createStarredPrStore>;
const readStore = (directory: string, storage: Storage) =>
  (rowPatches
    ? (createPrReadStore as unknown as Factory)(storage, () => now)
    : (createPrReadStore as unknown as Factory)(() => directory, () => now, storage)) as ReturnType<typeof createPrReadStore>;

/** The synchronous call plus the microtask that hands the change to the worker. */
async function mainThread(run: () => unknown) {
  const start = performance.now();
  run();
  await Promise.resolve();
  return performance.now() - start;
}

async function mutations(root: string) {
  const directory = path.join(root, 'mutations');
  seed(directory, true);
  const storage = appDataModule.createAppDataStore();
  await storage.open(directory);
  try {
    const mutes = mutedStore(directory, storage),
      stars = starredStore(directory, storage),
      reads = readStore(directory, storage);
    // Load once, as the first queue view does, so only the change is timed.
    mutes.index(account);
    stars.load(account);
    reads.snapshot(account);
    const mute: number[] = [],
      unmute: number[] = [],
      star: number[] = [],
      update: number[] = [],
      read: number[] = [];
    for (let i = 0; i < RUNS; i++) {
      const pr = member(40_000 + i);
      mute.push(await mainThread(() => mutes.set(account, { muted: true, members: [pr] })));
      await storage.flush();
      unmute.push(await mainThread(() => mutes.set(account, { muted: false, urls: [pr.url] })));
      await storage.flush();
      star.push(await mainThread(() => stars.set(account, { starred: true, members: [member(50_000 + i)] })));
      await storage.flush();
      const starred = member(20_000 + (i % STARRED));
      update.push(await mainThread(() => stars.update(account, [{ ...starred, title: `Renamed ${i}` }])));
      await storage.flush();
      const target = member(30_000 + (i % READ), 0);
      read.push(
        await mainThread(() =>
          reads.mark(account, {
            account,
            read: false,
            receipts: [{ url: target.url, headSha: target.headSha, versions: emptyReadVersions(), unread: [] }],
          })
        )
      );
      await storage.flush();
    }
    console.log(`\nMutations (${MUTED} muted PRs, ${STARRED} stars, ${READ} read entries)`);
    summary('mute one PR', mute);
    summary('unmute one PR', unmute);
    summary('star one PR', star);
    summary('stars.update one changed PR', update);
    summary('mark one PR unread', read);
  } finally {
    await storage.close();
  }
}

const files = (count: number, patch: number) =>
  Array.from({ length: count }, (_, i) => ({
    sha: createHash('sha1').update(String(i)).digest('hex'),
    filename: `src/module-${i}/file-${i}.ts`,
    status: 'modified',
    additions: 10,
    deletions: 2,
    changes: 12,
    blob_url: `https://github.com/o/r/blob/abc/src/module-${i}/file-${i}.ts`,
    raw_url: `https://github.com/o/r/raw/abc/src/module-${i}/file-${i}.ts`,
    contents_url: `https://api.github.com/repos/o/r/contents/src/module-${i}/file-${i}.ts?ref=abc`,
    patch: '@@ -1,2 +1,10 @@\n' + '+ line of changed code\n'.repeat(Math.ceil(patch / 22)).slice(0, patch),
  }));

async function cacheReads(root: string) {
  console.log('\nGitHub cache');
  // A memory entry just under the 1 MB limit.
  const memory = createGitHubCache(() => now).scope('a'.repeat(64));
  const entry = { files: files(1_150, 400) };
  memory.set('one-megabyte', entry);
  const valid = (value: unknown): value is { files: unknown[] } => !!value && typeof value === 'object';
  if (!memory.get('one-megabyte', valid)) throw new Error('The 1 MB entry must stay in memory.');
  console.log(`  memory entry ${(Buffer.byteLength(JSON.stringify(entry)) / 1e6).toFixed(2)} MB`);
  const get: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const start = performance.now();
    memory.get('one-megabyte', valid);
    get.push(performance.now() - start);
  }
  summary('get on a 1 MB entry', get);

  // A prepared entry larger than the memory limit, read while its write is still queued.
  const disk = createGitHubCache(() => now);
  await disk.setStorage(path.join(root, 'cache', 'github-cache.json'));
  const scope = disk.scope('b'.repeat(64));
  const large = { version: 1, files: files(3_000, 7_000) };
  const pending: number[] = [];
  for (let i = 0; i < 5; i++) {
    const key = `pr-changes:v2:https://github.com/o/r/pull/1:${i}`;
    scope.set(key, large);
    const start = performance.now();
    if (!(await scope.getPrepared(key, valid))) throw new Error('The pending write must be readable.');
    pending.push(performance.now() - start);
    await disk.flush();
  }
  console.log(`  prepared payload ${(Buffer.byteLength(JSON.stringify(large)) / 1e6).toFixed(1)} MB`);
  summary('getPrepared with its write pending (wall)', pending);
  await disk.close();
}

async function octokit() {
  console.log('\nOctokit, 3000-file listFiles read (30 pages of 100)');
  let clock = now;
  const PAGES = 30;
  const pages = Array.from({ length: PAGES }, (_, page) => JSON.stringify(files(3_000, 2_000).slice(page * 100, page * 100 + 100)));
  console.log(`  responses ${(pages.reduce((sum, body) => sum + Buffer.byteLength(body), 0) / 1e6).toFixed(2)} MB in total`);
  const sent = { ok: 0, notModified: 0 };
  // Each forced read sees a new ETag, so it downloads; a later expiry revalidates that ETag.
  let version = 0;
  const pool = createGitHubClientPool({
    now: () => clock,
    sleep: (wait) => {
      clock += wait;
      return Promise.resolve();
    },
    fetch: ((url: string, init: RequestInit) => {
      const page = Number(new URL(url).searchParams.get('page') ?? '1');
      const headers = new Headers(init.headers);
      const link: Record<string, string> =
        page < PAGES
          ? { link: `<https://api.github.com/repos/o/r/pulls/1/files?per_page=100&page=${page + 1}>; rel="next"` }
          : {};
      const etag = `"v${version}-${page}"`;
      if (headers.get('if-none-match') === etag) {
        sent.notModified++;
        return Promise.resolve(new Response(null, { status: 304, headers: { etag, ...link } }));
      }
      sent.ok++;
      return Promise.resolve(
        new Response(pages[page - 1], {
          status: 200,
          headers: { 'content-type': 'application/json', etag, 'cache-control': 'max-age=60', ...link },
        })
      );
    }) as typeof fetch,
  });
  const client = pool.client('token');
  const read = (force = false) =>
    client.paginate(client.pulls.listFiles, {
      owner: 'o',
      repo: 'r',
      pull_number: 1,
      per_page: 100,
      ...(force ? { headers: { 'cache-control': 'no-cache' } } : {}),
    });
  const ok: number[] = [],
    hit: number[] = [],
    revalidated: number[] = [];
  // Octokit logs each 304 response to stderr through a console method it bound earlier.
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = () => true;
  for (let i = 0; i < RUNS; i++) {
    version++;
    let start = performance.now();
    await read(true);
    ok.push(performance.now() - start);
    start = performance.now();
    await read();
    hit.push(performance.now() - start);
    // An expired entry is revalidated with its ETag.
    clock += 61_000;
    start = performance.now();
    const files = await read();
    revalidated.push(performance.now() - start);
    if (files.length !== 3_000) throw new Error('Pagination returned the wrong number of files.');
    clock += 61_000;
  }
  process.stderr.write = write;
  if (sent.ok !== RUNS * PAGES || sent.notModified !== RUNS * PAGES)
    throw new Error(`Unexpected requests: ${JSON.stringify(sent)}`);
  summary('memory hit (30 pages)', hit);
  summary('200 responses (30 pages)', ok);
  summary('304 responses (30 pages)', revalidated);
}

async function startup(root: string) {
  console.log('\nStartup: appData.open, then the first muted index');
  for (const muted of [false, true]) {
    const directory = path.join(root, muted ? 'startup-muted' : 'startup-empty');
    seed(directory, muted);
    // The first launch imports legacy files on newer builds. Time the launches after it.
    const first = appDataModule.createAppDataStore();
    const migrateStart = performance.now();
    await first.open(directory);
    const migrated = performance.now() - migrateStart;
    mutedStore(directory, first).index(account);
    await first.close();
    const open: number[] = [],
      index: number[] = [];
    for (let i = 0; i < 5; i++) {
      const storage = appDataModule.createAppDataStore();
      let start = performance.now();
      await storage.open(directory);
      open.push(performance.now() - start);
      start = performance.now();
      mutedStore(directory, storage).index(account);
      index.push(performance.now() - start);
      await storage.close();
    }
    const label = muted ? `with ${MUTED} muted PRs` : 'without muted PRs';
    console.log(`  first launch ${label}: ${ms(migrated)}`);
    summary(`open ${label}`, open);
    summary(`first muted index ${label}`, index);
  }
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gnosis-cache-store-benchmark-'));
  console.log(`Stores: ${rowPatches ? 'appData row patches' : 'whole JSON files'}`);
  try {
    await mutations(root);
    await cacheReads(root);
    await octokit();
    await startup(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
void main();
