import { closeCaches, createGitHubClientPool } from './cache-test-pool';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createPrChangesService } from '../src/pr-changes-service';
import { loadExplanationSetup, type ExplanationSetupDeps } from '../src/explanation-setup';
import { prepareReviewSource } from '../src/review-start-source';
import { readAccessiblePr } from '../lib/github-auth';
import { GitHubDiffSource, getPrMetadata } from '../lib/github';
import { StackDiffSource } from '../lib/stack-source';
import { normalizeExplanationOptions } from '../lib/explanation-options';
import { DEFAULT_CLAUDE_MODEL } from '../lib/models';
import type { GenerateReviewRequest, PrMetadata } from '../lib/types';
import type { ReviewMember, ReviewSubject } from '../lib/workbench';

after(() => closeCaches());

/**
 * Latency per request, as in the log of klanggames/seed#35388: 1.7 s for the PR, 0.45 s per file page. Tests run at
 * 1/100 of it. `GNOSIS_SETUP_LATENCY=1` runs at full latency and prints the timings.
 */
const scale = Number(process.env.GNOSIS_SETUP_LATENCY ?? 0.01);
const latency = { pr: 1700, files: 450, commit: 250, compare: 300 };
const FILE_COUNT = 250;
const url = (n: number) => `https://github.com/o/r/pull/${n}`;

function github() {
  const reads: string[] = [];
  const heads = new Map<number, string>();
  const denied = new Set<number>();
  let offset = 0,
    active = 0,
    concurrentPrs = 0;
  const head = (n: number) => heads.get(n) ?? `${'a'.repeat(39)}${n}`;
  const files = (n: number) => [
    ...Array.from({ length: FILE_COUNT }, (_, i) => ({
      filename: i % 10 === 0 ? `src/file-${n}-${i}.test.ts` : `src/file-${n}-${i}.ts`,
      status: 'modified',
      sha: `${head(n).slice(0, 8)}${i}`,
      // Large patches defer, as in big PRs, so the old path listed the files from the API again.
      patch: '@@ -1 +1 @@\n' + '+x'.repeat(5_000),
      additions: 1,
      deletions: 1,
    })),
    ...(heads.has(n) ? [{ filename: `src/pushed-${n}.ts`, status: 'added', sha: 'p', additions: 3, deletions: 0 }] : []),
  ];
  const pr = (n: number) => ({
    title: `Change ${n}`,
    body: '',
    user: { login: 'dev' },
    base: { ref: n === 1 ? 'main' : `branch-${n - 1}`, sha: `${'b'.repeat(39)}${n}`, repo: { full_name: 'o/r', archived: false } },
    head: { ref: `branch-${n}`, sha: head(n), repo: { full_name: 'o/r' } },
    state: 'open',
    merged: false,
    labels: [],
    html_url: url(n),
    created_at: '2026-11-01T00:00:00Z',
    updated_at: heads.has(n) ? '2026-11-03T00:00:00Z' : '2026-11-02T00:00:00Z',
    changed_files: files(n).length,
    commits: 1,
  });
  const pool = createGitHubClientPool({
    now: () => Date.now() + offset,
    fetch: (async (input: string, init?: RequestInit) => {
      const u = new URL(input);
      const n = Number(/\/pulls\/(\d+)/.exec(u.pathname)?.[1] ?? /([1-9])$/.exec(u.pathname)?.[1] ?? 1);
      let body: unknown, wait: number;
      const isPr = /\/pulls\/\d+$/.test(u.pathname);
      if (/\/pulls\/\d+\/files$/.test(u.pathname)) {
        const page = Number(u.searchParams.get('page') ?? 1);
        body = files(n).slice((page - 1) * 100, page * 100);
        wait = latency.files;
        reads.push(`files:${n}:${page}`);
      } else if (isPr) {
        body = pr(n);
        wait = latency.pr;
        reads.push(`pr:${n}`);
      } else if (u.pathname.includes('/git/commits/')) {
        body = { sha: u.pathname.split('/').pop() };
        wait = latency.commit;
        reads.push(`commit:${n}`);
      } else if (u.pathname.includes('/compare/')) {
        body = { merge_base_commit: { sha: 'c'.repeat(40) } };
        wait = latency.compare;
        reads.push(`compare:${n}`);
      } else throw new Error('Unexpected request ' + u.pathname);
      if (isPr) concurrentPrs = Math.max(concurrentPrs, ++active);
      await new Promise((r) => setTimeout(r, wait * scale));
      if (isPr) active--;
      if (denied.has(n))
        return new Response(JSON.stringify({ message: 'Not Found' }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        });
      const text = JSON.stringify(body);
      const etag = `"${text.length}:${head(n)}"`;
      // As in the log: the data is cached, but every revalidation is a full round trip.
      if (new Headers(init?.headers).get('if-none-match') === etag) return new Response(null, { status: 304, headers: { etag } });
      return new Response(text, {
        headers: { 'content-type': 'application/json', etag, 'cache-control': 'private, max-age=60, s-maxage=60' },
      });
    }) as typeof fetch,
  });
  return {
    client: pool.client('token'),
    reads,
    concurrentPrs: () => concurrentPrs,
    /** Let GitHub's 60 s freshness lapse, so every read revalidates, as for a PR opened a while ago. */
    age: () => (offset += 120_000),
    push: (n: number) => heads.set(n, `${'d'.repeat(39)}${n}`),
    deny: (n: number) => denied.add(n),
    reset: () => {
      reads.length = 0;
      concurrentPrs = 0;
    },
  };
}
type GitHub = ReturnType<typeof github>;

