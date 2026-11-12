// Times `view()` on a large local profile: 400 queue subjects, 649 muted PRs and 512 saved reviews.
// Results and method: docs/benchmarks/queue-rebuild.md.
//
//   npx tsx scripts/benchmark-queue-rebuild.ts             # main's cached history and preferences
//   npx tsx scripts/benchmark-queue-rebuild.ts --uncached  # re-read both files on every call, as before #252
//   GNOSIS_PERF_TRACE=1 npx tsx scripts/benchmark-queue-rebuild.ts
//
// No network: the service never discovers, and briefings stay paused.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createWorkbenchService, type WorkbenchPreferences } from '../src/workbench-service';
import { groupSubjects, snapshot, type ReviewMember } from '../lib/workbench';
import type { ReviewHistoryEntry } from '../lib/types';
import { DEFAULT_CLAUDE_MODEL } from '../lib/models';
import { createStatCache } from '../src/stat-cache';
import { deepFreeze } from '../lib/deep-freeze';
import { createMemoryStorage } from '../src/app-data-store';
import { mutedPrsName } from '../src/muted-pr-store';

const SUBJECTS = 400,
  MUTED = 649,
  HISTORY = 512,
  RUNS = 30;
const uncached = process.argv.includes('--uncached');
const now = Date.now();
const text = (n: number, size: number) => `PR ${n} description. `.repeat(Math.ceil(size / 20)).slice(0, size);
const member = (n: number, description = 600): ReviewMember => ({
  number: n,
  repo: `owner/repo${n % 20}`,
  headRepo: `owner/repo${n % 20}`,
  baseRepo: `owner/repo${n % 20}`,
  url: `https://github.com/owner/repo${n % 20}/pull/${n}`,
  title: `PR ${n}`,
  description: text(n, description),
  author: n % 3 ? 'author' : 'me',
  role: 'watched',
  baseBranch: 'main',
  headBranch: `feature-${n}`,
  baseSha: 'b'.repeat(40),
  headSha: createHash('sha1').update(String(n)).digest('hex'),
  merged: false,
  state: 'open',
  createdAt: new Date(now - 86_400_000).toISOString(),
  updatedAt: new Date(now - n * 60_000).toISOString(),
  labels: ['bug'],
  mergeable: null,
  isDraft: false,
  commitCount: 3,
  requestedReviewers: ['me'],
  requestedTeams: [],
  mergeableState: null,
  autoMerge: null,
  milestone: null,
});

function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gnosis-queue-benchmark-'));
  try {
    const subjects = groupSubjects(Array.from({ length: SUBJECTS }, (_, i) => member(i + 1)));
    // About 4 KB per muted PR, as on the measured profile (2.6 MB for 649 entries).
    const muted = Array.from({ length: MUTED }, (_, i) => ({
      seq: i,
      member: member(10_000 + i, 4_000),
      mutedAt: new Date(now).toISOString(),
    }));
    // Saved app data, as `appData` loads it: the queue, and muted PRs as one row each.
    const storage = createMemoryStorage(
      new Map([
        ['workbench:me', JSON.stringify({ account: 'me', subjects, overrides: [], briefs: {}, day: '', used: 0 })],
        [mutedPrsName('me'), JSON.stringify({ entries: Object.fromEntries(muted.map((entry) => [entry.member.url, entry])) })],
      ])
    );
    // Saved reviews of queue PRs and of PRs that left the queue, with their subject snapshots.
    const history: ReviewHistoryEntry[] = Array.from({ length: HISTORY }, (_, i) => {
      const pr = member(i % 2 ? i + 1 : 20_000 + i, 2_500);
      return {
        id: `review-${i}`,
        prUrl: pr.url,
        prTitle: pr.title,
        author: pr.author,
        riskLevel: 'low',
        savedAt: new Date(now - i * 3_600_000).toISOString(),
        status: 'completed',
        summary: text(i, 300),
        snapshot: snapshot(groupSubjects([pr])[0]),
      };
    });
    const indexPath = path.join(directory, 'reviews-index.json');
    fs.writeFileSync(indexPath, JSON.stringify(history, null, 2));
    const prefsPath = path.join(directory, 'preferences.json');
    const prefs: WorkbenchPreferences = {
      provider: 'claude',
      model: DEFAULT_CLAUDE_MODEL,
      watchedRepos: Array.from({ length: 20 }, (_, i) => `owner/repo${i}`),
      autoBriefings: false,
      briefingDailyLimit: 10,
    };
    fs.writeFileSync(prefsPath, JSON.stringify(prefs, null, 2));

    const readIndex = () =>
      (JSON.parse(fs.readFileSync(indexPath, 'utf8')) as ReviewHistoryEntry[]).map((e) => ({
        ...e,
        status: e.status ?? 'completed',
      }));
    const readPrefs = () => JSON.parse(fs.readFileSync(prefsPath, 'utf8')) as WorkbenchPreferences;
    // Main keeps both files parsed and frozen, and checks their size and modification time on each read.
    const index = createStatCache(
      () => indexPath,
      (exists): readonly ReviewHistoryEntry[] => (exists ? deepFreeze(readIndex()) : Object.freeze([]))
    );
    const preferences = createStatCache(
      () => prefsPath,
      () => deepFreeze(readPrefs())
    );
    const deps = uncached
      ? { history: readIndex, preferences: readPrefs }
      : { history: () => index.get(), preferences: () => ({ ...preferences.get() }) };
    const service = createWorkbenchService({
      directory: () => directory,
      storage,
      auth: () => ({ login: 'me', token: 'token' }),
      busy: () => true,
      client: () => {
        throw new Error('The benchmark makes no GitHub requests.');
      },
      ...deps,
    });
    const first = service.snapshot();
    const times: number[] = [];
    for (let i = 0; i < RUNS; i++) {
      const start = performance.now();
      service.snapshot();
      times.push(performance.now() - start);
    }
    times.sort((a, b) => a - b);
    const bytes = Buffer.byteLength(JSON.stringify(first));
    const ms = (value: number) => `${value.toFixed(1)} ms`;
    console.log(
      `view() over ${RUNS} runs${uncached ? ', uncached files' : ''}: min ${ms(times[0])}, median ${ms(times[Math.floor(RUNS / 2)])}, p90 ${ms(times[Math.floor(RUNS * 0.9)])}`
    );
    console.log(
      `items=${first.items.length} muted=${first.mutedPrs?.length ?? 0} history=${HISTORY} payload=${(bytes / 1024 / 1024).toFixed(2)} MB`
    );
    // The tray filters saved reviews by mutes, as main's `rebuildTrayMenu` does.
    const tray: number[] = [];
    for (let i = 0; i < 3; i++) {
      const start = performance.now();
      deps.history().filter((entry) => !service.isMutedReview(entry));
      tray.push(performance.now() - start);
    }
    console.log(`tray filter over 3 runs: min ${ms(Math.min(...tray))}`);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
main();
