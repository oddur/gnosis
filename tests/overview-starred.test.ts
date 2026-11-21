import { test } from 'node:test';
import assert from 'node:assert/strict';
import { overviewModel } from '../lib/overview';
import { morningPage, stackLine, stackStep, waitingOnYouNote, type NextItem } from '../lib/morning';
import { checkView } from '../lib/check-summary';
import { prTarget } from '../lib/deep-link';
import type { OverviewVisit } from '../lib/overview';
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
  assert.deepEqual(section.entries.map((entry) => entry.lead.action), ['review', 'rerun', 'merge', 'nudge', undefined, undefined]);
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

// ── Review fixes, round 2 (#441) ──

void test('A reply or change request leads a starred PR\'s line, with its fix after it, as Next up ranks them', () => {
  const status: Record<string, QueueSignals> = {};
  const both = mine(110);
  status[both.url] = signals(both, { checks: 'failure', decision: 'CHANGES_REQUESTED', opinions: [{ id: '1', author: 'lena', state: 'CHANGES_REQUESTED', at: iso(HOUR) }] });
  const replied = mine(111);
  status[replied.url] = signals(replied, { checks: 'failure' });
  const items = [item([both]), item([replied], { responses: { [replied.url]: { changesRequested: false, unresolvedThreads: 1, awaitingReply: 1, complete: true } } })];
  // Unstarred, Next up offers each as the person blocked on you, not as a fix.
  const plain = page(items, status);
  assert.deepEqual(plain.page.next.items.map((entry) => [entry.member.number, entry.kind]).sort(), [[110, 'changes'], [111, 'reply']]);
  const { section } = page(items.map((value) => star(value)), status);
  const by = Object.fromEntries(section.entries.map((entry) => [entry.lead.member.number, [entry.tier, entry.lead.rank, entry.why, entry.lead.action]]));
  assert.deepEqual(by[110], ['you', 0, 'lena requested changes · failing checks', 'open']);
  assert.deepEqual(by[111], ['you', 0, 'Awaiting your reply · failing checks', 'reply']);
});

void test('A PR above the merge PR waits for its own parent: straight and branching stacks', () => {
  const status: Record<string, QueueSignals> = {};
  const a = mine(120, { headBranch: 'a' });
  const b = mine(121, { baseBranch: 'a', headBranch: 'b' });
  const c = mine(122, { baseBranch: 'b', headBranch: 'c' });
  for (const m of [a, b, c]) status[m.url] = approved(m);
  const straight = page([star(item([a, b, c]))], status).section.entries[0];
  assert.deepEqual(straight.lines.map((line) => line.why), ['Ready to merge · approved by lena', 'Waits for #120 to merge', 'Waits for #121 to merge']);
  // A→B and A→C: both wait for A.
  const root = mine(130, { headBranch: 'r' });
  const left = mine(131, { baseBranch: 'r', headBranch: 'l' });
  const right = mine(132, { baseBranch: 'r', headBranch: 'q' });
  for (const m of [root, left, right]) status[m.url] = approved(m);
  const branching: QueueItem = {
    subject: { id: 'stack-130', kind: 'stack', title: 'Stack 130', members: [root, left, right], edges: [left, right].map((child) => ({ parent: root.url, child: child.url, evidence: 'branch' as const })), warnings: [] },
    attention: 'other',
  };
  const lines = page([star(branching)], status).section.entries[0].lines;
  assert.deepEqual(Object.fromEntries(lines.map((line) => [line.member.number, line.why])), { 130: 'Ready to merge · approved by lena', 131: 'Waits for #130 to merge', 132: 'Waits for #130 to merge' });
});

void test('A starred PR waiting on a reviewer offers Remind, also when a Waiting on others stack points at it', () => {
  const status: Record<string, QueueSignals> = {};
  const base = mine(140, { headBranch: 'a', requestedReviewers: ['lena'] });
  const child = mine(141, { baseBranch: 'a', headBranch: 'b' });
  const top = mine(142, { baseBranch: 'b', headBranch: 'c' });
  for (const m of [base, child, top]) status[m.url] = signals(m, { checks: 'success' });
  const value = page([item([base, child, top])], status, [star(item([base]))]);
  const stack = value.page.others.find((group) => group.kind === 'stacks')?.children?.[0];
  assert.equal(stack?.step?.inStarred, true);
  const line = value.section.entries[0].lead;
  assert.deepEqual([line.action, line.reviewer, line.why], ['nudge', 'lena', 'Waits on review from lena']);
});

