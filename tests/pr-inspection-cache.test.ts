import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrInspectionCache } from '../lib/pr-inspection-cache';
import type { InspectionRevision, PrChanges } from '../lib/pr-changes';
import type { PrCommits, PrCommit } from '../lib/pr-commits';
import type { PrMetadata } from '../lib/types';
const r = { url: 'https://github.com/o/r/pull/1', baseSha: 'base', headSha: 'head' };
function fixture(options: { truncatedHead?: string; commits?: number; comparisonFiles?: boolean; onFile?: (snapshot: PrChanges, file: string) => Promise<void> } = {}) {
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
    filesTruncated: revision.headSha === options.truncatedHead,
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
        commits: Array.from({ length: options.commits ?? 1 }, (_, i) => ({ sha: `commit-${i}` } as PrCommit)),
        fetchedAt: now,
      } as PrCommits);
    },
    comparison: (list, commit) => {
      calls.push(`comparison:${list.metadata.headSha}:${commit.sha}`);
      if (!options.comparisonFiles) return Promise.resolve(undefined);
      return Promise.resolve({ ...changes({ ...r, url: list.url, headSha: list.metadata.headSha }),
        files: [{ path: `history-${commit.sha}.ts`, status: 'modified', changeId: commit.sha, additions: 1, deletions: 0 }] });
    },
    file: (snapshot, file) => {
      calls.push(`file:${snapshot.metadata.headSha}:${file.path}`);
      return fail ? Promise.reject(new Error('API allowance')) : options.onFile?.(snapshot, file.path) ?? Promise.resolve();
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
void test('capped PRs retain tab data without monopolizing preloads or preparing incomplete explanations', async () => {
  const f = fixture({ truncatedHead: r.headSha });
  const other = { ...r, url: r.url + '2', headSha: 'small' };
  try {
    f.cache.setTargets('one', [r, other]);
    await f.cache.flush();
    assert.equal(f.cache.peekChanges(r)?.filesTruncated, true);
    assert.ok(f.cache.peekCommits(r));
    assert.deepEqual(f.calls.filter(call => call.includes(':head')), ['changes:head', 'commits:head']);
    assert.ok(f.calls.includes('review:small'), 'Other PRs still finish preparation');
    assert.equal(f.cache.activity(), undefined);
    const count = f.calls.length;
    f.cache.setTargets('one', [r, other]);
    await f.cache.flush();
    assert.equal(f.calls.length, count, 'No repeated retries of a permanent API cap');
  } finally { f.cache.stop(); }
});
void test('discovery preloads tab data and every changed file; unchanged revisions do no work', async () => {
  const f = fixture();
  try {
    f.cache.setTargets('one', [r]);
    await f.cache.flush();
    assert.ok(f.cache.peekChanges(r));
    assert.ok(f.cache.peekCommits(r));
    assert.equal(f.calls.filter((call) => call.startsWith('file:')).length, 3);
    assert.ok(f.calls.includes('comparison:head:commit-0'));
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
    comparison: () => Promise.resolve(undefined),
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

void test('prepares other PR file lists before downloading every file of the first PR', async () => {
  const f = fixture();
  try {
    f.cache.setTargets('one', [r, { ...r, url: r.url + '2', headSha: 'second' }]);
    await f.cache.flush();
    assert.ok(
      f.calls.indexOf('changes:second') < f.calls.indexOf('file:head:first.ts'),
      'A large first PR must not block other Changes tabs from getting their file lists'
    );
  } finally {
    f.cache.stop();
  }
});
void test('leaving the queue preserves prepared tab data for the same account', async () => {
  const f = fixture();
  try {
    f.cache.setTargets('one', [r]);
    await f.cache.flush();
    f.cache.stop();
    assert.ok(f.cache.peekChanges(r), 'Returning to Changes must synchronously find its prepared file list');
    const calls = f.calls.length;
    f.cache.setTargets('one', [r]);
    await f.cache.flush();
    assert.equal(f.calls.length, calls, 'Navigation does not repeat completed preparation');
    f.cache.setTargets('two', []);
    assert.equal(f.cache.peekChanges(r), undefined, 'Account changes still discard prepared data');
  } finally {
    f.cache.stop();
  }
});

void test('restores saved inventories before a cold PR can block the worker on GitHub', async () => {
  const savedRevision = { ...r, url: r.url + '2', headSha: 'saved' };
  const snapshot = {
    version: 1,
    url: savedRevision.url,
    metadata: { ...savedRevision, title: 'Saved' } as PrMetadata,
    comparisonBase: 'base',
    files: [],
    fetchedAt: 1,
  } as PrChanges;
  let release: (() => void) | undefined;
  const cache = createPrInspectionCache({
    restore: () => Promise.resolve({ changes: [snapshot], commits: [] }),
    changes: () =>
      new Promise((_resolve, reject) => {
        release = () => reject(new Error('offline'));
      }),
    commits: () => Promise.reject(new Error('offline')),
    comparison: () => Promise.resolve(undefined),
    file: () => Promise.resolve(),
    review: () => Promise.resolve(),
    visible: () => true,
  });
  try {
    cache.setTargets('one', [r, savedRevision]);
    const pending = cache.flush();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(
      cache.peekChanges(savedRevision),
      snapshot,
      'Saved Changes is ready even while the first PR waits on GitHub'
    );
    cache.stop();
    release?.();
    await pending;
  } finally {
    cache.stop();
  }
});

void test('active and visible PRs precede unread work, then current view and backlog', async () => {
  const f = fixture({ commits: 3, comparisonFiles: true });
  const revisions = ['backlog', 'view', 'unread', 'visible', 'active'].map((headSha, i) => ({ ...r, url: `${r.url}${i}`, headSha }));
  try {
    f.cache.setTargets('one', revisions, { active: [revisions[4].url], visible: [revisions[3].url], unread: [revisions[2].url, revisions[3].url, revisions[4].url], view: [revisions[1].url] });
    await f.cache.flush();
    for (const [first, second] of [['active', 'visible'], ['visible', 'unread'], ['unread', 'view'], ['view', 'backlog']]) {
      assert.ok(f.calls.indexOf(`file:${first}:history-commit-0.ts`) < f.calls.indexOf(`changes:${second}`));
    }
    assert.equal(f.calls.filter(call => call.startsWith('comparison:')).length, 15, 'Every commit, not just the newest');
    assert.equal(f.calls.filter(call => call.includes(':history-')).length, 15, 'Every commit file');
    assert.ok(f.calls.indexOf('comparison:active:commit-2') < f.calls.indexOf('comparison:active:commit-1'));
    const count = f.calls.length;
    f.cache.setTargets('one', revisions, { active: [revisions[4].url] });
    await f.cache.flush();
    assert.equal(f.calls.length, count, 'Priority changes do not repeat completed downloads');
  } finally { f.cache.stop(); }
});

void test('selection changes interrupt the backlog after the in-flight file; unfinished work resumes', async () => {
  let release!: () => void;
  let entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  let blocked = false;
  const f = fixture({ onFile: async (snapshot) => {
    if (snapshot.metadata.headSha === 'head' && !blocked) {
      blocked = true; entered(); await new Promise<void>(resolve => { release = resolve; });
    }
  } });
  const second = { ...r, url: r.url + '2', headSha: 'second' };
  try {
    f.cache.setTargets('one', [r, second]);
    const loading = f.cache.flush();
    await waiting;
    f.cache.setTargets('one', [r, second], { active: [second.url] });
    release(); await loading;
    assert.ok(f.calls.indexOf('review:second') < f.calls.indexOf('file:head:second.ts'));
    assert.equal(f.calls.filter(call => call === 'file:head:first.ts').length, 1);
    assert.ok(f.calls.includes('review:head'), 'Lower-priority work eventually finishes');
  } finally { f.cache.stop(); }
});

void test('new revisions preserve cached content and only schedule the changed PR', async () => {
  const f = fixture({ commits: 2 });
  const second = { ...r, url: r.url + '2', headSha: 'second' };
  try {
    f.cache.setTargets('one', [r, second]); await f.cache.flush();
    f.calls.length = 0;
    const next = { ...r, headSha: 'updated' };
    f.cache.setTargets('one', [next, second]);
    assert.equal(f.cache.peekChanges(next)?.metadata.headSha, 'head', 'Keep usable content during preparation');
    await f.cache.flush();
    assert.ok(f.calls.length > 0);
    assert.ok(f.calls.every(call => call.includes(':updated')));
    assert.equal(f.cache.peekChanges(next)?.metadata.headSha, 'updated');
  } finally { f.cache.stop(); }
});

void test('queues larger than the inventory memory limit still prepare every PR', async () => {
  const f = fixture();
  try {
    const revisions = Array.from({ length: 1002 }, (_, i) => ({ ...r, url: `${r.url}/${i}`, headSha: `head-${i}` }));
    f.cache.setTargets('one', revisions);
    await f.cache.flush();
    assert.equal(new Set(f.calls.filter(call => call.startsWith('review:'))).size, revisions.length);
  } finally { f.cache.stop(); }
});

void test('marking work read demotes unfinished downloads without repeating completed files', async () => {
  const other = { ...r, url: r.url + '2', headSha: 'unread' };
  let changed = false;
  const f = fixture({ onFile: () => {
    if (!changed) {
      changed = true;
      // The first PR was read while its first file was in flight.
      f.cache.setTargets('one', [r, other], { unread: [other.url] });
    }
    return Promise.resolve();
  } });
  try {
    f.cache.setTargets('one', [r, other], { unread: [r.url] });
    await f.cache.flush();
    assert.equal(f.calls[0], 'changes:head');
    assert.ok(f.calls.indexOf('review:unread') < f.calls.indexOf('file:head:second.ts'));
    assert.equal(f.calls.filter(call => call === 'file:head:first.ts').length, 1);
    assert.ok(f.calls.includes('review:head'), 'Read work still completes');
    const count = f.calls.length;
    f.cache.setTargets('one', [r, other], { unread: [r.url, other.url] });
    await f.cache.flush();
    assert.equal(f.calls.length, count, 'Marking completed work unread does not download it again');
  } finally { f.cache.stop(); }
});

void test('preload activity reports the current PR, pending counts, backoff, and completion', async () => {
  let release!: () => void;
  let entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  let blocked = false;
  const f = fixture({ onFile: () => {
    if (!blocked) {
      blocked = true; entered();
      return new Promise<void>(resolve => { release = resolve; });
    }
    return Promise.resolve();
  } });
  try {
    assert.equal(f.cache.activity(), undefined);
    f.cache.setTargets('one', [r]);
    const loading = f.cache.flush();
    await waiting;
    const task = f.cache.activity();
    assert.ok(task);
    assert.equal(task.kind, 'preload');
    assert.equal(task.status, 'running');
    assert.match(task.detail, /o\/r #1.*Changed files/);
    assert.deepEqual(task.progress, { completed: 0, total: 1, unit: 'PRs' });
    release(); await loading;
    assert.equal(f.cache.activity(), undefined, 'Completed preparation disappears instead of becoming a ready notification');
    f.fail(true);
    f.cache.setTargets('one', [{ ...r, headSha: 'new' }]);
    await f.cache.flush();
    assert.equal(f.cache.activity()?.status, 'paused');
    assert.match(f.cache.activity()?.detail ?? '', /API allowance.*Retrying automatically/);
    f.fail(false); f.advance(); await f.cache.flush();
    assert.equal(f.cache.activity(), undefined);
    f.cache.setTargets('one', [{ ...r, headSha: 'another' }]);
    assert.ok(f.cache.activity());
    f.cache.setTargets(null, []);
    assert.equal(f.cache.activity(), undefined, 'Sign-out removes the old account activity');
  } finally { f.cache.stop(); }
});

void test('one GitHub cooldown pauses the entire preload queue until the advertised deadline', async () => {
  let now = 1_000_000;
  const retryAt = now + 600_000;
  const calls: string[] = [];
  let limited = true;
  const cache = createPrInspectionCache({
    now: () => now, visible: () => true,
    changes: revision => {
      calls.push(revision.url);
      if (limited) return Promise.reject(new Error(`Error invoking remote method: GitHub updates are paused to protect your API allowance. GitHub requests can resume after ${new Date(retryAt).toISOString()}.`));
      return Promise.resolve({ version: 1, ...revision, metadata: { ...revision, title: 'PR' } as PrMetadata, comparisonBase: 'base', fetchedAt: now, files: [] });
    },
    commits: revision => Promise.resolve({ version: 1, url: revision.url, metadata: revision as PrMetadata, fetchedAt: now, commits: [] }),
    file: async () => {}, comparison: () => Promise.resolve(undefined), review: async () => {},
  });
  try {
    const targets = Array.from({ length: 10 }, (_, i) => ({ ...r, url: `${r.url}${i}` }));
    cache.setTargets('account', targets);
    await cache.flush();
    assert.equal(calls.length, 1, 'Do not retry the same account cooldown for every PR');
    assert.equal(cache.activity()?.status, 'paused');
    now += 31_000;
    cache.setTargets('account', targets, { active: [targets[4].url] });
    await cache.flush();
    assert.equal(calls.length, 1, 'Navigation and the generic retry interval cannot bypass the deadline');
    limited = false;
    await cache.readChanges(targets[4]);
    assert.equal(calls.length, 2, 'Explicit UI reads still reach the backend, which enforces the actual allowance');
    now = retryAt;
    await cache.flush();
    assert.equal(cache.activity(), undefined, 'All queued PRs resume automatically at the deadline');
  } finally { cache.stop(); }
});

void test('a late cooldown from the previous account cannot pause new account preloads', async () => {
  let reject!: (error: Error) => void;
  let reads = 0;
  const cache = createPrInspectionCache({
    visible: () => true,
    changes: revision => {
      if (++reads === 1) return new Promise<PrChanges>((_resolve, fail) => { reject = fail; });
      return Promise.resolve({ version: 1, ...revision, metadata: { ...revision, title: 'PR' } as PrMetadata, comparisonBase: 'base', fetchedAt: 1, files: [] });
    },
    commits: revision => Promise.resolve({ version: 1, url: revision.url, metadata: revision as PrMetadata, fetchedAt: 1, commits: [] }),
    file: async () => {}, comparison: () => Promise.resolve(undefined), review: async () => {},
  });
  try {
    cache.setTargets('old', [r]);
    const old = cache.flush();
    cache.setTargets('new', [r]);
    reject(new Error(`GitHub requests can resume after ${new Date(Date.now() + 600_000).toISOString()}.`));
    await old;
    await cache.flush();
    assert.equal(reads, 2);
    assert.equal(cache.activity(), undefined);
  } finally { cache.stop(); }
});
