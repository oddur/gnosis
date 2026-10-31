import test from 'node:test';
import assert from 'node:assert/strict';
import { createActivityService } from '../src/activity-service';
import { ACTIVITY_RETENTION_MS } from '../lib/activity';
import { createActivityCompletionTracker } from '../lib/activity-notifications';

const task = { id: 'review:1', kind: 'review' as const, title: 'A review', detail: 'Planning', reviewId: '1' };
void test('ready notifications ignore history, deduplicate polls, and include fast background completions', () => {
  const service = createActivityService();
  const completions = createActivityCompletionTracker();
  service.start(task, {});
  service.finish(task.id, 'completed', 'Ready before launch');
  assert.deepEqual(completions(service.list()), []);
  service.start({ ...task, id: 'exploration:2', kind: 'exploration', slideId: 'topic-2' }, {});
  service.finish('exploration:2', 'completed', 'A second topic');
  assert.deepEqual(
    completions(service.list()).map((t) => [t.id, t.slideId]),
    [['exploration:2', 'topic-2']]
  );
  assert.deepEqual(completions(service.list()), []);
  service.start({ ...task, id: 'review:3' }, {});
  assert.deepEqual(completions(service.list()), []);
  service.finish('review:3', 'completed', 'Ready now');
  assert.deepEqual(
    completions(service.list()).map((t) => t.id),
    ['review:3']
  );
});
void test('ready notifications exclude cancellation, failures, briefings, and GitHub refreshes', () => {
  const service = createActivityService();
  const completions = createActivityCompletionTracker();
  completions([]);
  for (const status of ['cancelled', 'failed'] as const) {
    service.start({ ...task, id: status }, {});
    service.finish(status, status, status);
  }
  for (const kind of ['briefing', 'github'] as const) {
    service.start({ ...task, id: kind, kind }, {});
    service.finish(kind, 'completed', 'Done');
  }
  assert.deepEqual(completions(service.list()), []);
});
void test('parallel tasks keep separate progress and cancellation actions', async () => {
  const service = createActivityService();
  let cancelled = '';
  service.start(task, {
    cancel: () => {
      cancelled = '1';
    },
  });
  service.start(
    { ...task, id: 'review:2' },
    {
      cancel: () => {
        cancelled = '2';
      },
    }
  );
  service.update(task.id, 'Writing sections', { completed: 2, total: 15 });
  assert.deepEqual(service.list()[0].progress, { completed: 2, total: 15 });
  assert.equal(service.list()[1].progress, undefined);
  await service.act('review:2', 'cancel');
  assert.equal(cancelled, '2');
  service.finish('review:2', 'cancelled', 'Cancelled');
  await assert.rejects(service.act('review:2', 'cancel'), /no longer available/);
  assert.equal(service.list()[0].status, 'running');
});
void test('failures remain retryable, completed results expire, and late progress cannot revive a task', async () => {
  let now = 100000;
  const service = createActivityService(() => now);
  let retries = 0;
  service.start(task, {
    cancel: () => {},
    retry: () => {
      retries++;
      return Promise.resolve();
    },
  });
  service.start({ ...task, id: 'done' }, { cancel: () => {} });
  service.finish(task.id, 'failed', 'Provider unavailable');
  service.finish('done', 'completed', 'Ready');
  service.update('done', 'Late writer', { completed: 1, total: 2 });
  assert.equal(service.list().find((t) => t.id === 'done')?.status, 'completed');
  now += ACTIVITY_RETENTION_MS + 1;
  assert.deepEqual(
    service.list().map((t) => t.id),
    [task.id]
  );
  await service.act(task.id, 'retry');
  assert.equal(retries, 1);
  assert.equal(service.list().length, 0);
});
void test('retrying an exploration retains the replacement task with the same identity', async () => {
  const service = createActivityService();
  service.start(task, {
    cancel: () => {},
    retry: () => {
      service.start(task, { cancel: () => {} });
      return Promise.resolve();
    },
  });
  service.finish(task.id, 'failed', 'Failed');
  await service.act(task.id, 'retry');
  assert.equal(service.list()[0].status, 'running');
  await assert.rejects(service.act(task.id, 'dismiss'), /no longer available/);
});

void test('rate-limit waits retain progress and cancellation, then resume without reviving completed tasks', async () => {
  const service = createActivityService();
  let cancelled = false;
  service.start(task, { cancel: () => { cancelled = true; } });
  service.update(task.id, 'Loading files', { completed: 12, total: 30 });
  service.wait(task.id, 'Waiting for GitHub');
  assert.equal(service.list()[0].status, 'paused');
  assert.deepEqual(service.list()[0].progress, { completed: 12, total: 30 });
  await service.act(task.id, 'cancel');
  assert.equal(cancelled, true);
  service.resume(task.id);
  service.update(task.id, 'Loading files', { completed: 13, total: 30 });
  assert.equal(service.list()[0].status, 'running');
  service.finish(task.id, 'completed', 'Ready');
  service.wait(task.id, 'Late wait');
  service.resume(task.id);
  assert.equal(service.list()[0].status, 'completed');
});

void test('conflict outcomes stay inline only for their visible workspace and notify after leaving', () => {
  const service = createActivityService();
  const completions = createActivityCompletionTracker();
  const active = { url: 'https://github.com/oddur/gnosis/pull/206', id: 'session-206' };
  completions([]);
  for (const [id, target, status] of [
    ['open', active.url, 'completed'],
    ['resolve', active.id, 'completed'],
    ['error', active.id, 'failed'],
    ['other-pr', 'session-207', 'completed'],
  ] as const) {
    service.start({ id, kind: 'pr-action', title: 'Conflicts', detail: '', conflictTarget: target }, {});
    service.finish(id, status, 'Ready');
  }
  assert.deepEqual(completions(service.list(), active).map(t => t.id), ['other-pr']);
  assert.deepEqual(completions(service.list()), [], 'Closing does not replay already-seen inline outcomes');
  service.start({ id: 'background', kind: 'pr-action', title: 'Conflicts', detail: '', conflictTarget: active.id }, {});
  service.finish('background', 'completed', 'Ready');
  assert.deepEqual(completions(service.list()).map(t => t.id), ['background']);
  service.start({ id: 'merge', kind: 'pr-action', title: 'Merge', detail: '' }, {});
  service.finish('merge', 'completed', 'Merged');
  assert.deepEqual(completions(service.list(), active).map(t => t.id), ['merge'], 'Other PR actions still notify');
});
