/**
 * The Overview's morning page (#390): the questions a reviewer asks on arrival, in order. Pure; built from the lane
 * model (`lib/overview.ts`) and a few reads the page adds. `morningPage` builds every section at once.
 *
 * 1. **Since yesterday:** `lib/since-log.ts`.
 * 2. **Next up** (`nextUp`): the next few things to do, cheapest first, each with one action.
 * 3. **Needs a decision** (`needsDecision`): your PRs failing, never approved or idle for over a week.
 * 4. **Waiting on you** (`waitingOnYou`): people blocked on you, by person, oldest wait first; then PRs whose
 *    requester is not known ("unassigned") and team requests.
 * 5. **Waiting on others** (`waitingOnOthers`): your PRs by what blocks them: stacks as chains, each requested
 *    reviewer (with Nudge), teams, CI, and you (failing checks, conflicts, restacks), each PR with its own reason.
 *
 * Needs a decision is drawn last on the page, but it claims its PRs before the Waiting sections do.
 *
 * **Each PR once.** Sections list each PR once on the whole page, and a PR goes to the first section that wants it:
 * Next up, then Needs a decision, then Waiting on you, then Waiting on others. A PR in Next up is removed from the
 * section below it, so nothing appears twice on screen. Within Waiting on others: stacks, then reviewers, teams, CI,
 * then you. A stack's chain is the one exception: it shows the stack's structure, so it lists every PR of the stack as
 * a full line, even a PR another section lists. That line ends in a quiet link to the other section ("↑ Next up"),
 * and it does not count toward its section's heading.
 *
 * **Counts.** Next up's heading is the number of rows it shows (`nextCount`); a row that stands for several PRs says
 * so ("6 PRs · updated since your review"), and the quiet line under it keeps its own number. The other headings are
 * the number of PRs they list (`sectionCount`): a stack of five PRs waiting on your review is "5 PRs". A group's
 * `urls` are exactly its lines' PRs.
 *
 * **Waiting on you elsewhere.** A PR waiting on you that Next up or Needs a decision lists is not in Waiting on you,
 * so the section points at where it went, by name and as a link (`waitingOnYouNote`): "#377 and #37286’s stack (6 PRs)
 * are in Next up." "Nobody is waiting on you." only when nobody is.
 *
 * **Briefing** (`morningBriefing`): counted from the sections, never apart from them, and each number links to the
 * rows it counts. Reviews and re-reviews apart, with their stacks spelled out ("7 re-reviews (6 in one stack)");
 * approved merges and merges without review are Next up's rows plus its quiet line (`readyMerges`); fixes by their
 * first reason, as the You group counts them; decisions apart.
 *
 * **Next up** (`nextUp`), at most `NEXT_LIMIT` items, whenever there is any work in Waiting on you, Fix or Merge:
 * - Candidates: people blocked on you (replies, change requests, re-reviews, reviews of any size), merges that are
 *   approved and passing, and fixes on your PRs (failing checks, conflicts, rebasing). A merge nobody reviewed is never
 *   a row, whatever it costs: it is counted on the quiet line (`nextMoreLine`), "10 ready to merge without review",
 *   which opens the review queue grouped by Action at Merge.
 * - Order, by tier (`NEXT_TIER`): people blocked on you, then approved merges, then fixes. Within a tier, `effortRank`,
 *   cheapest first; then the step that unblocks most PRs; then the longest wait. PRs that need a decision (stuck over a
 *   week) come after the rest, so they stay in Needs a decision unless there is nothing else to do.
 * - A stacked PR whose base has not merged is not the next step; its base is. A base's merge says what it unblocks:
 *   "approved by lena · green · unblocks 3 PRs". Only an approved, passing base is a row, as for any merge.
 * - **One row per stack, with its one next step.** When you owe a review or re-review on any PR of a stack (its base
 *   included), the review is the next step: the base's merge is not offered, and the review row says what follows
 *   ("6 PRs · updated since your review · then merge #35392"). Otherwise the stack's first step in this order is its
 *   row. A stack row leads with the number of its first PR in merge order that needs you, like any other row.
 * - The oldest review request always gets a slot, whatever its size: it replaces the last item when the rest fill
 *   the section.
 *
 * **Effort rank** (`effortRank`): an internal ordering weight, never shown. It counts roughly in minutes, rough on
 * purpose, and over 15 it rounds to 5. The page shows no time estimates.
 * - Merge a green PR: 1. Reply to a thread: 3. Address requested changes: 15.
 * - Fix: failing checks 10, conflicts 15, a restack 5, per PR.
 * - Re-review: 2, plus 1 for every 50 lines changed since your review up to 400, then 1 for every 80 (5 when the size
 *   is not known yet).
 * - Review: 3, plus 1 for every 40 lines up to 400, then 1 for every 60 lines; `UNKNOWN_REVIEW_LINES` when the size
 *   is not known yet. A ready explanation takes a third off. A 1,060-line review ranks 25, 2,800 lines 55.
 *
 * **Waiting time and comments.** Every PR row says how long it has waited (`since`, `source`): the time its lane entry
 * began, as `lib/overview.ts` documents per reason (a row for several PRs, the oldest of them; a decision, when it
 * started failing, opened or was last updated). And its comments, inline review comments included, as the queue row
 * counts them (`commentsOf`), from the status snapshot or the PR copy: no GitHub reads.
 *
 * **Tab count** (`morningCount`): the PRs in Next up and Waiting on you, each once. Waiting on you is counted before
 * Needs a decision claims its PRs, so a stale reply still counts. Work on your own PRs that waits on others, and
 * decisions, are not counted.
 */
import { reviewRequest } from './attention';
import { checkView, type CheckView } from './check-summary';
import { prTarget, type DeepLinkTarget } from './deep-link';
import { repoName, waitingLabel, type OverviewModel, type OverviewRow, type OverviewSinceSource } from './overview';
import { prCommentTotal, type QueueSignals } from './queue-signals';
import type { ReviewMember, ReviewSubject } from './workbench';

const DAY_MS = 86_400_000;
/** Next up lists at most this many. */
export const NEXT_LIMIT = 5;
/** Size only orders Next up: within an equal effort rank, PRs this small (or a stack in total) come first. */
export const QUICK_LINES = 300;
/** The size a review is estimated at while GitHub has not reported it. */
export const UNKNOWN_REVIEW_LINES = 200;
/** Groups with this many PRs or fewer list them inline, without a disclosure. */
export const INLINE_LIMIT = 3;
/** An expanded group lists this many PRs, then "N more". */
export const GROUP_SHOWN = 5;
/** Waiting on others shows this many stacks, the most actionable first, then "N more stacks". */
export const STACKS_SHOWN = 4;
/** A chain over this many PRs shows its first `CHAIN_HEAD` and its last, with "+N more" between. */
export const CHAIN_SHOWN = 5;
export const CHAIN_HEAD = 3;
/** Needs a decision: failing, never approved or idle for this long. */
export const DECISION_MS = 7 * DAY_MS;
/** Characters of a reply quoted on its row. */
export const QUOTE_LENGTH = 60;

const same = (a: string | undefined, b: string) => !!a && a.toLowerCase() === b.toLowerCase();
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const prs = (n: number) => plural(n, 'PR', 'PRs');
const time = (value: string | undefined) => {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
};
const lanes = (model: Pick<OverviewModel, 'lanes'>, lane: OverviewRow['lane']) => model.lanes.find((state) => state.lane === lane);
const memberLines = (member: Pick<ReviewMember, 'additions' | 'deletions'>) =>
  member.additions === undefined && member.deletions === undefined ? undefined : (member.additions ?? 0) + (member.deletions ?? 0);
const isOpen = (member: ReviewMember) => member.state === 'open' && !member.merged;
const unique = <T,>(values: Iterable<T>) => [...new Set(values)];

/** A row's size: a PR's changed lines, or the total of a stack's open PRs. Undefined while any of them is not known. */
export function quickSize(row: Pick<OverviewRow, 'kind' | 'item' | 'focus'>): number | undefined {
  const members = row.kind === 'stack' ? row.item.subject.members.filter(isOpen) : [row.focus];
  let total = 0;
  for (const member of members) {
    const lines = memberLines(member);
    if (lines === undefined) return undefined;
    total += lines;
  }
  return total;
}

