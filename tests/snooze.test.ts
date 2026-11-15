import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../src/app-data-store';
import { createSnoozedPrStore, snoozedPrsName } from '../src/snoozed-pr-store';
import { createWorkbenchService } from '../src/workbench-service';
import { groupSubjects, type QueueItem, type ReviewMember } from '../lib/workbench';
import { DEFAULT_CLAUDE_MODEL } from '../lib/models';
import type { NotificationEvent } from '../lib/notification-events';
import type { QueueSignals } from '../lib/queue-signals';
import { buildMenubarState } from '../lib/menubar-state';
import {
  applySnoozes,
  backLine,
  dueWakes,
  observeSnooze,
  observeSnoozes,
  SNOOZE_CEILING_MS,
  snoozeBasis,
  snoozePresets,
  summaryOf,
  wakesLine,
  type SnoozeEntry,
} from '../lib/snooze';

const ME = 'me';
const T0 = Date.parse('2026-11-10T12:00:00Z');
const HOUR = 3_600_000;

function member(number: number, patch: Partial<ReviewMember> = {}): ReviewMember {
  return {
    number,
    repo: 'owner/repo',
    headRepo: 'owner/repo',
    baseRepo: 'owner/repo',
    url: `https://github.com/owner/repo/pull/${number}`,
    title: `PR ${number}`,
    description: 'A PR',
    author: 'lena',
    role: 'watched',
    baseBranch: 'main',
    headBranch: `feature-${number}`,
    baseSha: 'base',
    headSha: `head-${number}`,
    merged: false,
    state: 'open',
    createdAt: new Date(T0 - 2 * HOUR).toISOString(),
    updatedAt: new Date(T0 - HOUR).toISOString(),
    labels: [],
    mergeable: null,
    isDraft: false,
    commitCount: 1,
    requestedReviewers: [],
    requestedTeams: [],
    mergeableState: null,
    autoMerge: null,
    milestone: null,
    ...patch,
  };
}
function signals(m: ReviewMember, patch: Partial<QueueSignals> = {}): QueueSignals {
  return {
    url: m.url,
    headSha: m.headSha,
    checkedAt: T0 + HOUR,
    comments: 0,
    latestReview: null,
    activity: { recent: [] },
    checks: { state: 'success', passed: 1, total: 1 },
    ...patch,
  };
}
function entry(m: ReviewMember, patch: Partial<SnoozeEntry> = {}, at = T0): SnoozeEntry {
  return {
    member: summaryOf(m),
    group: m.url,
    snoozedAt: at,
    on: ['activity'],
    own: m.author === ME,
    basis: snoozeBasis(m, undefined, ME),
    ...patch,
  };
}
const event = (kind: 'comment' | 'review', author: string, minutes: number, patch: { automated?: boolean; minimized?: boolean; state?: string } = {}) => ({
  kind,
  id: `${kind}-${author}-${minutes}`,
  at: new Date(T0 + minutes * 60_000).toISOString(),
  author,
  automated: patch.automated ?? false,
  ...patch,
});

void test('each wake signal ends a snooze that waits for it', () => {
  const pr = member(1);
  const ctx = { login: ME };
  // A review, with its author.
  assert.deepEqual(observeSnooze(entry(pr), { member: pr, signals: signals(pr, { activity: { recent: [event('review', 'maria', 5, { state: 'APPROVED' })] } }) }, ctx).wake, { kind: 'review', actor: 'maria' });
  // A comment.
  assert.deepEqual(observeSnooze(entry(pr), { member: pr, signals: signals(pr, { activity: { recent: [event('comment', 'maria', 5)] } }) }, ctx).wake, { kind: 'comment', actor: 'maria' });
  // New commits on a PR the reader did not author.
  assert.deepEqual(observeSnooze(entry(pr), { member: { ...pr, headSha: 'next' } }, ctx).wake, { kind: 'commits' });
  // The reader's review requested again.
  assert.deepEqual(observeSnooze(entry(pr), { member: { ...pr, requestedReviewers: [ME] } }, ctx).wake, { kind: 'requested' });
  // A draft marked ready.
  const draft = member(2, { isDraft: true });
  assert.deepEqual(observeSnooze(entry(draft), { member: { ...draft, isDraft: false } }, ctx).wake, { kind: 'ready' });
  // Status saved before recent activity was read: the comment total rose.
  const legacy = entry(pr, { basis: { ...snoozeBasis(pr, signals(pr, { comments: 2 }), ME) } });
  assert.deepEqual(observeSnooze(legacy, { member: pr, signals: { ...signals(pr, { comments: 3 }), activity: undefined } }, ctx).wake, { kind: 'comment' });
  // Nothing new: no wake.
  assert.deepEqual(observeSnooze(entry(pr), { member: pr, signals: signals(pr) }, ctx), {});
});

