import { test } from 'node:test';
import assert from 'node:assert/strict';
import { overviewModel, type OverviewModel } from '../lib/overview';
import {
  NEXT_LIMIT,

  QUICK_LINES,
  closeConfirmation,
  commentsOf,
  mergeCaveats,
  closeRequest,
  effortRank,
  morningPage,
  needsDecision,
  nextCount,
  nextMoreLine,
  nextUp,
  nudgeConfirmation,
  nudgeRequests,
  quote,
  waitingOnYouNote,
  repositoryNames,
  sectionCount,
  waitingOnYou,
  type MorningPage,
  NEXT_TIER,
  type GroupLine,
  type PersonGroup,
} from '../lib/morning';
import { checkView } from '../lib/check-summary';
import { overviewBriefing } from '../lib/overview';
import { appendSinceEvents, parseSinceEvent, sinceEventsFromNotifications, sinceLabel, sinceLine, sinceSummary, SINCE_LOG_LIMIT, SINCE_LOG_MAX_AGE_MS, type SinceEvent } from '../lib/since-log';
import { parseRereviewTargets, rereviewCompare, rereviewSize, REREVIEW_LIMIT } from '../lib/rereview-lines';
import { reviewedCommit, waitingReply } from '../lib/use-morning';
import { closeBlockedReason, type PrActionState } from '../lib/pr-actions';
import type { QueueItem, ReviewMember } from '../lib/workbench';
import type { QueueSignals } from '../lib/queue-signals';
import type { NotificationEvent } from '../lib/notification-events';
import type { GitHubReviewThreads } from '../lib/review-threads';
import { LOGIN, T0, member, mine, signals, readySignals } from './notification-fixtures';
import { FIXTURE_LOGIN, OVERVIEW_FIXTURES, overviewFixture } from './fixtures/overview-node';

const DAY = 86_400_000;
const must = <T,>(value: T | undefined): T => {
  assert.ok(value);
  return value;
};
const iso = (ago: number) => new Date(T0 - ago).toISOString();
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
const build = (items: QueueItem[], status: Record<string, QueueSignals>, now = T0, teamRequests = false): OverviewModel =>
  overviewModel({ items, signals: (m) => status[m.url], login: LOGIN, now, teamRequests });
const input = (model: OverviewModel, status: Record<string, QueueSignals>, extra: Partial<Parameters<typeof nextUp>[0]> = {}) => ({
  model,
  now: T0,
  login: LOGIN,
  signals: (m: ReviewMember) => status[m.url],
  ...extra,
});
const pr = (repo: string, n: number, extra: Partial<ReviewMember> = {}) =>
  member(n, { repo, baseRepo: repo, headRepo: repo, url: `https://github.com/${repo}/pull/${n}`, additions: 20, deletions: 5, ...extra });
const minePr = (repo: string, n: number, extra: Partial<ReviewMember> = {}) => pr(repo, n, { author: LOGIN, role: 'author', ...extra });
/** A stack subject with an explicit id: equal numbers in two repositories must not share one. */
const stack = (members: ReviewMember[], id = `${members[0].repo}#${members[0].number}`, name?: string): QueueItem => {
  const value = item(members);
  return { ...value, subject: { ...value.subject, id, ...(name ? { name } : {}) } };
};
const noReview = (m: ReviewMember) => signals(m, { checks: 'success', decision: null, mergeState: 'CLEAN' });
const approved = (m: ReviewMember, by = 'lena') => signals(m, { checks: 'success', decision: 'APPROVED', mergeState: 'CLEAN', opinions: [{ id: '1', author: by, state: 'APPROVED' }] });
const failing = (m: ReviewMember) => signals(m, { checks: 'failure' });
const conflicted = (m: ReviewMember) => signals(m, { checks: 'success', mergeable: 'CONFLICTING', mergeState: 'DIRTY' });
/** Five approved merges: cheaper than anything else, so they fill Next up and leave the rest to the sections below. */
function fillers(status: Record<string, QueueSignals>) {
  return [901, 902, 903, 904, 905].map((n) => {
    const m = minePr('o/fill', n);
    status[m.url] = approved(m);
    return item([m]);
  });
}
/** The number a row shows for its PRs: "5 PRs · …", "3 running", "17 PRs in 6 stacks", "2 failing checks, 1 conflict". */
const shown = (group: PersonGroup) =>
  group.kind === 'you'
    ? [...group.detail.matchAll(/(\d+) (failing checks?|conflicts?|restacks?)/g)].reduce((total, match) => total + Number(match[1]), 0)
    : Number(group.detail.match(/^(\d+) (PRs?|running|review requests?)\b/)?.[1] ?? NaN);

/**
 * The whole page: each PR is listed once across every section and every expanded row; a chain's references point at
 * PRs another section lists; every heading equals what its section lists, and every row says how many PRs it counts.
 */
