import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createDeepLinks,
  DEEP_LINK_BURST,
  DEEP_LINK_FOCUS_MS,
  DEEP_LINK_QUEUE_LIMIT,
  DEEP_LINK_REFILL_MS,
  DEEP_LINK_REPORT_MS,
  type DeepLinkDelivery,
} from '../src/deep-link-service';

function harness(schemes = ['gnosis']) {
  let clock = 1_000_000;
  const lines: string[] = [];
  const sent: DeepLinkDelivery[] = [];
  const timers: { at: number; run: () => void }[] = [];
  let shown = 0;
  const links = createDeepLinks({
    show: () => shown++,
    send: (_id, item) => (sent.push(item), true),
    log: (line) => lines.push(line),
    schemes,
    now: () => clock,
    schedule: (run, ms) => timers.push({ at: clock + ms, run }),
  });
  return {
    links,
    lines,
    sent,
    shown: () => shown,
    advance(ms: number) {
      clock += ms;
      for (const timer of timers.splice(0).sort((a, b) => a.at - b.at)) {
        if (timer.at <= clock) timer.run();
        else timers.push(timer);
      }
    },
  };
}

void test('an outside link waits for the renderer, is parsed in main, and is delivered once ready', () => {
  const h = harness();
  assert.equal(h.links.receive('gnosis://pr/oddur/gnosis/160/checks', 'os'), true);
  assert.equal(h.shown(), 1, 'The window is shown at once');
  assert.deepEqual(h.sent, []);
  const [item] = h.links.take(1);
  assert.deepEqual([item.source, item.target], ['os', { kind: 'pr', pr: { host: 'github.com', owner: 'oddur', repo: 'gnosis', number: 160 }, tab: 'checks' }]);
  // Ready: later links are sent at once.
  h.advance(DEEP_LINK_FOCUS_MS);
  h.links.receive('gnosis://pr/oddur/gnosis/161', 'content');
  assert.equal(h.sent.length, 1);
  // A reload clears the ready mark; the next renderer takes what waited.
  h.links.reset(1);
  h.links.receive('gnosis://pr/oddur/gnosis/162', 'os');
  assert.equal(h.sent.length, 1);
  assert.equal(h.links.take(2).length, 1);
});

void test('a refused link is delivered as an error, and log lines never contain the link', () => {
  const h = harness();
  const secret = 'ghp_secretsecretsecret';
  assert.equal(h.links.receive(`gnosis://pr/o/r/1/changes?file=../${secret}`, 'os'), false);
  assert.equal(h.links.receive(`gnosis://${secret}`, 'content'), false);
  assert.equal(h.links.receive({ not: 'a string' }, 'os'), false);
  assert.deepEqual(h.links.take(1).map((item) => item.error), [{ code: 'bad-parameter', route: 'pr' }, { code: 'unknown-route' }, { code: 'malformed' }]);
  assert.deepEqual(h.lines, [
    '[link] source=os route=pr result=rejected code=bad-parameter',
    '[link] source=content result=rejected code=unknown-route',
    '[link] source=os result=rejected code=malformed',
  ]);
  h.links.receive('gnosis://pr/o/r/1/changes?file=src/main.ts', 'os');
  assert.equal(h.lines.at(-1), '[link] source=os route=pr result=accepted');
  assert.doesNotMatch(h.lines.join('\n'), /secret|main\.ts|github/);
});

void test('the scheme is this build’s: gnosis-dev links only in development', () => {
  const dev = harness(['gnosis-dev']);
  assert.equal(dev.links.receive('gnosis://pr/o/r/1', 'os'), false);
  assert.equal(dev.links.receive('gnosis-dev://pr/o/r/1', 'os'), true);
});

void test('outside links are rate-limited by a token bucket; one report per 10 seconds', () => {
  const h = harness();
  const accepted = () => h.lines.filter((line) => line.includes('result=accepted')).length;
  for (let i = 0; i < 200; i++) h.links.receive(`gnosis://pr/o/r/${i + 1}/explanation`, 'os');
  assert.equal(accepted(), DEEP_LINK_BURST, 'Five links pass at once');
  assert.equal(h.links.pending(), DEEP_LINK_QUEUE_LIMIT, 'The pending queue holds 5');
  // The report of dropped links comes once, with the count, and never starts anything.
  h.advance(0);
  const waiting = h.links.take(1);
  assert.equal(waiting.length, DEEP_LINK_QUEUE_LIMIT);
  assert.deepEqual(waiting.at(-1)?.error, { code: 'rate-limited', count: 195 });
  // One more token every 2 seconds.
  h.advance(DEEP_LINK_REFILL_MS - 1);
  h.links.receive('gnosis://pr/o/r/500', 'os');
  assert.equal(accepted(), DEEP_LINK_BURST);
  h.advance(1);
  h.links.receive('gnosis://pr/o/r/501', 'os');
  assert.equal(accepted(), DEEP_LINK_BURST + 1);
  // Drops within 10 seconds of the last report are reported when that window ends.
  const reports = () => h.sent.filter((item) => item.error?.code === 'rate-limited');
  assert.equal(reports().length, 0);
  h.advance(DEEP_LINK_REPORT_MS - DEEP_LINK_REFILL_MS - 1);
  assert.equal(reports().length, 0);
  h.advance(1);
  assert.deepEqual(reports().map((item) => item.error?.count), [1], 'The link dropped at 2 s minus 1 ms');
});

void test('trusted sources bypass the rate limit and the focus limit', () => {
  const h = harness();
  for (let i = 0; i < 20; i++) h.links.open({ kind: 'review', reviewId: `r${i}` }, 'notification');
  assert.equal(h.lines.filter((line) => line.includes('result=accepted')).length, 20);
  assert.equal(h.shown(), 20);
  for (let i = 0; i < 4; i++) h.links.receive(`gnosis://pr/o/r/${i + 1}`, 'os');
  assert.equal(h.shown(), 21, 'Outside links focus the window at most once per second');
  h.advance(DEEP_LINK_FOCUS_MS);
  h.links.receive('gnosis://pr/o/r/9', 'os');
  assert.equal(h.shown(), 22);
});

void test('duplicates of the newest waiting link are dropped, and the queue holds 5', () => {
  const h = harness();
  h.links.receive('gnosis://pr/o/r/1', 'os');
  h.links.receive('gnosis://pr/o/r/1', 'os');
  assert.equal(h.links.pending(), 1);
  h.links.receive('gnosis://nope', 'os');
  h.links.receive('gnosis://nope', 'os');
  assert.equal(h.links.pending(), 2, 'A repeated refusal is shown once');
});