void test('checks finish wakes your own PR: failure at once, a pass only when seen twice', () => {
  const own = member(3, { author: ME });
  const running = signals(own, { checkedAt: T0 - 60_000, checks: { state: 'pending', passed: 0, running: 1, total: 1 } });
  let snooze = entry(own, { on: ['checks'], basis: snoozeBasis(own, running, ME) });
  assert.equal(snooze.basis.checks?.armed, true);
  // Failure wakes once seen.
  assert.deepEqual(observeSnooze(snooze, { member: own, signals: signals(own, { checks: { state: 'failure', passed: 0, failed: 1, total: 1 } }) }, { login: ME }).wake, { kind: 'checks', state: 'failed' });
  // A pass is kept, then confirmed by a later read.
  const first = observeSnooze(snooze, { member: own, signals: signals(own, { checkedAt: T0 + HOUR }) }, { login: ME });
  assert.equal(first.wake, undefined);
  assert.ok(first.entry);
  snooze = first.entry;
  // A pending run between two workflows resets the pass.
  const between = observeSnooze(snooze, { member: own, signals: signals(own, { checkedAt: T0 + HOUR + 1, checks: { state: 'pending', passed: 1, running: 1, total: 2 } }) }, { login: ME });
  assert.equal(between.wake, undefined);
  assert.equal(between.entry?.basis.checks?.success, undefined);
  const again = observeSnooze(snooze, { member: own, signals: signals(own, { checkedAt: T0 + 2 * HOUR }) }, { login: ME });
  assert.deepEqual(again.wake, { kind: 'checks', state: 'passed' });
  // Checks that had already finished at snooze time do not wake it.
  const settled = entry(own, { on: ['checks'], basis: snoozeBasis(own, signals(own, { checkedAt: T0 - 60_000 }), ME) });
  assert.equal(observeSnooze(settled, { member: own, signals: signals(own, { checkedAt: T0 + HOUR }) }, { login: ME }).wake, undefined);
  // Status of an older head never counts.
  assert.equal(observeSnooze(snooze, { member: own, signals: { ...signals(own, { checkedAt: T0 + 3 * HOUR }), headSha: 'old' } }, { login: ME }).wake, undefined);
  // Checks are for your own PRs only.
  const theirs = member(4);
  assert.equal(observeSnooze(entry(theirs, { on: ['checks'] }), { member: theirs, signals: signals(theirs, { checks: { state: 'failure', passed: 0, total: 1 } }) }, { login: ME }).wake, undefined);
});

void test('your own actions, bots and status from before the snooze never wake a PR', () => {
  const pr = member(5);
  const ctx = { login: ME };
  const quiet = (recent: ReturnType<typeof event>[], patch: Partial<QueueSignals> = {}) =>
    observeSnooze(entry(pr), { member: pr, signals: signals(pr, { activity: { recent }, ...patch }) }, ctx).wake;
  assert.equal(quiet([event('comment', ME, 5), event('review', 'ME', 6)]), undefined);
  assert.equal(quiet([event('comment', 'renovate[bot]', 5, { automated: true }), event('comment', 'github-actions', 6, { automated: true })]), undefined);
  assert.equal(quiet([event('comment', 'maria', 5, { minimized: true })]), undefined);
  // A comment made before the snooze.
  assert.equal(quiet([event('comment', 'maria', -5)]), undefined);
  // Status read before the snooze.
  assert.equal(quiet([event('comment', 'maria', 5)], { checkedAt: T0 - 1 }), undefined);
  // The reader's own push, and a bot's.
  const next = { ...pr, headSha: 'next' };
  assert.equal(observeSnooze(entry(pr), { member: next, signals: signals(next, { activity: { head: { author: ME, committer: 'web-flow' } } }) }, ctx).wake, undefined);
  assert.equal(observeSnooze(entry(pr), { member: next, signals: signals(next, { activity: { head: { author: 'dependabot[bot]', committer: null } } }) }, ctx).wake, undefined);
  // A write the reader made in Gnosis moves the basis instead.
  const draft = member(6, { isDraft: true, author: ME });
  const own = observeSnooze(entry(draft), { member: { ...draft, isDraft: false } }, { login: ME, own: true });
  assert.equal(own.wake, undefined);
  assert.equal(own.entry?.basis.isDraft, false);
  // A timed snooze ends on a review or request, not on comments or commits.
  const timed = entry(pr, { on: [], until: T0 + 24 * HOUR });
  assert.equal(observeSnooze(timed, { member: next }, ctx).wake, undefined);
  assert.equal(observeSnooze(timed, { member: pr, signals: signals(pr, { activity: { recent: [event('comment', 'maria', 5)] } }) }, ctx).wake, undefined);
  assert.equal(observeSnooze(timed, { member: pr, signals: signals(pr, { activity: { recent: [event('review', 'maria', 5)] } }) }, ctx).wake?.kind, 'review');
  // Merged or closed: the snooze ends silently.
  assert.deepEqual(observeSnooze(entry(pr), { member: { ...pr, merged: true } }, ctx), { end: true });
});