function assertPage(page: MorningPage) {
  const listed: string[] = [];
  for (const entry of page.next.items) listed.push(...entry.urls);
  for (const entry of page.decide) listed.push(entry.member.url);
  // A chain shows its whole stack, so it is exempt from "each PR once": a line for a PR another section lists links there.
  const also: { url: string; place: string }[] = [];
  const walk = (group: PersonGroup): number => {
    if (group.children) {
      const total = group.children.reduce((sum, child) => sum + walk(child), 0);
      assert.equal(group.urls.length, total, `${group.label}: the stacks' PRs`);
      assert.equal(group.lines.length, 0);
      return total;
    }
    const urls = group.lines.map((line) => line.member.url);
    listed.push(...urls);
    assert.deepEqual([...urls].sort(), [...group.urls].sort(), `${group.label}: its PRs are its lines`);
    if (group.chain) {
      assert.deepEqual(group.chain.filter((node) => !node.also).map((node) => node.line.member.url).sort(), [...urls].sort(), `${group.label}: its own chain lines are its PRs`);
      assert.equal(group.chain[0]?.line.status, 'next', `${group.label}: the base is first, and Next`);
      for (const { line, also: place } of group.chain) {
        // Every chain line is a full line: state, number, title, check state, status word and age.
        assert.ok(line.title && line.member.number && line.check.label && line.status && Number.isFinite(line.since), `${group.label}: #${line.member.number} is a full line`);
        if (place) also.push({ url: line.member.url, place });
      }
    }
    if (group.kind !== 'stack') assert.equal(shown(group), group.urls.length, `${group.label}: "${group.detail}" says how many PRs it lists`);
    for (const line of group.lines) assert.ok(line.check.label, 'every line has a check state');
    return urls.length;
  };
  const you = page.you.reduce((total, group) => total + walk(group), 0);
  const others = page.others.reduce((total, group) => total + walk(group), 0);
  assert.equal(new Set(listed).size, listed.length, `no PR appears twice: ${listed.filter((url, i) => listed.indexOf(url) !== i).join(', ')}`);
  const places = new Map<string, string>([
    ...page.next.items.flatMap((entry) => entry.urls.map((url) => [url, 'next'] as const)),
    ...page.decide.map((entry) => [entry.member.url, 'decide'] as const),
    ...page.you.flatMap((group) => group.urls.map((url) => [url, 'you'] as const)),
  ]);
  for (const { url, place } of also) assert.equal(places.get(url), place, `a chain line links to ${place} for ${url}, which lists it there`);
  // Next up: the heading is the rows shown. A row for several PRs says how many on the row, and leads with a PR
  // number like any other row; the quiet line keeps its own number, for merges no row lists.
  assert.equal(nextCount(page.next.items), page.next.items.length, 'Next up: heading = rows');
  assert.ok(page.next.items.length <= NEXT_LIMIT);
  for (const entry of page.next.items) {
    if (entry.urls.length > 1) assert.match(entry.why, new RegExp(`^${entry.urls.length} PRs · `), 'a stack row says how many PRs');
    else assert.doesNotMatch(entry.why, /^\d+ PRs · /, 'a row for one PR does not say "PRs"');
    assert.ok(entry.urls.includes(entry.member.url), `the row's number, #${entry.member.number}, is one of its PRs`);
  }
  const more = nextMoreLine(page.next);
  if (more) assert.match(more, new RegExp(`^${page.next.unreviewed.length || page.next.moreApproved.length} `), 'the quiet line says its own number');
  else assert.equal(page.next.unreviewed.length + page.next.moreApproved.length, 0);
  // One row per stack, carrying its one next step: never a merge of a stack you owe a review on.
  const stacks = page.next.items.map((entry) => entry.row.item.subject.id);
  assert.equal(new Set(stacks).size, stacks.length, 'at most one Next up row per stack');
  for (const entry of page.next.items)
    if (entry.kind === 'merge')
      assert.ok(!page.next.items.some((other) => (other.kind === 'review' || other.kind === 'rereview') && other.row.item.subject.id === entry.row.item.subject.id));
  assert.equal(sectionCount(page.you), you, 'Waiting on you: heading = rows');
  assert.equal(sectionCount(page.others), others, 'Waiting on others: heading = rows');
  // Waiting on you's note: where the PRs it does not list went.
  const note = waitingOnYouNote(you, page.youElsewhere);
  if (!you) assert.equal(note.text === 'Nobody is waiting on you.', page.youElsewhere.next.length + page.youElsewhere.decide.length === 0, `"${note.text}"`);
  assertBriefing(page);
  // Chains: the first PR is Next, every one after it Waiting (or Conflicts), never Ready.
  for (const group of page.others.flatMap((entry) => entry.children ?? []))
    for (const [i, node] of (group.chain ?? []).entries())
      if (node.kind === 'line') {
        assert.ok(i === 0 ? node.line.status === 'next' : node.line.status === 'waiting' || node.line.status === 'conflicts', `${group.label} #${node.line.member.number}: ${node.line.status}`);
        if (i > 0) assert.match(node.line.description, /, after #\d+$/);
      }
  for (const entry of [...page.next.items, ...page.decide]) assert.ok(entry.check.label);
  return page;
}
const page = (model: OverviewModel, status: Record<string, QueueSignals>, extra: Partial<Parameters<typeof nextUp>[0]> = {}) => assertPage(morningPage(input(model, status, extra)));

/**
 * Briefing = sections: every number in the briefing is the PRs the page lists for it, found here from the sections
 * themselves (the rows' kinds and reasons), not from the lanes the briefing reads.
 */
function assertBriefing(page: MorningPage) {
  const { briefing } = page;
  const chainLines = page.others.flatMap((group) => group.children ?? []).flatMap((stack) => (stack.chain ?? []).filter((node) => !node.also).map((node) => node.line));
  const lines = [...page.you, ...page.others].flatMap((group) => group.lines);
  const listed = new Set([...page.next.items.flatMap((entry) => entry.urls), ...page.decide.map((entry) => entry.member.url), ...lines.map((line) => line.id), ...chainLines.map((line) => line.id)]);
  const youLines = page.you.flatMap((group) => group.lines);
  const entryOf = (line: GroupLine) => line.row.entries.find((entry) => entry.member.url === line.id);
  const fixOf = (line: GroupLine) => (line.row.lane === 'fix' ? entryOf(line)?.reasons : undefined);
  const firstFix = (reasons: readonly string[] | undefined) => (!reasons ? undefined : reasons.includes('checks-failed') ? 'failing' : reasons.includes('conflicts') ? 'conflicts' : 'rebase');
  const fixRows = (reason: string) =>
    page.next.items.filter((entry) => entry.kind === 'fix').flatMap((entry) => entry.row.entries.filter((e) => entry.urls.includes(e.member.url) && firstFix(e.reasons) === reason).map((e) => e.member.url));
  const expected: Record<string, string[]> = {
    reviews: [...page.next.items.filter((entry) => entry.kind === 'review').flatMap((entry) => entry.urls), ...youLines.filter((line) => line.row.lane === 'review' && !line.row.reasons.includes('updated-since-review')).map((line) => line.id)],
    rereviews: [...page.next.items.filter((entry) => entry.kind === 'rereview').flatMap((entry) => entry.urls), ...youLines.filter((line) => line.row.lane === 'review' && line.row.reasons.includes('updated-since-review')).map((line) => line.id)],
    replies: [
      ...page.next.items.filter((entry) => entry.kind === 'reply' || entry.kind === 'changes').flatMap((entry) => entry.urls),
      ...youLines.filter((line) => line.row.lane === 'answer').map((line) => line.id),
      ...page.decide.filter((entry) => entry.row.lane === 'answer').map((entry) => entry.member.url),
    ],
    approved: [...page.next.items.filter((entry) => entry.kind === 'merge' && !entry.unreviewed).flatMap((entry) => entry.urls), ...page.next.moreApproved],
    unreviewed: [...page.next.items.filter((entry) => entry.kind === 'merge' && entry.unreviewed).flatMap((entry) => entry.urls), ...page.next.unreviewed],
    decide: page.decide.map((entry) => entry.member.url),
  };
  for (const reason of ['failing', 'conflicts', 'rebase'])
    expected[reason] = [...fixRows(reason), ...[...lines, ...chainLines].filter((line) => firstFix(fixOf(line)) === reason).map((line) => line.id)];
  const counted = new Map(briefing.counts.map((count) => [count.key, count]));
  for (const [key, urls] of Object.entries(expected)) {
    const count = counted.get(key as never);
    const want = [...new Set(urls)].sort();
    assert.deepEqual(count ? [...count.urls].sort() : [], want, `briefing "${key}" = the PRs the page lists for it: ${briefing.text}`);
    if (count) assert.equal(count.count, want.length);
  }
  for (const count of briefing.counts) {
    // The number in the words is the number of PRs; every PR it counts is on the page, in a row or on the quiet line.
    assert.ok(count.text === 'your reply' ? count.count === 1 : count.text.startsWith(`${count.count}`), `"${count.text}" says ${count.count}`);
    for (const url of count.urls) assert.ok(listed.has(url) || page.next.unreviewed.includes(url) || page.next.moreApproved.includes(url), `${count.key}: ${url} is on the page`);
    assert.ok(briefing.text.includes(count.text));
  }
  // The pointer under Waiting on you names the rows that hold its PRs.
  for (const entry of page.youElsewhere.next) assert.ok(page.next.items.some((item) => entry.urls.every((url) => item.urls.includes(url))));
}

void test('Next up: cheapest first, at most five, with a total; size orders but never excludes', () => {
  const ready = mine(1, { additions: 10, deletions: 2 });
  const pending = mine(2, { additions: 10, deletions: 2 });
  const replied = mine(3);
  const small = member(5, { requestedReviewers: [LOGIN], additions: 30, deletions: 10, author: 'sam' });
  const large = member(6, { requestedReviewers: [LOGIN], additions: 600, deletions: 100, author: 'maya' });
  const status: Record<string, QueueSignals> = {
    [ready.url]: { ...readySignals(ready), opinions: [{ url: 'r1', author: 'lena', state: 'APPROVED', submittedAt: iso(DAY), headSha: ready.headSha }] },
    // Approved and mergeable, but checks still running: not a merge yet.
    [pending.url]: { ...readySignals(pending), checks: { state: 'pending', passed: 0, total: 1 } },
    [replied.url]: signals(replied, { checks: 'success' }),
  };
  const items = [
    item([ready]),
    item([pending]),
    item([replied], { responses: { [replied.url]: { changesRequested: false, unresolvedThreads: 1, awaitingReply: 1, complete: true } } }),
    item([small]),
    item([large]),
  ];
  const few = nextUp(input(build(items, status), status, { replies: { [replied.url]: { author: 'owen', text: 'Could we keep the old loading order behind a flag until every plugin has migrated?' } } }));
  // People blocked on you first, cheapest first; then the approved merge, though it is cheaper.
  assert.deepEqual(few.items.map((entry) => [entry.kind, entry.member.number, entry.why, entry.rank]), [
    ['reply', 3, 'owen: “Could we keep the old loading order behind a flag until…”', 3],
    ['review', 5, '40 lines', 4],
    // 700 lines: not quick, but listed, after the smaller review.
    ['review', 6, '700 lines', 20],
    ['merge', 1, 'approved by lena · green', 1],
  ]);
  assert.ok(!few.items.some((entry) => /\bmin\b|\d h\+/.test(entry.why)), 'no time estimate in what a row says');
  assert.ok(!few.items.some((entry) => entry.member.number === 2), 'checks still running: not a merge yet');
  // More work than fits: five, cheapest first.
  const extra = Array.from({ length: 6 }, (_, i) => member(20 + i, { requestedReviewers: [LOGIN], additions: 10, deletions: 0, createdAt: iso((10 - i) * DAY) }));
  const { items: all } = nextUp(input(build([...items, ...extra.map((m) => item([m]))], status), status));
  assert.equal(all.length, NEXT_LIMIT, 'at most five');
  for (let i = 1; i < all.length; i++) assert.ok(NEXT_TIER[all[i - 1].kind] < NEXT_TIER[all[i].kind] || all[i - 1].rank <= all[i].rank, 'by tier, cheapest first within one');
  assert.equal(all.some((entry) => entry.member.number === 6), false, 'the large review waits for room; it is still in Waiting on you');
  const full = page(build([...items, ...extra.map((m) => item([m]))], status), status);
  assert.ok(full.you.some((group) => group.urls.includes(large.url)));
});

void test('the internal effort rank orders Next up, extended for large PRs', () => {
  assert.equal(effortRank('merge'), 1);
  assert.equal(effortRank('reply'), 3);
  assert.equal(effortRank('changes'), 15);
  assert.deepEqual([effortRank('fix', undefined, false, 'failing'), effortRank('fix', undefined, false, 'conflicts'), effortRank('fix', undefined, false, 'restack')], [10, 15, 5]);
  assert.equal(effortRank('rereview', undefined), 5, 'unknown size');
  assert.equal(effortRank('rereview', 120), 5);
  assert.equal(effortRank('review', 40), 4);
  assert.equal(effortRank('review', undefined), 8, 'unknown size counts as 200 lines');
  assert.equal(effortRank('review', 300, true), 7, 'an explanation takes a third off');
  assert.equal(effortRank('review', 1060), 25, 'a large review');
  assert.equal(effortRank('review', 2790), 55);
  assert.equal(effortRank('review', 4000), 75);
  assert.equal(quote('Short and `plain`.'), 'Short and plain.');
  assert.ok(quote('x '.repeat(100)).endsWith('…'));
  assert.ok(quote('word '.repeat(40)).length <= 61);
  assert.deepEqual(checkView([undefined]), { state: 'unknown', label: 'checking…', spoken: 'checks not read yet' });
});

void test('Next up is never empty while there is work, a merge nobody reviewed waits on the quiet line, and it says so when there is none', () => {
  const status: Record<string, QueueSignals> = {};
  const set = <T extends ReviewMember>(m: T, value: (m: T) => QueueSignals) => { status[m.url] = value(m); return m; };
  const broken = set(minePr('o/r', 1), failing);
  const onlyFix = page(build([item([broken])], status), status);
  assert.deepEqual(onlyFix.next.items.map((entry) => [entry.kind, entry.why, entry.rank]), [['fix', 'failing checks', 10]]);
  const huge = set(minePr('o/r', 2, { additions: 3000 }), noReview);
  const unreviewedOnly = page(build([item([huge])], status), status);
  assert.deepEqual(unreviewedOnly.next.items, [], 'a merge nobody reviewed is never a row');
  assert.equal(nextMoreLine(unreviewedOnly.next), '1 ready to merge without review');
  assert.equal(unreviewedOnly.briefing.text, '1 PR can merge without review.');
  const bigReview = pr('o/r', 3, { author: 'ivaremilsson', requestedReviewers: [LOGIN], additions: 2400, deletions: 300 });
  assert.deepEqual(page(build([item([bigReview])], status), status).next.items.map((entry) => [entry.kind, entry.rank]), [['review', 50]]);
  const changes = set(minePr('o/r', 4), (m) => signals(m, { checks: 'success', decision: 'CHANGES_REQUESTED', opinions: [{ id: '1', author: 'lena', state: 'CHANGES_REQUESTED' }] }));
  assert.deepEqual(page(build([item([changes])], status), status).next.items.map((entry) => [entry.kind, entry.why]), [['changes', 'lena requested changes']]);
  // A restack: one PR of a stack whose parent merged. The item names that PR, not the stack.
  const parent = minePr('o/r', 6, { merged: true, state: 'closed', headBranch: 'p6', title: 'Wallet balance API' });
  const child = set(minePr('o/r', 7, { baseBranch: 'p6', title: 'Wallet balance in the HUD' }), noReview);
  assert.deepEqual(page(build([item([parent, child])], status), status).next.items.map((entry) => [entry.kind, entry.title, entry.why, entry.rank]), [['fix', 'Wallet balance in the HUD', 'needs a restack', 5]]);
  // Nothing in Waiting on you, Fix or Merge: empty, and the page says "Nothing needs you right now."
  const waiting = set(minePr('o/r', 5, { requestedReviewers: ['lena'] }), (m) => signals(m, { checks: 'success' }));
  const idle = page(build([item([waiting])], status), status);
  assert.equal(idle.next.items.length, 0);
  assert.equal(idle.others.length, 1);
});

void test('a stacked PR waits for its base; the base merge is the next step and says what it unblocks', () => {
  const status: Record<string, QueueSignals> = {};
  const base = minePr('klang/launcher', 376, { title: 'STACK: EPIC', additions: 2400, deletions: 300, headBranch: 'epic' });
  const rest = [377, 378, 379].map((n, i) => minePr('klang/launcher', n, { baseBranch: i ? `feature-${n - 1}` : 'epic', additions: 400 }));
  for (const m of [base, ...rest]) status[m.url] = noReview(m);
  status[base.url] = approved(base);
  const model = build([stack([base, ...rest], 'epic', 'STACK: EPIC')], status);
  const result = page(model, status);
  assert.deepEqual(result.next.items.map((entry) => [entry.kind, entry.title, entry.why, entry.urls.length, entry.unblocks]), [['merge', 'STACK: EPIC', 'approved by lena · green · unblocks 3 PRs', 1, 3]]);
  assert.equal(nextMoreLine(result.next), undefined, 'the stacked PRs above it are not ready on their own');
  const stacks = result.others.find((group) => group.kind === 'stacks');
  const chain = must(stacks?.children?.[0]);
  assert.equal(must(chain.step).text, 'Merge #376 to unblock 3 PRs');
  assert.equal(must(chain.step).action, 'merge');
  // The base is in Next up: the chain still shows it as a full line, linked there, and the three PRs above it.
  assert.deepEqual(must(chain.chain).map((node) => `#${node.line.member.number} ${node.line.status} · ${node.line.description}${node.also ? ` · also ${node.also}` : ''}`), [
    '#376 next · #376, next, merges first. Merge #376 to unblock 3 PRs · also next',
    '#377 waiting · #377, waiting, after #376',
    '#378 waiting · #378, waiting, after #377',
    '#379 waiting · #379, waiting, after #378',
  ]);
  assert.equal(stacks?.detail, '3 PRs in 1 stack');
  // A base nobody reviewed is no row: the quiet line counts it, and its stack's button opens the PR instead of merging.
  status[base.url] = noReview(base);
  const unreviewed = page(build([stack([base, ...rest], 'epic', 'STACK: EPIC')], status), status);
  assert.deepEqual(unreviewed.next.items, []);
  assert.equal(nextMoreLine(unreviewed.next), '1 ready to merge without review');
  const step = must(unreviewed.others.find((group) => group.kind === 'stacks')?.children?.[0]?.step);
  assert.deepEqual([step.text, step.action, step.caveats], ['Merge #376 (not reviewed) to unblock 3 PRs', 'open', ['not reviewed']]);
});

void test('merges nobody reviewed are never rows: the quiet line under Next up counts every one', () => {
  const status: Record<string, QueueSignals> = {};
  const set = (m: ReviewMember, value: (m: ReviewMember) => QueueSignals) => { status[m.url] = value(m); return m; };
  const big = set(minePr('o/r', 11, { additions: 2000, updatedAt: iso(30 * 3_600_000) }), noReview);
  const small = [12, 13].map((n, i) => set(minePr('o/r', n, { updatedAt: iso((20 - i) * 3_600_000) }), noReview));
  const result = page(build([big, ...small].map((m) => item([m])), status), status);
  assert.deepEqual(result.next.items, [], 'the cheapest action is not a recommendation when nobody reviewed it');
  assert.equal(result.next.unreviewed.length, 3);
  assert.equal(nextMoreLine(result.next), '3 ready to merge without review');
  assert.ok(big.additions !== undefined && big.additions > QUICK_LINES);
  // Approved, passing merges are rows; the unreviewed ones stay on the quiet line, whatever the room.
  const approvedOnes = [21, 22].map((n) => set(minePr('o/r', n), (m) => approved(m)));
  const some = page(build([...approvedOnes, big, ...small].map((m) => item([m])), status), status);
  assert.deepEqual(some.next.items.map((entry) => [entry.kind, entry.member.number]), [['merge', 21], ['merge', 22]]);
  assert.equal(nextMoreLine(some.next), '3 ready to merge without review');
  assert.equal(some.briefing.text, '2 approved PRs can merge and 3 more can merge without review.');
  // More approved merges than fit: the quiet line counts the rest too.
  const many = [21, 22, 23, 24, 25, 26].map((n) => set(minePr('o/r', n), (m) => approved(m)));
  const full = page(build([...many, big, ...small].map((m) => item([m])), status), status);
  assert.equal(full.next.items.length, NEXT_LIMIT);
  assert.equal(nextMoreLine(full.next), '3 ready to merge without review · 1 more approved and ready to merge');
  assert.equal(nextMoreLine({ unreviewed: [], moreApproved: [] }), undefined);
});

void test('Next up by tier: people blocked on you, then approved merges, then fixes; effort, unblocks and age within one', () => {
  const status: Record<string, QueueSignals> = {};
  const set = (m: ReviewMember, value: (m: ReviewMember) => QueueSignals) => { status[m.url] = value(m); return m; };
  const merge = set(minePr('o/r', 1), (m) => approved(m));
  const unreviewed = set(minePr('o/r', 2), noReview);
  const restack = { parent: minePr('o/r', 3, { merged: true, state: 'closed', headBranch: 'p3' }), child: set(minePr('o/r', 4, { baseBranch: 'p3' }), noReview) };
  const broken = set(minePr('o/r', 5), failing);
  const review = pr('o/r', 6, { author: 'lena', requestedReviewers: [LOGIN], additions: 1200, createdAt: iso(2 * DAY) });
  // A failing base that unblocks two, and a lone failing PR that is older: the base comes first.
  const base = set(minePr('o/s', 7, { headBranch: 'b7', updatedAt: iso(DAY) }), failing);
  const above = [8, 9].map((n, i) => set(minePr('o/s', n, { baseBranch: i ? 'b8' : 'b7', headBranch: `b${n}` }), noReview));
  const older = set(minePr('o/r', 10, { updatedAt: iso(3 * DAY) }), failing);
  const items = [item([merge]), item([unreviewed]), item([restack.parent, restack.child]), item([broken]), item([review]), stack([base, ...above], 'b7'), item([older])];
  const result = page(build(items, status), status);
  assert.deepEqual(result.next.items.map((entry) => [entry.kind, entry.member.number]), [['review', 6], ['merge', 1], ['fix', 4], ['fix', 7], ['fix', 10]]);
  // The large review (effort 30) still leads the approved merge (effort 1): someone is blocked on you.
  assert.ok(must(result.next.items[0]).rank > must(result.next.items[1]).rank);
  // Within fixes: the cheapest first (rebasing), then the base that unblocks two before the older lone PR.
  assert.deepEqual(result.next.items.slice(2).map((entry) => [entry.rank, entry.unblocks ?? 0]), [[5, 0], [10, 2], [10, 0]]);
  assert.ok(!result.next.items.some((entry) => entry.urls.includes(unreviewed.url)), 'no unreviewed merge is a row');
  assert.deepEqual(result.next.unreviewed, [unreviewed.url]);
  assert.deepEqual(Object.entries(NEXT_TIER).sort(), [['changes', 1], ['fix', 3], ['merge', 2], ['reply', 1], ['rereview', 1], ['review', 1]]);
});

void test('the oldest review request always gets a slot, whatever its size', () => {
  const status: Record<string, QueueSignals> = {};
  const merges = [1, 2, 3, 4, 5, 6, 7].map((n) => {
    const m = minePr('o/r', n);
    status[m.url] = approved(m);
    return m;
  });
  const older = pr('klang/seed', 40, { author: 'zsolt-klang', requestedReviewers: [LOGIN], createdAt: iso(14 * DAY), additions: 1800, deletions: 200 });
  const newer = pr('klang/launcher', 41, { author: 'ivaremilsson', requestedReviewers: [LOGIN], createdAt: iso(4 * DAY), additions: 30, deletions: 5 });
  // Five small requests that are newer, and cheaper: the oldest, large one still takes the last slot.
  const newest = [42, 43, 44, 45].map((n) => pr('klang/launcher', n, { author: 'sam', requestedReviewers: [LOGIN], createdAt: iso(DAY), additions: 20, deletions: 2 }));
  const result = page(build([...merges.map((m) => item([m])), item([older]), item([newer]), ...newest.map((m) => item([m]))], status), status);
  assert.equal(result.next.items.length, NEXT_LIMIT);
  assert.ok(result.next.items.some((entry) => entry.member.number === 40), 'the oldest takes the last slot');
  assert.equal(result.next.items.at(-1)?.member.number, 40, 'and keeps its place by effort');
  assert.equal(result.next.items.filter((entry) => entry.kind === 'merge').length, 0, 'people blocked on you fill Next up first');
  // The rest stay in Waiting on you; the ones in Next up are not listed there again.
  assert.equal(sectionCount(result.you), 1);
});

void test('waiting on you groups people by their oldest wait, and team requests last', () => {
  const lena1 = member(1, { author: 'lena', requestedReviewers: [LOGIN], createdAt: iso(2 * DAY) });
  const lena2 = member(2, { author: 'lena', requestedReviewers: [LOGIN], createdAt: iso(4 * DAY) });
  const sam = member(3, { author: 'sam', requestedReviewers: [LOGIN], createdAt: iso(DAY) });
  const team = member(4, { author: 'maya', role: 'review-requested', createdAt: iso(3 * DAY) });
  const replied = mine(5);
  const status: Record<string, QueueSignals> = {
    [replied.url]: { ...signals(replied, { checks: 'success' }), activity: { recent: [{ kind: 'comment', id: 'c', at: iso(5 * DAY), author: 'owen', automated: false }] } },
  };
  const model = build([item([lena1]), item([lena2]), item([sam]), item([team]), item([replied], { responses: { [replied.url]: { changesRequested: false, unresolvedThreads: 1, awaitingReply: 1, complete: true } } })], status, T0, true);
  const groups = waitingOnYou(input(model, status));
  assert.deepEqual(groups.map((group) => [group.label, group.detail]), [
    ['owen', '1 PR · oldest 5 d'],
    ['lena', '2 PRs · oldest 4 d'],
    ['sam', '1 PR · oldest 1 d'],
    ['team', '1 review request'],
  ]);
  assert.deepEqual(groups[1].lines.map((line) => line.member.number), [2, 1], 'oldest first');
  // On the page, Next up takes all five (they fit), and Waiting on you lists none of them again. The tab counts each once.
  const result = page(model, status);
  assert.equal(result.next.items.length, 5);
  assert.equal(sectionCount(result.you), 0);
  assert.equal(result.count, 5, 'each PR once, across Next up and Waiting on you');
});

void test('Waiting on you counts what it lists: a stack is its PRs, and team and unassigned requests are rows', () => {
  // The real report: "Waiting on you 7" over two people. zsolt-klang's stack of five PRs counted five.
  const zsolt = [1, 2, 3, 4, 5].map((n) => pr('klang/seed', n, { author: 'zsolt-klang', requestedReviewers: [LOGIN], createdAt: iso(14 * DAY), baseBranch: n > 1 ? `feature-${n - 1}` : 'main' }));
  const ivar = pr('klang/launcher', 6, { author: 'ivaremilsson', requestedReviewers: [LOGIN], createdAt: iso(4 * DAY), additions: 600 });
  const team = pr('klang/web', 7, { author: 'maya', role: 'review-requested', createdAt: iso(3 * DAY) });
  const replied = minePr('klang/web', 8);
  const status: Record<string, QueueSignals> = { [replied.url]: signals(replied, { checks: 'success' }) };
  const items = [stack(zsolt), item([ivar]), item([team]), item([replied], { responses: { [replied.url]: { changesRequested: false, unresolvedThreads: 1, awaitingReply: 1, complete: true } } })];
  const model = build(items, status, T0, true);
  const you = waitingOnYou(input(model, status));
  assert.deepEqual(you.map((group) => [group.label, group.detail]), [
    ['zsolt-klang', '5 PRs · oldest 14 d'],
    ['ivaremilsson', '1 PR · oldest 4 d'],
    ['unassigned', '1 PR · oldest 1 h'],
    ['team', '1 review request'],
  ]);
  assert.equal(sectionCount(you), 8);
  assert.deepEqual(you[0].repos, ['klang/seed']);
  assert.match(overviewBriefing(model), /7 reviews are waiting on you\./, 'five from zsolt-klang, one from ivaremilsson, one team request');
  // Five approved merges do not push them out: people blocked on you come first, and one merge fills the last slot.
  const filled = build([...fillers(status), ...items], status, T0, true);
  const result = page(filled, status);
  assert.ok(result.next.items.some((entry) => entry.urls.includes(zsolt[0].url) && entry.why.startsWith('5 PRs · ')));
  assert.deepEqual(result.next.items.map((entry) => entry.kind), ['reply', 'review', 'review', 'review', 'merge']);
  assert.deepEqual(result.you, []);
  assert.equal(result.count, 9, 'the tab: the PRs in Next up and Waiting on you, each once (eight waiting on you, and the merge)');
});

void test('waiting on others: stacks as chains, reviewers with Nudge, teams, CI, and you, each PR once', () => {
  const lena = mine(1, { requestedReviewers: ['lena'], createdAt: iso(4 * DAY) });
  const both = mine(2, { requestedReviewers: ['lena', 'sam'], createdAt: iso(2 * DAY) });
  const team = mine(3, { requestedTeams: ['klang/web'], createdAt: iso(DAY) });
  const ci = mine(4);
  const base = mine(5, { headBranch: 'b1' });
  const top = mine(6, { baseBranch: 'b1' });
  const broken = mine(7);
  const conflict = mine(8);
  const status: Record<string, QueueSignals> = {
    [lena.url]: signals(lena, { checks: 'success' }),
    [both.url]: signals(both, { checks: 'success' }),
    [team.url]: signals(team, { checks: 'success' }),
    [ci.url]: signals(ci, { checks: 'pending', decision: 'APPROVED' }),
    [base.url]: failing(base),
    [top.url]: readySignals(top),
    [broken.url]: failing(broken),
    [conflict.url]: conflicted(conflict),
  };
  const model = build([...fillers(status), item([lena]), item([both]), item([team]), item([ci]), item([base, top]), item([broken]), item([conflict])], status);
  const result = page(model, status);
  const groups = result.others;
  assert.deepEqual(groups.map((group) => [group.kind, group.label, group.detail]), [
    // #2 waits on lena and sam: it is listed once, under the first reviewer GitHub names.
    ['person', 'lena', '2 PRs · 4 d'],
    ['team', 'klang/web', '1 PR · 1 d'],
    ['ci', 'CI', '1 running'],
    // #6 waits for #5, which is yours and failing: the chain lists both, base first, and says so.
    ['stacks', 'Waiting for earlier PRs in a stack to merge', '2 PRs in 1 stack'],
    ['you', 'you', '1 failing check, 1 conflict'],
  ]);
  const chain = must(groups[3].children?.[0]);
  assert.equal(must(chain.step).text, '#5 has failing checks');
  // #6 is approved and green, but waits for #5: "Waiting", with its check state beside it.
  assert.deepEqual(chain.lines.map((line) => [line.member.number, line.status, line.check.label]), [[5, 'next', 'failing'], [6, 'waiting', 'passing']]);
  assert.equal(chain.lines[1].description, '#6, waiting, after #5');
  assert.deepEqual(groups[0].nudge?.members.map((m) => m.number), [1, 2]);
  assert.equal(groups[1].nudge, undefined, 'teams are not nudged');
  assert.equal(groups[0].check?.label, 'passing', 'a person row shows its PRs’ checks together');
  // Nudge: one requested-reviewers write per PR, after a confirmation that names them.
  assert.deepEqual(nudgeRequests(groups[0]), [
    { prUrl: lena.url, action: 'nudge', reviewer: 'lena' },
    { prUrl: both.url, action: 'nudge', reviewer: 'lena' },
  ]);
  assert.deepEqual(nudgeConfirmation(groups[0]), {
    title: 'Nudge lena?',
    body: 'Gnosis asks GitHub to request lena’s review again on PRs #1, #2. GitHub notifies lena.',
    action: 'Re-request 2 reviews',
  });
  assert.equal(nudgeConfirmation({ nudge: { reviewer: 'sam', members: [both] } }).action, 'Re-request review');
  assert.deepEqual(nudgeRequests(groups[2]), []);
});

void test('You: each PR has its own reason, failing first, then conflicts and restacks', () => {
  const status: Record<string, QueueSignals> = {};
  const broken = minePr('o/r', 7);
  const conflict = minePr('o/r', 8);
  const parent = minePr('o/r', 9, { merged: true, state: 'closed', headBranch: 'p9' });
  const child = minePr('o/r', 10, { baseBranch: 'p9' });
  status[broken.url] = failing(broken);
  status[conflict.url] = conflicted(conflict);
  status[child.url] = noReview(child);
  const result = page(build([...fillers(status), item([broken]), item([conflict]), item([parent, child])], status), status);
  const you = must(result.others.find((group) => group.kind === 'you'));
  assert.equal(you.detail, '1 failing check, 1 conflict, 1 restack');
  assert.deepEqual(you.lines.map((line) => [line.member.number, line.reason, line.description, line.check.label]), [
    [7, 'failing', '#7, failing checks', 'failing'],
    [8, 'conflicts', '#8, conflicts', 'passing'],
    [10, 'restack', '#10, restack needed', 'passing'],
  ]);
});

void test('stacks: one chain per stack, keyed by repository and number, the most actionable first, each PR once', () => {
  const status: Record<string, QueueSignals> = {};
  const set = (m: ReviewMember, value: QueueSignals) => { status[m.url] = value; return m; };
  // Launcher i18n: a failing base and three PRs above it, listed twice in the queue.
  const i18n = [set(minePr('klang/launcher', 380, { title: 'Move the launcher text into keys' }), failing(minePr('klang/launcher', 380)))];
  for (const n of [381, 382, 383]) i18n.push(set(minePr('klang/launcher', n, { baseBranch: `feature-${n - 1}` }), noReview(minePr('klang/launcher', n))));
  // #384 in two repositories: one ready to merge, one waiting on lena.
  const launcher384 = [set(minePr('klang/launcher', 384, { title: 'Launcher: read the language' }), approved(minePr('klang/launcher', 384)))];
  for (const n of [385, 386]) launcher384.push(set(minePr('klang/launcher', n), noReview(minePr('klang/launcher', n))));
  const web384 = [set(minePr('klang/web', 384, { title: 'Web: language picker', requestedReviewers: ['lena'] }), signals(minePr('klang/web', 384), { checks: 'success' }))];
  for (const n of [385, 386]) web384.push(set(minePr('klang/web', n), noReview(minePr('klang/web', n))));
  // A base waiting on checks.
  const ci = [set(minePr('acme/api', 10, { title: 'API base 10' }), signals(minePr('acme/api', 10), { checks: 'pending', decision: 'APPROVED' }))];
  ci.push(set(minePr('acme/api', 11), noReview(minePr('acme/api', 11))));
  const items = [...fillers(status), stack(i18n, 'i18n', 'Launcher i18n'), stack(i18n, 'i18n-again', 'Launcher i18n'), stack(launcher384), stack(web384), stack(ci)];
  const result = page(build(items, status), status);
  const stacks = result.others.find((group) => group.kind === 'stacks');
  assert.ok(stacks);
  const byKey = Object.fromEntries((stacks.children ?? []).map((child) => [child.key, child]));
  assert.deepEqual(Object.keys(byKey).sort(), ['stack:acme/api#10', 'stack:klang/launcher#380', 'stack:klang/launcher#384', 'stack:klang/web#384']);
  // The base can merge, or needs you, first; then those waiting on others.
  assert.deepEqual(must(stacks.children).map((child) => must(child.step).text), [
    'Merge #384 to unblock 2 PRs',
    '#380 has failing checks',
    '#384 waits on review from lena',
    '#10 is waiting on checks',
  ]);
  assert.deepEqual(must(stacks.children).map((child) => must(child.step).action), ['merge', 'open', 'nudge', 'open']);
  // Listed twice in the queue, one chain; named by the stack.
  assert.equal(byKey['stack:klang/launcher#380'].label, 'Launcher i18n');
  assert.deepEqual(byKey['stack:klang/launcher#380'].lines.map((line) => [line.member.number, line.status]), [[380, 'next'], [381, 'waiting'], [382, 'waiting'], [383, 'waiting']]);
  assert.deepEqual(byKey['stack:acme/api#10'].lines.map((line) => [line.member.number, line.status, line.check.label]), [[10, 'next', 'running'], [11, 'waiting', 'passing']]);
  assert.equal(stacks.detail, `${stacks.urls.length} PRs in 4 stacks`);
});

void test('the screenshot-32 shape: Next up is full, each PR once, and the line under it is worded for what it lists', () => {
  const status: Record<string, QueueSignals> = {};
  const set = (m: ReviewMember, value: (m: ReviewMember) => QueueSignals) => { status[m.url] = value(m); return m; };
  // Seven review requests: one small from zsolt-klang, six large or stacked from ivaremilsson.
  const zsolt = pr('klang/seed', 36990, { author: 'zsolt-klang', requestedReviewers: [LOGIN], createdAt: iso(14 * DAY), additions: 96, deletions: 21 });
  const ivarLarge = [391, 392, 393].map((n) => pr('klang/seed', n, { author: 'ivaremilsson', requestedReviewers: [LOGIN], createdAt: iso(4 * DAY), additions: 840, deletions: 220 }));
  const ivarStack = [394, 395, 396].map((n, i) => pr('klang/seed', n, { author: 'ivaremilsson', requestedReviewers: [LOGIN], createdAt: iso(3 * DAY), additions: 260, baseBranch: i ? `feature-${n - 1}` : 'main' }));
  // Six merges nobody reviewed, all large or stacked: three large, and three stacks whose base can merge.
  const large = [610, 611, 612].map((n) => set(minePr('klang/launcher', n, { additions: 1600 }), noReview));
  const bases = [376, 383, 35392].map((n) => set(minePr('klang/launcher', n, { title: `Base ${n}`, headBranch: `b${n}` }), noReview));
  const above = bases.map((base, s) => [1, 2, 3].slice(0, s === 2 ? 2 : 3).map((k) => set(minePr('klang/launcher', base.number + k, { baseBranch: k === 1 ? `b${base.number}` : `feature-${base.number + k - 1}` }), noReview)));
  // Four PRs that need a decision and also fail or conflict.
  const stale = { createdAt: iso(14 * DAY), updatedAt: iso(12 * DAY) };
  const decide = [
    set(minePr('klang/launcher', 700, { title: 'feat: new launcher app icon', ...stale }), failing),
    set(minePr('klang/seed', 701, { title: 'feat: serve in-game notifications from seed-api', ...stale }), conflicted),
    set(minePr('klang/seed', 702, { title: 'fix: keep each sender’s failed command to itself', requestedReviewers: ['plucked'], ...stale }), conflicted),
    set(minePr('klang/launcher', 379, { title: 'feat: move the launcher’s text into translation keys (i18n 1/3)', headBranch: 'i18n-1', ...stale }), failing),
  ];
  const i18nAbove = [1, 2, 3, 4].map((k) => set(minePr('klang/launcher', 1379 + k, { baseBranch: k === 1 ? 'i18n-1' : `feature-${1379 + k - 1}` }), noReview));
  const items = [
    item([zsolt]), ...ivarLarge.map((m) => item([m])), stack(ivarStack),
    ...large.map((m) => item([m])), ...bases.map((base, s) => stack([base, ...above[s]])),
    ...decide.slice(0, 3).map((m) => item([m])), stack([decide[3], ...i18nAbove], 'i18n', 'Launcher i18n'),
  ];
  const model = build(items, status);
  assert.match(overviewBriefing(model), /^7 reviews are waiting on you\./);
  const result = page(model, status);
  assert.equal(result.next.items.length, NEXT_LIMIT, 'never empty');
  assert.ok(result.next.items.some((entry) => entry.urls.includes(zsolt.url)), 'the oldest review request has its slot');
  assert.ok(!result.next.items.some((entry) => entry.kind === 'merge'), 'six merges nobody reviewed: none is a row');
  assert.equal(nextMoreLine(result.next), '6 ready to merge without review');
  // The decisions are listed once, in Needs a decision, not again under You or in their stack.
  assert.deepEqual(result.decide.map((entry) => entry.member.number).sort(), [379, 700, 701, 702]);
  const you = result.others.find((group) => group.kind === 'you');
  assert.ok(!you || !you.urls.some((url) => decide.some((m) => m.url === url)));
  const i18n = must(result.others.find((group) => group.kind === 'stacks')?.children?.find((child) => child.key === 'stack:klang/launcher#379'));
  // The chain still shows its base as a full line, with a link down to Needs a decision; it does not count it.
  const base = must(i18n.chain)[0];
  assert.deepEqual([base.line.member.number, base.line.status, base.also], [379, 'next', 'decide'], 'the base is a full line that links to Needs a decision');
  assert.ok(!i18n.urls.includes(base.line.member.url), 'the stack does not count its base twice');
  assert.equal(must(i18n.step).text, '#379 has failing checks');
});

/**
 * Screenshot 36: one stack whose base you can merge without review, with two more of your PRs and six of ivar's
 * above it that changed since your review; a lone re-review; six merges nobody reviewed; and every review request
 * landing in Next up. Next up said "10" over five rows, offered both "Merge #35392" and a re-review of the same
 * stack, and Waiting on you said "Nobody is waiting on you." under a briefing of "7 reviews are waiting on you".
 */
function screenshot36() {
  const status: Record<string, QueueSignals> = {};
  const set = (m: ReviewMember, value: (m: ReviewMember) => QueueSignals) => { status[m.url] = value(m); return m; };
  const seed = 'klang/seed';
  const base = set(minePr(seed, 35392, { title: 'feat: add the market and create_seedling mcp tools to seed-api', headBranch: 'b35392', additions: 410 }), noReview);
  const own = [37378, 37578].map((n, i) => set(minePr(seed, n, { headBranch: `b${n}`, baseBranch: i ? 'b37378' : 'b35392' }), noReview));
  const theirs = [1, 2, 3, 4, 5, 6].map((k) => pr(seed, 37600 + k, { author: 'ivaremilsson', headBranch: `b${37600 + k}`, baseBranch: k === 1 ? 'b37578' : `b${37600 + k - 1}`, additions: 30 }));
  const market = { ...stack([base, ...own, ...theirs], 'market', 'feat: add the market and create_seedling mcp tools to seed-api'), attention: 'updated' as const };
  // A lone re-review, and a stack of yours whose base can merge.
  const lone = pr('klang/seed-launcher', 377, { author: 'ivaremilsson', title: 'feat: block launches until the player accepts the terms', additions: 60 });
  const epic = set(minePr('klang/seed-launcher', 376, { title: 'refactor: model the store distribution channel', headBranch: 'b376' }), noReview);
  const epicRest = [382, 378, 385].map((n, i) => set(minePr('klang/seed-launcher', n, { headBranch: `b${n}`, baseBranch: i ? `b${[382, 378][i - 1]}` : 'b376' }), noReview));
  // Six merges nobody reviewed, all large.
  const large = [610, 611, 612, 613, 614, 615].map((n) => set(minePr('klang/seed-launcher', n, { additions: 1600 }), noReview));
  const items = [market, item([lone], { attention: 'updated' }), stack([epic, ...epicRest], 'epic', 'STACK: EPIC'), ...large.map((m) => item([m]))];
  return { status, base, own, theirs, lone, epic, large, model: build(items, status) };
}

void test('screenshot 36: Next up counts its rows, and a row for a stack says how many PRs', () => {
  const { status, model, theirs, lone } = screenshot36();
  const result = page(model, status, { rereviewLines: { [lone.url]: 12 } });
  assert.equal(nextCount(result.next.items), result.next.items.length);
  const stackRow = must(result.next.items.find((entry) => entry.urls.length > 1));
  assert.equal(stackRow.kind, 'rereview');
  // The stack row leads with the first PR of the six that needs you, like every other row.
  assert.equal(stackRow.member.number, theirs[0].number);
  assert.equal(stackRow.why, '6 PRs · updated since your review · then merge #35392');
  assert.ok(nextCount(result.next.items) < result.next.items.reduce((total, entry) => total + entry.urls.length, 0), 'the heading is not the PRs inside the rows');
  // The quiet line keeps its own number: the merges nobody reviewed that no row lists.
  assert.equal(nextMoreLine(result.next), '8 ready to merge without review', 'six large merges, #376, and #35392, which waits for the re-review');
});

void test('a stack you owe a re-review on never also offers its base merge, and has one row in Next up', () => {
  const { status, model, base } = screenshot36();
  const result = page(model, status);
  const market = result.next.items.filter((entry) => entry.row.item.subject.id === 'market');
  assert.deepEqual(market.map((entry) => entry.kind), ['rereview'], 'one row: the re-review, not "Merge #35392" too');
  assert.ok(!result.next.items.some((entry) => entry.kind === 'merge' && entry.member.url === base.url));
  // Waiting on others names the same single step: the re-review first, then the merge. No Merge button.
  const chain = must(result.others.find((group) => group.kind === 'stacks')?.children?.find((child) => child.key === 'stack:klang/seed#35392'));
  assert.equal(must(chain.step).action, 'review');
  assert.equal(must(chain.step).text, 'Re-review 6 PRs first, then merge #35392');
  assert.deepEqual(must(chain.chain).map((node) => `#${node.line.member.number} ${node.line.status}${node.also ? ` also ${node.also}` : ''}`), ['#35392 next', '#37378 waiting', '#37578 waiting']);
  // A stack with a review request on its base: the same rule.
  const status2: Record<string, QueueSignals> = {};
  const mineBase = minePr('o/s', 1, { headBranch: 'b1' });
  status2[mineBase.url] = noReview(mineBase);
  const requested = pr('o/s', 2, { author: 'lena', requestedReviewers: [LOGIN], baseBranch: 'b1', headBranch: 'b2' });
  const two = page(build([stack([mineBase, requested], 'mixed')], status2), status2);
  assert.deepEqual(two.next.items.map((entry) => [entry.kind, entry.member.number, entry.why]), [['review', 2, '50 lines · then merge #1']]);
  // Without a review owed, the base merge is the stack's one row.
  const status3: Record<string, QueueSignals> = {};
  const lone = minePr('o/t', 1, { headBranch: 'b1' });
  const child = minePr('o/t', 2, { baseBranch: 'b1' });
  status3[lone.url] = approved(lone);
  status3[child.url] = failing(child);
  const three = page(build([stack([lone, child], 'own')], status3), status3);
  assert.deepEqual(three.next.items.map((entry) => [entry.kind, entry.member.number]), [['merge', 1]], 'one row per stack: its first step');
  // A base nobody reviewed is no row: the stack's fix is.
  status3[lone.url] = noReview(lone);
  const four = page(build([stack([lone, child], 'own')], status3), status3);
  assert.deepEqual(four.next.items.map((entry) => [entry.kind, entry.member.number]), [['fix', 2]]);
});

void test('Waiting on you says where its PRs went, and agrees with the briefing', () => {
  const { status, model, lone } = screenshot36();
  const briefing = overviewBriefing(model);
  assert.match(briefing, /^7 reviews are waiting on you\./);
  const result = page(model, status, { rereviewLines: { [lone.url]: 12 } });
  // All seven reviews are in Next up, so Waiting on you lists none, and says so.
  assert.equal(sectionCount(result.you), 0);
  assert.deepEqual(result.youElsewhere.next.map((entry) => `${entry.label}:${entry.urls.length}`).sort(), ['#37601’s stack (6 PRs):6', '#377:1']);
  assert.match(waitingOnYouNote(0, result.youElsewhere).text, /^(#377 and #37601’s stack \(6 PRs\)|#37601’s stack \(6 PRs\) and #377) are in Next up\.$/);
  // The briefing's numbers are the PRs Waiting on you lists plus those listed above and below it.
  assert.equal(result.briefing.text, '7 re-reviews (6 in one stack) are waiting on you. 8 PRs can merge without review.');
  const reviews = result.briefing.counts.filter((count) => count.key === 'reviews' || count.key === 'rereviews').reduce((total, count) => total + count.count, 0);
  assert.equal(reviews, sectionCount(result.you) + result.youElsewhere.next.reduce((total, entry) => total + entry.urls.length, 0) + result.youElsewhere.decide.length);
  void briefing;
  assert.equal(result.count, new Set([...result.next.items.flatMap((entry) => entry.urls), ...result.you.flatMap((group) => group.urls)]).size, 'the tab counts PRs, each once');
  // The words for every case: concrete pointers, never "All 7".
  const at = (label: string, n = 1) => ({ label, urls: Array.from({ length: n }, (_, i) => `${label}/${i}`) });
  assert.equal(waitingOnYouNote(0, { next: [], decide: [] }).text, 'Nobody is waiting on you.');
  assert.equal(waitingOnYouNote(0, { next: [at('#377')], decide: [] }).text, '#377 is in Next up.');
  assert.equal(waitingOnYouNote(0, { next: [at('#37286’s stack (6 PRs)', 6)], decide: [] }).text, '#37286’s stack (6 PRs) are in Next up.');
  assert.equal(waitingOnYouNote(0, { next: [], decide: ['a', 'b'] }).text, '2 are in Needs a decision.');
  assert.equal(waitingOnYouNote(0, { next: [at('#377'), at('#12')], decide: ['a', 'b'] }).text, '#377 and #12 are in Next up, and 2 are in Needs a decision.');
  assert.equal(waitingOnYouNote(3, { next: [at('#1'), at('#2'), at('#3'), at('#4')], decide: [] }).text, '#1, #2 and 2 more are in Next up.');
  assert.equal(waitingOnYouNote(3, { next: [], decide: [] }).text, '');
  // Each pointer is a link to the rows it names.
  const links = waitingOnYouNote(0, { next: [at('#377')], decide: ['x'] }).parts.filter((part) => typeof part !== 'string');
  assert.deepEqual(links.map((link) => typeof link !== 'string' && [link.place, link.urls]), [['next', ['#377/0']], ['decide', ['x']]]);
});

void test('needs a decision: failing, never approved or idle for over a week, one reason each, oldest first', () => {
  const broken = mine(1, { updatedAt: iso(9 * DAY) });
  const brokenNew = mine(2, { updatedAt: iso(2 * DAY) });
  const unapproved = mine(3, { createdAt: iso(10 * DAY), updatedAt: iso(4 * DAY) });
  const idle = mine(4, { requestedReviewers: ['lena'], createdAt: iso(20 * DAY), updatedAt: iso(8 * DAY) });
  const busy = mine(5, { requestedReviewers: ['lena'], updatedAt: iso(DAY) });
  const status: Record<string, QueueSignals> = {
    [broken.url]: failing(broken),
    [brokenNew.url]: failing(brokenNew),
    [unapproved.url]: signals(unapproved, { checks: 'success', decision: '', mergeState: 'CLEAN' }),
    [idle.url]: signals(idle, { checks: 'success' }),
    [busy.url]: signals(busy, { checks: 'success' }),
  };
  const model = build([item([broken]), item([brokenNew]), item([unapproved]), item([idle]), item([busy])], status);
  const decisions = needsDecision(input(model, status));
  assert.deepEqual(decisions.map((entry) => [entry.member.number, entry.reason, entry.label, entry.check.label]), [
    [3, 'unapproved', 'Never approved', 'passing'],
    [1, 'failing', 'Failing checks', 'failing'],
    [4, 'idle', 'Idle', 'passing'],
  ]);
  // On the page: the failing PR that needs a decision ranks after the fresh one in Next up, and stays a decision.
  const result = page(model, status);
  assert.deepEqual(result.next.items.map((entry) => entry.member.number), [2, 1]);
  assert.deepEqual(result.decide.map((entry) => entry.member.number), [3, 4]);
});

void test('Close PR: the request carries the confirmed revision and an optional comment; the confirmation says it can be reopened', () => {
  const state = { account: LOGIN, url: 'https://github.com/o/r/pull/9', headSha: 'h', baseSha: 'b', baseBranch: 'main' };
  assert.deepEqual(closeRequest(state, '  '), { account: LOGIN, kind: 'close', url: state.url, revisions: [{ url: state.url, headSha: 'h', baseSha: 'b', baseBranch: 'main' }] });
  assert.equal(closeRequest(state, ' Superseded by #12. ').comment, 'Superseded by #12.');
  const words = closeConfirmation({ number: 9, title: 'Old idea', repo: 'o/r' });
  assert.equal(words.title, 'Close #9?');
  assert.match(words.body, /reopen it on GitHub/);
  const open = { archived: false, state: 'OPEN', canChangeDraft: true } as PrActionState;
  assert.equal(closeBlockedReason(open), undefined);
  assert.match(closeBlockedReason({ ...open, canChangeDraft: false }) ?? '', /author or someone with write permission/);
  assert.match(closeBlockedReason({ ...open, state: 'CLOSED' }) ?? '', /already closed/);
  assert.match(closeBlockedReason({ ...open, archived: true }) ?? '', /archived/);
});

void test('since yesterday: events from notifications and sync, aggregated once per PR, in one short line', () => {
  const base = { title: 'T', repo: 'o/r', number: 1, at: T0 - 5 * 3_600_000 };
  const events = sinceEventsFromNotifications([
    { ...base, type: 'review-requested', key: 'requested|u1|1', url: 'https://github.com/o/r/pull/1' },
    { ...base, type: 'team-review-requested', key: 'team|u2|1', url: 'https://github.com/o/r/pull/2' },
    { ...base, type: 'reply', key: 'reply|c1', url: 'https://github.com/o/r/pull/3', actor: 'lena' },
    { ...base, type: 'mention', key: 'mention|c2', url: 'https://github.com/o/r/pull/4', actor: 'owen' },
    { ...base, type: 'reply', key: 'reply|c3', url: 'https://github.com/o/r/pull/4', actor: 'dependabot', actorIsBot: true },
    { ...base, type: 'checks-failed', key: 'checks-failed|u5|h', url: 'https://github.com/o/r/pull/5', mine: true },
    { ...base, type: 'checks-failed', key: 'checks-failed|u6|h', url: 'https://github.com/o/r/pull/6' },
    { ...base, type: 'approved', key: 'review|x', url: 'https://github.com/o/r/pull/7' },
  ] as NotificationEvent[]);
  assert.deepEqual(events.map((event) => [event.type, event.actor ?? '']), [
    ['review-requested', ''], ['review-requested', ''], ['reply', 'lena'], ['reply', 'owen'], ['reply', ''], ['checks-red', ''],
  ]);
  const sync: SinceEvent[] = [
    { type: 'merged', key: 'merged|8', url: 'https://github.com/o/r/pull/8', at: T0 - 2 * 3_600_000 },
    // Red, then green: counts once, as green.
    { type: 'checks-red', key: 'red|9', url: 'https://github.com/o/r/pull/9', at: T0 - 6 * 3_600_000 },
    { type: 'checks-green', key: 'green|9', url: 'https://github.com/o/r/pull/9', at: T0 - 3 * 3_600_000 },
    // Before the last visit: left out.
    { type: 'merged', key: 'merged|10', url: 'https://github.com/o/r/pull/10', at: T0 - 30 * 3_600_000 },
  ];
  const log = appendSinceEvents(appendSinceEvents([], events, T0), [...sync, ...events], T0);
  assert.equal(log.length, events.length + sync.length, 'each key once');
  const visit = T0 - 20 * 3_600_000;
  const summary = sinceSummary(log, visit);
  assert.deepEqual(summary, { merged: 1, requests: 2, repliers: ['lena', 'owen'], red: 1, green: 1 });
  assert.equal(sinceLine(summary, visit, T0), 'Since yesterday: 1 merged · 2 new review requests · lena and owen replied · checks failed on 1, passed on 1');
  assert.equal(sinceLine(sinceSummary(log, T0), visit, T0), '', 'nothing changed: no line');
  assert.equal(sinceLine({ merged: 0, requests: 0, repliers: ['a', 'b', 'c', 'd'], red: 0, green: 0 }, visit, T0), 'Since yesterday: a, b and 2 more replied');
  const morning = new Date(T0);
  morning.setHours(8, 5, 0, 0);
  assert.match(sinceLabel(morning.getTime(), morning.getTime() + 3_600_000), /^Since \d{2}[:.]\d{2}/, 'a visit earlier today names its time');
});

void test('the since log is bounded, drops old events and validates what crosses IPC', () => {
  const many: SinceEvent[] = Array.from({ length: SINCE_LOG_LIMIT + 50 }, (_, i) => ({ type: 'merged', key: `k${i}`, url: `https://github.com/o/r/pull/${i + 1}`, at: T0 - i * 1000 }));
  const log = appendSinceEvents([], many, T0);
  assert.equal(log.length, SINCE_LOG_LIMIT);
  assert.equal(log[0].key, 'k0', 'newest first');
  assert.equal(appendSinceEvents(log, [], T0 + SINCE_LOG_MAX_AGE_MS + 1).length, 0, 'old events leave');
  assert.equal(parseSinceEvent({ type: 'merged', key: 'k', url: 'https://evil.example/pull/1', at: 1 }), undefined);
  assert.equal(parseSinceEvent({ type: 'deleted', key: 'k', url: 'https://github.com/o/r/pull/1', at: 1 }), undefined);
  assert.deepEqual(parseSinceEvent({ type: 'reply', key: 'k', url: 'https://github.com/o/r/pull/1', at: 1, actor: 'lena', extra: true }), { type: 'reply', key: 'k', url: 'https://github.com/o/r/pull/1', at: 1, actor: 'lena' });
});

void test('re-review lines: one compare per PR from your reviewed commit to the head, validated and summed', () => {
  const target = { url: 'https://github.com/o/r/pull/4', from: 'abc1234', to: 'def5678' };
  assert.deepEqual(parseRereviewTargets([target]), [target]);
  assert.equal(parseRereviewTargets([{ ...target, from: 'not a sha' }]), undefined);
  assert.equal(parseRereviewTargets(Array.from({ length: REREVIEW_LIMIT + 1 }, () => target)), undefined);
  assert.deepEqual(rereviewCompare(target), { owner: 'o', repo: 'r', basehead: 'abc1234...def5678', per_page: 1 });
  assert.deepEqual(rereviewSize(target, [{ additions: 30, deletions: 2 }, { additions: 10 }]), { ...target, lines: 42, files: 2 });
  // The commit your latest review was on, from status.
  const pr = member(4, { headSha: 'def5678' });
  const status = { ...signals(pr), opinions: [
    { url: 'a', author: LOGIN, state: 'APPROVED', submittedAt: iso(3 * DAY), headSha: 'abc1234' },
    { url: 'b', author: 'lena', state: 'APPROVED', submittedAt: iso(DAY), headSha: 'def5678' },
  ] };
  assert.equal(reviewedCommit(status, LOGIN), 'abc1234');
  assert.equal(reviewedCommit(signals(pr), LOGIN), undefined);
});

void test('the reply quoted on a row is the last human comment of a thread waiting on you', () => {
  const comment = (id: string, login: string, body: string, bot = false) => ({ id, body, createdAt: iso(DAY), url: `u#${id}`, author: { login, avatarUrl: '', ...(bot ? { __typename: 'Bot' } : {}) } });
  const discussion = {
    headSha: 'h', baseSha: 'b',
    threads: [
      { id: 't1', path: 'a', line: 1, startLine: null, diffSide: 'RIGHT', isResolved: true, isOutdated: false, viewerCanResolve: true, viewerCanUnresolve: true, comments: [comment('1', 'lena', 'resolved one')] },
      { id: 't2', path: 'a', line: 2, startLine: null, diffSide: 'RIGHT', isResolved: false, isOutdated: false, viewerCanResolve: true, viewerCanUnresolve: true, comments: [comment('2', LOGIN, 'mine'), comment('3', 'owen', 'Could we keep it?'), comment('4', 'ci-bot', 'beep', true)] },
    ],
  } as unknown as GitHubReviewThreads;
  assert.deepEqual(waitingReply(discussion, LOGIN, LOGIN), { author: 'owen', text: 'Could we keep it?' });
  assert.equal(waitingReply(undefined, LOGIN, LOGIN), undefined);
});

void test('the briefing says how many merges are approved, and how many can merge without review', () => {
  const status: Record<string, QueueSignals> = {};
  const ready = [1, 2].map((n) => { const m = minePr('o/r', n); status[m.url] = approved(m); return m; });
  const open = [3, 4, 5, 6, 7, 8, 9, 10].map((n) => { const m = minePr('o/r', n); status[m.url] = noReview(m); return m; });
  assert.equal(overviewBriefing(build([...ready, ...open].map((m) => item([m])), status)), '2 PRs are approved and ready to merge, 8 more can merge without review.');
  assert.equal(overviewBriefing(build(open.map((m) => item([m])), status)), '8 PRs can merge without review.');
  assert.equal(overviewBriefing(build(ready.map((m) => item([m])), status)), '2 PRs are approved and ready to merge.');
});

void test('repositories are named by their short name, and owner/repo where two share one', () => {
  const names = repositoryNames(['klang/seed', 'acme/seed', 'klang/web-seed-portal', 'Klang/Launcher']);
  assert.deepEqual([...names.entries()], [
    ['klang/seed', 'klang/seed'],
    ['acme/seed', 'acme/seed'],
    ['klang/web-seed-portal', 'web-seed-portal'],
    ['Klang/Launcher', 'Launcher'],
  ]);
});

void test('the since log saves an object, which the state store accepts, and still reads the first builds\' bare array', async () => {
  const { createSinceLog, sinceLogName } = await import('../src/since-log-service');
  const { parseSinceLog, serializeSinceLog } = await import('../lib/since-log');
  const writes = new Map<string, unknown>();
  const storage = { read: (name: string) => writes.get(name), write: (name: string, value: unknown) => void writes.set(name, value) };
  const event = { key: 'merged:https://github.com/o/r/pull/1', type: 'merged', at: 1_000, url: 'https://github.com/o/r/pull/1', title: 'One' };
  const log = createSinceLog(storage as never, () => 2_000);
  log.record('Me', [event as never]);
  const saved = writes.get(sinceLogName('Me'));
  // app-data-worker rejects any top-level value that is not a plain object ("Invalid saved state"), failing the batch.
  assert.ok(saved && typeof saved === 'object' && !Array.isArray(saved), 'saved as a plain object');
  assert.equal(parseSinceLog(saved).length, 1);
  assert.equal(parseSinceLog([event]).length, 1, 'a bare array from an earlier build still reads');
  assert.deepEqual(parseSinceLog(serializeSinceLog(parseSinceLog([event]))), parseSinceLog([event]));
});

void test('comment counts: every PR row carries the queue row’s count from the snapshot, 0 included, and none while unknown', () => {
  const status: Record<string, QueueSignals> = {};
  const talked = mine(41, { additions: 10, deletions: 2 });
  const quiet = mine(42, { additions: 10, deletions: 2 });
  status[talked.url] = { ...approved(talked), comments: 3 };
  status[quiet.url] = { ...approved(quiet), comments: 0 };
  const result = page(build([item([talked]), item([quiet])], status), status);
  assert.deepEqual(result.next.items.map((entry) => [entry.member.number, entry.comments]).sort(), [[41, 3], [42, 0]]);
  // The page shows the badge above 0 only: 0 is known, and hidden.
  assert.equal(commentsOf({ signals: (m) => status[m.url] }, [talked, quiet]), 3, 'a stack row sums its PRs');
  // No status and no count on the PR copy: not known, so nothing is shown.
  const unknown = mine(43);
  assert.equal(commentsOf({ signals: () => undefined }, [unknown]), undefined);
  // The PR copy's count, inline review comments included, when no status is saved (`prCommentTotal`).
  assert.equal(commentsOf({ signals: () => undefined }, [mine(44, { commentCount: 2, reviewCommentCount: 5 })]), 7);
  // Lines under a group and decisions carry it too.
  const waiting = mine(45, { requestedReviewers: ['lena'] });
  status[waiting.url] = { ...signals(waiting, { checks: 'success' }), comments: 4 };
  const others = page(build([item([waiting])], status), status).others;
  assert.equal(others.flatMap((group) => group.lines).find((line) => line.member.number === 45)?.comments, 4);
  const stale = mine(46, { updatedAt: iso(9 * DAY), requestedReviewers: ['lena'] });
  status[stale.url] = { ...signals(stale, { checks: 'success' }), comments: 2 };
  assert.equal(needsDecision(input(build([item([stale])], status), status))[0]?.comments, 2);
});

void test('waiting time: each row type waits since its state began, and says which timestamp that is', () => {
  const status: Record<string, QueueSignals> = {};
  // Next up, a merge: since the approval.
  const merge = mine(51, { additions: 10, deletions: 2 });
  status[merge.url] = approved(merge);
  // Next up, a review request with no earlier review: since the PR opened.
  const review = pr('o/r', 52, { author: 'zsolt', requestedReviewers: [LOGIN], createdAt: iso(3 * DAY) });
  // Next up, a fix: since the PR's last update.
  const broken = mine(53, { updatedAt: iso(2 * DAY) });
  status[broken.url] = failing(broken);
  // Waiting on others: since the PR opened, nobody reviewed it yet.
  const waiting = mine(54, { requestedReviewers: ['lena'], createdAt: iso(4 * DAY) });
  status[waiting.url] = signals(waiting, { checks: 'success' });
  // Needs a decision: idle since the last update; never approved since it opened.
  const idle = mine(55, { requestedReviewers: ['lena'], updatedAt: iso(9 * DAY) });
  status[idle.url] = signals(idle, { checks: 'success' });
  const unapproved = mine(56, { createdAt: iso(10 * DAY), updatedAt: iso(4 * DAY) });
  status[unapproved.url] = signals(unapproved, { checks: 'success', decision: '', mergeState: 'CLEAN' });
  const model = build([item([merge]), item([review]), item([broken]), item([waiting]), item([idle]), item([unapproved])], status);
  const result = page(model, status);
  const next = (n: number) => must(result.next.items.find((entry) => entry.member.number === n));
  assert.deepEqual([next(51).source, next(51).since], ['approval', Date.parse('2026-11-14T09:00:00Z')]);
  assert.deepEqual([next(52).source, next(52).since], ['opened', T0 - 3 * DAY]);
  assert.deepEqual([next(53).source, next(53).since], ['updated', T0 - 2 * DAY]);
  const line = must(result.others.flatMap((group) => group.lines).find((entry) => entry.member.number === 54));
  assert.deepEqual([line.source, line.since], ['opened', T0 - 4 * DAY]);
  const decisions = needsDecision(input(model, status));
  assert.deepEqual(decisions.map((entry) => [entry.member.number, entry.label, entry.source, entry.since]), [
    [56, 'Never approved', 'opened', T0 - 10 * DAY],
    [55, 'Idle', 'updated', T0 - 9 * DAY],
  ]);
  // A stack row for several PRs waits since the oldest of them.
  const base = pr('o/r', 57, { author: 'ivar', requestedReviewers: [LOGIN], createdAt: iso(5 * DAY), headBranch: 's57' });
  const top = pr('o/r', 58, { author: 'ivar', requestedReviewers: [LOGIN], createdAt: iso(2 * DAY), baseBranch: 's57' });
  const stacked = page(build([stack([base, top])], status), status).next.items[0];
  assert.deepEqual([stacked.urls.length, stacked.source, stacked.since], [2, 'opened', T0 - 5 * DAY]);
});

void test('a stack header’s merge says what it goes ahead without, as Next up does', () => {
  const status: Record<string, QueueSignals> = {};
  const header = (base: ReviewMember, value: QueueSignals) => {
    const rest = [mine(62, { baseBranch: base.headBranch, additions: 40 })];
    status[base.url] = value;
    status[rest[0].url] = noReview(rest[0]);
    const model = build([stack([base, ...rest], `stack-${base.number}`)], status);
    const group = morningPage(input(model, status)).others.find((entry) => entry.kind === 'stacks');
    return must(must(group?.children?.[0]).step);
  };
  const base = mine(61, { headBranch: 's61', additions: 2400, deletions: 300 });
  // Not reviewed, green: Next up lists the base, and the header names what it lacks.
  assert.equal(header(base, noReview(base)).text, 'Merge #61 (not reviewed) to unblock 1 PR');
  // Not reviewed, no checks at all.
  const none = header(base, { ...noReview(base), checks: { state: 'neutral', passed: 0, total: 0 } });
  assert.equal(none.text, 'Merge #61 (not reviewed, no checks) to unblock 1 PR');
  assert.deepEqual(none.caveats, ['not reviewed', 'no checks']);
  // Approved and green: nothing to add.
  assert.equal(header(base, approved(base)).text, 'Merge #61 to unblock 1 PR');
  // Failing and running checks, in Next up's words.
  const row = { merge: { member: base, ready: true, notes: [{ kind: 'no-review' as const, text: 'No review required' }] } };
  assert.deepEqual(mergeCaveats(row, { state: 'failure' }), ['not reviewed', 'failing checks']);
  assert.deepEqual(mergeCaveats(row, { state: 'pending' }), ['not reviewed', 'checks running']);
  assert.deepEqual(mergeCaveats({ merge: { ...row.merge, notes: [{ kind: 'approved', text: 'Approved' }] } }, { state: 'success' }), []);
  // A failing base is a fix, not a merge: the header says so, with no Merge.
  const red = header(base, failing(base));
  assert.deepEqual([red.text, red.action], ['#61 has failing checks', 'open']);
  // A base with conflicts says so, and is marked for the conflict icon.
  const dirty = header(base, conflicted(base));
  assert.deepEqual([dirty.text, dirty.conflicts], ['#61 has conflicts', true]);
});

/** Every fixture day the browser suite shows: the default day, a light day, and the real shapes. */
async function fixturePage(name: (typeof OVERVIEW_FIXTURES)[number]) {
  const fixture = await overviewFixture(name);
  const now = Date.now();
  const model = overviewModel({ items: fixture.items, signals: fixture.signals, login: FIXTURE_LOGIN, now });
  const rereviewLines = Object.fromEntries(fixture.items.flatMap((entry) => entry.subject.members).map((m) => [m.url, 42]));
  return { fixture, model, page: morningPage({ model, now, login: FIXTURE_LOGIN, signals: fixture.signals, rereviewLines }) };
}

void test('briefing = sections, on every fixture: each number is the PRs the page lists for it', async () => {
  for (const name of OVERVIEW_FIXTURES) {
    const { page: result } = await fixturePage(name);
    assertPage(result);
    assert.ok(result.briefing.text.length > 0, name);
  }
  // Screenshot 39 at its real volume: 7 reviews, 10 merges without review and 19 failing checks no longer disagree
  // with the page. The failing checks the page lists outside Needs a decision are counted; decisions on their own.
  const { page: real7 } = await fixturePage('real7');
  const numbers = Object.fromEntries(real7.briefing.counts.map((count) => [count.key, count.count]));
  assert.equal(numbers.rereviews, 7);
  assert.equal(numbers.unreviewed, 10);
  assert.equal(numbers.decide, 7);
  assert.match(real7.briefing.text, /^7 re-reviews \(6 in one stack\) are waiting on you\./);
});
