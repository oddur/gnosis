import test from 'node:test';
import assert from 'node:assert/strict';
import { createActivityService } from '../src/activity-service';
import { ACTIVITY_RETENTION_MS } from '../lib/activity';

const task = { id: 'review:1', kind: 'review' as const, title: 'A review', detail: 'Planning', reviewId: '1' };
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
