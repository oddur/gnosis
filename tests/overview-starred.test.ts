import { test } from 'node:test';
import assert from 'node:assert/strict';
import { overviewModel } from '../lib/overview';
import { morningPage, stackLine, waitingOnYouNote } from '../lib/morning';
import { STARRED_SHOWN, starredSection, starredStatusRequests } from '../lib/overview-starred';
import { starAction } from '../components/PrEntryActions';
import type { QueueItem, ReviewMember } from '../lib/workbench';
import type { QueueSignals } from '../lib/queue-signals';
import { LOGIN, T0, member, signals } from './notification-fixtures';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const iso = (ago: number) => new Date(T0 - ago).toISOString();
const pr = (n: number, extra: Partial<ReviewMember> = {}) => member(n, { createdAt: iso(5 * DAY), updatedAt: iso(DAY), additions: 20, deletions: 5, ...extra });
const mine = (n: number, extra: Partial<ReviewMember> = {}) => pr(n, { author: LOGIN, role: 'author', ...extra });
const item = (members: ReviewMember[], extra: Partial<QueueItem> = {}): QueueItem => ({
  subject: {
    id: members.length > 1 ? `stack-${members[0].number}` : members[0].url,
    kind: members.length > 1 ? 'stack' : 'pr',
    title: members.length > 1 ? `Stack ${members[0].number}` : members[0].title,
    members,
    edges: members.slice(1).map((child, i) => ({ parent: members[i].url, child: child.url, evidence: 'branch' as const })),
    warnings: [],
  },
  attention: 'other',
  ...extra,
});
const star = (value: QueueItem, urls = value.subject.members.map((m) => m.url)): QueueItem => ({ ...value, starred: true, starredUrls: urls });
const approved = (m: ReviewMember) => signals(m, { checks: 'success', decision: 'APPROVED', mergeState: 'CLEAN', opinions: [{ id: '1', author: 'lena', state: 'APPROVED', at: iso(2 * HOUR) }] });

/** The page with these entries starred: the lane model, the Starred section and the morning page, as the Overview builds them. */
function page(items: QueueItem[], status: Record<string, QueueSignals>, starred: QueueItem[] = items.filter((entry) => entry.starred)) {
  const signal = (m: ReviewMember) => status[m.url];
  const model = overviewModel({ items, signals: signal, login: LOGIN, now: T0 });
  const section = starredSection({ items: starred, model, signals: signal, login: LOGIN, now: T0 });
  return { model, section, page: morningPage({ model, now: T0, login: LOGIN, signals: signal, starred: section }) };
}
/** Every PR listed outside stack chains, on the whole page. */
const listed = (value: ReturnType<typeof page>) => [
  ...value.section.urls,
  ...value.page.next.items.flatMap((entry) => entry.urls),
  ...value.page.decide.map((entry) => entry.member.url),
  ...value.page.you.flatMap((group) => group.urls),
  ...value.page.others.flatMap((group) => group.urls),
];

void test('Starred orders by what needs you: your action, then ready to merge, then waiting on others, then quiet, then done', () => {
  const status: Record<string, QueueSignals> = {};
  const quiet = pr(1, { updatedAt: iso(2 * HOUR) });
  const waiting = mine(2, { requestedReviewers: ['lena'] });
  status[waiting.url] = signals(waiting, { checks: 'success' });
  const merge = mine(3);
  status[merge.url] = approved(merge);
  const review = pr(4, { requestedReviewers: [LOGIN] });
  status[review.url] = signals(review, { checks: 'success' });
  const failing = mine(5);
  status[failing.url] = signals(failing, { checks: 'failure' });
  const merged = pr(6, { state: 'closed', merged: true });
  status[quiet.url] = signals(quiet, { checks: 'success', decision: 'APPROVED' });
  const items = [quiet, waiting, merge, review, failing, merged].map((m) => star(item([m])));
  const { section } = page(items, status);
  assert.deepEqual(section.entries.map((entry) => [entry.lead.member.number, entry.tier, entry.why]), [
    [4, 'you', 'Review requested'],
    [5, 'you', 'Failing checks'],
    [3, 'merge', 'Ready to merge · approved by lena'],
    [2, 'others', 'Waits on review from lena'],
    [1, 'quiet', 'Approved'],
    [6, 'done', 'Merged'],
  ]);
  assert.deepEqual(section.entries.map((entry) => entry.lead.action), ['review', 'rerun', 'merge', undefined, undefined, undefined]);
  // Open PRs carry their check state; a merged one has none, and claims nothing.
  assert.equal(section.entries[0].check?.label, 'passing');
  assert.equal(section.entries.at(-1)?.check, undefined);
  assert.deepEqual(section.urls.sort(), [quiet, waiting, merge, review, failing].map((m) => m.url).sort());
  // Starred status reads cover the open PRs, merged ones aside.
  assert.deepEqual(starredStatusRequests(items).map((request) => request.url).sort(), section.urls.sort());
  // The tab count's starred PRs: the ones that need you or can merge.
  assert.deepEqual([...section.actionable].sort(), [review.url, failing.url, merge.url].sort());
});

