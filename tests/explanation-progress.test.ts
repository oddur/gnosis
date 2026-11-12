import test from 'node:test';
import assert from 'node:assert/strict';
import {
  explanationSteps,
  explanationStepsFromDetail,
  formatElapsed,
  initialExplanationProgress,
  phaseStage,
  reduceExplanationProgress,
  type ExplanationEvent,
} from '../lib/explanation-progress';
import { createActivityService } from '../src/activity-service';
import { createExplanationBuilds } from '../src/explanation-builds';
import { sanitizeSteps } from '../lib/activity';
import type { Slide } from '../lib/types';

const must = <T,>(value: T | undefined | null): T => {
  assert.ok(value);
  return value;
};
const run = (events: ExplanationEvent[]) => events.reduce(reduceExplanationProgress, initialExplanationProgress());
const summary = (events: ExplanationEvent[]) =>
  explanationSteps(run(events)).map((step) => [step.id, step.status, step.meta ?? ''].join(':'));
const planned: ExplanationEvent[] = [
  { type: 'phase', phase: 'Fetching PR data' },
  { type: 'phase', phase: 'Loading files: 12/48', completed: 12, total: 48 },
  { type: 'phase', phase: 'Resolving imports' },
  { type: 'context', files: 48, imports: 12 },
  { type: 'phase', phase: 'Building context' },
  { type: 'phase', phase: 'Planning review structure' },
  {
    type: 'plan',
    topics: [
      { id: 'slide-1', title: 'Retry scheduling moves to the consumer' },
      { id: 'slide-2', title: 'Backoff configuration' },
      { id: 'slide-3', title: 'Tests' },
    ],
  },
  { type: 'phase', phase: 'Writing topics', completed: 0, total: 3 },
];

void test('phases map to stages, and runtime notes keep the current stage', () => {
  assert.equal(phaseStage('Loading files: 3/9'), 'context');
  assert.equal(phaseStage('Waiting for GitHub rate limit · resumes at 10:00'), 'context');
  assert.equal(phaseStage('Planning review structure'), 'plan');
  assert.equal(phaseStage('Thinking'), 'generate');
  assert.equal(phaseStage('Tool mode: project skills, MCP, and tests enabled'), undefined);
  const before = run(planned.slice(0, 3));
  assert.equal(reduceExplanationProgress(before, { type: 'phase', phase: 'Working tree has uncommitted changes' }), before);
});

void test('context shows file loading while running, then files and imports once read', () => {
  assert.deepEqual(summary(planned.slice(0, 2)).slice(0, 1), ['context:running:12 of 48 files']);
  assert.deepEqual(summary(planned).slice(0, 2), ['context:done:48 files · 12 imports', 'plan:done:']);
  assert.equal(explanationSteps(run(planned))[1].title, 'Planned 3 topics');
});

void test('topics report each status in plan order with counts and their own errors', () => {
  const steps = explanationSteps(
    run([
      ...planned,
      { type: 'topic', id: 'slide-1', status: 'writing' },
      { type: 'topic', id: 'slide-2', status: 'writing' },
      { type: 'topic', id: 'slide-1', status: 'done' },
      { type: 'topic', id: 'slide-2', status: 'failed', error: 'Provider rate limit. Retry when capacity is available.' },
      { type: 'topic', id: 'slide-3', status: 'writing' },
    ])
  );
  const topics = must(steps.find((step) => step.id === 'topics'));
  assert.equal(topics.status, 'running');
  assert.equal(topics.meta, '1 of 3 · 1 failed');
  assert.deepEqual(
    must(topics.subtasks).map((topic) => [topic.title, topic.status, topic.meta ?? '', topic.error ?? '', topic.slideId]),
    [
      ['Retry scheduling moves to the consumer', 'done', '', '', 'slide-1'],
      ['Backoff configuration', 'failed', '', 'Provider rate limit. Retry when capacity is available.', 'slide-2'],
      ['Tests', 'running', 'writing', '', 'slide-3'],
    ]
  );
  assert.deepEqual(
    steps.filter((step) => step.id !== 'topics').map((step) => [step.id, step.status]),
    [
      ['context', 'done'],
      ['plan', 'done'],
      ['check', 'queued'],
      ['overview', 'queued'],
      ['render', 'queued'],
    ]
  );
});

void test('a failure marks the stage it happened in with the real error', () => {
  const steps = summary([
    ...planned,
    { type: 'topic', id: 'slide-1', status: 'done' },
    { type: 'phase', phase: 'Checking explanation text' },
    { type: 'finish', status: 'failed', error: 'The model returned invalid JSON.' },
  ]);
  assert.deepEqual(steps, [
    'context:done:48 files · 12 imports',
    'plan:done:',
    'topics:done:1 of 3',
    'check:failed:',
    'overview:queued:',
    'render:queued:',
  ]);
  assert.equal(
    must(explanationSteps(run([...planned, { type: 'finish', status: 'failed', error: '' }])).find((s) => s.id === 'topics'))
      .error,
    'Generation stopped without an error message.'
  );
});