function request(n: number, extra: Partial<GenerateReviewRequest> = {}): GenerateReviewRequest {
  return { prUrl: url(n), subjectId: url(n), standalone: true, provider: 'claude', model: DEFAULT_CLAUDE_MODEL, ...extra };
}
const memberOf = (n: number, meta: PrMetadata): ReviewMember => ({
  ...meta,
  number: n,
  repo: 'o/r',
  headRepo: 'o/r',
  baseRepo: 'o/r',
  role: 'watched',
});
const member = async (gh: GitHub, n: number) => memberOf(n, await getPrMetadata(gh.client, 'o', 'r', n));

/** The main process wiring of `explanation-setup`, with a fake GitHub. */
function environment(gh: GitHub, stack?: ReviewSubject) {
  const prChanges = createPrChangesService();
  const client = gh.client;
  const muted = new Set<string>();
  /** Metadata background sync saved for open PRs. */
  const synced = new Map<string, PrMetadata>();
  let useSaved = true;
  const workbench = {
    mutedUrls: () => muted,
    queue: () =>
      Promise.resolve({ items: stack ? [{ subject: stack, attention: 'other' as const }] : [], warnings: [], remaining: 0 }),
    subject: (id: string) => (stack?.id === id ? stack : undefined),
    fresh: async (subject: ReviewSubject, verified?: ReadonlyMap<string, PrMetadata>) => ({
      ...subject,
      members: await Promise.all(
        subject.members.map(async (m) => {
          const known = verified?.get(m.url);
          return known ? memberOf(m.number, known) : member(gh, m.number);
        })
      ),
    }),
  };
  const sourceDeps = {
    token: 'token',
    workbench,
    checkAccess: (u: string) => readAccessiblePr(client, u),
    prSource: (u: string, metadata?: PrMetadata) => Promise.resolve(new GitHubDiffSource(u, null, client, metadata)),
    stackSource: (subject: ReviewSubject, verified: ReadonlyMap<string, PrMetadata>) =>
      new StackDiffSource(subject, null, client, verified),
  };
  const deps: ExplanationSetupDeps = {
    prepare: (value) => prepareReviewSource(value, sourceDeps),
    saved: {
      muted: () => muted,
      subject: (value) => (useSaved && value.subjectId ? workbench.subject(value.subjectId) : undefined),
      metadata: (u) => (useSaved ? (synced.get(u) ?? prChanges.latest(client, u)?.metadata) : undefined),
      inventory: (u, revision) => (useSaved ? prChanges.saved(client, u, revision) : Promise.resolve(undefined)),
    },
    inventory: (u, revision) => prChanges.manifest(client, u, false, { revision }),
    overrides: () => ({}),
    kinds: () => Promise.resolve({}),
    options: () => ({ options: normalizeExplanationOptions(undefined), restored: false }),
  };
  return {
    deps,
    sourceDeps,
    prChanges,
    muted,
    synced,
    /** Forget saved data, as for a PR that was never opened. */
    withoutSaved: () => (useSaved = false),
  };
}
type Environment = ReturnType<typeof environment>;