/**
 * How each repository is named on the page: its short name ("seed-launcher") when no other repository shares it,
 * else `owner/repo`. Case does not matter.
 */
export function repositoryNames(repos: Iterable<string>): ReadonlyMap<string, string> {
  const all = unique(repos);
  const short = (repo: string) => repoName(repo).toLowerCase();
  const counts = new Map<string, number>();
  for (const repo of all) counts.set(short(repo), (counts.get(short(repo)) ?? 0) + 1);
  return new Map(all.map((repo) => [repo, (counts.get(short(repo)) ?? 0) > 1 ? repo : repoName(repo)]));
}
/** A repository's name on the page, from `repositoryNames`; the short name when it is not in the map. */
export const repositoryLabel = (names: ReadonlyMap<string, string>, repo: string) => names.get(repo) ?? repoName(repo);

export type NextKind = 'merge' | 'rereview' | 'reply' | 'changes' | 'review' | 'fix';
export type FixReason = 'failing' | 'conflicts' | 'restack';
export interface NextItem {
  /** `next|${row.id}` */
  id: string;
  kind: NextKind;
  row: OverviewRow;
  /** What the item names: the PR a merge merges (a stack's base), else the row's title. */
  title: string;
  /** The PR the action acts on and the title previews. */
  member: ReviewMember;
  /** A merge of a PR nobody reviewed: never a row (`NEXT_TIER`), only what follows a stack's review. */
  unreviewed?: boolean;
  /** A merge of a stack's base: the open PRs above it, which can merge once it has. */
  unblocks?: number;
  /** A fix: what is wrong. */
  fix?: FixReason;
  /** One line: "approved by lena · green", "not reviewed · green · unblocks 3 PRs", "1060 lines", "failing checks". */
  why: string;
  /** The internal ordering weight (`effortRank`): orders Next up, never shown. */
  rank: number;
  /** Changed lines, when known: only orders items of an equal rank. */
  lines?: number;
  /** The PRs the item lists: the one a merge merges, else the row's PRs. */
  urls: string[];
  /** The check state of those PRs. */
  check: CheckView;
  /** When the item entered its current state, and where that time comes from (`lib/overview.ts`, "Waiting time"). */
  since: number;
  source: OverviewSinceSource;
  /** Comments on those PRs, inline review comments included, as the queue row counts them (`commentsOf`). */
  comments?: number;
}
export interface NextUp {
  items: NextItem[];
  /**
   * Ready merges nobody reviewed that no row lists: the quiet line's number. Every ready merge is in exactly one of
   * the rows, this list and `moreApproved` (`readyMerges`), so the briefing counts them from here.
   */
  unreviewed: string[];
  /** Approved merges no row lists: Next up is full, the stack's review comes first, or the PR has no checks. */
  moreApproved: string[];
}
/**
 * Every ready merge on the page, by its PR: Merge lane rows that are ready, not stacked on an open base, not leaving
 * the page, and not failing or running checks (those are fixes, or wait on CI). `approved`: approved and passing;
 * `other`: approved without passing checks (none, or not known yet).
 */
export function readyMerges(model: Pick<OverviewModel, 'lanes'>, signals: MorningInput['signals'], hidden: ReadonlySet<string> = new Set()): { approved: string[]; unreviewed: string[]; other: string[] } {
  const result = { approved: [] as string[], unreviewed: [] as string[], other: [] as string[] };
  for (const row of lanes(model, 'merge')?.rows ?? []) {
    const member = row.merge?.member ?? row.focus;
    if (!row.merge?.ready || row.merge.notes.some((note) => note.kind === 'base-open') || hidden.has(member.url)) continue;
    const checks = current({ signals }, member)?.checks.state;
    if (checks === 'failure' || checks === 'pending') continue;
    const review = row.merge.notes[0]?.kind;
    if (review === 'approved' && checks === 'success') result.approved.push(member.url);
    else if (review === 'no-review') result.unreviewed.push(member.url);
    else result.other.push(member.url);
  }
  return result;
}
/** The stack (or PR) an item belongs to: Next up gives each one row. */
const stackKey = (item: Pick<NextItem, 'row'>) => item.row.item.subject.id;
/** The row's first PR in merge order (base first): the number a stack row leads with. */
function leadMember(row: OverviewRow): ReviewMember {
  if (row.entries.length <= 1) return row.focus;
  const position = (member: ReviewMember) => row.item.subject.members.findIndex((candidate) => candidate.url === member.url);
  return [...row.entries].map((entry) => entry.member).sort((a, b) => position(a) - position(b))[0] ?? row.focus;
}
export interface MorningInput {
  model: Pick<OverviewModel, 'lanes'>;
  now: number;
  login: string;
  signals: (member: ReviewMember) => QueueSignals | undefined;
  /** Lines changed since your review, by PR URL (one compare read each). */
  rereviewLines?: Readonly<Record<string, number>>;
  /** The thread waiting on your reply, by PR URL: who wrote last and what. From the saved discussion. */
  replies?: Readonly<Record<string, { author: string; text: string }>>;
  /** PRs to leave off the page, such as ones closing on GitHub. */
  hidden?: ReadonlySet<string>;
}

/** The PR's status, when it is for its current revision. */
const current = (input: Pick<MorningInput, 'signals'>, member: ReviewMember) => {
  const value = input.signals(member);
  return value && value.url === member.url && value.headSha === member.headSha ? value : undefined;
};
const checksOf = (input: Pick<MorningInput, 'signals'>, members: readonly ReviewMember[]) => checkView(members.map((member) => current(input, member)));
/**
 * Comments on these PRs, inline review comments included: the queue row's count (`QueueMetadata`, `prCommentTotal`),
 * from the status snapshot or the PR copy. Undefined while any PR's count is not known. No GitHub reads.
 */
export function commentsOf(input: Pick<MorningInput, 'signals'>, members: readonly ReviewMember[]): number | undefined {
  let total = 0;
  for (const member of members) {
    const count = prCommentTotal(member, current(input, member));
    if (count === undefined) return undefined;
    total += count;
  }
  return members.length ? total : undefined;
}
/** When one PR of a row entered the row's state: its own entry, else the row's oldest. */
function sinceOf(row: OverviewRow, member?: ReviewMember): { since: number; source: OverviewSinceSource } {
  const entry = member && row.entries.find((candidate) => candidate.member.url === member.url);
  return entry ? { since: entry.since, source: entry.source } : { since: row.since, source: row.source };
}

const roundRank = (rank: number) => (rank > 15 ? Math.round(rank / 5) * 5 : rank);
const FIX_RANK: Readonly<Record<FixReason, number>> = { failing: 10, conflicts: 15, restack: 5 };
/**
 * An item's place in Next up, cheapest first: an internal ordering weight, roughly minutes of work, that the page never
 * shows. See "Effort rank" at the top of this file.
 */