void test('completion finishes every stage and ignores late events; cancellation stops writing topics', () => {
  const done = run([...planned, { type: 'finish', status: 'completed' }]);
  assert.ok(explanationSteps(done).every((step) => step.status === 'done'));
  assert.equal(reduceExplanationProgress(done, { type: 'phase', phase: 'Rendering' }), done);
  const cancelled = explanationSteps(
    run([...planned, { type: 'topic', id: 'slide-1', status: 'writing' }, { type: 'finish', status: 'cancelled' }])
  );
  const topics = must(cancelled.find((step) => step.id === 'topics'));
  assert.equal(topics.status, 'cancelled');
  assert.equal(must(topics.subtasks)[0].status, 'cancelled');
});

void test('single-shot generation has no plan or topic rows', () => {
  assert.deepEqual(
    summary([{ type: 'phase', phase: 'Building context' }, { type: 'phase', phase: 'Thinking' }]).map((s) =>
      s.split(':').slice(0, 2).join(':')
    ),
    ['context:done', 'generate:running', 'check:queued', 'overview:queued', 'render:queued']
  );
});

void test('a task with only a detail line still gets rows', () => {
  const steps = explanationStepsFromDetail('Writing topics', { completed: 1, total: 3 });
  assert.deepEqual(
    steps.map((s) => [s.id, s.status, s.meta ?? '']),
    [
      ['context', 'done', ''],
      ['plan', 'done', ''],
      ['topics', 'running', '1 of 3'],
      ['check', 'queued', ''],
      ['overview', 'queued', ''],
      ['render', 'queued', ''],
    ]
  );
  assert.equal(formatElapsed(102_400), '1m 42s');
  assert.equal(formatElapsed(9_000), '9s');
});

void test('steps crossing IPC keep known fields with bounded sizes', () => {
  const steps = sanitizeSteps([
    { id: 'topics', title: 'Write topics', status: 'running', extra: 'dropped', subtasks: [{ id: 's', title: 'x'.repeat(500), status: 'done', subtasks: [{ id: 'deep', title: 'Too deep', status: 'done' }] }] },
    { id: 'bad', title: 'Unknown status', status: 'exploded' },
    'not a step',
  ]);
  assert.ok(steps);
  assert.equal(steps.length, 1);
  assert.equal('extra' in steps[0], false);
  assert.equal(must(steps[0].subtasks)[0].title.length, 300);
  assert.equal(must(steps[0].subtasks)[0].subtasks, undefined);
  assert.equal(sanitizeSteps('nope'), undefined);
});

const slide = (id: string, title: string): Slide => ({
  id,
  slideNumber: Number(id.split('-')[1]),
  title,
  slideType: 'feature',
  narrative: `Narrative for ${title}`,
  reviewFocus: null,
  diffHunks: [],
  contextSnippets: [],
  affectedFiles: [],
  dependsOn: [],
});

void test('a build mirrors steps into Activity and serves finished topics with placeholders', () => {
  const activities = createActivityService();
  const builds = createExplanationBuilds(activities);
  activities.start({ id: 'review:r1', kind: 'review', title: 'Fix reconnect', detail: 'Preparing review', reviewId: 'r1' }, {});
  for (const event of planned) builds.event('r1', event);
  assert.equal(builds.draft('r1'), undefined, 'No draft before the plan base exists');
  builds.draftBase('r1', {
    prTitle: 'Fix reconnect',
    prDescription: '',
    prUrl: 'https://github.com/klang/engine/pull/150',
    author: 'lena',
    summary: 'Planner summary',
    riskLevel: 'low',
    riskRationale: '',
    totalFilesChanged: 3,
    totalLinesChanged: 20,
  });
  builds.event('r1', { type: 'topic', id: 'slide-2', status: 'writing' });
  const written = slide('slide-1', 'Retry scheduling moves to the consumer');
  builds.topicWritten('r1', written);
  written.narrative = 'Changed later by the text check';
  builds.event('r1', { type: 'topic', id: 'slide-1', status: 'done' });
  builds.event('r1', { type: 'topic', id: 'slide-3', status: 'failed', error: 'Model timed out.' });

  const task = activities.list()[0];
  assert.ok(task.startedAt, 'Tasks record when they started');
  assert.equal(task.steps?.find((step) => step.id === 'topics')?.meta, '1 of 3 · 1 failed');

  const draft = must(builds.draft('r1'));
  assert.deepEqual(draft.draft, { completed: 1, total: 3 });
  assert.equal(draft.reviewId, 'r1');
  assert.deepEqual(
    draft.slides.map((s) => [s.id, s.draftStatus ?? 'written', s.draftError ?? '']),
    [
      ['slide-1', 'written', ''],
      ['slide-2', 'writing', ''],
      ['slide-3', 'failed', 'Model timed out.'],
    ]
  );
  assert.equal(draft.slides[0].narrative, 'Narrative for Retry scheduling moves to the consumer', 'Drafts are copies');
  draft.slides[0].title = 'Edited by a reader';
  assert.equal(must(builds.draft('r1')).slides[0].title, 'Retry scheduling moves to the consumer');

  builds.event('r1', { type: 'finish', status: 'failed', error: '1 of 3 topics saved. Model timed out.' });
  activities.finish('review:r1', 'failed', '1 of 3 topics saved. Model timed out.');
  assert.equal(builds.draft('r1'), undefined, 'A stopped build has no draft');
  const failed = activities.list()[0];
  assert.equal(failed.status, 'failed');
  assert.equal(failed.steps?.find((step) => step.id === 'topics')?.status, 'failed', 'Failure keeps its rows');
  builds.clear('r1');
});
