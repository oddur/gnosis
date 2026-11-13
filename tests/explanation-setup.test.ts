import { closeCaches, createGitHubClientPool } from './cache-test-pool';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createPrChangesService } from '../src/pr-changes-service';
import { loadExplanationSetup, type ExplanationSetupDeps } from '../src/explanation-setup';
import { prepareReviewSource } from '../src/review-start-source';
import { checkGitHubPrAccess } from '../lib/github-auth';
import { GitHubDiffSource, getPrMetadata, parsePrUrl } from '../lib/github';
import { StackDiffSource } from '../lib/stack-source';
import { normalizeExplanationOptions } from '../lib/explanation-options';
import { DEFAULT_CLAUDE_MODEL } from '../lib/models';
import type { GenerateReviewRequest } from '../lib/types';
import type { ReviewMember, ReviewSubject } from '../lib/workbench';

after(() => closeCaches());

/** Latency per request, as in the log of klanggames/seed#35388: 1.7 s for the PR, 0.45 s per file page. */
const scale = Number(process.env.GNOSIS_SETUP_LATENCY ?? 0.01);
const latency = { pr: 1700, files: 450, commit: 250, compare: 300 };
const FILE_COUNT = 250;

function github() {
  const reads: string[] = [];
  const heads = new Map<number, string>();
  const denied = new Set<number>();
  let offset = 0;
  const pr = (n: number) => ({
    title: `Change ${n}`,
    body: '',
    user: { login: 'dev' },
    base: { ref: n === 1 ? 'main' : `branch-${n - 1}`, sha: `${'b'.repeat(39)}${n}`, repo: { full_name: 'o/r', archived: false } },
    head: { ref: `branch-${n}`, sha: heads.get(n) ?? `${'a'.repeat(39)}${n}`, repo: { full_name: 'o/r' } },
    state: 'open',
    merged: false,
    labels: [],
    html_url: `https://github.com/o/r/pull/${n}`,
    created_at: '2026-11-01T00:00:00Z',
    updated_at: '2026-11-02T00:00:00Z',
    changed_files: FILE_COUNT,
    commits: 1,
  });
  const files = (n: number) =>
    Array.from({ length: FILE_COUNT }, (_, i) => ({
      filename: i % 10 === 0 ? `src/file-${n}-${i}.test.ts` : `src/file-${n}-${i}.ts`,
      status: 'modified',
      sha: `${(heads.get(n) ?? 'h').slice(0, 8)}${i}`,
      // Large patches defer, as in big PRs. The file list then comes from the API again.
      patch: '@@ -1 +1 @@\n' + '+x'.repeat(5_000),
      additions: 1,
      deletions: 1,
    }));
  const pool = createGitHubClientPool({
    now: () => Date.now() + offset,
    fetch: (async (input: string, init?: RequestInit) => {
      const u = new URL(input);
      const n = Number(/\/pulls\/(\d+)/.exec(u.pathname)?.[1] ?? 1);
      let body: unknown, wait: number;
      if (/\/pulls\/\d+\/files$/.test(u.pathname)) {
        const page = Number(u.searchParams.get('page') ?? 1);
        body = files(n).slice((page - 1) * 100, page * 100);
        wait = latency.files;
        reads.push(`files:${n}:${page}`);
      } else if (/\/pulls\/\d+$/.test(u.pathname)) {
        body = pr(n);
        wait = latency.pr;
        reads.push(`pr:${n}`);
      } else if (u.pathname.includes('/git/commits/')) {
        body = { sha: u.pathname.split('/').pop() };
        wait = latency.commit;
        reads.push('commit');
      } else if (u.pathname.includes('/compare/')) {
        body = { merge_base_commit: { sha: 'c'.repeat(40) } };
        wait = latency.compare;
        reads.push('compare');
      } else throw new Error('Unexpected request ' + u.pathname);
      await new Promise((r) => setTimeout(r, wait * scale));
      if (denied.has(n))
        return new Response(JSON.stringify({ message: 'Not Found' }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        });
      const text = JSON.stringify(body);
      const etag = `"${text.length}:${heads.get(n) ?? ''}"`;
      if (new Headers(init?.headers).get('if-none-match') === etag) return new Response(null, { status: 304, headers: { etag } });
      return new Response(text, {
        headers: { 'content-type': 'application/json', etag, 'cache-control': 'private, max-age=60, s-maxage=60' },
      });
    }) as typeof fetch,
  });
  return {
    client: pool.client('token'),
    reads,
    /** Let GitHub's 60 s freshness lapse, so every read revalidates as in a PR opened a while ago. */
    age: () => (offset += 120_000),
    push: (n: number, sha: string) => heads.set(n, sha),
    deny: (n: number) => denied.add(n),
  };
}