export function effortRank(kind: NextKind, lines?: number, explanation = false, fix: FixReason = 'failing'): number {
  if (kind === 'merge') return 1;
  if (kind === 'reply') return 3;
  if (kind === 'changes') return 15;
  if (kind === 'fix') return FIX_RANK[fix];
  if (kind === 'rereview') return lines === undefined ? 5 : roundRank(2 + Math.ceil(Math.min(lines, 400) / 50) + Math.ceil(Math.max(0, lines - 400) / 80));
  const size = lines ?? UNKNOWN_REVIEW_LINES;
  const rank = 3 + Math.ceil(Math.min(size, 400) / 40) + Math.ceil(Math.max(0, size - 400) / 60);
  return roundRank(explanation ? Math.max(1, Math.round((rank * 2) / 3)) : rank);
}
/** A comment as one quoted line: markdown and whitespace flattened, cut at a word near `QUOTE_LENGTH`. */
export function quote(text: string): string {
  const flat = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^>.*$/gm, ' ')
    .replace(/[`*_#>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (flat.length <= QUOTE_LENGTH) return flat;
  const cut = flat.slice(0, QUOTE_LENGTH + 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > QUOTE_LENGTH * 0.6 ? cut.slice(0, space) : cut.slice(0, QUOTE_LENGTH)).replace(/[\s,.;:]+$/, '')}…`;
}

const entryMembers = (row: OverviewRow) => row.entries.map((entry) => entry.member);
/** "3 PRs · " before a stack row's reason, so the row says how many PRs it stands for. */
const stackPrefix = (row: OverviewRow) => (row.entries.length > 1 ? `${row.entries.length} PRs · ` : '');
const FIX_WORDS: Readonly<Record<FixReason, string>> = { failing: 'failing checks', conflicts: 'conflicts', restack: 'needs a restack' };
/** Restack needed, Conflicts, Failing checks: the reason a PR is under You. */
export const FIX_LABEL: Readonly<Record<FixReason, string>> = { failing: 'Failing checks', conflicts: 'Conflicts', restack: 'Restack needed' };
const fixReason = (reasons: readonly string[]): FixReason => (reasons.includes('checks-failed') ? 'failing' : reasons.includes('conflicts') ? 'conflicts' : 'restack');

/** The open PRs above `member` in its stack: what merging it unblocks. */
export function openAbove(subject: Pick<ReviewSubject, 'members' | 'edges'>, member: ReviewMember): ReviewMember[] {
  const found: ReviewMember[] = [];
  const queue = [member.url];
  const seen = new Set(queue);
  while (queue.length) {
    const url = queue.shift() as string;
    for (const edge of subject.edges) {
      if (edge.parent !== url || seen.has(edge.child)) continue;
      seen.add(edge.child);
      const child = subject.members.find((candidate) => candidate.url === edge.child);
      if (child && isOpen(child)) found.push(child);
      queue.push(edge.child);
    }
  }
  return found;
}

/**
 * Next up's tiers, in order: people blocked on you (a reply, a review, a re-review, changes requested), then approved
 * merges, then fixes on your PRs. Merges nobody reviewed have no tier: they are never a row.
 */
export const NEXT_TIER: Readonly<Record<NextKind, number>> = { reply: 1, changes: 1, review: 1, rereview: 1, merge: 2, fix: 3 };
/** The order of Next up. See the rules at the top of this file. */
const nextOrder = (stale: ReadonlySet<string>) => {
  const decision = (item: NextItem) => (item.urls.some((url) => stale.has(url)) ? 1 : 0);
  return (a: NextItem, b: NextItem) =>
    decision(a) - decision(b) ||
    NEXT_TIER[a.kind] - NEXT_TIER[b.kind] ||
    a.rank - b.rank ||
    (b.unblocks ?? 0) - (a.unblocks ?? 0) ||
    a.row.since - b.row.since ||
    a.title.localeCompare(b.title);
};

/** Next up: see the rules at the top of this file. `stale`: PRs that need a decision, ranked after the rest. */
export function nextUp(input: MorningInput & { stale?: ReadonlySet<string> }): NextUp {
  const { model } = input;
  const hidden = input.hidden ?? new Set<string>();
  const candidates: NextItem[] = [];
  const add = (value: Omit<NextItem, 'id' | 'check' | 'since' | 'source' | 'comments'>) => {
    // A row for one PR of a stack names that PR, not the stack.
    const item = value.kind !== 'merge' && value.row.entries.length === 1 ? { ...value, title: value.member.title } : value;
    if (item.urls.some((url) => hidden.has(url))) return;
    const members = item.urls.map((url) => item.row.item.subject.members.find((member) => member.url === url)).filter((member): member is ReviewMember => !!member);
    // One PR waits since its own entry in the lane; a row for several since the oldest of them.
    const waited = sinceOf(item.row, members.length === 1 ? members[0] : undefined);
    const comments = commentsOf(input, members);
    candidates.push({ ...item, id: `next|${item.row.id}`, check: checksOf(input, members), ...waited, ...(comments !== undefined ? { comments } : {}) });
  };
  for (const row of lanes(model, 'merge')?.rows ?? []) {
    const member = row.merge?.member ?? row.focus;
    // A PR stacked on one that has not merged waits for it: its base is the next step.
    if (!row.merge?.ready || row.merge.notes.some((note) => note.kind === 'base-open')) continue;
    if (current(input, member)?.checks.state !== 'success') continue;
    const review = row.merge.notes[0];
    if (review.kind !== 'approved' && review.kind !== 'no-review') continue;
    const unblocks = openAbove(row.item.subject, member).length;
    const why = [review.kind === 'approved' ? `${review.text.replace(/^Approved/, 'approved')} · green` : 'not reviewed · green', unblocks ? `unblocks ${prs(unblocks)}` : '']
      .filter(Boolean)
      .join(' · ');
    add({
      kind: 'merge', row, title: member.title, member, why, rank: effortRank('merge'), lines: memberLines(member), urls: [member.url],
      // A merge nobody reviewed is never a row: it only says what a stack's review row is followed by.
      ...(review.kind === 'no-review' ? { unreviewed: true } : {}),
      ...(unblocks ? { unblocks } : {}),
    });
  }
  const requests: NextItem[] = [];
  for (const row of lanes(model, 'review')?.rows ?? []) {
    const urls = entryMembers(row).map((member) => member.url);
    if (row.reasons.includes('updated-since-review')) {
      const lines = input.rereviewLines?.[row.focus.url];
      add({
        kind: 'rereview', row, title: row.title, member: leadMember(row), urls, lines,
        why: stackPrefix(row) + (lines === undefined ? 'updated since your review' : `+${plural(lines, 'line', 'lines')} since your review`),
        rank: effortRank('rereview', lines),
      });
      continue;
    }
    const lines = quickSize(row);
    const explanation = !!row.explanation;
    add({
      kind: 'review', row, title: row.title, member: leadMember(row), urls, lines,
      why: stackPrefix(row) + [lines === undefined ? 'size not known yet' : plural(lines, 'line', 'lines'), explanation ? 'explanation ready' : ''].filter(Boolean).join(' · '),
      rank: effortRank('review', lines, explanation),
    });
    const item = candidates.at(-1);
    if (item?.row === row && row.reasons.includes('review-requested')) requests.push(item);
  }
  for (const row of lanes(model, 'answer')?.rows ?? []) {
    const urls = entryMembers(row).map((member) => member.url);
    if (row.reasons.includes('replies')) {
      const reply = input.replies?.[row.focus.url];
      add({
        kind: 'reply', row, title: row.title, member: leadMember(row), urls, rank: effortRank('reply'),
        why: reply ? `${reply.author}: “${quote(reply.text)}”` : `${row.person ?? 'Someone'} is waiting on your reply`,
      });
    } else if (row.reasons.includes('changes-requested'))
      add({ kind: 'changes', row, title: row.title, member: leadMember(row), urls, rank: effortRank('changes'), why: `${row.person ? `${row.person} requested` : 'Requested'} changes` });
  }
  for (const row of lanes(model, 'fix')?.rows ?? []) {
    const fix = fixReason(row.reasons);
    const rank = roundRank(row.entries.reduce((total, entry) => total + effortRank('fix', undefined, false, fixReason(entry.reasons)), 0));
    const lead = leadMember(row);
    const unblocks = openAbove(row.item.subject, lead).length;
    add({ kind: 'fix', row, title: row.title, member: lead, fix, rank, urls: entryMembers(row).map((member) => member.url), why: stackPrefix(row) + FIX_WORDS[fix], ...(unblocks ? { unblocks } : {}) });
  }
  // A stack you owe a review on: the review is its next step, and its base merges after it.
  const reviewing = new Set(candidates.filter((item) => item.kind === 'review' || item.kind === 'rereview').map(stackKey));
  const deferred = new Map<string, NextItem>();
  const pool = candidates.filter((item) => {
    if (item.kind !== 'merge') return true;
    if (reviewing.has(stackKey(item))) deferred.set(stackKey(item), item);
    // Only approved, passing merges can be a row: a merge nobody reviewed goes to the quiet line.
    return !item.unreviewed && !reviewing.has(stackKey(item));
  });
  for (const item of pool) {
    const merge = (item.kind === 'review' || item.kind === 'rereview') && deferred.get(stackKey(item));
    if (merge) item.why = `${item.why} · then merge #${merge.member.number}`;
  }
  const order = nextOrder(input.stale ?? new Set());
  pool.sort(order);
  const items: NextItem[] = [];
  for (const item of pool) {
    if (items.length >= NEXT_LIMIT) break;
    // One row per stack: its first step in this order.
    if (items.some((listed) => stackKey(listed) === stackKey(item))) continue;
    items.push(item);
  }
  // The oldest review request always has a slot: it replaces its own stack's row, else the last item when the rest
  // fill the section.
  const oldest = [...requests].sort((a, b) => a.row.since - b.row.since).at(0);
  if (oldest && !items.includes(oldest)) {
    const same = items.findIndex((listed) => stackKey(listed) === stackKey(oldest));
    if (same >= 0) items.splice(same, 1);
    else if (items.length >= NEXT_LIMIT) items.pop();
    items.push(oldest);
    items.sort(order);
  }
  // Every ready merge no row lists is on the quiet line, so the briefing's merge numbers are the page's.
  const listed = new Set(items.filter((item) => item.kind === 'merge').flatMap((item) => item.urls));
  const ready = readyMerges(model, input.signals, hidden);
  return {
    items,
    unreviewed: ready.unreviewed.filter((url) => !listed.has(url)),
    moreApproved: [...ready.approved, ...ready.other].filter((url) => !listed.has(url)),
  };
}
/** The quiet line under Next up: the ready merges no row lists. "10 ready to merge without review", "3 more approved and ready to merge". */
export function nextMoreLine(next: Pick<NextUp, 'unreviewed' | 'moreApproved'>): string | undefined {
  const unreviewed = next.unreviewed.length;
  const approved = next.moreApproved.length;
  const words = [
    unreviewed ? `${unreviewed} ready to merge without review` : '',
    approved ? `${approved} more approved and ready to merge` : '',
  ].filter(Boolean);
  return words.length ? words.join(' · ') : undefined;
}
/** Next up's heading: the rows it shows. A row for several PRs says so on the row; the quiet line keeps its own number. */
export const nextCount = (items: readonly unknown[]) => items.length;

/** Where a PR is listed on the page. */
export type Place = 'next' | 'decide' | 'you' | 'others' | 'hidden';
export const PLACE_LABEL: Readonly<Record<Exclude<Place, 'hidden' | 'others'>, string>> = { next: 'Next up', decide: 'Needs a decision', you: 'Waiting on you' };
/**
 * Where a PR stands in its stack's chain. The first is "Next". Every PR after it is "Waiting" (on the PR below it),
 * whatever its own checks or review say: its check state shows beside it. "Conflicts" is the one exception, because
 * the PR needs you whatever happens below it. "Ready" is not used in chains: no PR above an open base can merge.
 */
export type ChainStatus = 'next' | 'waiting' | 'conflicts';
export const CHAIN_STATUS_LABEL: Readonly<Record<ChainStatus, string>> = { next: 'Next', waiting: 'Waiting', conflicts: 'Conflicts' };

/** One PR under a group. */
export interface GroupLine {
  /** The PR's URL: a PR is listed once on the page. */
  id: string;
  row: OverviewRow;
  member: ReviewMember;
  title: string;
  /** When the PR entered its current state in its lane, and where that time comes from (`lib/overview.ts`). */
  since: number;
  source: OverviewSinceSource;
  /** Comments, inline review comments included (`commentsOf`). Undefined while not known. */
  comments?: number;
  /** Where a click lands. */
  target: DeepLinkTarget;
  /** The PR's check state. */
  check: CheckView;
  /** Under You: why the PR needs you. */
  reason?: FixReason;
  /** In a stack's chain: where the PR stands. */
  status?: ChainStatus;
  /** The accessible description, before the check state: "#377, waiting, after #376". */
  description: string;
}
/** A section a chain's line links to: the PR is also listed there. */
export type AlsoPlace = Exclude<Place, 'hidden' | 'others'>;
/**
 * A chain step: always a full line. `also`: another section lists the PR too, so the line links there, and the
 * stack's `urls` (its heading count) leave it out.
 */
export type ChainNode = { kind: 'line'; line: GroupLine; also?: AlsoPlace };
/** What a stack waits on, in words, and the action that moves it. */
export interface StackStep {
  /**
   * "Merge #376 to unblock 3 PRs", "Merge #376 (not reviewed, no checks) to unblock 3 PRs", "#36948 is waiting on
   * checks", "#379 waits on review from lena", "#379 has conflicts", "Re-review 6 PRs first, then merge #35392".
   */
  text: string;
  /**
   * A merge: what the merge goes ahead without, in Next up's words: "not reviewed", "no checks", "failing checks",
   * "checks running". Empty for an approved, green base. The header and its button's tooltip both say them.
   */
  caveats?: string[];
  /** The PR has merge conflicts with its base: shown with the conflict icon. */
  conflicts?: boolean;
  /** `review`: you owe a review on the stack, so its base merges after it. */
  action: 'merge' | 'nudge' | 'open' | 'review';
  /** The PR that has to merge first. */
  member: ReviewMember;
  /** Its row in the lanes: Merge acts on it. For `review`, the review row, which the action opens. */
  row?: OverviewRow;
  /** Nudge: the reviewer. */
  reviewer?: string;
  /** Can merge, or needs you: shown before stacks that wait on others. */
  actionable: boolean;
}
export interface PersonGroup {
  /** `person:lena`, `unassigned`, `team`, `team:org/name`, `review`, `ci`, `stack:owner/repo#380`, `stacks`, `you`. */
  key: string;
  kind: 'person' | 'unassigned' | 'team' | 'ci' | 'stack' | 'stacks' | 'you' | 'review';
  /** "lena", "team", "CI", "Launcher i18n", "Waiting for earlier PRs in a stack to merge", "you". */
  label: string;
  /** "2 PRs · oldest 4 d", "3 running", "2 failing checks, 1 conflict", "13 PRs in 5 stacks", "4 PRs". */
  detail: string;
  rows: OverviewRow[];
  /** The PRs this group lists, each once: its share of the section heading. Exactly its lines' PRs. */
  urls: string[];
  /** The repositories of those PRs, each once. */
  repos: string[];
  /** Its PRs, one line each. */
  lines: GroupLine[];
  /** When the longest wait in the group began. */
  oldest: number;
  /** A requested reviewer of your PRs: Nudge re-requests their review on these PRs. */
  nudge?: { reviewer: string; members: ReviewMember[] };
  /** A stack: what it waits on, and its chain in merge order, base first. */
  step?: StackStep;
  chain?: ChainNode[];
  /** The stacks row: one chain per stack, the most actionable first. */
  children?: PersonGroup[];
  /** People, teams and reviewers: the check state of their PRs together. */
  check?: CheckView;
}
/** A section heading: the sum of the PRs its rows stand for. */
export const sectionCount = (groups: readonly Pick<PersonGroup, 'urls'>[]) => groups.reduce((total, group) => total + group.urls.length, 0);

type GroupSeed = Pick<PersonGroup, 'kind' | 'label'> & Partial<Pick<PersonGroup, 'nudge'>>;
/** Builds groups that list each PR once on the page: a PR another section or group claimed is skipped. */
function grouper(input: Pick<MorningInput, 'signals'>, claimed: Map<string, Place>, place: Place) {
  const groups = new Map<string, PersonGroup>();
  /** A PR's line, without claiming it: a chain's line for a PR another section lists. */
  const line = (row: OverviewRow, member: ReviewMember, extra: Partial<GroupLine> = {}): GroupLine => {
    const { since, source } = sinceOf(row, member);
    const comments = commentsOf(input, [member]);
    return {
      id: member.url, row, member, title: member.title, since, source, target: prTarget(member.url) ?? row.target, check: checksOf(input, [member]),
      ...(comments !== undefined ? { comments } : {}), description: `#${member.number}`, ...extra,
    };
  };
  const add = (key: string, seed: () => GroupSeed, row: OverviewRow, member: ReviewMember, extra: Partial<GroupLine> = {}) => {
    if (claimed.has(member.url)) return undefined;
    claimed.set(member.url, place);
    const group: PersonGroup = groups.get(key) ?? { key, detail: '', rows: [], urls: [], repos: [], lines: [], oldest: row.since, ...seed() };
    if (!group.rows.includes(row)) group.rows.push(row);
    group.urls.push(member.url);
    if (!group.repos.includes(member.repo)) group.repos.push(member.repo);
    const added = line(row, member, extra);
    group.lines.push(added);
    group.oldest = Math.min(group.oldest, added.since);
    groups.set(key, group);
    return group;
  };
  return { groups, add, line };
}
const sortLines = (group: PersonGroup) => {
  group.rows.sort((a, b) => a.since - b.since);
  group.lines.sort((a, b) => a.since - b.since || a.title.localeCompare(b.title));
};

/**
 * Waiting on you: review requests and re-reviews by author, replies and change requests by who wrote, oldest wait
 * first; then PRs whose requester is not known ("unassigned"), and team requests last: "team · 3 review requests".
 * A PR in two lanes (a reply and a re-review) is listed once, under its oldest wait. PRs in `claimed` are left out.
 */
export function waitingOnYou(input: Pick<MorningInput, 'model' | 'now' | 'login' | 'signals'>, claimed = new Map<string, Place>()): PersonGroup[] {
  const { add, groups } = grouper(input, claimed, 'you');
  const rows = [...(lanes(input.model, 'answer')?.rows ?? []), ...(lanes(input.model, 'review')?.rows ?? [])].sort((a, b) => a.since - b.since);
  for (const row of rows) {
    const team = row.lane === 'review' && !row.reasons.includes('updated-since-review') && row.entries.every((entry) => reviewRequest(entry.member, input.login) === 'team');
    const person = row.person ?? (row.lane === 'review' && !same(row.focus.author, input.login) ? row.focus.author : undefined);
    for (const { member } of row.entries) {
      if (team) add('team', () => ({ kind: 'team', label: 'team' }), row, member);
      else if (person) add(`person:${person.toLowerCase()}`, () => ({ kind: 'person', label: person }), row, member);
      else add('unassigned', () => ({ kind: 'unassigned', label: 'unassigned' }), row, member);
    }
  }
  const order: PersonGroup['kind'][] = ['person', 'unassigned', 'team'];
  const result = [...groups.values()].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || a.oldest - b.oldest || a.label.localeCompare(b.label));
  for (const group of result) {
    sortLines(group);
    const n = group.urls.length;
    group.detail = group.kind === 'team' ? plural(n, 'review request', 'review requests') : `${prs(n)} · oldest ${waitingLabel(group.oldest, input.now)}`;
    group.check = checksOf(input, group.lines.map((line) => line.member));
  }
  return result;
}