void test('times and ceilings: a signal-only snooze returns after 14 days', () => {
  const pr = member(7);
  const timed = new Map([[pr.url, entry(pr, { on: [], until: T0 + HOUR })]]);
  assert.deepEqual(dueWakes(timed, T0 + HOUR - 1), []);
  assert.equal(dueWakes(timed, T0 + HOUR)[0].reason.kind, 'time');
  const open = new Map([[pr.url, entry(pr)]]);
  assert.deepEqual(dueWakes(open, T0 + SNOOZE_CEILING_MS - 1), []);
  const [wake] = dueWakes(open, T0 + SNOOZE_CEILING_MS);
  assert.equal(wake.reason.kind, 'ceiling');
  assert.equal(backLine({ reason: wake.reason, at: T0 + SNOOZE_CEILING_MS, snoozedAt: T0 }), 'Back: no activity for 14 days · snoozed 14 days');
  assert.match(wakesLine({ on: ['activity'], own: false, snoozedAt: T0 }, T0), /^Wakes on new activity, or /);
  assert.match(wakesLine({ on: [], until: T0 + HOUR, own: false, snoozedAt: T0 }, T0), /, or on a new review or review request$/);
});

void test('a stack snoozes as a group: a signal on any member wakes all, and a snoozed member keeps the stack row', () => {
  const a = member(10), b = member(11), c = member(12);
  const entries = new Map([a, b].map((m) => [m.url, entry(m, { group: 'stack' })]));
  entries.set(c.url, entry(c));
  const changes = observeSnoozes(entries, [{ member: { ...b, requestedReviewers: [ME] } }], { login: ME });
  assert.equal(changes.wakes.length, 1);
  assert.deepEqual(changes.wakes[0].urls.sort(), [a.url, b.url].sort());
  assert.equal(changes.wakes[0].trigger, b.url);
  const stack = groupSubjects([a, { ...b, baseBranch: a.headBranch }])[0];
  const item: QueueItem = { subject: stack, attention: 'other', unreadUrls: [a.url, b.url] };
  // Every open PR snoozed: hidden.
  assert.equal(applySnoozes(item, new Set([a.url, b.url])), undefined);
  // One snoozed: the row stays, without that PR's unread state.
  const partial = applySnoozes(item, new Set([b.url]));
  assert.ok(partial);
  assert.deepEqual(partial.snoozedUrls, [b.url]);
  assert.deepEqual(partial.unreadUrls, [a.url]);
  // A merged member does not keep a fully snoozed stack visible.
  const merged = { ...item, subject: { ...stack, members: [{ ...stack.members[0], merged: true }, stack.members[1]] } };
  assert.equal(applySnoozes(merged, new Set([b.url])), undefined);
});

