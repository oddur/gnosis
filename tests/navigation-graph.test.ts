import test from 'node:test';
import assert from 'node:assert/strict';
import { PREDICTION_THRESHOLD, predictableMembers, prOpenPredictions } from '../lib/navigation-graph';
import { destinationKind } from '../lib/navigation-predictor';

const member = { url: 'https://github.com/o/r/pull/1', headSha: 'h'.repeat(40), baseSha: 'b'.repeat(40), updatedAt: '2026-01-01T00:00:00Z' };
const base = { subjectId: member.url, members: [member], attention: 0, running: 0, unresolved: 0, responseNeeded: false, explanationReady: false };
const weights = (input: Partial<typeof base>) =>
  Object.fromEntries(prOpenPredictions({ ...base, ...input }).map((p) => [destinationKind(p.destination), p.weight]));
const executed = (input: Partial<typeof base>) =>
  prOpenPredictions({ ...base, ...input }).filter((p) => p.weight >= PREDICTION_THRESHOLD).map((p) => destinationKind(p.destination));

void test('a quiet PR predicts Changes only', () => {
  assert.deepEqual(weights({}), {
    'pr-tab:changes': 0.6, 'pr-tab:checks': 0.1, 'pr-tab:feedback': 0.1, 'pr-tab:explanation': 0, 'pr-tab:commits': 0.15,
  });
  assert.deepEqual(executed({}), ['pr-tab:changes'], 'Weights below 0.2 are declared and measured, not run');
});

void test('failing checks, running checks, open threads, a needed response and a ready explanation raise their tabs', () => {
  assert.equal(weights({ attention: 2 })['pr-tab:checks'], 0.5);
  assert.equal(weights({ running: 1 })['pr-tab:checks'], 0.3);
  assert.equal(weights({ unresolved: 3 })['pr-tab:feedback'], 0.5);
  assert.equal(weights({ responseNeeded: true })['pr-tab:feedback'], 0.5);
  assert.equal(weights({ explanationReady: true })['pr-tab:explanation'], 0.5);
  assert.deepEqual(executed({ attention: 1, responseNeeded: true }), ['pr-tab:changes', 'pr-tab:checks', 'pr-tab:feedback']);
});

void test('the failing-check count is part of each destination, so new failures read their details', () => {
  const checks = (attention: number) => prOpenPredictions({ ...base, attention }).find((p) => destinationKind(p.destination) === 'pr-tab:checks');
  assert.notDeepEqual(checks(1)?.destination, checks(2)?.destination);
});

void test('every tab is predicted while the PR is open, and nothing without a GitHub revision', () => {
  assert.equal(prOpenPredictions({ ...base, members: [] }).length, 0);
  assert.deepEqual(predictableMembers([{ ...member, url: 'local:review' }, member, { ...member, headSha: '' }]), [member]);
  assert.equal(predictableMembers(Array.from({ length: 9 }, () => member)).length, 5, 'At most five stack members');
});

void test('entry points become intents: PRs and stacks, a focused stack member, saved reviews and PR tabs', async () => {
  const { destinationIntent, openIntent, reviewIntent, tabIntent } = await import('../lib/navigation-graph');
  assert.equal(openIntent('local', [{ ...member, url: 'local:/repo' }]), null, 'Local reviews have nothing to prepare');
  assert.deepEqual(openIntent(member.url, [member])?.destination, { kind: 'pr-open', subjectId: member.url, members: [member] });
  assert.equal(openIntent(member.url, [member])?.strength, 'intent');
  assert.deepEqual(reviewIntent('r1', ['d2']).destination, { kind: 'review', reviewId: 'r1', diagrams: ['d2'] });
  assert.equal(tabIntent(member.url, 'checks', [], 1), null);
  assert.equal(tabIntent(member.url, 'checks', [member], 1)?.destination.kind, 'pr-tab');
  const second = { ...member, url: 'https://github.com/o/r/pull/2' };
  const stack = { subject: { id: 'stack', kind: 'stack', title: 'Stack', members: [member, second], edges: [], warnings: [] }, attention: 'other' } as unknown as import('../lib/workbench').QueueItem;
  assert.deepEqual(destinationIntent({ kind: 'home', subject: stack })?.destination, { kind: 'pr-open', subjectId: 'stack', members: [member, second] });
  assert.deepEqual(destinationIntent({ kind: 'home', subject: stack, focusUrl: second.url })?.destination, { kind: 'pr-open', subjectId: second.url, members: [second] });
  assert.equal(destinationIntent({ kind: 'review', reviewId: 'r2' })?.destination.kind, 'review');
  assert.equal(destinationIntent({ kind: 'home', section: 'all' }), null, 'Views and settings are local');
});