/** Your open PRs' rows on the page: Fix, Merge (Ready and Parked), Waiting and Answer. A stack can have a row in each. */
function ownRows(model: Pick<OverviewModel, 'lanes'>): OverviewRow[] {
  return (['fix', 'merge', 'waiting', 'answer'] as const).flatMap((lane) => {
    const state = lanes(model, lane);
    return [...(state?.rows ?? []), ...(state?.parked ?? [])];
  });
}

/** The open PR directly below `member` in its stack, if any. */
function openParent(subject: ReviewSubject, member: ReviewMember): ReviewMember | undefined {
  return subject.edges
    .filter((edge) => edge.child === member.url)
    .map((edge) => subject.members.find((candidate) => candidate.url === edge.parent))
    .find((parent): parent is ReviewMember => !!parent && isOpen(parent));
}
/** The lowest open PR under `member`: the one that has to merge first. */
function openRoot(subject: ReviewSubject, member: ReviewMember): ReviewMember | undefined {
  let found = openParent(subject, member);
  const seen = new Set<string>();
  while (found && !seen.has(found.url)) {
    seen.add(found.url);
    const next = openParent(subject, found);
    if (!next) break;
    found = next;
  }
  return found;
}

/**
 * What a merge goes ahead without, in Next up's words: "not reviewed" unless approved, then "no checks", "failing
 * checks" or "checks running". An approved, green PR has none.
 */
