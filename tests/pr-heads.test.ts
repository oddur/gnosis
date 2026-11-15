import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHeadInvalidation, createHeadTracker, reportPrHead, setPrHeadReporter } from '../lib/pr-heads';

const url = 'https://github.com/acme/app/pull/1';
const sha = (c: string) => c.repeat(40);
const at = (minute: number) => `2026-11-15T09:${String(minute).padStart(2, '0')}:00Z`;

void test('the first head seen sets the baseline; a different head is one change', () => {
  const heads = createHeadTracker();
  assert.equal(heads.note(url, sha('a'), { source: 'metadata', updatedAt: at(0) }), undefined);
  assert.equal(heads.note(url, sha('a'), { source: 'signals' }), undefined, 'the same head again is no change');
  assert.deepEqual(heads.note(url, sha('b'), { source: 'search', updatedAt: at(1) }), { url, from: sha('a'), to: sha('b'), source: 'search' });
  assert.equal(heads.note(url, sha('b'), { source: 'metadata', updatedAt: at(1) }), undefined, 'a second read of the new head changes nothing');
  assert.equal(heads.current(url), sha('b'));
});

void test('a saved copy with another head makes the first read a change', () => {
  const heads = createHeadTracker({ known: () => ({ headSha: sha('a'), updatedAt: at(0) }) });
  assert.deepEqual(heads.note(url, sha('b'), { source: 'metadata', updatedAt: at(5) })?.from, sha('a'));
});

void test('a slow read of an older head cannot flip the PR back, but a newer force push can', () => {
  const heads = createHeadTracker();
  heads.note(url, sha('a'), { source: 'metadata', updatedAt: at(0) });
  heads.note(url, sha('b'), { source: 'metadata', updatedAt: at(2) });
  assert.equal(heads.note(url, sha('a'), { source: 'metadata', updatedAt: at(0) }), undefined, 'an older read of the old head');
  assert.equal(heads.note(url, sha('a'), { source: 'signals' }), undefined, 'an old head without a time');
  assert.equal(heads.note(url, sha('c'), { source: 'metadata', updatedAt: at(1) }), undefined, 'a read older than the current report');
  assert.equal(heads.note(url, sha('a'), { source: 'metadata', updatedAt: at(3) })?.to, sha('a'), 'force-pushed back, reported later');
});

void test('a new head invalidates everything keyed to the old head once, and tells every window', () => {
  const calls: string[] = [];
  const heads = createHeadInvalidation({
    known: () => ({ headSha: sha('a'), updatedAt: at(0) }),
    dropSaved: (changed, old) => calls.push(`saved ${changed} ${old.slice(0, 1)}`),
    dropThreads: (changed) => calls.push(`threads ${changed}`),
    invalidateViews: (changed, kinds) => calls.push(`views ${changed} ${kinds.join(',')}`),
    readPr: (changed) => calls.push(`read ${changed}`),
    broadcast: (change) => calls.push(`broadcast ${change.from.slice(0, 1)}>${change.to.slice(0, 1)}`),
  });
  assert.equal(heads.note(url, sha('a'), { source: 'metadata', updatedAt: at(0) }), undefined);
  assert.equal(calls.length, 0, 'the saved head again: nothing to drop');
  heads.note(url, sha('b'), { source: 'metadata', updatedAt: at(1) });
  assert.deepEqual(calls, [
    `saved ${url} a`,
    `threads ${url}`,
    `views ${url} signals,checks,discussion`,
    'broadcast a>b',
  ], 'a PR read already published the new PR, so no second read');
  calls.length = 0;
  heads.note(url, sha('b'), { source: 'search', updatedAt: at(1) });
  heads.note(url, sha('b'), { source: 'signals' });
  assert.equal(calls.length, 0, 'other reads of the same head change nothing');
  heads.note(url, sha('c'), { source: 'signals' });
  assert.ok(calls.includes(`read ${url}`), 'a signals read names only the head: the PR is read');
  assert.ok(calls.includes('broadcast b>c'));
});

void test('invalid heads are ignored and clear forgets an account', () => {
  const heads = createHeadTracker();
  assert.equal(heads.note(url, 'not-a-sha', { source: 'metadata' }), undefined);
  heads.note(url, sha('a'), { source: 'metadata' });
  heads.clear();
  assert.equal(heads.current(url), undefined);
});

void test('readers report heads through one registered reporter that never fails the read', () => {
  const seen: string[] = [];
  setPrHeadReporter((_client, reported, head, observation) => seen.push(`${reported}@${head.slice(0, 1)}:${observation.source}`));
  reportPrHead({}, url, sha('a'), { source: 'metadata' });
  setPrHeadReporter(() => {
    throw new Error('boom');
  });
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.doesNotThrow(() => reportPrHead({}, url, sha('b'), { source: 'metadata' }));
  } finally {
    console.warn = warn;
    setPrHeadReporter(undefined);
  }
  assert.deepEqual(seen, [`${url}@a:metadata`]);
});
