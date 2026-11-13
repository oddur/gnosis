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