export function mergeCaveats(row: Pick<OverviewRow, 'merge'>, checks?: Pick<CheckView, 'state'>): string[] {
  const caveats: string[] = [];
  if (row.merge?.notes[0]?.kind !== 'approved') caveats.push('not reviewed');
  const words: Partial<Record<CheckView['state'], string>> = { neutral: 'no checks', failure: 'failing checks', pending: 'checks running' };
  const word = checks && words[checks.state];
  if (word) caveats.push(word);
  return caveats;
}

/**
 * What the PR a stack waits on is waiting on itself, from its row in the lanes, and the action that moves it.
 * `checks`: the PR's check state, so a merge says what it goes ahead without (`mergeCaveats`).
 */
export function stackStep(model: Pick<OverviewModel, 'lanes'>, member: ReviewMember, login: string, unblocks: number, checks?: Pick<CheckView, 'state'>): StackStep {
  const n = `#${member.number}`;
  const find = (lane: OverviewRow['lane'], parked = false) => {
    const state = lanes(model, lane);
    return (parked ? state?.parked : state?.rows)?.find((row) => row.entries.some((entry) => entry.member.url === member.url));
  };
  const reasons = (row: OverviewRow) => row.entries.find((entry) => entry.member.url === member.url)?.reasons ?? row.reasons;
  const fix = find('fix');
  if (fix) {
    const reason = fixReason(reasons(fix));
    return { member, row: fix, action: 'open', actionable: true, ...(reason === 'conflicts' ? { conflicts: true } : {}), text: `${n} ${{ failing: 'has failing checks', conflicts: 'has conflicts', restack: 'needs a restack' }[reason]}` };
  }
  const answer = find('answer');
  if (answer) return { member, row: answer, action: 'open', actionable: true, text: reasons(answer).includes('changes-requested') ? `${n} has changes requested` : `${n} waits on your reply` };
  const merge = find('merge');
  const parked = find('merge', true);
  // You owe a review on a PR of this stack: the review comes first, and the base merges after it.
  const owed = (lanes(model, 'review')?.rows ?? []).find((row) => row.item.subject.members.some((candidate) => candidate.url === member.url));
  if (owed && ((merge && merge.merge?.member.url === member.url) || parked)) {
    const verb = owed.reasons.includes('updated-since-review') ? 'Re-review' : 'Review';
    return { member, row: owed, action: 'review', actionable: true, text: `${verb} ${owed.entries.length > 1 ? prs(owed.entries.length) : `#${owed.focus.number}`} first, then merge ${n}` };
  }
  if (merge && merge.merge?.member.url === member.url) {
    const caveats = mergeCaveats(merge, checks);
    const merging = `Merge ${n}${caveats.length ? ` (${caveats.join(', ')})` : ''}`;
    // Only an approved, passing base gets the Merge button; one nobody reviewed, or without checks, opens the PR.
    return { member, row: merge, action: caveats.length ? 'open' : 'merge', actionable: true, caveats, text: unblocks ? `${merging} to unblock ${prs(unblocks)}` : merging };
  }
  if (parked) return { member, row: parked, action: 'open', actionable: true, text: parked.merge?.notes[0]?.kind === 'approved' ? `${n} is approved and can merge` : `${n} can merge, not reviewed` };
  const waiting = find('waiting');
  if (waiting) {
    const why = reasons(waiting);
    if (why.includes('review-pending')) {
      const reviewer = member.requestedReviewers.find((name) => !same(name, login));
      const team = member.requestedTeams[0];
      if (reviewer) return { member, row: waiting, action: 'nudge', reviewer, actionable: false, text: `${n} waits on review from ${reviewer}` };
      return { member, row: waiting, action: 'open', actionable: false, text: team ? `${n} waits on review from ${team}` : `${n} waits on a review` };
    }
    return { member, row: waiting, action: 'open', actionable: false, text: `${n} is waiting on checks` };
  }
  const review = find('review');
  if (review) return { member, row: review, action: 'open', actionable: true, text: `${n} waits on your review` };
  return { member, action: 'open', actionable: false, text: `${n} has to merge first` };
}

/**
 * Waiting on others: your PRs by blocker, each PR once on the page. Stacks first, as chains; then each requested
 * reviewer (with Nudge), oldest wait first (a PR waiting on two reviewers is under the first one GitHub names); then
 * requested teams, PRs awaiting a reviewer nobody was asked to be, CI still running, and you, each PR with its reason.
 *
 * Stacks: one chain per stack, keyed by the repository and number of the open PR at its bottom (never the number
 * alone), so a stack listed twice is one chain and equal numbers in two repositories stay apart. The chain lists the
 * base and every PR waiting for it, in merge order, each as a full line; a PR another section lists links there
 * (`ChainNode.also`) and is left out of the stack's `urls`. The step says what
 * the base waits on. All stacks are one group, "Waiting for earlier PRs in a stack to merge", the most actionable
 * first (the base can merge, or needs you), then the oldest.
 */
export function waitingOnOthers(input: Pick<MorningInput, 'model' | 'now' | 'login' | 'signals'>, claimed = new Map<string, Place>()): PersonGroup[] {
  const { model, now, login } = input;
  const { add, groups, line } = grouper(input, claimed, 'others');
  // Stacks: every PR of yours waiting for an earlier PR, by the PR at the bottom.
  type Waiting = { member: ReviewMember; row: OverviewRow; reasons: Set<string> };
  const stacks = new Map<string, { root: ReviewMember; subject: ReviewSubject; row: OverviewRow; waiting: Map<string, Waiting> }>();
  for (const row of ownRows(model)) {
    for (const entry of row.entries) {
      const root = openRoot(row.item.subject, entry.member);
      if (!root) continue;
      const key = `stack:${root.repo.toLowerCase()}#${root.number}`;
      const stack = stacks.get(key) ?? { root, subject: row.item.subject, row, waiting: new Map<string, Waiting>() };
      const found = stack.waiting.get(entry.member.url) ?? { member: entry.member, row, reasons: new Set<string>() };
      for (const reason of entry.reasons) found.reasons.add(reason);
      if (row.lane === 'merge') found.reasons.add('merge');
      stack.waiting.set(entry.member.url, found);
      stacks.set(key, stack);
    }
  }
  const stackGroups: PersonGroup[] = [];
  for (const [key, { root, subject, row, waiting }] of stacks) {
    const position = (member: ReviewMember) => subject.members.findIndex((candidate) => candidate.url === member.url);
    const above = [...waiting.values()].sort((a, b) => position(a.member) - position(b.member));
    if (above.every(({ member }) => claimed.has(member.url))) continue;
    const step = stackStep(model, root, login, openAbove(subject, root).length, checksOf(input, [root]));
    const label = subject.name || root.title;
    const seed = () => ({ kind: 'stack' as const, label });
    const chain: ChainNode[] = [];
    const node = (member: ReviewMember, lineRow: OverviewRow, extra: Partial<GroupLine>) => {
      const place = claimed.get(member.url);
      // A PR leaving the page (closing) leaves its chain too.
      if (place === 'hidden') return;
      const group = place ? undefined : add(key, seed, lineRow, member, extra);
      if (group) chain.push({ kind: 'line', line: group.lines.at(-1) as GroupLine });
      else chain.push({ kind: 'line', line: line(lineRow, member, extra), ...(place && place !== 'others' ? { also: place } : {}) });
    };
    // The base's line is its own row in the lanes, not the review row a `review` step opens.
    node(root, step.action === 'review' ? row : (step.row ?? row), { status: 'next', description: `#${root.number}, next, merges first. ${step.text}` });
    for (const { member, row: lineRow, reasons } of above) {
      const parent = openParent(subject, member);
      const status: ChainStatus = reasons.has('conflicts') ? 'conflicts' : 'waiting';
      node(member, lineRow, { status, description: `#${member.number}, ${CHAIN_STATUS_LABEL[status].toLowerCase()}, after #${parent?.number ?? root.number}` });
    }
    const group = groups.get(key);
    if (!group) continue;
    group.step = step;
    group.chain = chain;
    group.detail = prs(group.urls.length);
    group.oldest = Math.min(...group.lines.map((line) => line.since));
    groups.delete(key);
    stackGroups.push(group);
  }
  for (const row of lanes(model, 'waiting')?.rows ?? []) {
    for (const entry of row.entries) {
      const member = entry.member;
      if (!entry.reasons.includes('review-pending')) continue;
      const reviewer = member.requestedReviewers.find((name) => !same(name, login));
      const team = member.requestedTeams[0];
      if (reviewer) {
        const group = add(`person:${reviewer.toLowerCase()}`, () => ({ kind: 'person', label: reviewer, nudge: { reviewer, members: [] } }), row, member, { description: `#${member.number}, waits on review from ${reviewer}` });
        if (group?.nudge && !group.nudge.members.some((candidate) => candidate.url === member.url)) group.nudge.members.push(member);
      } else if (team) add(`team:${team.toLowerCase()}`, () => ({ kind: 'team', label: team }), row, member, { description: `#${member.number}, waits on review from ${team}` });
      else add('review', () => ({ kind: 'review', label: 'a reviewer' }), row, member, { description: `#${member.number}, waits on a reviewer` });
    }
    for (const entry of row.entries)
      if (entry.reasons.includes('checks-pending')) add('ci', () => ({ kind: 'ci', label: 'CI' }), row, entry.member, { description: `#${entry.member.number}, checks running` });
  }
  for (const row of lanes(model, 'fix')?.rows ?? [])
    for (const entry of row.entries) {
      const reason = fixReason(entry.reasons);
      add('you', () => ({ kind: 'you', label: 'you' }), row, entry.member, { reason, description: `#${entry.member.number}, ${FIX_LABEL[reason].toLowerCase()}` });
    }
  const order: PersonGroup['kind'][] = ['person', 'team', 'review', 'ci', 'you'];
  const result = [...groups.values()].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || a.oldest - b.oldest || a.label.localeCompare(b.label));
  for (const group of result) {
    sortLines(group);
    const n = group.urls.length;
    if (group.kind === 'ci') group.detail = `${n} running`;
    else if (group.kind === 'you') {
      // Each PR under its first reason, so the counts add up to the PRs.
      const count = (reason: FixReason) => group.lines.filter((line) => line.reason === reason).length;
      const words: [FixReason, string, string][] = [['failing', 'failing check', 'failing checks'], ['conflicts', 'conflict', 'conflicts'], ['restack', 'restack', 'restacks']];
      group.detail = words.filter(([reason]) => count(reason)).map(([reason, one, many]) => plural(count(reason), one, many)).join(', ');
      // Failing first, then conflicts, then restacks; oldest first within each.
      const rank = (line: GroupLine) => words.findIndex(([reason]) => reason === line.reason);
      group.lines.sort((a, b) => rank(a) - rank(b) || a.since - b.since);
    } else {
      group.detail = `${prs(n)} · ${waitingLabel(group.oldest, now)}`;
      group.check = checksOf(input, group.lines.map((line) => line.member));
    }
  }
  if (stackGroups.length) {
    // The base can merge first (approved and passing, then without review), then a base that needs you, then the
    // rest; the oldest first within each.
    const rank = (group: PersonGroup) => (group.step?.action === 'merge' ? 0 : group.step?.caveats ? 1 : group.step?.actionable ? 2 : 3);
    stackGroups.sort((a, b) => rank(a) - rank(b) || a.oldest - b.oldest || a.label.localeCompare(b.label));
    const urls = stackGroups.flatMap((group) => group.urls);
    const stacksGroup: PersonGroup = {
      key: 'stacks',
      kind: 'stacks',
      label: 'Waiting for earlier PRs in a stack to merge',
      detail: `${prs(urls.length)} in ${plural(stackGroups.length, 'stack', 'stacks')}`,
      rows: unique(stackGroups.flatMap((group) => group.rows)),
      urls,
      repos: unique(stackGroups.flatMap((group) => group.repos)),
      lines: [],
      oldest: Math.min(...stackGroups.map((group) => group.oldest)),
      children: stackGroups,
    };
    const at = result.findIndex((group) => group.kind === 'you');
    result.splice(at < 0 ? result.length : at, 0, stacksGroup);
  }
  return result;
}

