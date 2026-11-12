import test from 'node:test';
import assert from 'node:assert/strict';
import { activityCapsule, seenKey, seenKeys } from '../lib/activity-capsule';
import type { ActivityTask } from '../lib/activity';

const task = (id: string, patch: Partial<ActivityTask>): ActivityTask => ({
  id,
  kind: 'review',
  title: id,
  detail: '',
  status: 'running',
  updatedAt: '2026-11-12T10:00:00.000Z',
  canCancel: false,
  canRetry: false,
  ...patch,
});
const none = new Set<string>();

void test('the capsule is hidden when nothing runs and every result has been seen', () => {
  assert.equal(activityCapsule([], none).visible, false);
  const done = [task('a', { status: 'completed' }), task('b', { status: 'failed' }), task('c', { status: 'cancelled' })];
  const seen = new Set(seenKeys(done));
  const capsule = activityCapsule(done, seen);
  assert.equal(capsule.visible, false);
  assert.equal(capsule.tone, 'idle');
});

void test('running and paused work counts as running; queued work is counted apart', () => {
  const capsule = activityCapsule(
    [task('a', {}), task('b', { kind: 'briefing', status: 'queued' }), task('c', { kind: 'pr-action', status: 'paused' })],
    none
  );
  assert.deepEqual(
    [capsule.visible, capsule.tone, capsule.running, capsule.queued, capsule.label],
    [true, 'running', 2, 1, '2 running · 1 queued']
  );
  const waiting = activityCapsule([task('b', { status: 'queued' })], none);
  assert.deepEqual([waiting.visible, waiting.tone, waiting.label], [true, 'running', '1 queued']);
  assert.deepEqual(seenKeys([task('b', { status: 'queued' })]), [], 'Unfinished work is never marked seen');
});

void test('routine background work never brings the capsule up on its own', () => {
  const quiet = [
    task('pr-preload', { kind: 'preload' }),
    task('github:oddur', { kind: 'github' }),
    task('github:done', { kind: 'github', status: 'completed' }),
    task('preload:paused', { kind: 'preload', status: 'paused' }),
  ];
  assert.equal(activityCapsule(quiet, none).visible, false);
  // A GitHub update that fails is news.
  assert.equal(activityCapsule([...quiet, task('github:x', { kind: 'github', status: 'failed' })], none).label, '1 failed');
});

void test('unseen failures and results show until seen, then quiet', () => {
  const tasks = [task('f', { status: 'failed' }), task('r', { kind: 'exploration', status: 'completed' })];
  const unseen = activityCapsule(tasks, none);
  assert.deepEqual([unseen.visible, unseen.tone, unseen.label], [true, 'failed', '1 failed · 1 ready']);
  const seen = new Set(seenKeys(tasks));
  assert.equal(activityCapsule(tasks, seen).visible, false);
  // A retried task that fails again is a new failure.
  const again = [task('f', { status: 'failed', updatedAt: '2026-11-12T10:05:00.000Z' })];
  assert.equal(activityCapsule(again, seen).unseenFailed, 1);
});

void test('seen failures stay muted beside running work; running tasks are never marked seen', () => {
  const tasks = [task('run', {}), task('f', { status: 'failed' })];
  assert.deepEqual(seenKeys(tasks), [seenKey(tasks[1])]);
  const capsule = activityCapsule(tasks, new Set(seenKeys(tasks)));
  assert.deepEqual([capsule.tone, capsule.label, capsule.seenFailed, capsule.unseenFailed], ['running', '1 running', 1, 0]);
});
