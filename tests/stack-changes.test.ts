import test from 'node:test';
import assert from 'node:assert/strict';
import { stackFileSources, linearStack, stackRevisionKey, stackFileProgressKey, combinedThreadIsInline } from '../lib/stack-changes';
import { createStackChangesService } from '../src/stack-changes-service';
import { createGitHubClientPool } from './cache-test-pool';
import { preparedFileKey } from '../lib/prepared-pr';
import type { ReviewSubject, ReviewMember } from '../lib/workbench';
import type { PrChanges } from '../lib/pr-changes';
import type { GitHubReviewThread } from '../lib/review-threads';
const members = [1, 2].map(
  (n) =>
    ({
      url: `https://github.com/o/r/pull/${n}`,
      number: n,
      repo: 'o/r',
      baseRepo: 'o/r',
      headRepo: 'o/r',
      baseBranch: n === 1 ? 'main' : 'one',
      headBranch: n === 1 ? 'one' : 'two',
      baseSha: n === 1 ? 'base' : 'head1',
      headSha: `head${n}`,
      title: `PR ${n}`,
      description: '',
      author: 'dev',
      state: 'open',
      merged: false,
      role: 'review-requested',
    }) as ReviewMember
);
const subject: ReviewSubject = {
  id: 'stack',
  kind: 'stack',
  title: 'Stack',
  members,
  edges: [{ parent: members[0].url, child: members[1].url, evidence: 'branch' }],
  warnings: [],
};
const file = {
  path: 'one.ts',
  status: 'modified' as const,
  additions: 1,
  deletions: 1,
  patch: '@@ -1 +1 @@\n-old\n+new',
  changeId: 'net',
};
function source(n: number): PrChanges {
  return {
    version: 1,
    url: members[n].url,
    metadata: members[n],
    comparisonBase: n === 0 ? 'ancestor' : 'head1',
    files: [file],
    fetchedAt: 0,
  };
}
function fixture() {
  const calls: string[] = [];
  let stale = false,
    count = 1;
  const pool = createGitHubClientPool({
    minSpacingMs: 0,
    fetch: ((input: string) => {
      const u = new URL(input);
      calls.push(u.pathname);
      if (u.pathname.includes('/contents/'))
        return Promise.resolve(new Response(u.searchParams.get('ref') === 'ancestor' ? 'old' : 'new'));
      return Promise.resolve(
        new Response(
          JSON.stringify({
            merge_base_commit: {
              sha: u.pathname.endsWith('head1...head2') ? (stale ? 'old-parent' : 'head1') : 'ancestor',
            },
            files: Array.from({ length: count }, (_, i) => ({
              filename: i ? `file${i}.ts` : 'one.ts',
              status: 'modified',
              sha: 'blob',
              patch: file.patch,
              additions: 1,
              deletions: 1,
            })),
          }),
          { headers: { 'content-type': 'application/json' } }
        )
      );
    }) as typeof fetch,
  });
  const client = pool.client('test');
  const service = createStackChangesService({
    manifest: (_client, url) => Promise.resolve(source(url.endsWith('/1') ? 0 : 1)),
  });
  return {
    service,
    client,
    calls,
    stale: () => {
      stale = true;
    },
    many: () => {
      count = 300;
    },
  };
}
void test('combined comparisons require a single complete same-repository chain', () => {
  assert.deepEqual(linearStack({ ...subject, members: [...members].reverse() }), members);
  assert.equal(stackRevisionKey(subject), stackRevisionKey({ ...subject, members: [...members].reverse() }));
  assert.throws(() => linearStack({ ...subject, edges: [] }), /single base/);
  assert.throws(
    () =>
      linearStack({
        ...subject,
        edges: [...subject.edges, { parent: members[1].url, child: members[0].url, evidence: 'manual' }],
      }),
    /single base/
  );
  assert.throws(
    () => linearStack({ ...subject, members: [members[0], { ...members[1], headRepo: 'other/repo' }] }),
    /same repository/
  );
  const third = { ...members[1], url: 'https://github.com/o/r/pull/3' };
  assert.throws(
    () =>
      linearStack({
        ...subject,
        members: [...members, third],
        edges: [...subject.edges, { parent: members[0].url, child: third.url, evidence: 'branch' }],
      }),
    /branches/
  );
});
void test('net comparison pins merge-base and top head, reuses cache, and loads correct file sides', async () => {
  const f = fixture();
  const value = await f.service.read(f.client, subject);
  assert.equal(value.comparisonBase, 'ancestor');
  assert.equal(value.metadata.baseSha, 'base');
  assert.equal(value.metadata.headSha, 'head2');
  assert.deepEqual(
    value.stackComparison?.fileSources['one.ts'],
    members.map((m) => m.url)
  );
  const before = f.calls.length;
  assert.equal(await f.service.read(f.client, subject), value);
  assert.equal(f.calls.length, before);
  const req = {
    url: value.url,
    path: 'one.ts',
    baseSha: 'base',
    headSha: 'head2',
    stackComparison: value.stackComparison.key,
  };
  assert.deepEqual(await f.service.content(f.client, req), {
    before: { kind: 'text', content: 'old' },
    after: { kind: 'text', content: 'new' },
  });
  assert.notEqual(preparedFileKey(req), preparedFileKey({ ...req, stackComparison: undefined }));
  await assert.rejects(f.service.find(f.client, { ...req, url: members[0].url }), /Reload/);
  await assert.rejects(f.service.find(f.client, { ...req, headSha: 'newer' }), /Reload/);
});
void test('a stale child never masquerades as the complete result of current parent PRs', async () => {
  const f = fixture();
  f.stale();
  await assert.rejects(f.service.read(f.client, subject), /PR #2 does not include.*PR #1/);
  assert.equal(f.calls.filter((c) => c.endsWith('base...head2')).length, 0);
});
void test('comparison cap stays explicitly partial, with all available paths preserved', async () => {
  const f = fixture();
  f.many();
  const value = await f.service.read(f.client, subject);
  assert.equal(value.files.length, 300);
  assert.equal(value.filesTruncated, true);
});
void test('combined progress is separate and unchanged net content retains its identity', () => {
  const s = { ...source(1), stackComparison: { key: 'first', subjectId: 'stack', members: [], fileSources: {} } };
  assert.match(stackFileProgressKey(s, file), /^stack:/);
  assert.equal(
    stackFileProgressKey(s, file),
    stackFileProgressKey({ ...s, metadata: { ...s.metadata, headSha: 'new' } }, file)
  );
  assert.notEqual(stackFileProgressKey(s, file), stackFileProgressKey(s, { ...file, changeId: 'changed' }));
});
void test('combined threads map only exact sides and keep outdated or unrelated revisions out of line', () => {
  const snapshot = { ...source(1), comparisonBase: 'ancestor' },
    root = { metadata: members[0], comparisonBase: 'ancestor' },
    tip = { metadata: members[1], comparisonBase: 'head1' };
  const thread = { line: 1, diffSide: 'RIGHT', path: 'one.ts', isOutdated: false } as GitHubReviewThread;
  const data = { headSha: 'head2', baseSha: 'head1', threads: [thread] };
  assert.equal(combinedThreadIsInline(snapshot, file, tip, data, thread), true);
  assert.equal(
    combinedThreadIsInline(snapshot, file, root, { ...data, headSha: 'head1', baseSha: 'base' }, thread),
    false
  );
  assert.equal(
    combinedThreadIsInline(
      snapshot,
      file,
      root,
      { ...data, headSha: 'head1', baseSha: 'base' },
      { ...thread, diffSide: 'LEFT' }
    ),
    true
  );
  assert.equal(combinedThreadIsInline(snapshot, file, tip, data, { ...thread, isOutdated: true }), false);
  assert.equal(combinedThreadIsInline(snapshot, file, tip, { ...data, headSha: 'newer' }, thread), false);
});
void test('cancelled combined reads release their member requests and permit a fresh retry', async () => {
  const f = fixture();
  let cancelled = 0;
  const service = createStackChangesService({
    manifest: (_client, _url, _refresh, _options, signal) =>
      new Promise((_, reject) => {
        signal?.addEventListener(
          'abort',
          () => {
            cancelled++;
            reject(new Error('Cancelled'));
          },
          { once: true }
        );
      }),
  });
  const controller = new AbortController();
  const first = service.read(f.client, subject, false, controller.signal);
  await new Promise((resolve) => setTimeout(resolve, 5));
  controller.abort();
  await assert.rejects(first);
  assert.equal(cancelled, 2);
});

void test('source links follow a file through intermediate renames without confusing a reused name', () => {
  const root = {
    ...source(0),
    files: [{ ...file, path: 'middle.ts', previousPath: 'old.ts', status: 'renamed' as const }],
  };
  const tip = {
    ...source(1),
    files: [{ ...file, path: 'final.ts', previousPath: 'middle.ts', status: 'renamed' as const }],
  };
  assert.deepEqual(stackFileSources('final.ts', [root, tip]), [
    { url: root.url, path: 'middle.ts' },
    { url: tip.url, path: 'final.ts' },
  ]);
  assert.deepEqual(
    stackFileSources('final.ts', [root, { ...tip, files: [{ ...file, path: 'final.ts', status: 'added' }] }]),
    [{ url: tip.url, path: 'final.ts' }]
  );
});
void test('saved comparisons can be restored by a new service but remain account-scoped', async () => {
  const f = fixture();
  const saved = await f.service.read(f.client, subject);
  let reads = 0;
  const restored = createStackChangesService({
    manifest: () => {
      reads++;
      return Promise.reject(new Error('Network should not be needed'));
    },
  });
  const value = await restored.read(f.client, subject);
  assert.deepEqual(value, saved);
  assert.equal(reads, 0);
  assert.ok(saved.stackComparison);
  const other = createGitHubClientPool().client('another-account');
  await assert.rejects(
    restored.find(other, {
      url: saved.url,
      path: file.path,
      baseSha: saved.metadata.baseSha,
      headSha: saved.metadata.headSha,
      stackComparison: saved.stackComparison.key,
    }),
    /Reload/
  );
});
