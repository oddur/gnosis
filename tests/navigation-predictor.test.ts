import test from 'node:test';
import assert from 'node:assert/strict';
import { createNavigationPredictor, destinationKey, percentile, type Prediction } from '../lib/navigation-predictor';

const member = { url: 'https://github.com/o/r/pull/1', headSha: 'h'.repeat(40), baseSha: 'b'.repeat(40), updatedAt: '2026-01-01T00:00:00Z' };
const changes: Prediction = {
  destination: { kind: 'pr-tab', tab: 'changes', subjectId: member.url, members: [member] },
  weight: 0.6,
  strength: 'committed',
};

function harness() {
  let time = 0;
  const lines: string[] = [];
  const predictor = createNavigationPredictor({ now: () => time, report: (line) => lines.push(line) });
  return { predictor, lines, advance: (ms: number) => (time += ms), at: () => time };
}

void test('classifies hits, cold opens and kept tabs, and measures from the input event', () => {
  const { predictor, lines, advance, at } = harness();
  predictor.declare('pr:1', [changes]);
  const key = destinationKey(changes.destination);
  assert.equal(key, `pr-tab:changes:${member.url}`);
  advance(100);
  const input = at();
  advance(40);
  predictor.navigate(key, input);
  assert.equal(predictor.awaiting(key), true);
  predictor.arrived(key, { loading: false });
  assert.equal(predictor.awaiting(key), false);
  predictor.navigate(`pr-tab:checks:${member.url}`);
  advance(500);
  predictor.arrived(`pr-tab:checks:${member.url}`, { loading: true });
  predictor.navigate(key);
  predictor.arrived(key, { loading: false, kept: true });
  assert.deepEqual(predictor.records().map((r) => [r.kind, r.outcome, r.ttcMs, r.predicted]), [
    ['pr-tab:changes', 'hit', 40, 0.6],
    ['pr-tab:checks', 'cold', 500, undefined],
    ['pr-tab:changes', 'kept', 0, 0.6],
  ]);
  assert.equal(lines[0], 'nav pr-tab:changes hit 40ms predicted=0.6');
  assert.equal(lines[1], 'nav pr-tab:checks cold 500ms predicted=no from=pr-tab:changes');
  const summary = predictor.summary();
  assert.deepEqual(summary.destinations['pr-tab:changes'], { n: 2, hit: 1, joined: 0, cold: 0, kept: 1, p50: 40, p95: 40 });
  assert.deepEqual(summary.declared, { navigations: 3, predicted: 2 });
  assert.equal(summary.transitions['pr-tab:changes -> pr-tab:checks'], 1);
});

void test('an arrival without a navigation, a second arrival and an abandoned navigation record nothing', () => {
  const { predictor } = harness();
  predictor.arrived('pr-tab:changes:x', { loading: false });
  predictor.navigate('pr-tab:changes:x');
  predictor.abandon('pr-tab:changes:x');
  predictor.arrived('pr-tab:changes:x', { loading: false });
  predictor.navigate('pr-tab:commits:x');
  predictor.arrived('pr-tab:commits:x', { loading: false });
  predictor.arrived('pr-tab:commits:x', { loading: true });
  assert.deepEqual(predictor.records().map((r) => r.outcome), ['hit']);
});

void test('a repeated navigate keeps the first start time', () => {
  const { predictor, advance } = harness();
  predictor.navigate('pr-open:x');
  advance(200);
  predictor.navigate('pr-open:x');
  advance(100);
  assert.equal(predictor.arrived('pr-open:x', { loading: true })?.ttcMs, 300);
});

void test('percentiles use the nearest rank', () => {
  assert.equal(percentile([], 50), null);
  assert.equal(percentile([5], 95), 5);
  const values = Array.from({ length: 20 }, (_, i) => i + 1);
  assert.equal(percentile(values, 50), 10);
  assert.equal(percentile(values, 95), 19);
});

void test('reset clears records and declarations', () => {
  const { predictor } = harness();
  predictor.declare('pr:1', [changes]);
  predictor.navigate(destinationKey(changes.destination));
  predictor.arrived(destinationKey(changes.destination), { loading: false });
  predictor.reset();
  assert.deepEqual(predictor.summary().destinations, {});
  predictor.navigate(destinationKey(changes.destination));
  assert.equal(predictor.arrived(destinationKey(changes.destination), { loading: false })?.predicted, undefined);
});