void test('presets are on the local calendar', () => {
  const now = new Date(2026, 10, 14, 15, 10).getTime(); // Saturday 15:10
  const presets = snoozePresets(now);
  assert.deepEqual(presets.map((p) => p.id), ['later', 'tomorrow', 'week']);
  assert.equal(new Date(presets[0].until).getHours(), 18);
  assert.equal(new Date(presets[0].until).getMinutes(), 30);
  assert.equal(new Date(presets[1].until).getDate(), 15);
  assert.equal(new Date(presets[2].until).getDay(), 1);
  assert.equal(new Date(presets[2].until).getHours(), 9);
  assert.deepEqual(snoozePresets(new Date(2026, 10, 14, 20, 0).getTime()).map((p) => p.id), ['tomorrow', 'week']);
  // On Sunday, next week is not tomorrow.
  const sunday = snoozePresets(new Date(2026, 10, 15, 22, 0).getTime());
  assert.equal(new Date(sunday[0].until).getDate(), 16);
  assert.equal(new Date(sunday[1].until).getDate(), 23);
});

void test('an unreadable snooze store resets to empty, and rows are account scoped', () => {
  const saved = new Map<string, string>([[snoozedPrsName('me'), '{"entries":{"snooze:x":{"member":{"url":"https://evil.example/1"}}}}']]);
  const store = createSnoozedPrStore(createMemoryStorage(saved));
  assert.equal(store.index('me').urls.size, 0);
  store.change('Me', { put: [entry(member(1))] });
  const restart = createSnoozedPrStore(createMemoryStorage(saved));
  assert.equal(restart.index('ME').rows.length, 1);
  assert.equal(restart.index('bob').rows.length, 0);
});

function service(saved: Map<string, string>, clock: { now: number }, subjects = groupSubjects([member(1), member(2)]), delivered: NotificationEvent[] = []) {
  if (!saved.has('workbench:me')) saved.set('workbench:me', JSON.stringify({ account: 'me', subjects, overrides: [], briefs: {}, day: '', used: 0 }));
  return createWorkbenchService({
    directory: () => '/tmp/unused',
    storage: createMemoryStorage(saved),
    auth: () => ({ login: ME, token: 'token' }),
    preferences: () => ({ provider: 'claude' as const, model: DEFAULT_CLAUDE_MODEL, watchedRepos: [], autoBriefings: false, briefingDailyLimit: 0 }),
    history: () => [],
    busy: () => true,
    now: () => clock.now,
    notifications: { deliver: (events) => delivered.push(...events) },
  });
}

void test('snoozed PRs leave the queue and counts, keep being watched, and Undo restores them', () => {
  const saved = new Map<string, string>();
  const clock = { now: T0 };
  const delivered: NotificationEvent[] = [];
  const workbench = service(saved, clock, undefined, delivered);
  assert.equal(workbench.snapshot().items.length, 2);
  const result = workbench.snoozePrs({ action: 'snooze', groups: [[member(1).url]], on: ['activity'] });
  assert.deepEqual(result.urls, [member(1).url]);
  assert.deepEqual(result.queue.items.map((item) => item.subject.members[0].number), [2]);
  assert.equal(result.queue.snoozedPrs?.length, 1);
  assert.ok(workbench.snoozedUrls().has(member(1).url));
  assert.ok(workbench.hiddenUrls().has(member(1).url));
  // Mute keeps its meaning: a snoozed PR is not muted.
  assert.equal(workbench.mutedUrls().has(member(1).url), false);
  assert.ok(result.undo);
  const undone = workbench.snoozePrs({ action: 'undo', token: result.undo });
  assert.equal(undone.queue.items.length, 2);
  assert.equal(undone.queue.snoozedPrs?.length, 0);
  assert.throws(() => workbench.snoozePrs({ action: 'undo', token: result.undo ?? '' }), /no longer be undone/);
  assert.throws(() => workbench.snoozePrs({ action: 'snooze', groups: [[member(1).url]], on: [], until: T0 - 1 }), /future/);
  // A signal from GitHub wakes it: it comes back with its reason and one notification.
  workbench.snoozePrs({ action: 'snooze', groups: [[member(1).url]], on: ['activity'] });
  clock.now = T0 + HOUR;
  workbench.updatePrMetadata({ ...member(1), headSha: 'pushed', updatedAt: new Date(T0 + HOUR).toISOString() });
  const back = workbench.snapshot();
  assert.equal(back.snoozedPrs?.length, 0);
  const item = back.items.find((entry) => entry.subject.members[0].number === 1);
  assert.equal(item?.back?.[member(1).url]?.reason.kind, 'commits');
  assert.equal(delivered.filter((value) => value.type === 'snooze-ended').length, 1);
  assert.equal(delivered.find((value) => value.type === 'snooze-ended')?.detail, 'new commits');
});

