import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveEvents, type PrBasis, type PrObservation } from '../lib/notification-events';
import { memberAttention, attentionItems, badgeCount, attentionSummary, ATTENTION_RANK } from '../lib/attention';
import { LOGIN, T0, member, mine, signals, readySignals } from './notification-fixtures';
import type { ReviewMember } from '../lib/workbench';

const context = (now = T0, extra: { initialized?: boolean; own?: boolean } = {}) => ({ login: LOGIN, now, initialized: extra.initialized ?? true, own: extra.own });
/** Runs observations in order and returns every event type with its key. */
function run(steps: PrObservation[], start?: PrBasis, extra: { initialized?: boolean; own?: boolean } = {}) {
  let basis = start;
  const events: { type: string; key: string }[] = [];
  steps.forEach((step, i) => {
    const result = deriveEvents(basis, step, context(T0 + i * 60_000, extra));
    basis = result.basis;
    events.push(...result.events.map(({ type, key }) => ({ type, key })));
  });
  return { basis, events };
}
const obs = (pr: ReviewMember, value?: ReturnType<typeof signals>): PrObservation => ({ member: pr, signals: value });

test('nothing is raised before the first-run baseline', () => {
  const pr = member(1, { requestedReviewers: [LOGIN] });
  assert.deepEqual(run([obs(pr)], undefined, { initialized: false }).events, []);
});

test('a PR seen for the first time after the baseline raises only Review requested', () => {
  const requested = member(1, { requestedReviewers: [LOGIN], role: 'review-requested' });
  assert.deepEqual(run([obs(requested)]).events, [{ type: 'review-requested', key: 'requested|https://github.com/o/r/pull/1|1' }]);
  const failing = mine(2);
  assert.deepEqual(run([obs(failing, signals(failing, { checks: 'failure' }))]).events, []);
});

test('review requested fires once on its edge, again on a re-request, never on a replay', () => {
  const pr = member(1);
  const asked = { ...pr, requestedReviewers: [LOGIN] };
  const { events } = run([obs(pr), obs(asked), obs(asked), obs(pr), obs(asked)]);
  assert.deepEqual(events.map((e) => e.key), ['requested|https://github.com/o/r/pull/1|1', 'requested|https://github.com/o/r/pull/1|2']);
});

test('a draft waits and fires when it becomes ready for review', () => {
  const draft = member(1, { requestedReviewers: [LOGIN], isDraft: true });
  const { events } = run([obs(member(1)), obs(draft), obs({ ...draft, isDraft: false })]);
  assert.deepEqual(events.map((e) => e.type), ['review-requested']);
});

test('a team request is its own type, and a metadata update without a role keeps it', () => {
  const team = member(1, { role: 'review-requested', requestedTeams: ['core'] });
  const { events, basis } = run([obs(member(1)), obs(team)]);
  assert.deepEqual(events.map((e) => e.type), ['team-review-requested']);
  const metadata = { ...team, role: undefined };
  assert.deepEqual(deriveEvents(basis, { member: metadata }, context(T0 + 600_000)).events, []);
});

test('your own PR never raises a review request', () => {
  assert.deepEqual(run([obs(mine(1)), obs(mine(1, { requestedReviewers: [LOGIN] }))]).events, []);
});

test('changes requested on your PR fires once per review, from someone else only', () => {
  const pr = mine(1);
  const changes = signals(pr, { review: { id: '1', author: 'maya', state: 'CHANGES_REQUESTED' }, decision: 'CHANGES_REQUESTED', checkedAt: T0 + 1 });
  const { events } = run([obs(pr, signals(pr)), obs(pr, changes), obs(pr, { ...changes, checkedAt: T0 + 2 })]);
  assert.deepEqual(events, [{ type: 'changes-requested', key: 'review|https://github.com/o/r/pull/1#pullrequestreview-1' }]);
  const own = signals(pr, { review: { id: '2', author: LOGIN, state: 'CHANGES_REQUESTED' }, checkedAt: T0 + 1 });
  assert.deepEqual(run([obs(pr, signals(pr)), obs(pr, own)]).events, []);
});

test('the first signals for a PR only start a basis', () => {
  const pr = mine(1);
  const approved = signals(pr, { review: { id: '1', author: 'maya', state: 'APPROVED' } });
  assert.deepEqual(run([obs(pr), obs(pr, approved)]).events, []);
});

test('approval fires, and a bot approval is kept', () => {
  const pr = mine(1);
  const bot = signals(pr, { review: { id: '9', author: 'renovate[bot]', state: 'APPROVED' }, checkedAt: T0 + 1 });
  assert.deepEqual(run([obs(pr, signals(pr)), obs(pr, bot)]).events.map((e) => e.type), ['approved']);
});

