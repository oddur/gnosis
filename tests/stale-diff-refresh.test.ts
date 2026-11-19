import assert from 'node:assert/strict';
import test from 'node:test';
import { createStaleDiffRefresh, staleAttemptKey, staleStatus, type Revision, type StaleTarget } from '../lib/stale-diff-refresh';
import type { PrFileRequest } from '../lib/pr-changes';

const url = 'https://github.com/o/r/pull/1';
const target = (path: string, headSha = 'head1', extra: Partial<StaleTarget> = {}): StaleTarget => ({
  request: { url, path, baseSha: 'base', headSha },
  fileKey: JSON.stringify([url, path, 'base', headSha]),
  both: false,
  pinned: false,
  ...extra,
});

/** A refresh with a manual clock: timers run when the test says, and every call is logged. */
function harness(shown?: (revision: Revision) => Revision | undefined) {
  let now = 0;
  const timers: { at: number; run: () => void; cancelled: boolean }[] = [];
  const log: string[] = [];
  const refresh = createStaleDiffRefresh({
    refresh: (u, revision, paths, interactive) => {
      log.push(`refresh ${revision.headSha} ${paths.join(',')}${interactive ? ' interactive' : ''}`);
      return Promise.resolve(shown ? shown(revision) : revision);
    },
    drop: (request: PrFileRequest) => log.push(`drop ${request.path}`),
    reread: (request, both, interactive) => {
      log.push(`read ${request.path}${both ? ' both' : ''}${interactive ? ' interactive' : ''}`);
      return Promise.resolve();
    },
    delayMs: 300,
    maxDelayMs: 1000,
    now: () => now,
    schedule: (run, ms) => {
      const timer = { at: now + ms, run, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
  });
  const advance = async (ms: number) => {
    now += ms;
    for (const timer of timers.filter((t) => !t.cancelled && t.at <= now)) {
      timer.cancelled = true;
      timer.run();
    }
    // Let the refresh and the reads after it settle.
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };
  return { refresh, log, advance };
}

void test('ten files that go stale together share one refresh, at the view tier', async () => {
  const { refresh, log, advance } = harness();
  const targets = Array.from({ length: 10 }, (_, i) => target(`src/f${i}.ts`));
  for (const t of targets) {
    refresh.report(t);
    await advance(50);
  }
  assert.equal(log.filter((line) => line.startsWith('refresh')).length, 0, 'Each report restarts the wait');
  assert.ok(targets.every((t) => refresh.attempt(staleAttemptKey(t)) === 'refreshing'));
  await advance(300);
  const refreshes = log.filter((line) => line.startsWith('refresh'));
  assert.deepEqual(refreshes, [`refresh head1 ${targets.map((t) => t.request.path).join(',')}`], 'One refresh, never interactive');
  assert.equal(log.filter((line) => line.startsWith('drop')).length, 10, 'Each file’s cached contents are dropped');
  assert.equal(log.filter((line) => line.startsWith('read') && !line.includes('interactive')).length, 10);
  assert.ok(targets.every((t) => refresh.attempt(staleAttemptKey(t)) === 'done'));
  assert.equal(refresh.stats().refreshes, 1);
});

void test('reports that keep coming wait at most the longest delay', async () => {
  const { refresh, log, advance } = harness();
  for (let i = 0; i < 12; i++) {
    refresh.report(target(`src/f${i}.ts`));
    await advance(100);
  }
  assert.equal(log.filter((line) => line.startsWith('refresh')).length, 1, 'The batch ran at the longest delay');
});

void test('each file revision gets one automatic attempt: a file that stays stale never loops', async () => {
  const { refresh, log, advance } = harness();
  const t = target('src/a.ts');
  refresh.report(t);
  await advance(300);
  assert.equal(refresh.attempt(staleAttemptKey(t)), 'done');
  // Still stale after the refresh: the view reports it again on every render; nothing more happens.
  for (let i = 0; i < 5; i++) {
    refresh.report(t);
    await advance(1000);
  }
  assert.equal(log.filter((line) => line.startsWith('refresh')).length, 1);
  // A new head is a new file revision: it may refresh once more.
  refresh.report(target('src/a.ts', 'head2'));
  await advance(300);
  assert.equal(log.filter((line) => line.startsWith('refresh')).length, 2);
});

void test('still stale after the refresh at the same head records one mismatch; Refresh retries at once', async () => {
  const { refresh, log, advance } = harness();
  const t = target('src/a.ts');
  const key = staleAttemptKey(t);
  const mismatch = {
    url,
    path: 'src/a.ts',
    headSha: 'head1',
    line: 48,
    patch: { endings: 'lf' as const, finalNewline: true, bom: false },
    file: { endings: 'crlf' as const, finalNewline: true, bom: false },
    lineEndingsDiffer: true,
  };
  refresh.mismatch(key, mismatch);
  assert.equal(refresh.stats().mismatches.length, 0, 'Nothing is recorded before the refresh');
  refresh.report(t);
  await advance(300);
  refresh.mismatch(key, mismatch);
  refresh.mismatch(key, mismatch);
  assert.deepEqual(
    refresh.stats().mismatches.map((entry) => ({ ...entry, at: 0 })),
    [{ ...mismatch, at: 0 }],
    'One diagnostics entry with the PR, path, head, line and line endings'
  );
  refresh.retry(t);
  assert.equal(refresh.attempt(key), 'refreshing');
  await advance(0);
  assert.deepEqual(log.slice(-3), ['drop src/a.ts', 'refresh head1 src/a.ts interactive', 'read src/a.ts interactive']);
  assert.equal(refresh.attempt(key), 'done');
  refresh.mismatch(key, mismatch);
  assert.equal(refresh.stats().mismatches.length, 2, 'The manual attempt records its own outcome');
});

void test('a refresh that finds a new head reads nothing at the old one; a topic’s pinned revision still reads', async () => {
  const { refresh, log, advance } = harness((revision) => ({ ...revision, headSha: 'head2' }));
  refresh.report(target('src/a.ts'));
  refresh.report(target('src/topic.ts', 'head1', { pinned: true, both: true }));
  await advance(300);
  assert.deepEqual(log.filter((line) => line.startsWith('read')), ['read src/topic.ts both']);
});

void test('a view that shows the PR registers its own refresh; files of a commit comparison only read again', async () => {
  const { refresh, log, advance } = harness();
  const calls: string[] = [];
  const stop = refresh.register(url, (_url, revision, paths) => {
    calls.push(paths.join(','));
    return Promise.resolve(revision);
  });
  refresh.report(target('src/a.ts'));
  await advance(300);
  assert.deepEqual(calls, ['src/a.ts']);
  assert.equal(log.filter((line) => line.startsWith('refresh')).length, 0, 'The view’s refresh ran instead');
  stop();
  const commit = target('src/c.ts', 'commit1');
  commit.request = { ...commit.request, comparison: { url, prBaseSha: 'base', prHeadSha: 'head1', firstSha: 'c', lastSha: 'c' } };
  refresh.report(commit);
  await advance(300);
  assert.equal(log.filter((line) => line.startsWith('refresh')).length, 0);
  assert.deepEqual(log.slice(-2), ['drop src/c.ts', 'read src/c.ts']);
});

void test('the gap bar shows the update while a stale file refreshes, then the manual message if it is still stale', () => {
  assert.equal(staleStatus(false, true, undefined), undefined, 'Matching contents show nothing');
  assert.equal(staleStatus(true, true, undefined), 'refreshing', 'Stale, before the report lands');
  assert.equal(staleStatus(true, true, 'refreshing'), 'refreshing');
  assert.equal(staleStatus(false, true, 'refreshing'), 'refreshing', 'Its contents dropped, the file still waits');
  assert.equal(staleStatus(true, true, 'done'), 'mismatch', 'Still stale after the refresh: Couldn’t match, Refresh');
  assert.equal(staleStatus(false, true, 'done'), undefined, 'The refreshed data matched');
  assert.equal(staleStatus(true, false, undefined), 'stale', 'A local review cannot refresh');
});
