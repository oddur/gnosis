import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cascadePrLine, cascadeSentence, type CascadePr, type CascadePreview } from '../lib/conflict-cascade';
import { CASCADE_OUT_OF_DATE, CASCADE_RETRY_MS, createCascadePreviews } from '../src/conflict-cascade';
import { BACKGROUND_YIELDED } from '../src/conflict-resolution-service';

const pr = (n: number, outcome: CascadePr['outcome'], extra: Partial<CascadePr> = {}): CascadePr => ({
  url: `https://github.com/o/r/pull/${n}`,
  title: `PR ${n}`,
  outcome,
  merges: 0,
  review: outcome !== 'clean' && outcome !== 'merged',
  ...extra,
});
const preview = (prs: CascadePr[], version = 1): CascadePreview => ({ version, url: 'https://github.com/o/r/pull/101', prs });

void test('the cascade sentence names what the push settles, where it stops, and what waits (#445 item 22)', () => {
  assert.equal(
    cascadeSentence(preview([pr(102, 'clean'), pr(103, 'merged'), pr(104, 'conflicts', { conflicts: 1 })])),
    'Resolving #101 also settles #102 and #103. #104 has 1 new conflict.'
  );
  assert.equal(
    cascadeSentence(preview([pr(102, 'conflicts', { conflicts: 3 }), pr(103, 'waiting'), pr(104, 'waiting')])),
    '#102 has 3 new conflicts. #103 and #104 wait for #102.'
  );
  assert.equal(
    cascadeSentence(preview([pr(102, 'carried'), pr(103, 'clean', { merges: 2, review: true }), pr(104, 'merged')])),
    'Resolving #101 also settles #102, #103 and #104.'
  );
  assert.equal(cascadePrLine(pr(103, 'merged')), '#103 · Merged and checked · No review needed');
  assert.equal(cascadePrLine(pr(102, 'carried')), '#102 · Settled by your choices · Needs your review');
  assert.equal(
    cascadePrLine(pr(104, 'clean', { merges: 1, review: true })),
    '#104 · Replays cleanly · Recreates 1 merge commit · Needs your review'
  );
  assert.equal(cascadePrLine(pr(105, 'conflicts', { conflicts: 2 })), '#105 · 2 new conflicts to check or decide · Needs your review');
  assert.equal(cascadePrLine(pr(106, 'waiting')), '#106 · Checked after the PR below it');
});

const ID = 'a'.repeat(64);
const tick = () => new Promise((resolve) => setImmediate(resolve));
function harness(current: Record<string, number> = {}) {
  const calls: { id: string; version: number; signal: AbortSignal; resolve: (value: CascadePreview | undefined) => void; reject: (error: Error) => void }[] = [];
  const changed: string[] = [];
  let battery = false;
  let clock = 1_000_000;
  const previews = createCascadePreviews({
    run: (id, version, signal) =>
      new Promise((resolve, reject) => {
        calls.push({ id, version, signal, resolve, reject });
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }),
    onBattery: () => battery,
    account: () => 'me',
    current: (id) => current[id],
    changed: (id) => changed.push(id),
    now: () => clock,
  });
  return {
    previews,
    calls,
    changed,
    setBattery: (value: boolean) => (battery = value),
    advance: (ms: number) => (clock += ms),
  };
}

void test('the cascade preview runs once per draft version, and a newer version cancels the older run (#445 item 22)', async () => {
  const h = harness();
  assert.deepEqual(h.previews.request(ID, 1), { state: 'checking' });
  await tick();
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.previews.request(ID, 1), { state: 'checking' }, 'Asking again does not start another run');
  await tick();
  assert.equal(h.calls.length, 1);
  // The draft changed: the old run stops, and the new one starts once the old one let go.
  assert.deepEqual(h.previews.request(ID, 2), { state: 'checking' });
  assert.equal(h.calls[0].signal.aborted, true);
  await tick();
  await tick();
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1].version, 2);
  // A second window still on version 1 is told it is out of date, and the run for version 2 goes on.
  assert.deepEqual(h.previews.request(ID, 1), { state: 'failed', message: CASCADE_OUT_OF_DATE });
  assert.equal(h.calls[1].signal.aborted, false);
  h.calls[1].resolve(preview([pr(102, 'clean')], 2));
  await tick();
  assert.deepEqual(h.changed, [ID], 'Only the run that counts says it changed');
  const ready = h.previews.request(ID, 2);
  assert.equal(ready?.state, 'ready');
  h.previews.request(ID, 2);
  await tick();
  assert.equal(h.calls.length, 2, 'Cached for its version');
});

