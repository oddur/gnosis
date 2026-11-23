import test from 'node:test';
import assert from 'node:assert/strict';
import { assertPerf } from './perf-budget';
import { serialize } from 'node:v8';
import { groupSubjects, type QueueItem, type ReviewMember, type WorkbenchQueue } from '../lib/workbench';
import { stampQueue } from '../lib/workbench-revision';
import { applyQueueDelta, queueDelta } from '../lib/workbench-delta';
import { correlateInteractions, mainLoopReport, mainSpan, noteMainPhase, noteSystemSleep, noteSystemWake, recordMainSpan, resetMainLoopReport, startMainLoopMonitor } from '../src/main-blocking';

const member = (n: number, updatedAt = '2026-11-15T09:00:00Z'): ReviewMember => ({
  number: n, repo: 'owner/repo', baseRepo: 'owner/repo', headRepo: 'owner/repo', url: `https://github.com/owner/repo/pull/${n}`,
  title: `PR ${n}`, description: `Change ${n}. `.repeat(300), author: 'alice', role: 'watched', baseBranch: 'main', headBranch: `pr-${n}`,
  baseSha: 'base', headSha: `head-${n}`, merged: false, state: 'open', createdAt: '2026-11-01T12:00:00Z', updatedAt, labels: [],
  mergeable: true, isDraft: false, commitCount: 1, requestedReviewers: [], requestedTeams: [], mergeableState: 'clean', autoMerge: null, milestone: null,
});
const item = (n: number, updatedAt?: string): QueueItem => ({ subject: groupSubjects([member(n, updatedAt)])[0], attention: 'other' });
const queueOf = (items: QueueItem[]): WorkbenchQueue =>
  stampQueue({ items, starredItems: items.slice(0, 3), warnings: [], remaining: 0, filters: undefined, sync: { status: 'idle', checkedAt: 1 } }, []);

void test('a delta names unchanged rows by revision and rebuilds the same snapshot', () => {
  const before = queueOf(Array.from({ length: 540 }, (_, i) => item(i + 1)));
  const rows = Array.from({ length: 540 }, (_, i) => item(i + 1, i % 90 === 0 ? '2026-11-15T09:05:00Z' : undefined));
  const after = queueOf([rows[5], ...rows.filter((_, i) => i !== 5)]);
  const delta = queueDelta(before, after);
  assert.ok(delta);
  assert.equal(delta.items.filter((entry) => typeof entry !== 'string').length, 6, 'Only the six changed rows travel');
  // The receiver holds its own copy of the base, as the renderer store does.
  const held = structuredClone(before);
  const rebuilt = applyQueueDelta(held, structuredClone(delta));
  assert.ok(rebuilt);
  assert.deepEqual(rebuilt, after);
  assert.equal(rebuilt.items[2], held.items[1], 'Unchanged rows keep the receiver’s objects');
  const full = serialize(after).length;
  const small = serialize(delta).length;
  assert.ok(small * 10 < full, `The delta is a small part of the snapshot: ${small} of ${full} bytes`);
  // A receiver that holds another revision, or lacks a named row, reads a full snapshot instead.
  assert.equal(applyQueueDelta({ ...held, revision: 'other' }, delta), undefined);
  assert.equal(applyQueueDelta({ ...held, items: held.items.slice(2), starredItems: [] }, delta), undefined);
  assert.equal(queueDelta({ ...before, revision: undefined }, after), undefined);
});

void test('a change to a field outside the rows, such as the briefing budget, changes the revision and travels in the delta', () => {
  const rows = Array.from({ length: 20 }, (_, i) => item(i + 1));
  const budget = { limit: 10, used: 3, remaining: 7, resetsAt: '2026-11-16T23:00:00Z', repositories: {} };
  const before = queueOf(rows);
  const changes: [string, (queue: WorkbenchQueue) => WorkbenchQueue][] = [
    ['briefingBudget', (queue) => ({ ...queue, briefingBudget: budget })],
    ['remaining', (queue) => ({ ...queue, remaining: 4 })],
    ['warnings', (queue) => ({ ...queue, warnings: ['GitHub rate limit reached.'] })],
    ['savedViews', (queue) => ({ ...queue, savedViews: { views: [], counts: {} } as unknown as WorkbenchQueue['savedViews'] })],
    ['snoozedPrs', (queue) => ({ ...queue, snoozedPrs: [{ url: 'https://github.com/owner/repo/pull/1' }] as unknown as WorkbenchQueue['snoozedPrs'] })],
  ];
  for (const [field, change] of changes) {
    const after = stampQueue(change({ ...before, revision: undefined, parts: undefined }), []);
    assert.notEqual(after.revision, before.revision, `${field} changes the revision, so main never answers “same”`);
    const delta = queueDelta(before, after);
    assert.ok(delta);
    const rebuilt = applyQueueDelta(structuredClone(before), structuredClone(delta));
    assert.deepEqual(rebuilt?.[field as keyof WorkbenchQueue], after[field as keyof WorkbenchQueue], `${field} reaches the window`);
  }
});