void test('When you owe a review in a starred stack, its base says to review first, offers no Merge and is not counted', () => {
  const status: Record<string, QueueSignals> = {};
  const base = mine(160, { headBranch: 'a' });
  const child = pr(161, { baseBranch: 'a', headBranch: 'b', requestedReviewers: [LOGIN] });
  status[base.url] = approved(base);
  status[child.url] = signals(child, { checks: 'success' });
  const plain = page([item([base, child])], status);
  // Next up: the review is the stack's step, and the merge follows it.
  assert.match(plain.page.next.items[0].why, /then merge #160$/);
  const starred = page([star(item([base, child]))], status);
  const lines = starred.section.entries[0].lines;
  assert.deepEqual(lines.map((line) => [line.member.number, line.why, line.action ?? null, line.actionable]), [
    [160, 'Review #161 first, then merge #160', 'review', false],
    [161, 'Review requested', 'review', true],
  ]);
  assert.equal(starred.section.entries[0].lead.member.number, 161);
  assert.equal(starred.page.count, plain.page.count);
});

void test('A starred PR that needs a decision counts in the tab only where an unstarred one would', () => {
  const status: Record<string, QueueSignals> = {};
  // Five quick merges fill Next up, so the stale fix is in Needs a decision, not Next up.
  const merges = [171, 172, 173, 174, 175].map((n) => {
    const m = mine(n);
    status[m.url] = approved(m);
    return item([m]);
  });
  const stale = mine(176, { createdAt: iso(20 * DAY), updatedAt: iso(10 * DAY) });
  status[stale.url] = signals(stale, { checks: 'failure' });
  const plain = page([...merges, item([stale])], status);
  assert.ok(plain.page.decide.some((entry) => entry.member.url === stale.url));
  const starred = page([...merges, star(item([stale]))], status);
  assert.equal(starred.page.count, plain.page.count);
});

// ── Review fixes, rounds 3 and 4 (#441): a starred line decides what Next up and the stack step decide ──

/** The starred line for `member`, Next up's row for it (unstarred), and its stack step, from one lane model. */
function decisions(items: QueueItem[], status: Record<string, QueueSignals>, starred: QueueItem, member: ReviewMember, options: { previous?: OverviewVisit; hidden?: ReadonlySet<string> } = {}) {
  const signal = (m: ReviewMember) => status[m.url];
  const { previous, hidden } = options;
  const model = overviewModel({ items, signals: signal, login: LOGIN, now: T0, previous });
  const section = starredSection({ items: [starred], model, signals: signal, login: LOGIN, now: T0, hidden });
  const line = section.entries.flatMap((entry) => entry.lines).find((candidate) => candidate.member.url === member.url);
  assert.ok(line, `#${member.number} has a starred line`);
  const next = morningPage({ model, now: T0, login: LOGIN, signals: signal, hidden }).next.items.find((entry) => entry.urls.length === 1 && entry.urls[0] === member.url);
  const step = stackStep(model, member, LOGIN, 0, checkView([status[member.url]]), signal, hidden);
  return { line, next, step, model };
}
/** The starred action for a Next up row: the same verb. */
const NEXT_ACTION: Readonly<Record<NextItem['kind'], string>> = { reply: 'reply', changes: 'open', review: 'review', rereview: 'rereview', merge: 'merge', fix: 'open' };
const nextAction = (entry: NextItem) => (entry.kind === 'fix' && entry.fix === 'failing' ? 'rerun' : NEXT_ACTION[entry.kind]);
const awaiting = (m: ReviewMember): Partial<QueueItem> => ({ responses: { [m.url]: { changesRequested: false, unresolvedThreads: 1, awaitingReply: 1, complete: true } } });
/** A line opens its own PR: its own row's target, as a stack chain line does. */
const ownTarget = (line: { member: ReviewMember; row?: { focus: ReviewMember; target: unknown } }) => (line.row && line.row.focus.url === line.member.url ? line.row.target : prTarget(line.member.url));

void test('Starred lines match Next up and the stack step: text, action, target, unread dot, conflicts and owed reviews', () => {
  const status: Record<string, QueueSignals> = {};
  const lenaChanges = [{ id: '1', author: 'lena', state: 'CHANGES_REQUESTED', at: iso(HOUR) }];
  const lenaApproved = (ago: number) => [{ id: '1', author: 'lena', state: 'APPROVED', at: iso(ago) }];
  const cases: { name: string; check: () => void }[] = [];

  // A reply and a change request on one PR: Reply everywhere.
  const both = mine(300);
  status[both.url] = signals(both, { checks: 'success', decision: 'CHANGES_REQUESTED', opinions: lenaChanges });
  cases.push({ name: 'reply plus changes', check: () => {
    const value = item([both], awaiting(both));
    const { line, next, step } = decisions([value], status, star(value), both);
    assert.ok(next);
    assert.equal(next.kind, 'reply');
    assert.equal(line.action, nextAction(next));
    assert.equal(line.why, 'lena is waiting on your reply');
    assert.equal(step.text, '#300 waits on your reply');
    assert.deepEqual(line.target, next.row.target);
    assert.equal(!!line.isNew, !!next.isNew);
  } });

  // Conflicts behind a reply, leading or not among the fix's reasons: the conflict icon shows on both surfaces.
  const conflicted = mine(301);
  status[conflicted.url] = signals(conflicted, { checks: 'success', mergeable: 'CONFLICTING', mergeState: 'DIRTY' });
  const failingConflicted = mine(302);
  status[failingConflicted.url] = signals(failingConflicted, { checks: 'failure', mergeable: 'CONFLICTING', mergeState: 'DIRTY' });
  for (const [m, words] of [[conflicted, 'conflicts'], [failingConflicted, 'failing checks']] as const)
    cases.push({ name: `conflicts behind a reply (${words})`, check: () => {
      const value = item([m], awaiting(m));
      const { line, next, step } = decisions([value], status, star(value), m);
      assert.equal(next?.kind, 'reply');
      assert.equal(line.action, 'reply');
      assert.equal(line.why, `Awaiting your reply · ${words}`);
      assert.equal(line.conflicts, true);
      assert.equal(step.conflicts, true);
    } });

  // A lone-PR subject whose parent merged in its stack: the rebase words name the merged parent.
  const parent = mine(310, { headBranch: 'p', state: 'closed', merged: true });
  const child = mine(311, { baseBranch: 'p', headBranch: 'c' });
  status[child.url] = signals(child, { checks: 'success' });
  cases.push({ name: 'lone subject, merged parent', check: () => {
    const { line, next, step } = decisions([item([parent, child])], status, star(item([child])), child);
    assert.ok(next);
    assert.equal(step.text, '#311 needs to move onto main after #310 merged');
    assert.equal(next.why, 'needs to move onto main after #310 merged');
    assert.equal(line.why, 'Needs to move onto main after #310 merged');
    assert.equal(line.action, nextAction(next));
  } });

  // A review owed in the stack, on the base that merges next, ready, running checks or parked: review first. The
  // line opens its own PR; only its Review button opens the owed review, and says so.
  const owedCase = (name: string, n: number, signal: (m: ReviewMember) => QueueSignals, extra: Partial<ReviewMember> = {}) => {
    const base = mine(n, { headBranch: `b${n}`, ...extra });
    const owed = pr(n + 1, { baseBranch: `b${n}`, headBranch: `o${n}`, requestedReviewers: [LOGIN] });
    status[base.url] = signal(base);
    status[owed.url] = signals(owed, { checks: 'success' });
    cases.push({ name, check: () => {
      const value = item([base, owed]);
      const { line, step } = decisions([value], status, star(value), base);
      assert.equal(step.action, 'review', `${name}: the stack step reviews first`);
      assert.equal(line.why, step.text);
      assert.equal(line.why, `Review #${n + 1} first, then merge #${n}`);
      assert.equal(line.action, 'review');
      assert.equal(line.actionable, false);
      assert.equal(line.actionRow, step.row);
      assert.deepEqual(line.actionTarget, step.row?.target);
      assert.equal(line.actionNumber, n + 1);
      assert.deepEqual(line.target, ownTarget(line));
      assert.equal(line.row?.entries.some((entry) => entry.member.url === base.url), true, 'its row is its own');
    } });
  };
  owedCase('owed review on a merge base', 320, approved);
  owedCase('owed review on a checks-running base', 330, (m) => signals(m, { checks: 'pending', decision: 'APPROVED', mergeState: 'CLEAN', opinions: lenaApproved(HOUR) }));
  owedCase('owed review on a parked base', 340, (m) => signals(m, { checks: 'success', decision: 'APPROVED', mergeState: 'CLEAN', opinions: lenaApproved(6 * DAY) }), { updatedAt: iso(6 * DAY) });

  // A parked PR above the base, with a review owed in the stack: it waits for its base, and opens itself.
  const pBase = mine(360, { headBranch: 'pb', updatedAt: iso(6 * DAY) });
  const pChild = mine(361, { baseBranch: 'pb', headBranch: 'pc', updatedAt: iso(6 * DAY) });
  const pOwed = pr(362, { baseBranch: 'pc', headBranch: 'po', requestedReviewers: [LOGIN] });
  for (const m of [pBase, pChild]) status[m.url] = signals(m, { checks: 'success', decision: 'APPROVED', mergeState: 'CLEAN', opinions: lenaApproved(6 * DAY) });
  status[pOwed.url] = signals(pOwed, { checks: 'success' });
  cases.push({ name: 'parked PR above an owed base', check: () => {
    const value = item([pBase, pChild, pOwed]);
    const { line, step } = decisions([value], status, star(value), pChild);
    assert.equal(line.why, 'Waits for #360 to merge');
    assert.equal(line.actionRow, undefined);
    assert.equal(line.action, undefined);
    assert.deepEqual(line.target, ownTarget(line));
    assert.equal(step.text, '#361 has to merge first');
  } });

  // An owed review that is leaving the page (closing) is not owed, as Next up leaves it out: the base merges.
  const hBase = mine(370, { headBranch: 'hb' });
  const hOwed = pr(371, { baseBranch: 'hb', headBranch: 'ho', requestedReviewers: [LOGIN] });
  status[hBase.url] = approved(hBase);
  status[hOwed.url] = signals(hOwed, { checks: 'success' });
  cases.push({ name: 'hidden owed review', check: () => {
    const value = item([hBase, hOwed]);
    const { line, next, step } = decisions([value], status, star(value), hBase, { hidden: new Set([hOwed.url]) });
    assert.equal(next?.kind, 'merge');
    assert.equal(step.action, 'merge');
    assert.equal(line.action, 'merge');
    assert.equal(line.why, 'Ready to merge · approved by lena');
  } });

  // A new fix entry behind an unchanged reply, and a new owed review: the line's unread dot follows what it names.
  const fresh = mine(350);
  status[fresh.url] = signals(fresh, { checks: 'failure' });
  cases.push({ name: 'new fix entry', check: () => {
    const value = item([fresh], awaiting(fresh));
    const seen = overviewModel({ items: [value], signals: (m) => status[m.url], login: LOGIN, now: T0 });
    const previous: OverviewVisit = { at: T0 - DAY, keys: [], entries: seen.entryKeys.filter((key) => !key.startsWith('fix|')), seen: [fresh.url], unchecked: [] };
    const { line, model } = decisions([value], status, star(value), fresh, { previous });
    assert.ok(model.lanes.find((state) => state.lane === 'fix')?.rows[0]?.entries[0]?.isNew, 'the fix entry is new');
    assert.ok(!model.lanes.find((state) => state.lane === 'answer')?.rows[0]?.entries[0]?.isNew, 'the reply is not');
    assert.equal(line.why, 'Awaiting your reply · failing checks');
    assert.equal(line.isNew, true);
  } });
  const nBase = mine(380, { headBranch: 'nb' });
  const nOwed = pr(381, { baseBranch: 'nb', headBranch: 'no', requestedReviewers: [LOGIN] });
  status[nBase.url] = approved(nBase);
  status[nOwed.url] = signals(nOwed, { checks: 'success' });
  cases.push({ name: 'new owed review', check: () => {
    const value = item([nBase, nOwed]);
    const seen = overviewModel({ items: [value], signals: (m) => status[m.url], login: LOGIN, now: T0 });
    const previous: OverviewVisit = { at: T0 - DAY, keys: [], entries: seen.entryKeys.filter((key) => !key.startsWith('review|')), seen: [nBase.url, nOwed.url], unchecked: [] };
    const { line } = decisions([value], status, star(value), nBase, { previous });
    assert.equal(line.action, 'review');
    assert.equal(line.isNew, true);
  } });

  // A check state the gate does not count as passing never offers Merge on one surface and Open on another.
  const unknown = mine(390);
  status[unknown.url] = { ...approved(unknown), checks: { state: 'unknown' as never, passed: 0, total: 0 } };
  cases.push({ name: 'unknown check state', check: () => {
    const value = item([unknown]);
    const { line, model } = decisions([value], status, star(value), unknown);
    const step = stackStep(model, unknown, LOGIN, 0, { state: 'unknown' }, (m) => status[m.url]);
    assert.equal(line.action, 'open');
    assert.equal(step.action, 'open');
  } });

  for (const { name, check } of cases) {
    try {
      check();
    } catch (error) {
      throw new Error(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
});
