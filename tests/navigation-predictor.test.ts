import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createNavigationPredictor,
  destinationKey,
  percentile,
  PREDICTOR_READS,
  type Prediction,
  type PredictionConditions,
  type PredictorReads,
} from '../lib/navigation-predictor';
import { prOpenPredictions } from '../lib/navigation-graph';

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

function running(options: { concurrency?: number } = {}) {
  let time = 0;
  const calls: string[] = [];
  const releases: (() => void)[] = [];
  let hold = false;
  const conditions: PredictionConditions = {
    enabled: true, online: true, visible: true, focused: true,
    state: { off: false, paused: false, battery: false, hot: false, light: false },
  };
  const warm = new Set<string>();
  const done = (name: string) => {
    calls.push(name);
    return hold ? new Promise<void>((resolve) => releases.push(resolve)) : Promise.resolve();
  };
  const reads: PredictorReads = {
    changes: (m, _subject, files, label) => done(`changes ${m.url} files=${files} ${label}`),
    changesReady: (m) => warm.has(`changes ${m.url}`),
    open: (members, label) => done(`open ${members.map((m) => m.url).join(',')} ${label}`),
    openIntent: (members) => void calls.push(`intent ${members ? members.map((m) => m.url).join(',') : 'clear'}`),
    graph: (m, label) => done(`graph ${m.url} ${label}`),
    chunk: (name) => done(`chunk ${name}`),
    review: (id) => done(`review ${id}`),
    reviewReady: (id) => warm.has(`review ${id}`),
  };
  const predictor = createNavigationPredictor({ now: () => time, reads, conditions: () => conditions, concurrency: options.concurrency });
  const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve)); };
  return {
    predictor, calls, conditions, warm, flush,
    advance: (ms: number) => (time += ms),
    hold: (value: boolean) => (hold = value),
    release: async () => { releases.splice(0).forEach((resolve) => resolve()); await flush(); },
  };
}
const opened = (input: Partial<Parameters<typeof prOpenPredictions>[0]> = {}) =>
  prOpenPredictions({ subjectId: member.url, members: [member], attention: 0, running: 0, unresolved: 0, responseNeeded: false, explanationReady: false, ...input });

void test('opening a PR runs Changes, Checks and Feedback reads once each, two at a time, highest weight first', async () => {
  const h = running();
  h.hold(true);
  h.predictor.declare('pr:1', opened({ attention: 1, unresolved: 2 }));
  await h.flush();
  assert.deepEqual(h.calls, [`changes ${member.url} files=3 pr-tab:changes`, `open ${member.url} pr-tab:changes`], 'Two in flight');
  await h.release();
  await h.release();
  await h.release();
  assert.deepEqual(h.calls.slice(2), [`graph ${member.url} pr-tab:checks`, 'chunk workflow-graph'],
    'Checks adds its graph and chunk; threads and check details are one read for the PR');
  const before = h.calls.length;
  h.predictor.declare('pr:1', opened({ attention: 1, unresolved: 2 }));
  h.predictor.declare('other', opened({ attention: 1, unresolved: 2 }));
  await h.release();
  assert.equal(h.calls.length, before, 'Each resource runs once');
});

void test('work that has not started is dropped when the set changes; work in flight finishes', async () => {
  const h = running({ concurrency: 1 });
  h.hold(true);
  h.predictor.declare('pr:1', opened({ attention: 1 }));
  await h.flush();
  assert.equal(h.calls.length, 1);
  h.predictor.declare('pr:1', []);
  await h.release();
  assert.equal(h.calls.length, 1, 'Leaving the PR drops the rest');
  assert.deepEqual(h.predictor.wanted(), []);
});

void test('nothing runs when off, paused, hidden or offline; a blurred window runs committed work but no intent', async () => {
  for (const change of [
    (c: PredictionConditions) => (c.enabled = false),
    (c: PredictionConditions) => (c.state.off = true),
    (c: PredictionConditions) => (c.state.paused = true),
    (c: PredictionConditions) => (c.visible = false),
    (c: PredictionConditions) => (c.online = false),
  ]) {
    const h = running();
    change(h.conditions);
    h.predictor.declare('pr:1', opened());
    await h.flush();
    assert.deepEqual(h.calls, []);
    h.predictor.intent('palette', { destination: { kind: 'review', reviewId: 'r1' }, weight: 1, strength: 'intent' });
    await h.flush();
    assert.deepEqual(h.calls, [], 'Intent is gated too');
  }
  const blurred = running();
  blurred.conditions.focused = false;
  blurred.predictor.intent('palette', { destination: { kind: 'review', reviewId: 'r1' }, weight: 1, strength: 'intent' });
  blurred.predictor.intent('queue', { destination: { kind: 'pr-open', subjectId: 'x', members: [member] }, weight: 1, strength: 'intent' });
  await blurred.flush();
  assert.deepEqual(blurred.calls, []);
  blurred.predictor.declare('pr:1', opened());
  await blurred.flush();
  assert.equal(blurred.calls.length, 2, 'Committed work for the open PR still runs');
  const resumed = running();
  resumed.conditions.state.paused = true;
  resumed.predictor.declare('pr:1', opened());
  await resumed.flush();
  resumed.conditions.state.paused = false;
  resumed.predictor.wake();
  await resumed.flush();
  assert.equal(resumed.calls.length, 2, 'Work resumes when conditions allow');
});

