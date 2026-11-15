import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import v8 from 'node:v8';
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
    assert.ok(worst < 100, `The main event loop blocked for ${worst} ms: ${JSON.stringify(longTasks)}`);
    assert.ok(Math.max(...sizes) < 200_000, 'Each change sends a small delta, not the whole queue');
    assert.ok(v8.serialize(held).length > 2_000_000, 'The full queue is the large payload the delta replaces');
  } finally {
    stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