void test('main long tasks are detected, named by the spans inside them, and matched to delayed inputs', async () => {
  const stop = startMainLoopMonitor();
  resetMainLoopReport();
  await new Promise((resolve) => setTimeout(resolve, 60));
  noteMainPhase('cache-open');
  mainSpan('busy work', () => {
    // Many short parses, each under the 10 ms span threshold, add up inside one long task.
    for (let i = 0; i < 20; i++) {
      const start = performance.timeOrigin + performance.now();
      const end = performance.now() + 3;
      while (performance.now() < end);
      recordMainSpan('cache parse', start);
    }
    const end = performance.now() + 90;
    while (performance.now() < end);
  });
  await new Promise((resolve) => setTimeout(resolve, 80));
  stop();
  const { longTasks, eventLoopDelay } = mainLoopReport();
  const task = longTasks.find((t) => t.duration >= 100);
  assert.ok(task, `The 150 ms block is a long task: ${JSON.stringify(longTasks)}`);
  assert.equal(task.spans[0]?.name, 'busy work');
  const parses = task.work?.find((w) => w.name === 'cache parse');
  assert.ok(parses, `Short work is summed by name: ${JSON.stringify(task.work)}`);
  assert.equal(parses.count, 20, `Short work is summed by name: ${JSON.stringify(task.work)}`);
  assert.ok(parses.ms >= 55);
  assert.equal(task.phase?.after, 'cache-open', 'The task names the startup phase it ran in');
  assert.ok(eventLoopDelay.max >= 100);
  const [delayed, quick] = correlateInteractions(
    [
      { at: task.at + 10, inputDelay: 120 },
      { at: task.at + 10, inputDelay: 10 },
    ],
    longTasks
  );
  assert.equal(delayed.mainBlocked?.[0].at, task.at);
  assert.equal(quick.mainBlocked, undefined);
});

const block = (ms: number) => {
  const end = performance.now() + ms;
  while (performance.now() < end);
};

void test('sleep and a locked screen are never long tasks or the maximum event-loop delay', async () => {
  const stop = startMainLoopMonitor();
  try {
    resetMainLoopReport();
    await new Promise((resolve) => setTimeout(resolve, 60));
    // A suspended process does not turn its event loop: blocking stands in for the time asleep.
    noteSystemSleep('suspend');
    block(400);
    noteSystemWake('suspend');
    await new Promise((resolve) => setTimeout(resolve, 80));
    // Locked, then asleep, then awake but still locked: nothing is measured until the screen unlocks.
    noteSystemSleep('lock-screen');
    noteSystemSleep('suspend');
    block(300);
    noteSystemWake('suspend');
    await new Promise((resolve) => setTimeout(resolve, 40));
    block(300);
    noteSystemWake('lock-screen');
    await new Promise((resolve) => setTimeout(resolve, 80));
    const { longTasks, eventLoopDelay } = mainLoopReport();
    assert.deepEqual(longTasks, [], 'No long task while asleep or locked');
    // Each block above is 300 ms or more, so one the histogram kept would read about 290 ms or more (it samples every
    // 10 ms): this does not depend on the machine. How close the rest stays to zero does, so that is a budget.
    assert.ok(eventLoopDelay.max < 250, `The delay histogram skips the sleep: max ${eventLoopDelay.max} ms`);
    assertPerf('main event loop: delay histogram maximum around a sleep', eventLoopDelay.max, 150);
    assert.equal(eventLoopDelay.sleeps, 2, 'Each wake starts the histogram again');
    // Awake again, real blocking is measured as before.
    block(160);
    await new Promise((resolve) => setTimeout(resolve, 60));
    const after = mainLoopReport();
    assert.ok(after.longTasks.some((task) => task.duration >= 100), `Blocking after waking is a long task: ${JSON.stringify(after.longTasks)}`);
    assert.ok(after.eventLoopDelay.max >= 100);
  } finally {
    stop();
  }
});

void test('without a suspend event, a wall-clock jump is treated as sleep, not as a long task', async () => {
  const stop = startMainLoopMonitor();
  const realNow = Date.now;
  try {
    resetMainLoopReport();
    await new Promise((resolve) => setTimeout(resolve, 60));
    // The monotonic clock may stop while a Mac sleeps; the wall clock does not.
    const slept = realNow() + 10 * 60_000;
    Date.now = () => slept + performance.now();
    await new Promise((resolve) => setTimeout(resolve, 60));
    const { longTasks, eventLoopDelay } = mainLoopReport();
    assert.deepEqual(longTasks, []);
    assert.equal(eventLoopDelay.sleeps, 1, 'The jump counts as one sleep');
  } finally {
    Date.now = realNow;
    stop();
  }
});

void test('the sampler names the functions inside a long task that no span covers', async () => {
  const stop = startMainLoopMonitor({ sampler: true });
  try {
    resetMainLoopReport();
    await new Promise((resolve) => setTimeout(resolve, 60));
    function unnamedPeriodicWork() {
      block(180);
    }
    unnamedPeriodicWork();
    await new Promise((resolve) => setTimeout(resolve, 60));
    const task = mainLoopReport().longTasks.find((t) => t.duration >= 150);
    assert.ok(task, 'The block is a long task');
    // The monitor lists garbage-collection pauses as spans on purpose (src/main-blocking.ts), and a minor GC can land
    // inside any 180 ms of work: a Windows runner had one of 31 ms. The point here is that no work span names it.
    assert.deepEqual(task.spans.filter((span) => !span.name.startsWith('gc')), [], 'No work span names it');
    assert.ok(task.profile && task.profile.samples > 5, `The sampler took samples inside it: ${JSON.stringify(task.profile)}`);
    assert.ok(task.profile.total.some((fn) => /^unnamedPeriodicWork\d* /.test(fn.name)), `The work is named: ${JSON.stringify(task.profile)}`);
  } finally {
    stop();
  }
});
