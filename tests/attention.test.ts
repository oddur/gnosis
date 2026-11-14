import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attentionItems, attentionSummary, attentionTarget, badgeCount, ATTENTION_RANK, type AttentionKind } from '../lib/attention';
import type { QueueItem, ReviewMember } from '../lib/workbench';
import type { QueueSignals } from '../lib/queue-signals';
import type { ReviewHistoryEntry } from '../lib/types';
import { LOGIN, T0, member, mine, signals, readySignals } from './notification-fixtures';

const pr = (url: string) => {
  const [, owner, repo, number] = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(url) ?? [];
  return { host: 'github.com', owner, repo, number: Number(number) };
};
const item = (members: ReviewMember[], extra: Partial<QueueItem> = {}): QueueItem => ({
  subject: { id: members.length > 1 ? `stack-${members[0].number}` : members[0].url, kind: members.length > 1 ? 'stack' : 'pr', title: members[0].title, members, edges: [], warnings: [] },
  attention: 'other',
  ...extra,
});
const review = (url: string, extra: Partial<ReviewHistoryEntry> = {}) =>
  ({ id: `review-${url.split('/').pop()}`, prUrl: url, prTitle: 'PR', status: 'completed', unread: true, ...extra }) as ReviewHistoryEntry;
function rows(items: QueueItem[], options: { signals?: Record<string, QueueSignals>; now?: number; enabled?: (kind: AttentionKind, repo: string) => boolean } = {}) {
  return attentionItems({
    items,
    signals: (m) => options.signals?.[m.url],
    login: LOGIN,
    enabled: options.enabled ?? (() => true),
    now: options.now ?? T0,
  });
}

void test('each kind comes from its source fields, one row per PR', () => {
  const requested = member(1, { requestedReviewers: [LOGIN] });
  const updated = member(2);
  const changes = mine(3);
  const failing = mine(4);
  const conflicted = mine(5);
  const replies = mine(6);
  const ready = mine(7);
  const explained = member(8);
  const result = rows(
    [
      item([requested]),
      item([updated], { attention: 'updated', review: review(updated.url, { unread: false }) }),
      item([changes]),
      item([failing]),
      item([conflicted]),
      item([replies], { responses: { [replies.url]: { changesRequested: false, unresolvedThreads: 2 } as never } }),
      item([ready]),
      item([explained], { review: review(explained.url) }),
    ],
    {
      signals: {
        [changes.url]: signals(changes, { review: { id: '1', author: 'maya', state: 'CHANGES_REQUESTED' } }),
        [failing.url]: signals(failing, { checks: 'failure' }),
        [conflicted.url]: signals(conflicted, { mergeable: 'CONFLICTING', mergeState: 'DIRTY' }),
        [ready.url]: readySignals(ready),
      },
    }
  );
  assert.deepEqual(
    result.map((row) => [row.number, row.kinds]),
    [
      [1, ['review-requested']],
      [2, ['updated-since-review']],
      [3, ['changes-requested']],
      [4, ['checks-failed']],
      [5, ['conflicts']],
      [6, ['replies']],
      [7, ['ready-to-merge']],
      [8, ['explanation-ready']],
    ]
  );
  assert.deepEqual(result.map((row) => row.group), ['review', 'review', 'fix', 'fix', 'fix', 'fix', 'ready', 'ready']);
});

void test('the target for every kind', () => {
  const url = 'https://github.com/o/r/pull/1';
  const tab = (kind: AttentionKind, options = {}) => {
    const target = attentionTarget(kind, url, options);
    return target?.kind === 'pr' ? target.tab : target?.kind;
  };
  assert.equal(tab('review-requested'), 'summary');
  assert.equal(tab('review-requested', { explanation: true }), 'explanation');
  assert.equal(tab('updated-since-review'), 'changes');
  assert.equal(tab('changes-requested'), 'feedback');
  assert.equal(tab('replies'), 'feedback');
  assert.equal(tab('checks-failed'), 'checks');
  assert.equal(tab('conflicts'), 'summary');
  assert.equal(tab('ready-to-merge'), 'summary');
  assert.deepEqual(attentionTarget('explanation-ready', url, { reviewId: 'r1' }), { kind: 'review', reviewId: 'r1' });
  assert.deepEqual(attentionTarget('checks-failed', url), { kind: 'pr', pr: pr(url), tab: 'checks' });
});

void test('the headline is the top-ranked kind; the next is kept for the second label', () => {
  const pr = mine(1);
  const value = signals(pr, { checks: 'failure', review: { id: '1', author: 'maya', state: 'CHANGES_REQUESTED' } });
  const [row] = rows([item([pr])], { signals: { [pr.url]: value } });
  assert.deepEqual(row.kinds, ['changes-requested', 'checks-failed']);
  assert.equal(row.target.kind === 'pr' && row.target.tab, 'feedback');
});

void test('an unread explanation folds into a review request and points it at the explanation', () => {
  const requested = member(1, { requestedReviewers: [LOGIN] });
  const [row] = rows([item([requested], { attention: 'requested', review: review(requested.url) })]);
  assert.deepEqual(row.kinds, ['review-requested', 'explanation-ready']);
  assert.equal(row.group, 'review');
  assert.deepEqual(row.target, { kind: 'pr', pr: pr(requested.url), tab: 'explanation' });
  assert.equal(row.isNew, true, 'An unread explanation is new');
  // A read explanation adds no kind; an outdated one makes the item "updated" instead.
  assert.deepEqual(rows([item([requested], { review: review(requested.url, { unread: false }) })])[0].kinds, ['review-requested']);
  const outdated = rows([item([member(2)], { attention: 'updated', review: review(member(2).url) })]);
  assert.deepEqual(outdated[0].kinds, ['updated-since-review']);
  // A generating or failed explanation is not ready.
  assert.deepEqual(rows([item([member(3)], { review: review(member(3).url, { status: 'generating' }) })]), []);
});