/** The Changes tab of an open PR, or predictive preloading, saved its inventory. */
async function openPr(gh: GitHub, env: Environment, n: number) {
  const meta = await member(gh, n);
  await env.prChanges.manifest(gh.client, url(n), false, { revision: meta });
}

async function measure<T>(gh: GitHub, label: string, run: () => Promise<T>) {
  gh.reset();
  const started = performance.now();
  const value = await run();
  const ms = Math.round((performance.now() - started) / scale);
  const counts = gh.reads.reduce<Record<string, number>>((all, read) => {
    const kind = read.split(':')[0];
    all[kind] = (all[kind] ?? 0) + 1;
    return all;
  }, {});
  if (scale === 1) console.log(`${label}: ${ms} ms, ${gh.reads.length} requests ${JSON.stringify(counts)}`);
  return { value, ms, reads: [...gh.reads], counts };
}

async function stackFixture(gh: GitHub) {
  const members = await Promise.all([1, 2, 3].map((n) => member(gh, n)));
  const stack: ReviewSubject = { id: 'stack:o/r', kind: 'stack', title: 'Three changes', members, edges: [], warnings: [] };
  return { stack, request: request(1, { subjectId: stack.id, standalone: false }) };
}

void test('an open PR with saved metadata and inventory returns its setup without a GitHub request', async () => {
  const gh = github();
  const env = environment(gh);
  await openPr(gh, env, 1);
  gh.age();
  const saved = await measure(gh, 'open PR, saved data', () => loadExplanationSetup(request(1), env.deps));
  assert.deepEqual(saved.reads, [], 'the setup comes from saved data');
  assert.ok(saved.value.revalidate, 'a saved answer is checked afterwards');
  assert.equal(saved.value.setup.title, 'Change 1');
  assert.equal(saved.value.setup.repository, 'o/r');
  assert.equal(saved.value.setup.files.length, FILE_COUNT);
  assert.equal(saved.value.setup.files[0].group, '#1 Change 1');
  assert.equal(saved.value.setup.files.filter((file) => file.kinds.test.value).length, FILE_COUNT / 10);
  // The full path, which also ran before this change, gives the same files.
  env.withoutSaved();
  const loaded = await loadExplanationSetup(request(1), env.deps);
  assert.equal(loaded.revalidate, undefined);
  assert.deepEqual(saved.value.setup.files, loaded.setup.files);
  assert.equal(saved.value.setup.title, loaded.setup.title);
});

void test('background revalidation updates the files after a push and does nothing without one', async () => {
  const gh = github();
  const env = environment(gh);
  await openPr(gh, env, 1);
  gh.age();
  const first = await loadExplanationSetup(request(1), env.deps);
  const unchanged = await measure(gh, 'revalidation, no push', () => first.revalidate?.() ?? Promise.reject(Error('none')));
  assert.equal(unchanged.value, undefined, 'a current answer is not replaced');
  assert.deepEqual(unchanged.counts, { pr: 1, commit: 2 }, 'one fresh PR read checks access and the head');

  gh.push(1);
  gh.age();
  const stale = await loadExplanationSetup(request(1), env.deps);
  assert.equal(stale.setup.files.length, FILE_COUNT, 'the saved answer still shows at once');
  const updated = await stale.revalidate?.();
  assert.ok(updated, 'a push replaces the answer');
  assert.equal(updated.files.length, FILE_COUNT + 1);
  assert.ok(updated.files.some((file) => file.path === 'src/pushed-1.ts'));
  // Changes now has the new revision, so the next setup is saved and current.
  gh.age();
  const next = await measure(gh, 'open PR after the update', () => loadExplanationSetup(request(1), env.deps));
  assert.deepEqual(next.reads, []);
  assert.equal(next.value.setup.files.length, FILE_COUNT + 1);
  assert.equal(await next.value.revalidate?.(), undefined);
});