export type DecisionReason = 'failing' | 'unapproved' | 'idle';
export interface DecisionItem {
  /** `decide|${row.id}` */
  id: string;
  row: OverviewRow;
  /** The PR Close and Snooze act on. */
  member: ReviewMember;
  reason: DecisionReason;
  /** "Failing checks", "Never approved", "Idle". The age is its own column (`since`). */
  label: string;
  /** When the PR started failing, opened, or was last updated, and where that time comes from. */
  since: number;
  source: OverviewSinceSource;
  check: CheckView;
  /** Comments, inline review comments included (`commentsOf`). */
  comments?: number;
  /** The PR also has merge conflicts with its base: shown beside its reason with the conflict icon. */
  conflicts?: boolean;
}
/**
 * Needs a decision: your PRs failing checks for over a week, mergeable but never approved over a week after they
 * opened, or idle (no push, review or comment) for over a week. One reason each, in that order; oldest first.
 */
export function needsDecision(input: Pick<MorningInput, 'model' | 'now' | 'signals' | 'hidden'>): DecisionItem[] {
  const { now } = input;
  const items: DecisionItem[] = [];
  const seen = new Set<string>();
  for (const row of ownRows(input.model)) {
    if (row.kind === 'stack' && row.entries.length > 1) continue;
    const member = row.focus;
    // One reason per PR: the first lane that gives one (Fix, then Merge, Waiting, Answer).
    if (seen.has(member.url) || input.hidden?.has(member.url)) continue;
    const updated = time(member.updatedAt) ?? now;
    const created = time(member.createdAt) ?? now;
    let item: Pick<DecisionItem, 'reason' | 'label' | 'since' | 'source'> | undefined;
    if (row.lane === 'fix' && row.reasons.includes('checks-failed') && now - row.since >= DECISION_MS) item = { reason: 'failing', label: 'Failing checks', since: row.since, source: row.source };
    else if (row.merge && row.merge.notes[0]?.kind === 'unapproved' && now - created >= DECISION_MS) item = { reason: 'unapproved', label: 'Never approved', since: created, source: 'opened' };
    else if (now - updated >= DECISION_MS) item = { reason: 'idle', label: 'Idle', since: updated, source: 'updated' };
    if (item) {
      seen.add(member.url);
      const comments = commentsOf(input, [member]);
      const conflicts = row.entries.find((entry) => entry.member.url === member.url)?.reasons.includes('conflicts') ?? false;
      items.push({ id: `decide|${row.id}`, row, member, ...item, check: checksOf(input, [member]), ...(comments !== undefined ? { comments } : {}), ...(conflicts ? { conflicts } : {}) });
    }
  }
  return items.sort((a, b) => a.since - b.since || a.row.title.localeCompare(b.row.title));
}

