import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Octokit } from '@octokit/rest';
import { createWorkbenchService, type WorkbenchPreferences } from '../src/workbench-service';
import { createCommandSearchService } from '../src/command-search-service';
import { groupSubjects, type ReviewMember } from '../lib/workbench';
import { normalizePrInactivityDays } from '../lib/pr-inactivity';
import { DEFAULT_CLAUDE_MODEL } from '../lib/models';
function member(number: number): ReviewMember {
  return {
    number,
    repo: 'owner/repo',
    headRepo: 'owner/repo',
    baseRepo: 'owner/repo',
    url: `https://github.com/owner/repo/pull/${number}`,
    title: `PR ${number}`,
    description: 'A saved PR',
    author: 'author',
    role: 'watched',
    baseBranch: 'main',
    headBranch: `feature-${number}`,
    baseSha: 'base',
    headSha: `head-${number}`,
    merged: false,
    state: 'open',
    createdAt: '2026-10-22',
    updatedAt: '2026-10-22',
    labels: [],
    mergeable: null,
    isDraft: false,
    commitCount: 1,
    requestedReviewers: [],
    requestedTeams: [],
    mergeableState: null,
    autoMerge: null,
    milestone: null,
  };
}
function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gnosis-inactivity-'));
  return { directory, cleanup: () => fs.rmSync(directory, { recursive: true, force: true }) };
}

const NOW = Date.parse('2026-10-24T12:00:00Z');
const age = (days: number) => new Date(NOW - days * 86400000).toISOString();
function dated(number: number, days: number): ReviewMember {
  return { ...member(number), updatedAt: age(days), createdAt: age(300) };
}
function prefs(): WorkbenchPreferences {
  return {
    provider: 'claude',
    model: DEFAULT_CLAUDE_MODEL,
    watchedRepos: ['owner/repo'],
    autoBriefings: false,
    briefingDailyLimit: 10,
  };
}

