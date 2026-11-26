import assert from 'node:assert/strict';
import { test } from 'node:test';
import { markSeen, pageStep, seenShare } from '../lib/review-paging';
import { currentItem } from '../lib/tree-symbol-review';

/** Long symbols: V pages through before it ticks (lib/review-paging.ts). */

// A 100-line added function: its lines a1…a100 are places 0…99 of the diff.
const lines = Array.from({ length: 100 }, (_, i) => `a${i + 1}`);
const place = (line: string) => (line.startsWith('a') ? Number(line.slice(1)) - 1 : undefined);

void test('V ticks an item that fits on screen at once', () => {
  const seen = new Set<string>();
  const short = ['a3', 'a4', 'a9'];
  markSeen(seen, short, place, [0, 40]);
  assert.deepEqual(pageStep({ lines: short, place, seen, range: [0, 40], atEnd: false }), { kind: 'tick' });
});

void test('a long item pages down until every line has been on screen, then ticks', () => {
  const seen = new Set<string>();
  const screens: [number, number][] = [[0, 39], [38, 77], [76, 99]];
  const steps = screens.map((range) => {
    markSeen(seen, lines, place, range);
    return pageStep({ lines, place, seen, range, atEnd: false }).kind;
  });
  assert.deepEqual(steps, ['down', 'down', 'tick']);
  assert.equal(seenShare(lines, seen), 100);
});

void test('what was seen counts, wherever the reader scrolled: lines above the view are gone back to', () => {
  const seen = new Set<string>();
  // The reader jumped to the item's end: its start was never on screen.
  markSeen(seen, lines, place, [60, 99]);
  assert.equal(seenShare(lines, seen), 40);
  assert.deepEqual(pageStep({ lines, place, seen, range: [60, 99], atEnd: true }), { kind: 'to', place: 0 }, 'Back to the first unseen line');
  // Then it shows, and the rest has been seen before: the next V ticks.
  markSeen(seen, lines, place, [0, 59]);
  assert.deepEqual(pageStep({ lines, place, seen, range: [0, 59], atEnd: false }), { kind: 'tick' });
});

void test('V never gets stuck: at the end of the stream it ticks, and lines the diff does not show do not count', () => {
  const seen = new Set<string>();
  markSeen(seen, lines, place, [0, 39]);
  assert.deepEqual(pageStep({ lines, place, seen, range: [0, 39], atEnd: true }), { kind: 'tick' }, 'Nothing more to scroll to');
  // A line in a hidden quiet hunk has no place: only the shown ones are waited for.
  const hidden = ['a1', 'b500'];
  const seenHidden = new Set<string>();
  markSeen(seenHidden, hidden, place, [0, 10]);
  assert.deepEqual(pageStep({ lines: hidden, place, seen: seenHidden, range: [0, 10], atEnd: false }), { kind: 'tick' });
  // Nothing of the diff on screen (a slice still mounting): it pages on, rather than ticking blind.
  assert.deepEqual(pageStep({ lines, place, seen: new Set(), range: undefined, atEnd: false }), { kind: 'down' });
});

void test("after the reader's own scroll, the long item they are in stays current over a neighbour peeking in", () => {
  const long = { key: 'a.ts', id: 'function:long' };
  const next = { key: 'a.ts', id: 'function:next' };
  assert.deepEqual(currentItem({ moved: true, reading: next, paging: { item: long, onScreen: true, done: false } }), long);
  // Seen whole, or scrolled off: the reading position decides again.
  assert.deepEqual(currentItem({ moved: true, reading: next, paging: { item: long, onScreen: true, done: true } }), next);
  assert.deepEqual(currentItem({ moved: true, reading: next, paging: { item: long, onScreen: false, done: false } }), next);
  // A target the reader was taken to comes first, as before.
  assert.deepEqual(currentItem({ target: next, paging: { item: long, onScreen: true, done: false } }), next);
});
