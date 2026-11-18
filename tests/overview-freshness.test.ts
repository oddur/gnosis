/** The Overview's freshness line (lib/overview-freshness.ts): when the page is up to date, and what it says if not. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LIST_STALE_MS,
  REFRESH_NOTE_TITLE,
  STATUS_FRESH_MS,
  STATUS_GRACE_MS,
  overviewFreshness,
  statusFreshness,
  type StatusFreshness,
} from '../lib/overview-freshness';
import type { WorkbenchSync } from '../lib/workbench';

const NOW = Date.parse('2026-11-18T14:00:00Z');
const MIN = 60_000;
const fresh: StatusFreshness = { total: 40, missing: 0, stale: 0, pending: 0, oldestAt: NOW - 2 * MIN };
const idle: WorkbenchSync = { status: 'idle', checkedAt: NOW - 4 * MIN, signals: true };
const line = (input: Parameters<typeof overviewFreshness>[0]) => overviewFreshness(input).line;

void test('up to date: fresh status, signals answering, no error. Quiet, no spinner, the oldest status time', () => {
  const value = overviewFreshness({ sync: idle, status: fresh, now: NOW });
  assert.equal(value.line?.kind, 'up-to-date');
  assert.equal(value.line?.text, 'Up to date · 2m ago');
  assert.equal(value.line?.at, NOW - 2 * MIN);
  assert.equal(value.line?.spinner, undefined);
  assert.equal(value.line?.problem, undefined);
  assert.equal(value.progress, undefined);
  assert.equal(line({ sync: idle, status: { ...fresh, oldestAt: NOW - 20_000 }, now: NOW })?.text, 'Up to date · just now');
  assert.equal(line({ sync: idle, status: { total: 0, missing: 0, stale: 0, pending: 0 }, now: NOW })?.text, 'Up to date', 'no PRs, no time');
  // A completed pass long ago is fine while the signals answer and a pass is running.
  assert.equal(line({ sync: { status: 'checking', checkedAt: NOW - 3 * 60 * MIN, signals: true }, status: fresh, now: NOW })?.kind, 'up-to-date');
});

void test('change signals not answering, or unknown: no "Up to date", the last full read instead', () => {
  for (const signals of [false, undefined]) {
    const value = line({ sync: { ...idle, signals }, status: fresh, now: NOW });
    assert.equal(value?.kind, 'updated');
    assert.equal(value?.text, 'Updated 4m ago');
    assert.equal(value?.problem, undefined);
  }
});

void test('a background refresh is a quiet note beside the line, with or without its total', () => {
  const known = overviewFreshness({ sync: { status: 'checking', checkedAt: NOW - 14 * MIN, signals: true, progress: { done: 120, total: 273 } }, status: fresh, now: NOW });
  assert.equal(known.line?.kind, 'up-to-date', 'a slow pass does not take the page out of up to date');
  assert.deepEqual(known.progress, { text: 'Refreshing PR list · 120 of 273', title: REFRESH_NOTE_TITLE });
  const unknown = overviewFreshness({ sync: { status: 'checking', checkedAt: NOW - 14 * MIN, signals: true }, status: fresh, now: NOW });
  assert.equal(unknown.progress?.text, 'Refreshing PR list…');
  assert.match(REFRESH_NOTE_TITLE, /re-reads every PR in the background, a few at a time, to catch anything the notifications missed/);
  // The saved snapshot from last session, before main says anything: the note, not a spinner.
  assert.equal(overviewFreshness({ status: fresh, now: NOW, saved: true }).progress?.text, 'Refreshing PR list…');
  // The first pass ever: no line to claim, only the note.
  const first = overviewFreshness({ sync: { status: 'checking', signals: true, progress: { done: 10, total: 273 } }, status: fresh, now: NOW });
  assert.equal(first.line, undefined);
  assert.equal(first.progress?.text, 'Refreshing PR list · 10 of 273');
});

void test('the reader\'s refresh: a spinner until the pass\'s first results, then the progress note', () => {
  const asked = overviewFreshness({ sync: idle, status: fresh, now: NOW, asked: true });
  assert.equal(asked.line?.kind, 'requested');
  assert.equal(asked.line?.spinner, true);
  assert.equal(asked.line?.text, 'Refreshing…');
  assert.equal(asked.progress, undefined, 'one at a time: the spinner, then the note');
  const started: WorkbenchSync = { status: 'checking', checkedAt: idle.checkedAt, signals: true, requested: true };
  assert.equal(line({ sync: started, status: fresh, now: NOW })?.spinner, true);
  assert.equal(line({ sync: { ...started, progress: { done: 0, total: 273 } }, status: fresh, now: NOW })?.spinner, true, 'a total is not a result');
  const results = overviewFreshness({ sync: { ...started, progress: { done: 5, total: 273 } }, status: fresh, now: NOW, asked: true });
  assert.equal(results.line?.kind, 'up-to-date', 'the first results end the spinner');
  assert.equal(results.progress?.text, 'Refreshing PR list · 5 of 273');
});

void test('status reads: "Checking" while they just started, a specific line once they take long', () => {
  const missing = (pendingFor: number | undefined): StatusFreshness => ({
    ...fresh, missing: 12, pending: pendingFor === undefined ? 0 : 12, ...(pendingFor === undefined ? {} : { pendingSince: NOW - pendingFor }),
  });
  const started = line({ sync: idle, status: missing(2_000), now: NOW });
  assert.equal(started?.kind, 'checking-status');
  assert.equal(started?.text, 'Checking status of 12 PRs');
  assert.equal(started?.problem, undefined);
  const slow = line({ sync: idle, status: missing(STATUS_GRACE_MS + 1), now: NOW });
  assert.equal(slow?.kind, 'status-missing');
  assert.equal(slow?.text, 'Status not checked for 12 PRs yet');
  assert.equal(slow?.problem, true);
  assert.equal(line({ sync: idle, status: missing(undefined), now: NOW })?.text, 'Status not checked for 12 PRs yet', 'a read that failed is not checked either');
  assert.equal(line({ sync: idle, status: { ...fresh, missing: 1, pending: 1, pendingSince: NOW - 30_000 }, now: NOW })?.text, 'Status not checked for 1 PR yet');
  const stale = line({ sync: idle, status: { ...fresh, stale: 3, oldestAt: NOW - 9 * MIN }, now: NOW });
  assert.equal(stale?.kind, 'status-stale');
  assert.equal(stale?.text, 'Status of 3 PRs last checked 9m ago');
});

void test('rate limit, offline and an incomplete pass name the problem and the fix', () => {
  const retryAt = new Date(2026, 10, 18, 14, 5).getTime();
  const now = retryAt - 10 * MIN;
  const limited = overviewFreshness({ sync: { status: 'paused', checkedAt: now - 30 * MIN, retryAt }, status: fresh, now });
  assert.equal(limited.line?.kind, 'rate-limited');
  assert.equal(limited.line?.text, `GitHub rate limit · showing saved data until ${new Date(retryAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`);
  assert.equal(limited.line?.problem, true);
  assert.equal(limited.progress, undefined);
  assert.equal(line({ sync: { status: 'paused' }, status: fresh, now })?.text, 'GitHub rate limit · showing saved data');
  const offline = line({ sync: { status: 'error', reason: 'unreachable', checkedAt: NOW - 30 * MIN, signals: true }, status: fresh, now: NOW });
  assert.equal(offline?.kind, 'offline');
  assert.equal(offline?.text, 'Could not reach GitHub · showing saved data');
  assert.equal(offline?.action, 'retry');
  // Rate limits win over everything, the reader's refresh included.
  assert.equal(line({ sync: { status: 'paused', retryAt }, status: fresh, now, asked: true })?.kind, 'rate-limited');
  const incomplete = line({ sync: { status: 'error', reason: 'incomplete', checkedAt: NOW - MIN, signals: true }, status: fresh, now: NOW });
  assert.equal(incomplete?.kind, 'incomplete');
  assert.equal(incomplete?.action, 'activity');
});

void test('an old PR list is a problem only when it is abnormally old and no pass is running', () => {
  const old = NOW - 3 * 60 * MIN;
  const stale = line({ sync: { status: 'idle', checkedAt: old, signals: true }, status: fresh, now: NOW });
  assert.equal(stale?.kind, 'list-stale');
  assert.equal(stale?.text, 'PR list last fully refreshed 3h ago');
  assert.equal(stale?.action, 'refresh');
  assert.equal(line({ sync: { status: 'idle', checkedAt: NOW - LIST_STALE_MS + MIN, signals: true }, status: fresh, now: NOW })?.kind, 'up-to-date', 'under the threshold');
  assert.equal(line({ sync: { status: 'checking', checkedAt: old, signals: true, progress: { done: 40, total: 273 } }, status: fresh, now: NOW })?.kind, 'up-to-date', 'a pass is running');
  assert.equal(LIST_STALE_MS, 60 * MIN);
});

void test('statusFreshness counts missing, stale and pending reads, and the oldest status', () => {
  const requests = [1, 2, 3, 4].map((n) => ({ url: `https://github.com/o/r/pull/${n}`, headSha: `h${n}` }));
  const key = (n: number) => `https://github.com/o/r/pull/${n}@h${n}`;
  const values = new Map([
    [key(1), { checkedAt: NOW - MIN }],
    [key(2), { checkedAt: NOW - STATUS_FRESH_MS - 1 }],
    [key(3), { checkedAt: NOW - 3 * MIN }],
  ]);
  const pending = new Map([[key(4), NOW - 3_000], [key(1), NOW - 1_000]]);
  assert.deepEqual(statusFreshness(requests, values, pending, NOW), {
    total: 4, missing: 1, stale: 1, pending: 1, pendingSince: NOW - 3_000, oldestAt: NOW - STATUS_FRESH_MS - 1,
  });
  assert.deepEqual(statusFreshness([], new Map(), new Map(), NOW), { total: 0, missing: 0, stale: 0, pending: 0 });
});