/** The tab count: PRs in Next up and Waiting on you, each once. */
export function morningCount(next: readonly Pick<NextItem, 'urls'>[], you: readonly Pick<PersonGroup, 'urls'>[]): number {
  return new Set([...next.flatMap((item) => item.urls), ...you.flatMap((group) => group.urls)]).size;
}

export interface MorningPage {
  next: NextUp;
  decide: DecisionItem[];
  you: PersonGroup[];
  others: PersonGroup[];
  /** PRs waiting on you that an earlier section lists instead: the Next up rows that hold them, and Needs a decision's. */
  youElsewhere: YouElsewhere;
  /** The tab count (`morningCount`). */
  count: number;
  /** The sentence under the title, counted from these sections (`morningBriefing`). */
  briefing: Briefing;
}
export interface YouElsewhere {
  /** Next up's rows that hold PRs waiting on you: "#377", "#37286’s stack (6 PRs)". */
  next: { label: string; urls: string[] }[];
  /** PRs waiting on you that Needs a decision lists. */
  decide: string[];
}

/** A link in a sentence: it scrolls to and focuses the rows of `place` that list `urls`. */
export interface PageLink {
  text: string;
  urls: string[];
  place: AlsoPlace;
}
/**
 * What Waiting on you says about the PRs waiting on you that it does not list: where they are, by name, as links.
 * "#377 and #37286’s stack (6 PRs) are in Next up.", "#311 is in Next up, and 2 are in Needs a decision.", and
 * "Nobody is waiting on you." when nobody is. Empty when the section lists them all.
 */
export function waitingOnYouNote(listed: number, elsewhere: YouElsewhere): { parts: (string | PageLink)[]; text: string } {
  const parts: (string | PageLink)[] = [];
  const names = elsewhere.next.map((entry) => entry.label);
  const decide = elsewhere.decide.length;
  if (!names.length && !decide) {
    const text = listed ? '' : 'Nobody is waiting on you.';
    return { parts: text ? [text] : [], text };
  }
  if (names.length) {
    const shown = names.length > 3 ? [...names.slice(0, 2), `${names.length - 2} more`] : names;
    const list = shown.length > 1 ? `${shown.slice(0, -1).join(', ')} and ${shown.at(-1)}` : shown[0];
    const many = names.length > 1 || elsewhere.next[0].urls.length > 1;
    parts.push({ text: `${list} ${many ? 'are' : 'is'} in Next up`, urls: elsewhere.next.flatMap((entry) => entry.urls), place: 'next' });
  }
  if (decide) {
    if (parts.length) parts.push(', and ');
    parts.push({ text: `${decide} ${decide === 1 ? 'is' : 'are'} in Needs a decision`, urls: elsewhere.decide, place: 'decide' });
  }
  parts.push('.');
  return { parts, text: parts.map((part) => (typeof part === 'string' ? part : part.text)).join('') };
}

/** What a Next up row is called where another line points at it: "#377", "STACK: EPIC (4 PRs)", "#37286’s stack (6 PRs)". */
export function nextItemName(item: Pick<NextItem, 'member' | 'urls' | 'row'>): string {
  if (item.urls.length <= 1) return `#${item.member.number}`;
  const name = item.row.item.subject.name;
  const short = name && name.length <= 24 && !item.row.item.subject.members.some((member) => member.title === name);
  return short ? `${name} (${prs(item.urls.length)})` : `#${item.member.number}’s stack (${prs(item.urls.length)})`;
}

/** A number in the briefing: the PRs it counts, which the page lists in rows (or on the quiet line under Next up). */
export type BriefingKey = 'replies' | 'reviews' | 'rereviews' | 'approved' | 'unreviewed' | 'failing' | 'conflicts' | 'rebase' | 'decide' | 'waiting';
export interface BriefingCount {
  key: BriefingKey;
  /** The link's words: "7 re-reviews", "13", "your reply". */
  text: string;
  count: number;
  urls: string[];
  /** Merges: the quiet line under Next up lists the ones no row lists. */
  line?: boolean;
}
export interface Briefing {
  /** Words and links, in order. */
  parts: (string | BriefingCount)[];
  text: string;
  counts: BriefingCount[];
}

/**
 * The briefing. Every number is counted from the sections below it, never apart from them, and links to the rows it
 * counts. Each PR counts once, under its section's reason.
 * - Who is blocked on you: replies and change requests on your PRs (at most two people named), then reviews and
 *   re-reviews, each saying how many sit in stacks: "7 re-reviews (6 in one stack) are waiting on you."
 * - Your PRs: approved merges (Next up's rows, and the quiet line), merges without review (the quiet line), then fixes
 *   by their first reason, as the You group counts them: failing checks, conflicts, rebasing. A fix Needs a decision
 *   lists is counted there instead.
 * - Decisions: "7 PRs need a decision."
 * - With none of these: "Nothing needs you right now.", and how many of your PRs wait on others.
 */
