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
import v8 from 'node:v8';
import { stampQueue } from '../lib/workbench-revision';
import { queueDelta } from '../lib/workbench-delta';
import type { WorkbenchQueue } from '../lib/workbench';
import { deepFreeze } from '../lib/deep-freeze';
import { createMemoryStorage } from '../src/app-data-store';
import { mutedPrsName } from '../src/muted-pr-store';

const SUBJECTS = Number(process.env.SUBJECTS ?? 400),
  MUTED = 649,
  HISTORY = 512,
  RUNS = 30;
const uncached = process.argv.includes('--uncached');
const now = Date.now();
const text = (n: number, size: number) => `PR ${n} description. `.repeat(Math.ceil(size / 20)).slice(0, size);
const DESCRIPTION = Number(process.env.DESCRIPTION ?? 600);
const member = (n: number, description = DESCRIPTION): ReviewMember => ({
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

    // One background change, as main handles it (#345). Before: the broadcast builds the queue, the window's read
    // builds it again, and the reply serializes all of it. After: the read reuses the broadcast's queue and the reply
    // is a delta from the revision the window holds. v8.serialize stands in for IPC's structured clone.
    const changeOf = (base: WorkbenchQueue, round: number): WorkbenchQueue => {
      const at = new Date(now + round * 1000).toISOString();
      const items = base.items.map((item, i) =>
        i % 90 === round % 90
          ? { ...item, revision: undefined, subject: { ...item.subject, members: item.subject.members.map((m) => ({ ...m, updatedAt: at })) } }
          : item
      );
      return stampQueue({ ...base, items, revision: undefined }, deps.history(), { reuseMembers: true });
    };
    const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
    const full: number[] = [], fullRead: number[] = [], delta: number[] = [], deltaRead: number[] = [];
    let fullBytes = 0, deltaBytes = 0;
    let base = service.snapshot();
    for (let round = 0; round < RUNS; round++) {
      const next = changeOf(base, round);
      let start = performance.now();
      service.snapshot();
      service.snapshot();
      const fullPayload = v8.serialize(next);
      full.push(performance.now() - start);
      fullBytes = fullPayload.length;
      start = performance.now();
      v8.deserialize(fullPayload);
      fullRead.push(performance.now() - start);
      start = performance.now();
      service.snapshot();
      const change = queueDelta(base, next);
      if (!change) throw new Error('No delta');
      const deltaPayload = v8.serialize(change);
      delta.push(performance.now() - start);
      deltaBytes = deltaPayload.length;
      start = performance.now();
      v8.deserialize(deltaPayload);
      deltaRead.push(performance.now() - start);
      base = next;
    }
    console.log(
      `main per change, full snapshot: median ${ms(median(full))}, max ${ms(Math.max(...full))}, ${(fullBytes / 1024 / 1024).toFixed(2)} MB; window deserialize ${ms(median(fullRead))}`
    );
    console.log(
      `main per change, delta: median ${ms(median(delta))}, max ${ms(Math.max(...delta))}, ${(deltaBytes / 1024).toFixed(0)} KB; window deserialize ${ms(median(deltaRead))}`
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
main();
