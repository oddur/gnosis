import test from 'node:test';
import assert from 'node:assert/strict';
import { serialize } from 'node:v8';
import { groupSubjects, type QueueItem, type ReviewMember, type WorkbenchQueue } from '../lib/workbench';
import { stampQueue } from '../lib/workbench-revision';
import { applyQueueDelta, queueDelta } from '../lib/workbench-delta';
import { correlateInteractions, mainLoopReport, mainSpan, noteMainPhase, recordMainSpan, resetMainLoopReport, startMainLoopMonitor } from '../src/main-blocking';

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
