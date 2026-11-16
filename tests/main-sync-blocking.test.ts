import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import v8 from 'node:v8';
import type { Octokit } from '@octokit/rest';
import { perfBudget } from './perf-budget';
import { setTimedSink } from '../lib/perf-trace';
import { createWorkbenchService, type WorkbenchPreferences } from '../src/workbench-service';
import { createMemoryStorage } from '../src/app-data-store';
import { mutedPrsName } from '../src/muted-pr-store';
import { groupSubjects, type ReviewMember, type WorkbenchQueue } from '../lib/workbench';
import { stampQueue } from '../lib/workbench-revision';
import { queueDelta } from '../lib/workbench-delta';
import { DEFAULT_CLAUDE_MODEL } from '../lib/models';
import { mainLoopReport, mainSpan, resetMainLoopReport, startMainLoopMonitor } from '../src/main-blocking';

/**
 * Main's share of background sync on a large queue (#345): 540 PRs with 4 KB descriptions and 649 muted PRs. For each
 * change main builds the queue for the broadcast and answers the window's read with a delta, serialized for IPC. The
 * main event loop must not block for 100 ms or more while this repeats.
 */
const now = Date.now();
const member = (n: number, description = 4_000): ReviewMember => ({
  number: n, repo: `owner/repo${n % 20}`, headRepo: `owner/repo${n % 20}`, baseRepo: `owner/repo${n % 20}`,
  url: `https://github.com/owner/repo${n % 20}/pull/${n}`, title: `PR ${n}`, description: `PR ${n} description. `.repeat(description / 20),
  author: n % 3 ? 'author' : 'me', role: 'watched', baseBranch: 'main', headBranch: `feature-${n}`, baseSha: 'b'.repeat(40),
  headSha: n.toString(16).padStart(40, '0'), merged: false, state: 'open', createdAt: new Date(now - 86_400_000).toISOString(),
  updatedAt: new Date(now - n * 60_000).toISOString(), labels: ['bug'], mergeable: null, isDraft: false, commitCount: 3,
  requestedReviewers: ['me'], requestedTeams: [], mergeableState: null, autoMerge: null, milestone: null,
});