void test('on battery or near the predicted cap, a PR reads one file body instead of three', async () => {
  const h = running();
  h.conditions.state.light = true;
  h.predictor.declare('pr:1', opened());
  await h.flush();
  assert.equal(h.calls[0], `changes ${member.url} files=1 pr-tab:changes`);
});

void test('warm data sends nothing, and a finished read is not repeated within a minute', async () => {
  const h = running();
  h.warm.add(`changes ${member.url}`);
  h.predictor.declare('pr:1', opened());
  await h.flush();
  assert.deepEqual(h.calls, [`open ${member.url} pr-tab:changes`]);
  h.predictor.declare('pr:1', []);
  h.predictor.declare('pr:1', opened());
  await h.flush();
  assert.equal(h.calls.length, 1, 'Re-opening within a minute repeats nothing');
  h.advance(60_001);
  h.predictor.declare('pr:1', []);
  h.predictor.declare('pr:1', opened());
  await h.flush();
  assert.equal(h.calls.length, 2, 'After a minute, saved copies are checked again; main sends nothing if they are fresh');
});

void test('a navigation during a prediction in flight is joined; used and wasted predictions are counted', async () => {
  const h = running();
  h.hold(true);
  h.predictor.declare('pr:1', opened({ attention: 1 }));
  await h.flush();
  const changes = `pr-tab:changes:${member.url}`;
  h.predictor.navigate(changes);
  h.advance(120);
  assert.equal(h.predictor.arrived(changes, { loading: true })?.outcome, 'joined');
  await h.release();
  await h.release();
  await h.release();
  h.predictor.declare('pr:1', []);
  const summary = h.predictor.summary();
  assert.equal(summary.predictions, 2, 'Changes and Checks ran');
  assert.equal(summary.used, 1);
  assert.equal(summary.wasted, 1, 'Checks was never opened');
});

void test('hover intent forwards a PR to the queue preparation and clears it on leave', async () => {
  const h = running();
  const destination = { kind: 'pr-open' as const, subjectId: member.url, members: [member] };
  h.predictor.intent('palette', { destination, weight: 1, strength: 'intent' });
  h.predictor.intent('palette', null);
  h.predictor.intent('palette', { destination: { kind: 'review', reviewId: 'r1', diagrams: ['mermaid'] }, weight: 1, strength: 'intent' });
  await h.flush();
  assert.deepEqual(h.calls, [`intent ${member.url}`, 'intent clear', 'review r1', 'chunk review-page', 'chunk mermaid']);
});

void test('predictions can reach only read executors', () => {
  const allowed = ['changes', 'changesReady', 'open', 'openIntent', 'graph', 'chunk', 'review', 'reviewReady'];
  assert.deepEqual([...PREDICTOR_READS].sort(), [...allowed].sort());
  // The type has exactly these keys: adding a write or generate executor fails to compile here.
  const keys: Record<keyof PredictorReads, true> = { changes: true, changesReady: true, open: true, openIntent: true, graph: true, chunk: true, review: true, reviewReady: true };
  assert.deepEqual(Object.keys(keys).sort(), [...allowed].sort());
  assert.ok(!allowed.some((name) => /write|post|submit|generate|mark|merge|comment|download|lfs/i.test(name)));
});

void test('turning the setting off stops new predictions; work in flight finishes; turning it on resumes', async () => {
  const h = running({ concurrency: 1 });
  h.hold(true);
  h.predictor.declare('pr:1', opened({ attention: 1 }));
  await h.flush();
  assert.equal(h.calls.length, 1);
  h.conditions.enabled = false;
  await h.release();
  assert.equal(h.calls.length, 1, 'Nothing new starts while off');
  h.predictor.intent('palette', { destination: { kind: 'pr-open', subjectId: 'x', members: [member] }, weight: 1, strength: 'intent' });
  assert.equal(h.calls.length, 1, 'Hover intent from new entry points is off too');
  h.hold(false);
  h.conditions.enabled = true;
  h.predictor.wake();
  await h.flush();
  assert.notEqual(h.calls.length, 1, 'Turning it on resumes the set');
});