void test('a snooze that ended while the app was closed comes back on launch, silently', () => {
  const saved = new Map<string, string>();
  const clock = { now: T0 };
  service(saved, clock).snoozePrs({ action: 'snooze', groups: [[member(1).url, member(2).url]], on: [], until: T0 + HOUR });
  // Restart a day later.
  clock.now = T0 + 24 * HOUR;
  const delivered: NotificationEvent[] = [];
  const restart = service(saved, clock, undefined, delivered);
  const queue = restart.snapshot();
  assert.equal(queue.snoozedPrs?.length, 0);
  assert.equal(queue.items.length, 2);
  assert.ok(queue.items.every((item) => Object.values(item.back ?? {})[0]?.reason.kind === 'time'));
  assert.equal(delivered.length, 0);
  // Signals that arrived while closed are found by comparing with the saved basis, not the last poll.
  const later = service(new Map(), clock);
  later.snoozePrs({ action: 'snooze', groups: [[member(1).url]], on: ['activity'] });
  const signalsAfter = signals(member(1), { checkedAt: clock.now + HOUR, activity: { recent: [{ kind: 'comment', id: 'c1', at: new Date(clock.now + 30 * 60_000).toISOString(), author: 'maria', automated: false }] } });
  later.observeReadSignals(ME, [signalsAfter]);
  assert.equal(later.snapshot().items.find((item) => item.subject.members[0].number === 1)?.back?.[member(1).url]?.reason.kind, 'comment');
});

void test('notifications for a snoozed PR are held, and an existing event describes its wake', () => {
  const saved = new Map<string, string>();
  const clock = { now: T0 };
  const delivered: NotificationEvent[] = [];
  const own = member(3, { author: ME });
  const workbench = service(saved, clock, groupSubjects([member(1), member(2), own]), delivered);
  workbench.snapshot();
  workbench.observeReadSignals(ME, [signals(own, { checkedAt: T0 })]);
  workbench.snoozePrs({ action: 'snooze', groups: [[member(2).url], [own.url]], on: [], until: T0 + 48 * HOUR });
  // Failing checks do not end a timed snooze, and their notification is held.
  clock.now = T0 + 30 * 60_000;
  workbench.observeReadSignals(ME, [signals(own, { checkedAt: clock.now, checks: { state: 'failure', passed: 0, failed: 1, total: 1 } })]);
  assert.equal(delivered.length, 0);
  assert.ok(workbench.snoozedUrls().has(own.url));
  clock.now = T0 + HOUR;
  // A review request wakes a timed snooze; the review-requested notification says why, so no second one.
  workbench.updatePrMetadata({ ...member(2), requestedReviewers: [ME], updatedAt: new Date(clock.now).toISOString() });
  assert.deepEqual(delivered.map((value) => value.type), ['review-requested']);
  assert.equal(workbench.snoozedUrls().has(member(2).url), false);
  assert.ok(workbench.snoozedUrls().has(own.url));
});

void test('the menu bar leaves snoozed stack members out, marks a PR that came back and counts the snoozed', () => {
  const a = member(20, { requestedReviewers: [ME] }), b = member(21, { requestedReviewers: [ME], baseBranch: 'feature-20' }), c = member(22, { requestedReviewers: [ME] });
  const stack = groupSubjects([a, b]).find((subject) => subject.kind === 'stack');
  assert.ok(stack);
  const single = groupSubjects([c])[0];
  const items: QueueItem[] = [
    { subject: stack, attention: 'requested', snoozedUrls: [b.url], unreadUrls: [a.url] },
    { subject: single, attention: 'requested', unreadUrls: [c.url], back: { [c.url]: { reason: { kind: 'review', actor: 'lena' }, at: T0, snoozedAt: T0 - HOUR } } },
  ];
  const snoozedPrs = [{ member: summaryOf(b), group: 'g', snoozedAt: T0, on: ['activity' as const], own: false }];
  const { state } = buildMenubarState({ login: ME, signedIn: true, online: true, queue: { items, snoozedPrs }, signals: () => undefined, now: T0 });
  const rows = state.groups.flatMap((group) => group.rows);
  assert.deepEqual(rows.map((row) => row.number).sort(), [20, 22]);
  assert.equal(rows.find((row) => row.number === 22)?.back, true);
  assert.equal(rows.find((row) => row.number === 20)?.back, undefined);
  assert.equal(state.snoozed, 1);
});