void test('A starred PR is listed once: in Starred, never in Next up or the sections below, and the counts follow', () => {
  const status: Record<string, QueueSignals> = {};
  const review = pr(10, { requestedReviewers: [LOGIN] });
  const other = pr(11, { requestedReviewers: [LOGIN] });
  const merge = mine(12);
  const waiting = mine(13, { requestedReviewers: ['lena'] });
  for (const m of [review, other, waiting]) status[m.url] = signals(m, { checks: 'success' });
  status[merge.url] = approved(merge);
  const items = [star(item([review])), item([other]), star(item([merge])), star(item([waiting]))];
  const value = page(items, status);
  const all = listed(value);
  assert.equal(new Set(all).size, all.length, 'no PR twice');
  assert.deepEqual(value.page.next.items.flatMap((entry) => entry.urls), [other.url], 'Next up keeps only the unstarred review');
  assert.equal(value.page.others.flatMap((group) => group.urls).length, 0, 'Waiting on others lists no starred PR');
  // The briefing still counts every PR that needs you, the starred ones included, and their merges.
  assert.match(value.page.briefing.text, /2 PRs are waiting on your review/);
  assert.match(value.page.briefing.text, /1 approved PR can merge/);
  // The tab count: Next up and Waiting on you, plus starred PRs that need you or can merge.
  assert.equal(value.page.count, 3);
  // Waiting on you points at the starred review it does not list.
  assert.deepEqual(value.page.youElsewhere.starred, [review.url]);
  assert.match(waitingOnYouNote(0, value.page.youElsewhere).text, /^Shown in Starred: 1 PR\. Shown in Next up: #11\.$/);
  // Starred took work from Next up and Waiting on others: their empty states say "else".
  assert.deepEqual(value.page.starredHolds, { next: true, others: true, decide: false });
});

void test('With everything that needs you starred, Next up is empty and says "else"', () => {
  const status: Record<string, QueueSignals> = {};
  const review = pr(20, { requestedReviewers: [LOGIN] });
  status[review.url] = signals(review, { checks: 'success' });
  const value = page([star(item([review]))], status);
  assert.equal(value.page.next.items.length, 0);
  assert.equal(value.page.starredHolds.next, true);
  assert.equal(value.page.you.length, 0);
  assert.equal(waitingOnYouNote(0, value.page.youElsewhere).text, 'Shown in Starred: 1 PR.');
});

void test('A stack is starred when any of its PRs is: one entry, its PRs in merge order, led by its most actionable PR', () => {
  const status: Record<string, QueueSignals> = {};
  const base = mine(30, { headBranch: 'a' });
  const middle = mine(31, { baseBranch: 'a', headBranch: 'b' });
  const top = mine(32, { baseBranch: 'b', headBranch: 'c', state: 'closed', merged: false });
  status[base.url] = signals(base, { checks: 'success' });
  status[middle.url] = signals(middle, { checks: 'failure' });
  const stacked = star(item([base, middle, top]), [middle.url]);
  const value = page([stacked], status);
  const [entry] = value.section.entries;
  assert.equal(entry.kind, 'stack');
  assert.deepEqual(entry.lines.map((line) => line.member.number), [30, 31, 32], 'base first');
  assert.equal(entry.lead.member.number, 31);
  assert.equal(entry.why, '3 PRs · #31 failing checks');
  // The base waits on a review GitHub requires; the closed PR is done.
  assert.deepEqual(entry.lines.map((line) => line.tier), ['others', 'you', 'done']);
  assert.equal(entry.lines[0].why, 'Awaiting review');
  assert.equal(entry.lines[2].why, 'Closed');
  // Every open PR of the stack is claimed, the unstarred base too, so the stack is not repeated below.
  assert.deepEqual(entry.urls, [base.url, middle.url]);
  const all = listed(value);
  assert.equal(new Set(all).size, all.length);
  assert.ok(!value.page.others.some((group) => group.kind === 'stacks'), 'no chain for the starred stack in Waiting on others');
});

void test('A stack chain elsewhere links to Starred for its starred PR', () => {
  const status: Record<string, QueueSignals> = {};
  const base = mine(40, { headBranch: 'a', requestedReviewers: ['lena'] });
  const child = mine(41, { baseBranch: 'a', headBranch: 'b' });
  const top = mine(42, { baseBranch: 'b', headBranch: 'c' });
  status[base.url] = signals(base, { checks: 'success' });
  status[child.url] = approved(child);
  status[top.url] = approved(top);
  const stack = item([base, child, top]);
  // Only the child's own entry is starred, as a PR the queue lists apart from its stack.
  const value = page([stack], status, [star(item([child]))]);
  const chain = value.page.others.find((group) => group.kind === 'stacks')?.children?.[0]?.chain ?? [];
  assert.deepEqual(chain.map((node) => [node.line.member.number, node.also ?? null]), [[40, null], [41, 'starred'], [42, null]]);
  const all = listed(value);
  assert.equal(new Set(all).size, all.length);
});

void test('Merged and closed starred PRs stay at the end as quiet done rows; snoozed, muted and closing PRs leave', () => {
  const status: Record<string, QueueSignals> = {};
  const open = pr(50, { updatedAt: iso(HOUR) });
  const merged = pr(51, { state: 'closed', merged: true, updatedAt: iso(10 * DAY) });
  const closed = pr(52, { state: 'closed', updatedAt: iso(2 * DAY) });
  const muted = pr(53);
  const snoozed = pr(54);
  const closing = pr(55);
  const items = [merged, closed, open, muted, closing].map((m) => star(item([m])));
  items.push(star(item([snoozed]), [snoozed.url]));
  items[items.length - 1] = { ...items[items.length - 1], snoozedUrls: [snoozed.url] };
  const model = overviewModel({ items, signals: (m) => status[m.url], login: LOGIN, now: T0 });
  const section = starredSection({ items, model, signals: (m) => status[m.url], login: LOGIN, now: T0, excluded: new Set([muted.url]), hidden: new Set([closing.url]) });
  // Done rows: the latest change first.
  assert.deepEqual(section.entries.map((entry) => [entry.lead.member.number, entry.tier, entry.why]), [
    // Its status is not read yet: it says only that it is open.
    [50, 'quiet', 'Open'],
    [52, 'done', 'Closed'],
    [51, 'done', 'Merged'],
  ]);
  assert.deepEqual(section.urls, [open.url]);
});

void test('A stack with every PR merged is a done row that says so', () => {
  const a = pr(60, { state: 'closed', merged: true, headBranch: 'a' });
  const b = pr(61, { state: 'closed', merged: true, baseBranch: 'a' });
  const { section } = page([], {}, [star(item([a, b]))]);
  assert.equal(section.entries[0].tier, 'done');
  assert.equal(section.entries[0].why, '2 PRs · all merged');
  assert.deepEqual(section.urls, []);
});

void test('Drafts, change requests, replies and rebases say so in words', () => {
  const status: Record<string, QueueSignals> = {};
  const draft = pr(70, { isDraft: true });
  const changes = mine(71);
  status[changes.url] = signals(changes, { checks: 'success', decision: 'CHANGES_REQUESTED', opinions: [{ id: '1', author: 'lena', state: 'CHANGES_REQUESTED', at: iso(HOUR) }] });
  const { section } = page([star(item([draft])), star(item([changes]))], status);
  const why = Object.fromEntries(section.entries.map((entry) => [entry.lead.member.number, entry.why]));
  assert.equal(why[70], 'Draft');
  assert.equal(why[71], 'lena requested changes');
});

void test('No stars: the section is empty, and the page is as it was', () => {
  const status: Record<string, QueueSignals> = {};
  const review = pr(80, { requestedReviewers: [LOGIN] });
  status[review.url] = signals(review, { checks: 'success' });
  const items = [item([review])];
  const value = page(items, status);
  assert.deepEqual(value.section.entries, []);
  assert.deepEqual(value.section.urls, []);
  const plain = morningPage({ model: value.model, now: T0, login: LOGIN, signals: (m) => status[m.url] });
  assert.deepEqual(value.page.next.items.map((entry) => entry.id), plain.next.items.map((entry) => entry.id));
  assert.equal(value.page.briefing.text, plain.briefing.text);
  assert.equal(value.page.count, plain.count);
  assert.deepEqual(value.page.starredHolds, { next: false, others: false, decide: false });
});

void test('Many stars: every entry is built and ordered; the page shows the first eight', () => {
  const items = Array.from({ length: 12 }, (_, i) => star(item([pr(100 + i, { updatedAt: iso((i + 1) * HOUR) })])));
  const { section } = page([], {}, items);
  assert.equal(STARRED_SHOWN, 8);
  assert.equal(section.entries.length, 12);
  // Quiet rows: the latest change first.
  assert.deepEqual(section.entries.slice(0, 3).map((entry) => entry.lead.member.number), [100, 101, 102]);
  // One entry per subject, even when the queue sends it twice.
  assert.equal(page([], {}, [...items, items[0]]).section.entries.length, 12);
});

// ── Review fixes (#441) ──

void test('In a stack\'s merge row, only the PR the row merges gets Merge; the PRs above it wait for it and are not work', () => {
  const status: Record<string, QueueSignals> = {};
  const base = mine(30, { headBranch: 'a' });
  const child = mine(31, { baseBranch: 'a', headBranch: 'b' });
  status[base.url] = approved(base);
  status[child.url] = approved(child);
  const { section } = page([star(item([base, child]))], status);
  const [entry] = section.entries;
  assert.deepEqual(entry.lines.map((line) => [line.member.number, line.tier, line.why, line.action ?? null, line.actionable]), [
    [30, 'merge', 'Ready to merge · approved by lena', 'merge', true],
    [31, 'others', 'Waits for #30 to merge', null, false],
  ]);
  // The Merge button on a line merges that line's PR.
  assert.equal(entry.lines[0].row?.merge?.member.url, base.url);
  assert.deepEqual(section.actionable, [base.url]);
});

void test('The briefing counts starred PRs in their own section: a decision, and a PR waiting on others', () => {
  const status: Record<string, QueueSignals> = {};
  const idle = mine(90, { createdAt: iso(20 * DAY), updatedAt: iso(10 * DAY) });
  status[idle.url] = signals(idle, { checks: 'success' });
  const plain = page([item([idle])], status);
  assert.match(plain.page.briefing.text, /1 PR needs a decision/);
  const starred = page([star(item([idle]))], status);
  assert.equal(starred.page.decide.length, 0, 'Needs a decision leaves the starred PR out');
  assert.equal(starred.page.briefing.text, plain.page.briefing.text, 'the briefing still counts it as a decision');
  assert.equal(starred.page.starredHolds.decide, true);

  const waiting = mine(91, { requestedReviewers: ['lena'] });
  status[waiting.url] = signals(waiting, { checks: 'success' });
  const before = page([item([waiting])], status);
  const after = page([star(item([waiting]))], status);
  assert.equal(before.page.briefing.text, 'Nothing needs you right now. 1 of your PRs is waiting on others.');
  assert.equal(after.page.briefing.text, before.page.briefing.text);
});

void test('Starred merges pass the gates Next up uses: passing checks, and a review, for the Merge button', () => {
  const status: Record<string, QueueSignals> = {};
  const running = mine(92);
  status[running.url] = signals(running, { checks: 'pending', decision: 'APPROVED', mergeState: 'CLEAN', opinions: [{ id: '1', author: 'lena', state: 'APPROVED', at: iso(HOUR) }] });
  const unreviewed = mine(93);
  status[unreviewed.url] = signals(unreviewed, { checks: 'success', decision: null, mergeState: 'CLEAN' });
  const unchecked = mine(94);
  status[unchecked.url] = { ...approved(unchecked), checks: { state: 'neutral', passed: 0, total: 0 } };
  const { section } = page([running, unreviewed, unchecked].map((m) => star(item([m]))), status);
  const by = Object.fromEntries(section.entries.map((entry) => [entry.lead.member.number, [entry.tier, entry.why, entry.lead.action ?? null, entry.lead.actionable]]));
  assert.deepEqual(by[92].slice(2), [null, false], 'running checks: no Merge, not work');
  assert.notEqual(by[92][0], 'merge');
  assert.deepEqual(by[93], ['merge', 'Ready to merge · no review required', 'open', false]);
  assert.deepEqual(by[94], ['merge', 'Ready to merge · approved by lena · no checks', 'open', false]);
  assert.deepEqual(section.actionable, []);
});

void test('Starring a PR Next up lists does not raise the tab count, though Next up refills', () => {
  const status: Record<string, QueueSignals> = {};
  const reviews = Array.from({ length: 7 }, (_, i) => pr(200 + i, { requestedReviewers: [LOGIN], createdAt: iso((10 - i) * DAY) }));
  for (const m of reviews) status[m.url] = signals(m, { checks: 'success' });
  const before = page(reviews.map((m) => item([m])), status);
  const listed = before.page.next.items[0].urls[0];
  const after = page(reviews.map((m) => (m.url === listed ? star(item([m])) : item([m]))), status);
  assert.ok(!after.page.next.items.some((entry) => entry.urls.includes(listed)), 'Next up leaves it out and refills');
  assert.equal(after.page.next.items.length, before.page.next.items.length);
  assert.equal(after.page.count, before.page.count);
});

void test('A reply on a PR that also changed since your review says both', () => {
  const status: Record<string, QueueSignals> = {};
  const reviewed = pr(95);
  status[reviewed.url] = signals(reviewed, { checks: 'success' });
  const value = item([reviewed], { attention: 'updated', responses: { [reviewed.url]: { changesRequested: false, unresolvedThreads: 1, awaitingReply: 1, complete: true } } });
  const { section } = page([star(value)], status);
  assert.match(section.entries[0].why, /your reply · updated since your review$/);
});

void test('A Waiting on others stack whose next step is starred points at Starred, without its own action', () => {
  const status: Record<string, QueueSignals> = {};
  const base = mine(96, { headBranch: 'a', requestedReviewers: ['lena'] });
  const child = mine(97, { baseBranch: 'a', headBranch: 'b' });
  const top = mine(98, { baseBranch: 'b', headBranch: 'c' });
  for (const m of [base, child, top]) status[m.url] = signals(m, { checks: 'success' });
  const value = page([item([base, child, top])], status, [star(item([base]))]);
  const stack = value.page.others.find((group) => group.kind === 'stacks')?.children?.[0];
  assert.ok(stack?.step);
  assert.equal(stack.step.inStarred, true);
  assert.match(stackLine(stack), /next step in Starred$/);
});

void test('The star toggle waits while a star change is saved', () => {
  const m = pr(99);
  assert.equal(starAction({ members: [m], starred: true, busy: true, onStarChange: () => undefined }).disabled, true);
  assert.equal(starAction({ members: [m], starred: true, onStarChange: () => undefined }).label, 'Unstar PR #99');
  assert.equal(starAction({ members: [m, pr(100)], starred: true, onStarChange: () => undefined }).label, 'Unstar PRs in this stack');
});