void test('a stack explanation belongs to the member it was made for', () => {
  const base = member(1);
  const top = member(2);
  const result = rows([item([base, top], { review: review(top.url) })]);
  assert.deepEqual(result.map((row) => [row.number, row.kinds, row.stackSize]), [[2, ['explanation-ready'], 2]]);
  assert.deepEqual(result[0].target, { kind: 'review', reviewId: 'review-2' });
});

void test('ready to merge is dropped beside a fix kind', () => {
  const pr = mine(1);
  const value = { ...readySignals(pr), checks: { state: 'failure' as const, passed: 0, total: 1 } };
  assert.deepEqual(rows([item([pr])], { signals: { [pr.url]: value } })[0].kinds, ['checks-failed']);
  const threads = rows([item([pr], { responses: { [pr.url]: { changesRequested: false, unresolvedThreads: 1 } as never } })], {
    signals: { [pr.url]: readySignals(pr) },
  });
  assert.deepEqual(threads[0].kinds, ['replies']);
});

void test('readiness is evaluated at the time of the check, and status older than 30 minutes is dropped', () => {
  const pr = mine(1);
  const value = readySignals(pr, T0);
  const late = rows([item([pr])], { signals: { [pr.url]: value }, now: T0 + 10 * 60_000 });
  assert.deepEqual(late[0].kinds, ['ready-to-merge'], 'Ten minutes later it is still ready as of its check');
  assert.equal(late[0].checkedAt, T0, 'The row carries the age of its status');
  assert.deepEqual(rows([item([pr])], { signals: { [pr.url]: value }, now: T0 + 31 * 60_000 }), []);
  const failing = signals(pr, { checks: 'failure', checkedAt: T0 });
  assert.deepEqual(rows([item([pr])], { signals: { [pr.url]: failing }, now: T0 + 31 * 60_000 }), []);
  const otherHead = { ...failing, headSha: 'old-head' };
  assert.deepEqual(rows([item([pr])], { signals: { [pr.url]: otherHead } }), [], 'Status for an older head is ignored');
});

void test('drafts, merged and closed PRs and your own PRs never ask for your review', () => {
  for (const pr of [
    member(1, { requestedReviewers: [LOGIN], isDraft: true }),
    member(2, { requestedReviewers: [LOGIN], merged: true }),
    member(3, { requestedReviewers: [LOGIN], state: 'closed' }),
    mine(4, { requestedReviewers: [LOGIN] }),
  ])
    assert.deepEqual(rows([item([pr])]), [], `PR ${pr.number}`);
  const merged = mine(5, { merged: true });
  assert.deepEqual(rows([item([merged])], { signals: { [merged.url]: signals(merged, { checks: 'failure' }) } }), []);
});

void test('the enabled callback removes kinds per kind and per repository', () => {
  const requested = member(1, { requestedReviewers: [LOGIN] });
  const other = member(2, { requestedReviewers: [LOGIN], repo: 'o/quiet', url: 'https://github.com/o/quiet/pull/2' });
  const result = rows([item([requested]), item([other])], { enabled: (kind, repo) => repo !== 'o/quiet' && kind === 'review-requested' });
  assert.deepEqual(result.map((row) => row.number), [1]);
  assert.deepEqual(rows([item([requested])], { enabled: () => false }), []);
});

void test('rows: groups in order, then rank, then new before seen, then most recently updated', () => {
  const older = member(1, { requestedReviewers: [LOGIN], updatedAt: '2026-11-14T08:00:00Z' });
  const newer = member(2, { requestedReviewers: [LOGIN], updatedAt: '2026-11-14T09:30:00Z' });
  const unread = member(3, { requestedReviewers: [LOGIN], updatedAt: '2026-11-13T09:30:00Z' });
  const updated = member(4);
  const ready = mine(5);
  const result = rows(
    [item([ready]), item([older]), item([updated], { attention: 'updated', review: review(updated.url, { unread: false }) }), item([newer]), item([unread], { unreadUrls: [unread.url] })],
    { signals: { [ready.url]: readySignals(ready) } }
  );
  assert.deepEqual(result.map((row) => row.number), [3, 2, 1, 4, 5]);
  assert.deepEqual(result.map((row) => row.isNew), [true, false, false, false, false]);
  assert.equal(ATTENTION_RANK.indexOf('review-requested') < ATTENTION_RANK.indexOf('updated-since-review'), true);
});

void test('the summary line, singular and zero', () => {
  const requested = member(1, { requestedReviewers: [LOGIN] });
  const second = member(2, { requestedReviewers: [LOGIN] });
  const ready = mine(3);
  const value = { [ready.url]: readySignals(ready) };
  assert.equal(attentionSummary(rows([item([requested])])).line, '1 needs you');
  assert.equal(attentionSummary(rows([item([requested]), item([second]), item([ready])], { signals: value })).line, '2 need you · 1 ready');
  assert.equal(attentionSummary(rows([item([ready])], { signals: value })).line, '1 ready');
  assert.deepEqual(attentionSummary([]), { needYou: 0, ready: 0, fresh: 0, line: 'Nothing needs you' });
});

void test('badgeCount counts new rows, or every row', () => {
  const a = member(1, { requestedReviewers: [LOGIN] });
  const b = member(2, { requestedReviewers: [LOGIN] });
  const result = rows([item([a], { unreadUrls: [a.url] }), item([b])]);
  assert.equal(badgeCount(result, 'new'), 1);
  assert.equal(badgeCount(result, 'all'), 2);
  assert.equal(badgeCount([], 'new'), 0);
});