void test('the cascade preview waits for power and gives way to your requests (#445 item 22)', async () => {
  const h = harness({ [ID]: 1 });
  h.setBattery(true);
  assert.deepEqual(h.previews.request(ID, 1), { state: 'battery' });
  await tick();
  assert.equal(h.calls.length, 0, 'Nothing starts on battery');
  h.setBattery(false);
  h.previews.power();
  await tick();
  assert.equal(h.calls.length, 1, 'On power it starts');
  // Back on battery: the run stops and waits.
  h.setBattery(true);
  h.previews.power();
  assert.equal(h.calls[0].signal.aborted, true);
  await tick();
  assert.deepEqual(h.previews.request(ID, 1), { state: 'battery' });
  h.setBattery(false);
  h.previews.power();
  await tick();
  assert.equal(h.calls.length, 2);
  // A request of yours stopped it, or the PR was busy: it says so, and the window's next ask starts it again.
  let before = h.changed.length;
  h.calls[1].reject(new Error(BACKGROUND_YIELDED));
  await tick();
  assert.equal(h.changed.length, before + 1);
  assert.deepEqual(h.previews.request(ID, 1), { state: 'checking' });
  await tick();
  assert.equal(h.calls.length, 3);
  before = h.changed.length;
  h.calls[2].resolve(undefined);
  await tick();
  assert.equal(h.changed.length, before + 1, 'Busy: the window hears it and asks again');
  assert.deepEqual(h.previews.request(ID, 1), { state: 'checking' });
  await tick();
  assert.equal(h.calls.length, 4);
  // A failure stays until Check again, or an ask a minute later.
  h.calls[3].reject(new Error('Cannot update https://github.com/o/r/pull/102.'));
  await tick();
  const failed = { state: 'failed', message: 'Cannot update https://github.com/o/r/pull/102.' };
  assert.deepEqual(h.previews.request(ID, 1), failed);
  await tick();
  assert.equal(h.calls.length, 4);
  assert.deepEqual(h.previews.request(ID, 1, true), { state: 'checking' }, 'Check again');
  await tick();
  assert.equal(h.calls.length, 5);
  h.calls[4].reject(new Error('Cannot update https://github.com/o/r/pull/102.'));
  await tick();
  h.advance(CASCADE_RETRY_MS);
  assert.deepEqual(h.previews.request(ID, 1), { state: 'checking' }, 'A minute later');
  await h.previews.dispose();
});

void test('on power, only recent current drafts start again, at most two (#445 item 22)', async () => {
  const ids = ['b', 'c', 'd', 'e'].map((c) => c.repeat(64));
  // d's draft moved on to version 2; e was asked about long ago.
  const h = harness({ [ids[0]]: 1, [ids[1]]: 1, [ids[2]]: 2, [ids[3]]: 1 });
  h.setBattery(true);
  h.previews.request(ids[3], 1);
  h.advance(10 * 60_000);
  for (const id of ids.slice(0, 3)) {
    h.previews.request(id, 1);
    h.advance(1000);
  }
  h.previews.request(ids[0], 1);
  h.setBattery(false);
  h.previews.power();
  await tick();
  assert.deepEqual(
    h.calls.map((call) => call.id).sort(),
    [ids[0], ids[1]].sort(),
    'The two most recent current drafts start; a draft that moved on and an old one do not'
  );
  assert.equal(h.previews.request(ids[2], 1)?.state, 'checking', 'A dropped draft starts again when a window asks');
  await h.previews.dispose();
});

void test('dispose waits for running previews to clean up, at most 3 seconds (#445 item 22)', async () => {
  let cleaned = false;
  const previews = createCascadePreviews({
    run: (_id, _version, signal) =>
      new Promise((_, reject) =>
        signal.addEventListener(
          'abort',
          () =>
            setTimeout(() => {
              cleaned = true;
              reject(new Error('aborted'));
            }, 50),
          { once: true }
        )
      ),
    onBattery: () => false,
    account: () => 'me',
    changed: () => {},
  });
  previews.request(ID, 1);
  await tick();
  await previews.dispose();
  assert.equal(cleaned, true, 'The run finished its cleanup before dispose resolved');
});