void test('without saved data the setup reads each PR once', async () => {
  const gh = github();
  const env = environment(gh);
  env.withoutSaved();
  const loaded = await measure(gh, 'PR without saved data', () => loadExplanationSetup(request(1), env.deps));
  assert.equal(loaded.counts.pr, 1, 'one PR read serves the access check and the metadata');
  assert.equal(loaded.counts.commit, 2);
  assert.equal(loaded.counts.files, 3);
  assert.equal(loaded.value.setup.files.length, FILE_COUNT);
  // And again once cached, with every read revalidating.
  gh.age();
  const cached = await measure(gh, 'PR without saved inventory, HTTP-cached', () => loadExplanationSetup(request(1), env.deps));
  assert.equal(cached.counts.pr, 1);
});

void test('an open stack returns its setup without a GitHub request, and checks members in parallel otherwise', async () => {
  const gh = github();
  const { stack, request: stackRequest } = await stackFixture(gh);
  const env = environment(gh, stack);
  for (const n of [1, 2, 3]) await openPr(gh, env, n);
  gh.age();
  const saved = await measure(gh, 'open stack, saved data', () => loadExplanationSetup(stackRequest, env.deps));
  assert.deepEqual(saved.reads, []);
  assert.equal(saved.value.setup.title, 'Three changes');
  assert.equal(saved.value.setup.files.length, FILE_COUNT * 3);
  assert.equal(saved.value.setup.files[0].path, 'PR-o~r-1/src/file-1-0.test.ts');
  assert.equal(saved.value.setup.files[FILE_COUNT].group, '#2 Change 2');
  const unchanged = await measure(gh, 'stack revalidation, no push', () => saved.value.revalidate?.() ?? Promise.resolve(null));
  assert.equal(unchanged.value, undefined);
  assert.equal(unchanged.counts.pr, 3, 'one read per member');
  // The requested PR is verified before queue lookup; the other members then load together.
  assert.equal(gh.concurrentPrs(), 2, 'members are checked in parallel');

  env.withoutSaved();
  gh.age();
  const loaded = await measure(gh, 'stack without saved inventory', () => loadExplanationSetup(stackRequest, env.deps));
  assert.deepEqual(loaded.value.setup.files, saved.value.setup.files, 'the full path lists the same files');
  assert.equal(loaded.counts.pr, 3);
  assert.equal(gh.concurrentPrs(), 2);
});

void test('a muted or inaccessible PR is still refused', async () => {
  const gh = github();
  const env = environment(gh);
  await openPr(gh, env, 1);
  gh.age();
  env.muted.add(url(1));
  gh.reset();
  await assert.rejects(loadExplanationSetup(request(1), env.deps), /muted/);
  await assert.rejects(prepareReviewSource(request(1), env.sourceDeps), /muted/);
  assert.deepEqual(gh.reads, [], 'a muted PR stops before GitHub');
  env.muted.clear();

  gh.deny(1);
  // Saved data shows, but GitHub's check refuses it, and the dialog reports that.
  const saved = await loadExplanationSetup(request(1), env.deps);
  await assert.rejects(saved.revalidate?.() ?? Promise.resolve(), /could not find the PR/);
  await assert.rejects(prepareReviewSource(request(1), env.sourceDeps), /could not find the PR/);
  env.withoutSaved();
  await assert.rejects(loadExplanationSetup(request(1), env.deps), /could not find the PR/);
});

void test('starting a review still verifies access and the current head, even with saved data', async () => {
  const gh = github();
  const env = environment(gh);
  await openPr(gh, env, 1);
  gh.push(1);
  gh.age();
  const started = await measure(gh, 'start-review source', () => prepareReviewSource(request(1), env.sourceDeps));
  assert.equal(started.counts.pr, 1, 'one fresh read, not two');
  assert.equal(started.counts.commit, 2);
  assert.equal(started.value.prData.headSha, `${'d'.repeat(39)}1`, 'generation uses the pushed head');
  assert.equal(started.value.reviewSnapshot?.subject.members[0].headSha, started.value.prData.headSha);
  assert.equal((await started.value.source.getChangedFiles()).length, FILE_COUNT + 1);
});