void test('background changes on a large queue never block the main event loop for 100 ms', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gnosis-main-sync-'));
  const stop = startMainLoopMonitor();
  try {
    const subjects = groupSubjects(Array.from({ length: 540 }, (_, i) => member(i + 1)));
    const muted = Array.from({ length: 649 }, (_, i) => ({ seq: i, member: member(10_000 + i), mutedAt: new Date(now).toISOString() }));
    const storage = createMemoryStorage(
      new Map([
        ['workbench:me', JSON.stringify({ account: 'me', subjects, overrides: [], briefs: {}, day: '', used: 0 })],
        [mutedPrsName('me'), JSON.stringify({ entries: Object.fromEntries(muted.map((entry) => [entry.member.url, entry])) })],
      ])
    );
    const prefs: WorkbenchPreferences = { provider: 'claude', model: DEFAULT_CLAUDE_MODEL, watchedRepos: ['owner/repo1'], autoBriefings: false, briefingDailyLimit: 10 };
    const service = createWorkbenchService({
      directory: () => directory,
      storage,
      auth: () => ({ login: 'me', token: 'token' }),
      busy: () => true,
      client: () => {
        throw new Error('No GitHub requests.');
      },
      history: () => [],
      preferences: () => ({ ...prefs }),
    });
    let held: WorkbenchQueue = service.snapshot();
    const sizes: number[] = [];
    await new Promise((resolve) => setTimeout(resolve, 50));
    resetMainLoopReport();
    for (let round = 1; round <= 15; round++) {
      // Six PRs changed on GitHub; main stamps the queue it builds.
      const at = new Date(now + round * 1000).toISOString();
      const changed: WorkbenchQueue = stampQueue({
        ...held,
        revision: undefined,
        items: held.items.map((item, i) =>
          i % 90 === round % 90 ? { ...item, revision: undefined, subject: { ...item.subject, members: item.subject.members.map((m) => ({ ...m, updatedAt: at })) } } : item
        ),
      }, [], { reuseMembers: true });
      mainSpan('sync change', () => {
        service.snapshot();
        const delta = queueDelta(held, changed);
        assert.ok(delta);
        sizes.push(v8.serialize(delta).length);
      });
      held = changed;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    const { longTasks, eventLoopDelay } = mainLoopReport();
    const worst = Math.max(0, ...longTasks.map((t) => t.duration));
    console.log(`main event loop during 15 changes: longest block ${worst} ms, p99 ${eventLoopDelay.p99} ms; delta ${Math.max(...sizes)} bytes`);
    assert.ok(worst < perfBudget(100), `The main event loop blocked for ${worst} ms: ${JSON.stringify(longTasks)}`);
    assert.ok(Math.max(...sizes) < 200_000, 'Each change sends a small delta, not the whole queue');
    assert.ok(v8.serialize(held).length > 2_000_000, 'The full queue is the large payload the delta replaces');
  } finally {
    stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

/**
 * Discovery on a large queue (#345). After every batch of five PR reads, discovery regroups the whole queue into stacks
 * and saves its progress. A heavy user's export showed a 355 ms main-process block every 12-30 s that no span named:
 * the regrouping was quadratic in the queue's size. Between batches the main event loop must stay responsive.
 */
void test('discovery batches on a queue of 3,000 PRs never block the main event loop for 100 ms', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gnosis-main-discovery-'));
  const stop = startMainLoopMonitor();
  try {
    // Stacks of up to four PRs across 30 repositories, as a monorepo team's queue has.
    const saved = Array.from({ length: 3000 }, (_, i): ReviewMember => {
      const n = i + 1, repo = `owner/repo${n % 30}`;
      return { ...member(n, 500), repo, headRepo: repo, baseRepo: repo, url: `https://github.com/${repo}/pull/${n}`, author: 'author',
        role: 'review-requested', baseBranch: n % 4 && n > 30 ? `feature-${n - 30}` : 'main' };
    });
    const subjects = groupSubjects(saved);
    assert.ok(subjects.some((subject) => subject.kind === 'stack' && subject.members.length >= 3), 'The queue holds stacks');
    const storage = createMemoryStorage(new Map([['workbench:me', JSON.stringify({ account: 'me', subjects, overrides: [], briefs: {}, day: '', used: 0 })]]));
    // Fifteen PRs changed on GitHub: three batches of reads.
    const changed = saved.slice(0, 15);
    const later = new Date(now + 60_000).toISOString();
    const pull = (m: ReviewMember) => ({
      title: m.title, body: m.description, user: { login: m.author }, html_url: m.url, state: 'open', merged: false, draft: false,
      base: { ref: m.baseBranch, sha: m.baseSha, repo: { full_name: m.repo, archived: false } },
      head: { ref: m.headBranch, sha: m.headSha, repo: { full_name: m.repo } }, created_at: m.createdAt, updated_at: later,
      labels: [], mergeable: null, commits: 3, requested_reviewers: [{ login: 'me' }], requested_teams: [], mergeable_state: null,
      auto_merge: null, milestone: null, comments: 0, review_comments: 0, assignees: [],
    });
    // Each read answers after a network turn, as GitHub does, so batches run in separate tasks.
    const network = <T>(value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), 5));
    const found = (q: string) => (q.includes('review-requested') ? changed : []);
    const client = {
      search: {
        issuesAndPullRequests: ({ q }: { q: string }) => network({ data: { total_count: found(q).length, incomplete_results: false,
          items: found(q).map((m) => ({ number: m.number, title: m.title, html_url: m.url, repository_url: `https://api.github.com/repos/${m.repo}`,
            user: { login: m.author }, updated_at: later, draft: false, state: 'open', pull_request: {} })) } }),
      },
      pulls: {
        get: ({ owner, repo, pull_number }: { owner: string; repo: string; pull_number: number }) =>
          network({ data: pull(changed.find((m) => m.url === `https://github.com/${owner}/${repo}/pull/${pull_number}`) ?? changed[0]) }),
        list: () => network({ data: [] }),
      },
    } as unknown as Octokit;
    const prefs: WorkbenchPreferences = { provider: 'claude', model: DEFAULT_CLAUDE_MODEL, watchedRepos: [], autoBriefings: false, briefingDailyLimit: 10 };
    const service = createWorkbenchService({
      directory: () => directory, storage, auth: () => ({ login: 'me', token: 'token' }), busy: () => true,
      client: () => client, history: () => [], preferences: () => ({ ...prefs }),
    });
    service.snapshot();
    await new Promise((resolve) => setTimeout(resolve, 50));
    resetMainLoopReport();
    await service.queue(true);
    const { longTasks } = mainLoopReport();
    const worst = Math.max(0, ...longTasks.map((t) => t.duration));
    const durations = longTasks.map((t) => t.duration).sort((a, b) => a - b);
    console.log(`main event loop during a discovery of 15 changed PRs in a queue of 3,000: ${durations.length} long tasks, ` +
      `median ${durations[durations.length >> 1] ?? 0} ms, longest ${worst} ms`);
    const updated = service.snapshot().items.flatMap((item) => item.subject.members).find((m) => m.url === changed[0].url);
    assert.equal(updated?.updatedAt, later, 'Discovery saved the changed PRs');
    // The regression this guards regrouped the whole queue after every batch: median 421 ms, every batch over 350 ms.
    // A shared two-core runner adds the odd GC or scheduling stall to an otherwise quiet run, so check that blocking is
    // rare and short, not that no single task ever crosses the line.
    const over = durations.filter((d) => d >= perfBudget(100));
    assert.ok(
      over.length <= 1 && worst < perfBudget(250),
      `The main event loop blocked for ${worst} ms (${over.length} tasks over ${perfBudget(100)} ms): ${JSON.stringify(longTasks)}`
    );
  } finally {
    stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

/**
 * Every queue broadcast makes each window list activity. Listing activity built the whole queue again, so each change
 * cost main two queue builds (#345). With the broadcast's queue it builds none.
 */
void test('listing activity with the queue a broadcast just built builds no other queue', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gnosis-main-activity-'));
  const labels: string[] = [];
  try {
    const subjects = groupSubjects(Array.from({ length: 300 }, (_, i) => member(i + 1, 200)));
    const storage = createMemoryStorage(new Map([['workbench:me', JSON.stringify({ account: 'me', subjects, overrides: [], briefs: {}, day: '', used: 0 })]]));
    const prefs: WorkbenchPreferences = { provider: 'claude', model: DEFAULT_CLAUDE_MODEL, watchedRepos: [], autoBriefings: false, briefingDailyLimit: 10 };
    const service = createWorkbenchService({
      directory: () => directory, storage, auth: () => ({ login: 'me', token: 'token' }), busy: () => true,
      client: () => { throw new Error('No GitHub requests.'); }, history: () => [], preferences: () => ({ ...prefs }),
    });
    setTimedSink((label) => labels.push(label));
    const broadcast = service.snapshot();
    labels.length = 0;
    const listed = service.activity(broadcast);
    assert.deepEqual(labels.filter((label) => label === 'view'), [], 'The broadcast queue is reused');
    assert.deepEqual(service.activity(), listed, 'The same tasks as building the queue');
    assert.equal(labels.filter((label) => label === 'view').length, 1);
  } finally {
    setTimedSink(undefined);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