const url = (n: number) => `https://github.com/o/r/pull/${n}`;
function request(n: number, extra: Partial<GenerateReviewRequest> = {}): GenerateReviewRequest {
  return { prUrl: url(n), subjectId: url(n), standalone: true, provider: 'claude', model: DEFAULT_CLAUDE_MODEL, ...extra };
}

async function member(client: ReturnType<typeof github>['client'], n: number): Promise<ReviewMember> {
  const meta = await getPrMetadata(client, 'o', 'r', n);
  return { ...meta, number: n, repo: 'o/r', headRepo: 'o/r', baseRepo: 'o/r', role: 'watched' };
}

function environment(gh: ReturnType<typeof github>, stack?: ReviewSubject) {
  const prChanges = createPrChangesService();
  const client = gh.client;
  const muted = new Set<string>();
  const workbench = {
    mutedUrls: () => muted,
    queue: () => Promise.resolve({ items: stack ? [{ subject: stack, attention: 'other' as const }] : [], warnings: [], remaining: 0 }),
    subject: (id: string) => (stack?.id === id ? stack : undefined),
    fresh: async (subject: ReviewSubject) => ({
      ...subject,
      members: await Promise.all(subject.members.map((m) => member(client, m.number))),
    }),
  };
  const deps: ExplanationSetupDeps = {
    prepare: (value) =>
      prepareReviewSource(value, {
        token: 'token',
        workbench,
        checkAccess: (u) => checkGitHubPrAccess(client, u),
        prSource: (u) => Promise.resolve(new GitHubDiffSource(u, null, client)),
        stackSource: (subject) => new StackDiffSource(subject, null, client),
      }),
    files: {
      overrides: () => ({}),
      inventory: (u, revision) => prChanges.manifest(client, u, false, { revision }),
      kinds: () => Promise.resolve({}),
    },
    options: () => ({ options: normalizeExplanationOptions(undefined), restored: false }),
  };
  return { deps, prChanges, muted, workbench };
}

/** The Changes tab of an open PR, or predictive preloading, saved its inventory. */
async function openPr(gh: ReturnType<typeof github>, env: ReturnType<typeof environment>, n: number) {
  const meta = await member(gh.client, n);
  await env.prChanges.manifest(gh.client, url(n), false, { revision: meta });
}

async function measure<T>(gh: ReturnType<typeof github>, run: () => Promise<T>) {
  gh.reads.length = 0;
  const started = performance.now();
  const value = await run();
  const ms = performance.now() - started;
  const counts = gh.reads.reduce<Record<string, number>>((all, read) => {
    const kind = read.split(':')[0];
    all[kind] = (all[kind] ?? 0) + 1;
    return all;
  }, {});
  return { value, ms: Math.round(ms / scale), reads: [...gh.reads], counts };
}

void test('setup timing for an open PR', async () => {
  const gh = github();
  const env = environment(gh);
  await openPr(gh, env, 1);
  gh.age();
  const result = await measure(gh, () => loadExplanationSetup(request(1), env.deps));
  assert.equal(result.value.files.length, FILE_COUNT);
  console.log('single PR', result.ms, 'ms', JSON.stringify(result.counts));
});

void test('setup timing for an open stack', async () => {
  const gh = github();
  const members = await Promise.all([1, 2, 3].map((n) => member(gh.client, n)));
  const stack: ReviewSubject = { id: 'stack:o/r', kind: 'stack', title: 'Three changes', members, edges: [], warnings: [] };
  const env = environment(gh, stack);
  for (const n of [1, 2, 3]) await openPr(gh, env, n);
  gh.age();
  const result = await measure(gh, () =>
    loadExplanationSetup(request(1, { subjectId: stack.id, standalone: false }), env.deps)
  );
  assert.equal(result.value.files.length, FILE_COUNT * 3);
  console.log('stack', result.ms, 'ms', JSON.stringify(result.counts));
});
void parsePrUrl;