export function morningBriefing(input: Pick<MorningInput, 'model' | 'hidden'>, page: Pick<MorningPage, 'next' | 'decide' | 'others'>): Briefing {
  const hidden = input.hidden ?? new Set<string>();
  const decided = new Set(page.decide.map((item) => item.member.url));
  const open = (rows: readonly OverviewRow[]) =>
    rows.map((row) => ({ row, urls: row.entries.map((entry) => entry.member.url).filter((url) => !hidden.has(url)) })).filter(({ urls }) => urls.length);
  const counts: BriefingCount[] = [];
  const count = (key: BriefingKey, urls: readonly string[], text: (n: number) => string, extra: Partial<BriefingCount> = {}): BriefingCount | undefined => {
    const all = unique(urls);
    if (!all.length) return undefined;
    const value: BriefingCount = { key, text: text(all.length), count: all.length, urls: all, ...extra };
    counts.push(value);
    return value;
  };
  type Clause = (string | BriefingCount)[];
  const parts: (string | BriefingCount)[] = [];
  const sentence = (clauses: Clause[]) => {
    if (!clauses.length) return;
    if (parts.length) parts.push(' ');
    clauses.forEach((clause, i) => {
      if (i) parts.push(i < clauses.length - 1 ? ', ' : clauses.length > 2 ? ', and ' : ' and ');
      parts.push(...clause);
    });
    parts.push('.');
  };

  // Who is blocked on you.
  const blocked: Clause[] = [];
  const answer = open(lanes(input.model, 'answer')?.rows ?? []);
  const people = unique(answer.map(({ row }) => row.person).filter((person): person is string => !!person));
  const replies = count('replies', answer.flatMap(({ urls }) => urls), (n) => (n === 1 && people.length ? 'your reply' : prs(n)));
  if (replies) {
    const who = people.length > 2 ? `${people[0]}, ${people[1]} and ${plural(people.length - 2, 'other', 'others')}` : people.join(' and ');
    if (!people.length) blocked.push([replies, ` ${replies.count === 1 ? 'is' : 'are'} waiting on your reply`]);
    else if (replies.count === 1) blocked.push([`${who} is waiting on `, replies]);
    else blocked.push([`${who} ${people.length > 1 ? 'are' : 'is'} waiting on your reply on `, replies]);
  }
  const review = open(lanes(input.model, 'review')?.rows ?? []);
  const reviewClause: Clause = [];
  let reviews = 0;
  for (const kind of [
    { key: 'reviews' as const, rows: review.filter(({ row }) => !row.reasons.includes('updated-since-review')), one: 'review', many: 'reviews' },
    { key: 'rereviews' as const, rows: review.filter(({ row }) => row.reasons.includes('updated-since-review')), one: 're-review', many: 're-reviews' },
  ]) {
    const value = count(kind.key, kind.rows.flatMap(({ urls }) => urls), (n) => plural(n, kind.one, kind.many));
    if (!value) continue;
    reviews += value.count;
    // Stacks are spelled out, so six PRs of one stack do not read as six separate reviews.
    const stacked = kind.rows.filter(({ urls }) => urls.length > 1);
    const inStacks = stacked.reduce((total, { urls }) => total + urls.length, 0);
    const where = stacked.length === 1 ? 'one stack' : `${stacked.length} stacks`;
    if (reviewClause.length) reviewClause.push(' and ');
    reviewClause.push(value);
    if (stacked.length) reviewClause.push(inStacks === value.count ? ` (${stacked.length === 1 ? 'one stack' : `in ${where}`})` : ` (${inStacks} in ${where})`);
  }
  if (reviewClause.length) blocked.push([...reviewClause, ` ${reviews === 1 ? 'is' : 'are'} waiting on you`]);
  sentence(blocked);

  // Your PRs: merges, then fixes by their first reason.
  const own: Clause[] = [];
  const listed = page.next.items.filter((item) => item.kind === 'merge');
  const approved = count('approved', [...listed.flatMap((item) => item.urls), ...page.next.moreApproved], (n) => plural(n, 'approved PR', 'approved PRs'), page.next.moreApproved.length ? { line: true } : {});
  if (approved) own.push([approved, ' can merge']);
  const unreviewed = count('unreviewed', page.next.unreviewed, (n) => (approved ? `${n} more` : prs(n)), { line: true });
  if (unreviewed) own.push([unreviewed, ' can merge without review']);
  const fixes = (lanes(input.model, 'fix')?.rows ?? []).flatMap((row) => row.entries).filter((entry) => !hidden.has(entry.member.url) && !decided.has(entry.member.url));
  const fixWords: [FixReason, BriefingKey, string, string][] = [
    ['failing', 'failing', 'has failing checks', 'have failing checks'],
    ['conflicts', 'conflicts', 'has conflicts', 'have conflicts'],
    ['restack', 'rebase', 'needs rebasing', 'need rebasing'],
  ];
  for (const [reason, key, one, many] of fixWords) {
    // The first number of the sentence names its unit: "13 PRs have failing checks"; later ones are bare: "4 have conflicts".
    const lead = !own.length;
    const value = count(key, fixes.filter((entry) => fixReason(entry.reasons) === reason).map((entry) => entry.member.url), (n) => (lead ? prs(n) : `${n}`));
    if (value) own.push([value, ` ${value.count === 1 ? one : many}`]);
  }
  sentence(own);
  const decide = count('decide', page.decide.map((item) => item.member.url), (n) => prs(n));
  if (decide) sentence([[decide, ` ${decide.count === 1 ? 'needs' : 'need'} a decision`]]);

  if (!parts.length) {
    parts.push('Nothing needs you right now.');
    const waiting = count('waiting', page.others.flatMap((group) => group.urls), (n) => (n === 1 ? '1 of your PRs' : `${n} of your PRs`));
    if (waiting) parts.push(' ', waiting, ` ${waiting.count === 1 ? 'is' : 'are'} waiting on others.`);
  }
  return { parts, text: parts.map((part) => (typeof part === 'string' ? part : part.text)).join(''), counts };
}

/** Every section, each PR in one: Next up, then Needs a decision, Waiting on you and Waiting on others. */
export function morningPage(input: MorningInput): MorningPage {
  const hidden = input.hidden ?? new Set<string>();
  const all = needsDecision(input);
  const next = nextUp({ ...input, stale: new Set(all.map((item) => item.member.url)) });
  const claimed = new Map<string, Place>([...hidden].map((url) => [url, 'hidden' as const]));
  for (const item of next.items) for (const url of item.urls) claimed.set(url, 'next');
  const decide = all.filter((item) => !claimed.has(item.member.url));
  for (const item of decide) claimed.set(item.member.url, 'decide');
  const you = waitingOnYou(input, claimed);
  const others = waitingOnOthers(input, claimed);
  // Waiting on you before decisions claim their PRs, as the tab has always counted it.
  const waiting = waitingOnYou(input, new Map([...hidden].map((url) => [url, 'hidden' as const])));
  const yours = new Set(waiting.flatMap((group) => group.urls));
  const youElsewhere: YouElsewhere = {
    next: next.items
      .map((item) => ({ item, urls: item.urls.filter((url) => yours.has(url)) }))
      .filter(({ urls }) => urls.length)
      .map(({ item, urls }) => ({ label: nextItemName(item), urls })),
    decide: decide.map((item) => item.member.url).filter((url) => yours.has(url)),
  };
  const count = morningCount(next.items, waiting);
  return { next, decide, you, others, youElsewhere, count, briefing: morningBriefing(input, { next, decide, others }) };
}

// ── Writes: Nudge and Close PR ──

/** Nudge: re-request `reviewer`'s review on each PR, through the requested-reviewers API. */
export function nudgeRequests(group: Pick<PersonGroup, 'nudge'>): { prUrl: string; action: 'nudge'; reviewer: string }[] {
  if (!group.nudge) return [];
  const { reviewer, members } = group.nudge;
  return members.map((member) => ({ prUrl: member.url, action: 'nudge' as const, reviewer }));
}
/** The confirmation's words for a nudge. */
export function nudgeConfirmation(group: Pick<PersonGroup, 'nudge'>): { title: string; body: string; action: string } {
  const reviewer = group.nudge?.reviewer ?? '';
  const members = group.nudge?.members ?? [];
  const list = members.map((member) => `#${member.number}`).join(', ');
  return {
    title: `Nudge ${reviewer}?`,
    body: `Gnosis asks GitHub to request ${reviewer}’s review again on ${members.length === 1 ? 'PR' : 'PRs'} ${list}. GitHub notifies ${reviewer}.`,
    action: members.length === 1 ? 'Re-request review' : `Re-request ${members.length} reviews`,
  };
}
/** Close PR: the request, with the optional comment trimmed (empty means none). */
export function closeRequest(
  state: { account: string; url: string; headSha: string; baseSha: string; baseBranch: string },
  comment: string
): { account: string; kind: 'close'; url: string; revisions: { url: string; headSha: string; baseSha: string; baseBranch: string }[]; comment?: string } {
  const body = comment.trim();
  return {
    account: state.account,
    kind: 'close',
    url: state.url,
    revisions: [{ url: state.url, headSha: state.headSha, baseSha: state.baseSha, baseBranch: state.baseBranch }],
    ...(body ? { comment: body } : {}),
  };
}
export function closeConfirmation(member: Pick<ReviewMember, 'number' | 'title' | 'repo'>): { title: string; body: string; action: string } {
  return {
    title: `Close #${member.number}?`,
    body: `${member.repo} #${member.number} “${member.title}” closes without merging. You can reopen it on GitHub later.`,
    action: 'Close PR',
  };
}
