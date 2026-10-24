import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrInspectionCache } from '../lib/pr-inspection-cache';
import type { InspectionRevision, PrChanges } from '../lib/pr-changes';
import type { PrCommits } from '../lib/pr-commits';
import type { PrMetadata } from '../lib/types';
const r = { url: 'https://github.com/o/r/pull/1', baseSha: 'base', headSha: 'head' };
function fixture() {
  const calls: string[] = [];
  let now = 1000,
    fail = false,
    visible = true;
  const changes = (revision: InspectionRevision): PrChanges => ({
    version: 1,
    url: revision.url,
    metadata: { ...revision, title: 'PR' } as PrMetadata,
    comparisonBase: 'merge-base',
    fetchedAt: now,
    files: ['first.ts', 'second.ts', 'third.svg'].map((path) => ({
      path,
      status: 'modified',
      additions: 1,
      deletions: 1,
      changeId: path,
    })),
  });
  const cache = createPrInspectionCache({
    changes: (revision) => {
      calls.push(`changes:${revision.headSha}`);
      return Promise.resolve(changes(revision));
    },
    commits: (revision) => {
      calls.push(`commits:${revision.headSha}`);
      return Promise.resolve({
        version: 1,
        url: revision.url,
        metadata: changes(revision).metadata,
        commits: [],
        fetchedAt: now,
      } as PrCommits);
    },
    comparison: (list) => {
      calls.push(`comparison:${list.metadata.headSha}`);
      return Promise.resolve();
    },
    file: (snapshot, file) => {
      calls.push(`file:${snapshot.metadata.headSha}:${file.path}`);
      return fail ? Promise.reject(new Error('API allowance')) : Promise.resolve();
    },
    review: (snapshot) => {
      calls.push(`review:${snapshot.metadata.headSha}`);
      return Promise.resolve();
    },
    visible: () => visible,
    now: () => now,
  });
  return {
    cache,
    calls,
    fail: (value: boolean) => {
      fail = value;
    },
    visible: (value: boolean) => {
      visible = value;
    },
    advance: () => {
      now += 31_000;
    },
  };
}
void test('discovery preloads tab data and every changed file; unchanged revisions do no work', async () => {
  const f = fixture();
  try {
    f.cache.setTargets('one', [r]);
    await f.cache.flush();
    assert.ok(f.cache.peekChanges(r));
    assert.ok(f.cache.peekCommits(r));
    assert.equal(f.calls.filter((call) => call.startsWith('file:')).length, 3);
    assert.ok(f.calls.includes('comparison:head'));
    assert.ok(f.calls.includes('review:head'));
    const count = f.calls.length;
    f.cache.setTargets('one', [r]);
    await f.cache.flush();
    await f.cache.readChanges(r);
    await f.cache.readCommits(r);
    assert.equal(f.calls.length, count, 'Opening either tab reuses already prepared data');
    f.cache.setTargets('one', [{ ...r, headSha: 'new' }]);
    await f.cache.flush();
    assert.equal(f.cache.peekChanges({ ...r, headSha: 'new' })?.metadata.headSha, 'new');
    assert.equal(f.calls.filter((call) => call.startsWith('file:new:')).length, 3);
  } finally {
    f.cache.stop();
  }
});
void test('backoff resumes the failed file without repeating manifests or completed files', async () => {
  const f = fixture();
  try {
    f.fail(true);
    f.cache.setTargets('one', [r]);
    await f.cache.flush();
    assert.equal(f.calls.filter((call) => call.startsWith('file:')).length, 1);
    f.fail(false);
    f.advance();
    await f.cache.flush();
    assert.equal(f.calls.filter((call) => call.startsWith('changes:')).length, 1);
    assert.equal(f.calls.filter((call) => call.startsWith('file:')).length, 4);
    assert.ok(f.calls.includes('review:head'));
  } finally {
    f.cache.stop();
  }
});
void test('hidden windows defer preloading; queue order prioritizes the current PR', async () => {
  const f = fixture();
  try {
    f.visible(false);
    f.cache.setTargets('one', [{ ...r, headSha: 'selected', url: r.url + '2' }, r]);
    await f.cache.flush();
    assert.equal(f.calls.length, 0);
    f.visible(true);
    await f.cache.flush();
    assert.equal(f.calls[0], 'changes:selected');
    f.cache.setTargets('two', []);
    assert.equal(f.cache.peekChanges(r), undefined);
  } finally {
    f.cache.stop();
  }
});
void test('account changes discard late responses and stop the old preload chain', async () => {
  let release!: (value: PrChanges) => void;
  const snapshot = {
    url: r.url,
    metadata: { ...r, title: 'PR' } as PrMetadata,
    files: [],
    version: 1,
    comparisonBase: 'base',
    fetchedAt: 1,
  } as PrChanges;
  let commits = 0;
  const cache = createPrInspectionCache({
    changes: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
    commits: () => {
      commits++;
      return Promise.reject(new Error('must not run'));
    },
    file: () => Promise.resolve(),
    comparison: () => Promise.resolve(),
    review: () => Promise.resolve(),
    visible: () => true,
  });
  try {
    cache.setTargets('one', [r]);
    const pending = cache.flush();
    cache.setTargets('two', []);
    release(snapshot);
    await pending;
    assert.equal(cache.peekChanges(r), undefined);
    assert.equal(commits, 0);
  } finally {
    cache.stop();
  }
});