test('Ready to merge absorbs Approved when both arrive together', () => {
  const pr = mine(1);
  const both = { ...readySignals(pr, T0 + 1), latestReview: { url: `${pr.url}#r1`, author: 'maya', state: 'APPROVED', submittedAt: '', headSha: pr.headSha } };
  assert.deepEqual(run([obs(pr, signals(pr)), obs(pr, both)]).events.map((e) => e.type), ['ready-to-merge']);
});

test('checks failed fires from pending, success or neutral, once per head SHA', () => {
  const pr = mine(1);
  for (const from of ['pending', 'success', 'neutral'] as const) {
    const { events } = run([obs(pr, signals(pr, { checks: from })), obs(pr, signals(pr, { checks: 'failure', checkedAt: T0 + 5 }))]);
    assert.deepEqual(events, [{ type: 'checks-failed', key: 'checks-failed|https://github.com/o/r/pull/1|head-1' }], from);
  }
  // Fail, re-run, fail again on the same SHA: the second edge carries the same key, which the store drops.
  const { events } = run([
    obs(pr, signals(pr, { checks: 'pending', checkedAt: T0 })),
    obs(pr, signals(pr, { checks: 'failure', checkedAt: T0 + 1 })),
    obs(pr, signals(pr, { checks: 'pending', checkedAt: T0 + 2 })),
    obs(pr, signals(pr, { checks: 'failure', checkedAt: T0 + 3 })),
  ]);
  assert.equal(new Set(events.map((e) => e.key)).size, 1);
});

test('a head SHA change resets status without an event; a failure on the new head fires', () => {
  const pr = mine(1);
  const pushed = { ...pr, headSha: 'head-2' };
  const { events } = run([obs(pr, signals(pr, { checks: 'failure' })), obs(pushed), obs(pushed, signals(pushed, { checks: 'failure', checkedAt: T0 + 120_000 }))]);
  assert.deepEqual(events.map((e) => e.key), ['checks-failed|https://github.com/o/r/pull/1|head-2']);
});

test('ready to merge is judged at the time of the check, so a sweep result minutes old still fires', () => {
  const pr = mine(1);
  const result = run([obs(pr, signals(pr)), obs(pr, readySignals(pr, T0 + 1))]);
  assert.deepEqual(result.events.map((e) => e.type), ['ready-to-merge']);
  // Evaluated five minutes after the check: still ready, because readiness uses `checkedAt`.
  const late = deriveEvents(deriveEvents(undefined, obs(pr, signals(pr)), context()).basis, obs(pr, readySignals(pr, T0 + 1)), context(T0 + 5 * 60_000));
  assert.deepEqual(late.events.map((e) => e.type), ['ready-to-merge']);
});

test('signals older than 30 minutes and older snapshots raise nothing', () => {
  const pr = mine(1);
  const start = deriveEvents(undefined, obs(pr, signals(pr, { checkedAt: T0 })), context()).basis;
  const old = deriveEvents(start, obs(pr, signals(pr, { checks: 'failure', checkedAt: T0 + 1 })), context(T0 + 31 * 60_000));
  assert.deepEqual(old.events, []);
  const replay = deriveEvents(start, obs(pr, signals(pr, { checks: 'failure', checkedAt: T0 - 1 })), context(T0 + 60_000));
  assert.deepEqual(replay.events, []);
});

test('own writes made in Gnosis update the basis and raise nothing', () => {
  const pr = member(1);
  const { basis } = run([obs(pr)]);
  const own = deriveEvents(basis, obs({ ...pr, requestedReviewers: [LOGIN] }), context(T0 + 1, { own: true }));
  assert.deepEqual(own.events, []);
  assert.equal(own.basis.kinds['review-requested'], 'direct');
});

test('a basis older than seven days is replaced silently', () => {
  const pr = member(1);
  const { basis } = run([obs(pr)]);
  const later = deriveEvents(basis, obs({ ...pr, requestedReviewers: [LOGIN] }), context(T0 + 8 * 86_400_000));
  assert.deepEqual(later.events, []);
});

