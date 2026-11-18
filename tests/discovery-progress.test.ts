/**
 * Discovery reports its pass through the queue's sync state (lib/workbench.ts, `WorkbenchSync`): PRs read so far and
 * the pass's total, whether the reader asked for it, why it failed, and whether the change signals answer. The
 * Overview's freshness line reads these (lib/overview-freshness.ts). Synthetic client; nothing reaches GitHub.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Octokit } from '@octokit/rest';
import { createWorkbenchService, type WorkbenchPreferences } from '../src/workbench-service';
import { DEFAULT_CLAUDE_MODEL } from '../lib/models';

const COUNT = 12;
const url = (n: number) => `https://github.com/owner/repo/pull/${n}`;
const pull = (n: number) => ({
  number: n,
  title: `PR ${n}`,
  body: '',
  user: { login: 'author' },
  base: { ref: 'main', sha: 'base', repo: { full_name: 'owner/repo', archived: false, default_branch: 'main' } },
  head: { ref: `branch-${n}`, sha: `head-${n}`, repo: { full_name: 'owner/repo', archived: false } },
  merged: false,
  state: 'open',
  created_at: '2026-11-17T00:00:00Z',
  updated_at: '2026-11-17T00:00:00Z',
  html_url: url(n),
  labels: [],
  mergeable: true,
  draft: false,
  commits: 1,
  requested_reviewers: [],
  requested_teams: [],
  mergeable_state: 'clean',
  auto_merge: null,
  milestone: null,
});

function setup(options: { signals?: () => boolean; fail?: boolean } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gnosis-discovery-progress-'));
  const numbers = Array.from({ length: COUNT }, (_, i) => i + 1);
  // Each PR read waits for the test to let it answer.
  const waiting: (() => void)[] = [];
  let reads = 0;
  let changes = 0;
  const client = {
    search: {
      issuesAndPullRequests: () => {
        if (options.fail) return Promise.reject(new Error('getaddrinfo ENOTFOUND api.github.com'));
        return Promise.resolve({
          data: {
            items: numbers.map((n) => ({ number: n, title: `PR ${n}`, html_url: url(n), repository_url: 'https://api.github.com/repos/owner/repo', user: { login: 'author' }, updated_at: '2026-11-17T00:00:00Z', draft: false })),
          },
        });
      },
    },
    pulls: {
      get: ({ pull_number }: { pull_number: number }) =>
        new Promise((resolve) => {
          reads++;
          waiting.push(() => resolve({ data: pull(pull_number) }));
        }),
      list: (args: { head?: string }) => Promise.resolve({ data: args.head ? [] : numbers.map(pull) }),
    },
  } as unknown as Octokit;
  const prefs = { provider: 'claude', model: DEFAULT_CLAUDE_MODEL, watchedRepos: [], autoBriefings: false, briefingDailyLimit: 0 } as WorkbenchPreferences;
  const service = createWorkbenchService({
    directory: () => directory,
    auth: () => ({ token: 'fixture', login: 'reviewer' }),
    preferences: () => prefs,
    history: () => [],
    busy: () => false,
    client: () => client,
    changed: () => { changes++; },
    ...(options.signals ? { signalsHealthy: options.signals } : {}),
  });
  const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
  return {
    service,
    reads: () => reads,
    changes: () => changes,
    /** Waits until `count` reads are waiting, then answers them. */
    async answer(count: number) {
      for (let i = 0; i < 200 && waiting.length < count; i++) await turn();
      assert.ok(waiting.length >= count, `expected ${count} PR reads to wait, saw ${waiting.length}`);
      for (const resolve of waiting.splice(0, count)) resolve();
      for (let i = 0; i < 20; i++) await turn();
    },
    async until(done: () => boolean) {
      for (let i = 0; i < 200 && !done(); i++) await turn();
      assert.ok(done());
    },
    cleanup: () => fs.rmSync(directory, { recursive: true, force: true }),
  };
}

void test('a pass the reader asked for reports requested, then its PR count batch by batch', async () => {
  const s = setup();
  try {
    const pass = s.service.queue(true);
    const sync = () => s.service.snapshot().sync;
    assert.equal(sync()?.status, 'checking');
    assert.equal(sync()?.requested, true, 'Refresh marks the pass as the reader\'s');
    assert.equal(sync()?.progress, undefined, 'no total before the PR list is read');
    assert.ok(s.changes() >= 1, 'the pass is broadcast as it starts');
    // The search answered: the total is known before any PR is read, and broadcast once.
    await s.until(() => s.reads() >= 5);
    assert.deepEqual(sync()?.progress, { done: 0, total: COUNT });
    await s.answer(5);
    assert.deepEqual(sync()?.progress, { done: 5, total: COUNT }, 'a batch counts before its snapshot is published');
    await s.answer(5);
    assert.deepEqual(sync()?.progress, { done: 10, total: COUNT });
    await s.answer(2);
    await pass;
    const done = sync();
    assert.equal(done?.status, 'idle');
    assert.equal(done?.progress, undefined, 'a finished pass has no progress');
    assert.equal(done?.requested, undefined);
    assert.equal(typeof done?.checkedAt, 'number', 'checkedAt is when the pass finished');
  } finally {
    s.cleanup();
  }
});

void test('an automatic pass is not requested until the reader joins it with Refresh', async () => {
  const s = setup();
  try {
    void s.service.queue();
    const sync = () => s.service.snapshot().sync;
    assert.equal(sync()?.status, 'checking');
    assert.equal(sync()?.requested, undefined, 'main\'s own pass is a quiet note, not a spinner');
    await s.answer(5);
    assert.deepEqual(sync()?.progress, { done: 5, total: COUNT });
    const joined = s.service.queue(true);
    assert.equal(sync()?.requested, true, 'Refresh during a pass makes it the reader\'s');
    assert.deepEqual(sync()?.progress, { done: 5, total: COUNT }, 'joining keeps the count');
    await s.answer(5);
    await s.answer(2);
    await joined;
    assert.equal(sync()?.status, 'idle');
  } finally {
    s.cleanup();
  }
});

void test('a failed pass says GitHub was unreachable; snapshots carry the change signals\' health', async () => {
  let healthy = true;
  const s = setup({ fail: true, signals: () => healthy });
  try {
    await assert.rejects(s.service.queue(true));
    const sync = s.service.snapshot().sync;
    assert.equal(sync?.status, 'error');
    assert.equal(sync?.reason, 'unreachable');
    assert.equal(sync?.signals, true);
    healthy = false;
    assert.equal(s.service.snapshot().sync?.signals, false);
  } finally {
    s.cleanup();
  }
});