void test('inactivity defaults to 30 days, permits Never, and rejects invalid stored values', () => {
  for (const value of [undefined, null, '90', -1, 1.5, Infinity, NaN, 36501])
    assert.equal(normalizePrInactivityDays(value), 30);
  assert.equal(normalizePrInactivityDays(0), 0);
  assert.equal(normalizePrInactivityDays(90), 90);
});
void test('cached cutoff uses last update, keeps complete stacks and stars, and leaves local search available', async () => {
  const f = fixture();
  try {
    const recent = dated(1, 30),
      old = dated(2, 90),
      parent = dated(3, 200),
      child = { ...dated(4, 2), baseBranch: parent.headBranch };
    const subjects = groupSubjects([recent, old, parent, child]);
    fs.writeFileSync(
      path.join(f.directory, 'workbench.json'),
      JSON.stringify({ account: 'me', subjects, overrides: [], briefs: {}, day: '', used: 0 })
    );
    const preferences = prefs();
    let now = NOW;
    let busy = true;
    const service = createWorkbenchService({
      directory: () => f.directory,
      auth: () => ({ login: 'me', token: 'test' }),
      preferences: () => preferences,
      history: () => [],
      busy: () => busy,
      now: () => now,
      client: () => {
        throw Error('Unexpected network call');
      },
    });
    assert.equal(service.snapshot().items.length, 2);
    assert.equal(service.snapshot().items.find((item) => item.subject.kind === 'stack')?.subject.members.length, 2);
    assert.equal(service.cached().items.length, 3, 'Search retains old cached subjects');
    assert.equal(service.subject(old.url)?.id, old.url, 'Deliberate direct access remains available');
    service.setFilters({ updatedWithin: 90, briefingScope: 'all' });
    const saved = service.viewAction({ type: 'create', name: 'Last 90 days' });
    assert.deepEqual(
      Object.values(saved.savedViews?.counts ?? {}),
      [2],
      'Saved views cannot widen the global 30-day limit'
    );
    const search = createCommandSearchService({
      directory: () => f.directory,
      queue: () => service.cached(),
      history: () => [],
      account: () => 'me',
      ignoreBots: () => false,
      threads: () => undefined,
    });
    assert.ok((await search.search('#2')).hits.some((hit) => hit.document.sourceUrl === old.url));
    service.starPrs({ members: [old], starred: true });
    assert.equal(service.snapshot().items.length, 3);
    now += 86400000;
    assert.equal(service.snapshot().items.length, 2, 'The boundary rolls forward without another API call');
    service.starPrs({ members: [old], starred: false });
    assert.equal(service.snapshot().items.length, 1);
    preferences.prInactivityDays = 0;
    assert.equal(service.snapshot().items.length, 3, 'Never restores cached work immediately');
    preferences.prInactivityDays = 1;
    assert.equal(service.snapshot().items.length, 0);
    preferences.autoBriefings = true;
    busy = false;
    assert.deepEqual(service.activity(), [], 'Automatic work obeys the global limit');
  } finally {
    f.cleanup();
  }
});
void test('discovery skips old unrelated details, retains old stack context and starred seeds, and restores cached history', async () => {
  const f = fixture();
  try {
    const parent = dated(1, 150),
      child = { ...dated(2, 1), baseBranch: parent.headBranch },
      star = dated(3, 100),
      backlog = dated(4, 80);
    const prs = [parent, child, star, backlog, ...Array.from({ length: 201 }, (_, i) => dated(i + 5, 150))];
    const metadata = (m: ReviewMember) => ({
      ...m,
      html_url: m.url,
      updated_at: m.updatedAt,
      created_at: m.createdAt,
      body: m.description,
      user: { login: m.author },
      draft: false,
      commits: 1,
      requested_reviewers: [],
      requested_teams: [],
      base: { ref: m.baseBranch, sha: m.baseSha, repo: { full_name: m.repo, default_branch: 'main', archived: false } },
      head: { ref: m.headBranch, sha: m.headSha, repo: { full_name: m.repo } },
      merged: false,
      state: 'open',
    });
    const reads: number[] = [],
      queries: string[] = [];
    const client = {
      search: {
        issuesAndPullRequests: ({ q }: { q: string }) => {
          queries.push(q);
          return Promise.resolve({
            data: {
              items: [{ ...metadata(child), number: 2, repository_url: 'https://api.github.com/repos/owner/repo' }],
              total_count: 1,
            },
          });
        },
      },
      pulls: {
        get: ({ pull_number }: { pull_number: number }) => {
          reads.push(pull_number);
          const m = prs.find((m) => m.number === pull_number);
          assert.ok(m);
          return Promise.resolve({ data: metadata(m) });
        },
        list: ({ page = 1, head }: { page?: number; head?: string }) =>
          Promise.resolve({ data: head ? [] : prs.slice((page - 1) * 100, page * 100).map(metadata) }),
      },
    } as unknown as Octokit;
    fs.writeFileSync(
      path.join(f.directory, 'workbench.json'),
      JSON.stringify({ account: 'me', subjects: groupSubjects([backlog]), overrides: [], briefs: {}, day: '', used: 0 })
    );
    const preferences = prefs();
    const deps = {
      directory: () => f.directory,
      auth: () => ({ login: 'me', token: 'test' }),
      preferences: () => preferences,
      history: () => [],
      busy: () => true,
      now: () => NOW,
      client: () => client,
    };
    const service = createWorkbenchService(deps);
    service.starPrs({ members: [star], starred: true });
    const queue = await service.queue(true);
    assert.ok(
      queries.length === 3 && queries.every((q) => q.includes('updated:>=2026-09-24T12:00:00Z')),
      JSON.stringify({ queries, warnings: queue.warnings })
    );
    assert.deepEqual(
      [...new Set(reads)].sort(),
      [1, 2, 3],
      'Only recent PRs, starred PRs and related members need detail reads'
    );
    assert.equal(queue.items.length, 2);
    assert.equal(queue.items.find((i) => i.subject.kind === 'stack')?.subject.members.length, 2);
    assert.ok(service.cached().items.some((i) => i.subject.members.some((m) => m.url === backlog.url)));
    const restarted = createWorkbenchService(deps);
    preferences.prInactivityDays = 90;
    assert.ok(
      restarted.snapshot().items.some((i) => i.subject.members.some((m) => m.url === backlog.url)),
      'Widening uses persisted cached data immediately'
    );
    preferences.watchedRepos = [];
    assert.ok(
      !restarted.snapshot().items.some((i) => i.subject.members.some((m) => m.url === backlog.url)),
      'Retained inactive snapshots cannot revive a removed repository'
    );
    preferences.watchedRepos = ['owner/repo'];
    reads.length = 0;
    queries.length = 0;
    preferences.prInactivityDays = 0;
    await restarted.queue(true);
    assert.ok(reads.includes(4));
    assert.ok(
      queries.every((q) => !q.includes('updated:>=')),
      'Widening invalidates limited discovery checkpoints'
    );
  } finally {
    f.cleanup();
  }
});