test('every raised event kind has a matching menu bar row', () => {
  const pr = mine(1);
  const start = deriveEvents(undefined, obs(pr, signals(pr)), context()).basis;
  const failing = signals(pr, { checks: 'failure', checkedAt: T0 + 1 });
  const { events } = deriveEvents(start, obs(pr, failing), context(T0 + 1));
  const rows = attentionItems({
    items: [{ subject: { id: pr.url, kind: 'pr', title: pr.title, members: [pr], edges: [], warnings: [] }, attention: 'other', unreadUrls: [pr.url] }],
    signals: () => failing,
    login: LOGIN,
    enabled: () => true,
    now: T0 + 1,
  });
  assert.deepEqual(events.map((e) => e.type), ['checks-failed']);
  assert.deepEqual(rows.map((row) => row.kinds), [['checks-failed']]);
  assert.deepEqual(rows[0].target, { kind: 'pr', pr: { host: 'github.com', owner: 'o', repo: 'r', number: 1 }, tab: 'checks' });
  assert.equal(badgeCount(rows, 'new'), 1);
  assert.equal(attentionSummary(rows).line, '1 needs you');
});

void test('every raised event of every level kind has a matching panel row with the same target', () => {
  // The same snapshots feed the edge detector and the panel's level model (#308 risk 8).
  const requested = member(1);
  const changes = mine(2);
  const failing = mine(3);
  const ready = mine(4);
  const team = member(5);
  const before: Record<string, PrObservation> = {
    requested: obs(requested),
    changes: obs(changes, signals(changes)),
    failing: obs(failing, signals(failing)),
    ready: obs(ready, signals(ready)),
    team: obs(team),
  };
  const after: Record<string, PrObservation> = {
    requested: obs({ ...requested, requestedReviewers: [LOGIN] }),
    changes: obs(changes, signals(changes, { review: { id: '7', author: 'maya', state: 'CHANGES_REQUESTED' }, decision: 'CHANGES_REQUESTED', checkedAt: T0 + 1 })),
    failing: obs(failing, signals(failing, { checks: 'failure', checkedAt: T0 + 1 })),
    ready: obs(ready, readySignals(ready, T0 + 1)),
    team: obs({ ...team, role: 'review-requested' }),
  };
  const raised = Object.keys(before).flatMap((name) => {
    const basis = deriveEvents(undefined, before[name], context()).basis;
    return deriveEvents(basis, after[name], context(T0 + 1)).events;
  });
  assert.deepEqual(raised.map((e) => e.type).sort(), ['changes-requested', 'checks-failed', 'ready-to-merge', 'review-requested', 'team-review-requested']);
  const observed = Object.values(after);
  const rows = attentionItems({
    items: observed.map(({ member: m }) => ({ subject: { id: m.url, kind: 'pr' as const, title: m.title, members: [m as ReviewMember], edges: [], warnings: [] }, attention: 'other' as const })),
    signals: (m) => observed.find((o) => o.member.url === m.url)?.signals,
    login: LOGIN,
    enabled: () => true,
    now: T0 + 1,
    teamRequests: true,
  });
  for (const event of raised) {
    const row = rows.find((r) => r.url === event.url);
    assert.ok(row, `${event.type} has a row`);
    const kind = event.type === 'team-review-requested' ? 'review-requested' : event.type;
    assert.ok(row.kinds.includes(kind as never), `${event.type} is one of the row's kinds`);
    assert.deepEqual(row.target, event.target, `${event.type} opens the same place`);
  }
  // Approved is edge-only: it raises an event but is never a row on its own.
  const approved = mine(6);
  const start = deriveEvents(undefined, obs(approved, signals(approved)), context()).basis;
  const approval = signals(approved, { review: { id: '8', author: 'maya', state: 'APPROVED' }, checkedAt: T0 + 1 });
  assert.deepEqual(deriveEvents(start, obs(approved, approval), context(T0 + 1)).events.map((e) => e.type), ['approved']);
  const none = attentionItems({
    items: [{ subject: { id: approved.url, kind: 'pr', title: approved.title, members: [approved], edges: [], warnings: [] }, attention: 'other' }],
    signals: () => approval, login: LOGIN, enabled: () => true, now: T0 + 1,
  });
  assert.deepEqual(none, []);
});

test('the attention model: rank order, ready dropped beside a fix, team requests opt in', () => {
  assert.equal(ATTENTION_RANK[0], 'review-requested');
  const pr = mine(1);
  const conflicted = signals(pr, { checks: 'success', decision: 'APPROVED', mergeState: 'DIRTY', mergeable: 'CONFLICTING' });
  assert.deepEqual(Object.keys(memberAttention(pr, conflicted, LOGIN)), ['conflicts']);
  const team = member(2, { role: 'review-requested' });
  assert.deepEqual(memberAttention(team, undefined, LOGIN), {});
  assert.deepEqual(memberAttention(team, undefined, LOGIN, { teamRequests: true }), { 'review-requested': 'team' });
});
