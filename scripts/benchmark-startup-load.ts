// Main-thread cost of loading saved data at startup, on synthetic data the size of a large real profile (#345):
// workbench state of about 8 MB (540 PRs with 4 KB descriptions and briefings), 2,000 read states, and a GitHub cache
// holding 2,000 entries and 32 MB. Prints how long main's event loop was blocked during each step.
//
//   npx tsx scripts/benchmark-startup-load.ts
//
// No network and no real profile data: everything is generated in a temporary folder and deleted afterwards.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createAppDataStore } from '../src/app-data-store';
import { createGitHubCache } from '../lib/github-cache';
import { mainLoopReport, resetMainLoopReport, startMainLoopMonitor } from '../src/main-blocking';

const hex = (text: string) => createHash('sha256').update(text).digest('hex');
const now = Date.now();
const member = (n: number) => ({
  number: n, repo: `owner/repo${n % 20}`, headRepo: `owner/repo${n % 20}`, baseRepo: `owner/repo${n % 20}`,
  url: `https://github.com/owner/repo${n % 20}/pull/${n}`, title: `PR ${n}`, description: `Change ${n}. `.repeat(400),
  author: 'author', role: 'watched', baseBranch: 'main', headBranch: `f-${n}`, baseSha: 'b'.repeat(40), headSha: hex(String(n)).slice(0, 40),
  merged: false, state: 'open', createdAt: new Date(now).toISOString(), updatedAt: new Date(now - n * 60_000).toISOString(), labels: [],
  mergeable: null, isDraft: false, commitCount: 3, requestedReviewers: [], requestedTeams: [], mergeableState: null, autoMerge: null, milestone: null,
});

async function step(name: string, work: () => Promise<unknown>) {
  resetMainLoopReport();
  const start = performance.now();
  await work();
  await new Promise((resolve) => setTimeout(resolve, 60));
  const { longTasks } = mainLoopReport();
  const blocked = longTasks.reduce((sum, t) => sum + t.duration, 0);
  console.log(`${name}: ${(performance.now() - start).toFixed(0)} ms, main blocked ${blocked} ms in ${longTasks.length} tasks, longest ${Math.max(0, ...longTasks.map((t) => t.duration))} ms`);
}

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gnosis-startup-benchmark-'));
  const stop = startMainLoopMonitor();
  try {
    const subjects = Array.from({ length: 540 }, (_, i) => ({ id: `s${i}`, kind: 'pr', title: `PR ${i}`, members: [member(i + 1)], edges: [], warnings: [] }));
    const briefs = Object.fromEntries(subjects.map((s, i) => [hex(s.id), { key: hex(s.id), status: 'ready', summary: `Briefing ${i}. `.repeat(200), updatedAt: new Date(now).toISOString() }]));
    fs.writeFileSync(path.join(directory, 'workbench.json'), JSON.stringify({ account: 'me', subjects, overrides: [], briefs, day: '', used: 0 }));
    const reads = Object.fromEntries(Array.from({ length: 2000 }, (_, i) => [`https://github.com/owner/repo/pull/${i}`, { seenAt: new Date(now).toISOString(), unread: [], head: hex(String(i)) }]));
    fs.writeFileSync(path.join(directory, `pr-read-${hex('me')}.json`), JSON.stringify({ version: 1, account: 'me', entries: reads }));
    const scope = hex('token');
    const entries = Array.from({ length: 2000 }, (_, i) => ({ scope, key: hex(`key-${i}`), savedAt: now - i * 1000, value: { url: `u${i}`, body: 'x'.repeat(15_000) } }));
    fs.writeFileSync(path.join(directory, 'github-cache.json'), JSON.stringify({ version: 1, entries }));
    console.log(`workbench.json ${(fs.statSync(path.join(directory, 'workbench.json')).size / 1e6).toFixed(1)} MB, github-cache.json ${(fs.statSync(path.join(directory, 'github-cache.json')).size / 1e6).toFixed(1)} MB`);

    // First opens migrate the JSON into SQLite, once per profile. Later launches measure the second open.
    for (const run of ['first launch (migration)', 'later launch']) {
      const data = createAppDataStore();
      await step(`saved data open, ${run}`, () => data.open(directory));
      await step(`saved data read of the workbench state, ${run}`, () => Promise.resolve(data.read(`workbench:me`)));
      await data.close();
      const cache = createGitHubCache();
      await step(`GitHub cache open, ${run}`, () => cache.setStorage(path.join(directory, 'github-cache.json')));
      await cache.close();
    }
  } finally {
    stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
void main();
