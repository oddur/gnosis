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
 *    reviewer (with Nudge), teams, CI, and you (failing checks, conflicts, rebasing), each PR with its own reason.
 *
 * Needs a decision is drawn last on the page, but it claims its PRs before the Waiting sections do.
 *
 * **Starred** (`lib/overview-starred.ts`) is first on the page and claims its PRs before all of them: a starred PR is
 * listed there and in no other section, and the sections below leave it out of their rows and headings. The briefing
 * and the tab count still count it, and an empty section below that Starred took work from says "else"
 * (`MorningPage.starredHolds`).
 *
 * **Each PR once.** Sections list each PR once on the whole page, and a PR goes to the first section that wants it:
 * Next up, then Needs a decision, then Waiting on you, then Waiting on others. A PR in Next up is removed from the
 * section below it, so nothing appears twice on screen. Within Waiting on others: stacks, then reviewers, teams, CI,
 * then you. A stack's chain is the one exception: it shows the stack's structure, so it lists every PR of the stack as
 * a full line, even a PR another section lists. That line ends in a quiet link to the other section ("↑ Next up"),
 * and it does not count toward its section's heading. On the page a stack is one line until expanded (`stackLine`):
 * its name, repository, size and step, or "next step in Next up" when Next up lists the step. Chain rows say
 * `repo#number` when stacks from several repositories are on the page (`chainNumber`).
 *
 * **Unread dots** (`OverviewEntry.isNew`, `GroupLine.isNew`, `NextItem.isNew`): a PR's own state change since the last
 * visit (`entryChanged` in `lib/overview.ts`), never a row's other PRs, an update that changes no state, or a PR
 * that is only unopened.
 *
 * **Counts.** Next up's heading is the number of rows it shows (`nextCount`); a row that stands for several PRs says
 * so ("6 PRs · updated since your review"), and the quiet line under it keeps its own number. The other headings are
 * the number of PRs they list (`sectionCount`): a stack of five PRs waiting on your review is "5 PRs". A group's
 * `urls` are exactly its lines' PRs.
 *
 * **Waiting on you elsewhere.** A PR waiting on you that Next up or Needs a decision lists is not in Waiting on you,
 * so the section points at where it went, by name and as a link (`waitingOnYouNote`): "Shown in Next up: #377 and #37286’s
 * stack (6 PRs)." "Nobody is waiting on you." only when nobody is.
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
 *   "approved by lena · 3 PRs wait on it". Only an approved, passing base is a row, as for any merge. A row never says
 *   "green": its check state already shows passing.
 * - **One row per stack, with its one next step.** When you owe a review or re-review on any PR of a stack (its base
 *   included), the review is the next step: the base's merge is not offered, and the review row says what follows
 *   ("6 PRs · updated since your review · then merge #35392"). Otherwise the stack's first step in this order is its
 *   row. A stack row leads with the number of its first PR in merge order that needs you, like any other row.
 * - The oldest review request always gets a slot, whatever its size: it replaces the last item when the rest fill
 *   the section.
 *
 * **Effort rank** (`effortRank`): an internal ordering weight, never shown. It counts roughly in minutes, rough on
 * purpose, and over 15 it rounds to 5. The page shows no time estimates.
 * - Merge a passing PR: 1. Reply to a thread: 3. Address requested changes: 15.
 * - Fix: failing checks 10, conflicts 15, rebasing 5, per PR.
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
import { repoName, waitingLabel, type OverviewEntry, type OverviewModel, type OverviewReason, type OverviewRow, type OverviewSinceSource } from './overview';
import { prCommentTotal, type QueueSignals } from './queue-signals';
import type { ReviewMember, ReviewSubject } from './workbench';
import type { StarredSection } from './overview-starred';

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
/** "3 PRs wait on it": the PRs above a stack's base that merging it lets go ahead. */
const waitOnIt = (n: number) => `${prs(n)} ${n === 1 ? 'waits' : 'wait'} on it`;
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
  /** Any of its PRs changed state since the last visit (`OverviewEntry.isNew`): the unread dot. */
  isNew?: boolean;
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
  /** One line: "approved by lena", "approved by lena · 3 PRs wait on it", "1060 lines", "failing checks". */
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
    if (hidden.has(member.url)) continue;
    const gate = mergeGate(row, member, current({ signals }, member));
    if (gate === 'approved' || gate === 'unreviewed' || gate === 'other') result[gate].push(member.url);
  }
  return result;
}
/**
 * What a Merge lane row lets you do with one of its PRs, the one gate Next up, `readyMerges`, stack steps and Starred
 * share:
 * - `approved`: the PR the row merges (`OverviewMerge.member`), approved and passing: the Merge button.
 * - `unreviewed`: it needs no review; `other`: approved, without passing checks (none, or not known yet). Both can
 *   merge, and the page counts them, but they open the PR rather than merge it.
 * - `checks`: its checks are failing or running. `parked`: mergeable, not Ready (`OverviewMerge.ready`).
 * - `base-open`: another PR has to merge first: the PR below it in the stack, or the row's merge PR when this is not it.
 */
export type MergeGate = 'approved' | 'unreviewed' | 'other' | 'checks' | 'parked' | 'base-open';
export function mergeGate(row: Pick<OverviewRow, 'merge'>, member: Pick<ReviewMember, 'url'>, fresh: Pick<QueueSignals, 'checks'> | undefined): MergeGate {
  if (!row.merge || row.merge.member.url !== member.url || row.merge.notes.some((note) => note.kind === 'base-open')) return 'base-open';
  if (!row.merge.ready) return 'parked';
  const checks = fresh?.checks.state;
  if (checks === 'failure' || checks === 'pending') return 'checks';
  const review = row.merge.notes[0]?.kind;
  if (review === 'approved' && checks === 'success') return 'approved';
  if (review === 'no-review') return 'unreviewed';
  return 'other';
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
  /**
   * The Starred section (`lib/overview-starred.ts`). It is first on the page and claims its PRs before every other
   * section, so no other section lists them.
   */
  starred?: Pick<StarredSection, 'entries' | 'urls' | 'actionable'>;
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
const FIX_WORDS: Readonly<Record<FixReason, string>> = { failing: 'failing checks', conflicts: 'conflicts', restack: 'needs rebasing' };
/** Failing checks, Conflicts, Needs rebasing: the reason a PR is under You. */
export const FIX_LABEL: Readonly<Record<FixReason, string>> = { failing: 'Failing checks', conflicts: 'Conflicts', restack: 'Needs rebasing' };
/**
 * "needs rebasing after #35390 merged": a PR whose parent merged has to be rebased onto its base branch. The plain
 * words for a restack, the same in Next up, under You and in a stack's step.
 */
export function rebaseWords(subject: Pick<ReviewSubject, 'members' | 'edges'>, member: Pick<ReviewMember, 'url'>): string {
  const parent = subject.edges.filter((edge) => edge.child === member.url).map((edge) => subject.members.find((candidate) => candidate.url === edge.parent)).find((candidate) => candidate?.merged);
  return parent ? `needs rebasing after #${parent.number} merged` : 'needs rebasing';
}
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
  // Starred lists its PRs first; Next up leaves them out.
  const starred = new Set(input.starred?.urls ?? []);
  const candidates: NextItem[] = [];
  const add = (value: Omit<NextItem, 'id' | 'check' | 'since' | 'source' | 'comments'>) => {
    // A row for one PR of a stack names that PR, not the stack.
    const item = value.kind !== 'merge' && value.row.entries.length === 1 ? { ...value, title: value.member.title } : value;
    if (item.urls.some((url) => hidden.has(url) || starred.has(url))) return;
    const members = item.urls.map((url) => item.row.item.subject.members.find((member) => member.url === url)).filter((member): member is ReviewMember => !!member);
    // One PR waits since its own entry in the lane; a row for several since the oldest of them.
    const waited = sinceOf(item.row, members.length === 1 ? members[0] : undefined);
    const comments = commentsOf(input, members);
    const isNew = item.row.entries.some((entry) => entry.isNew && item.urls.includes(entry.member.url));
    candidates.push({ ...item, id: `next|${item.row.id}`, check: checksOf(input, members), ...waited, ...(comments !== undefined ? { comments } : {}), ...(isNew ? { isNew } : {}) });
  };
  for (const row of lanes(model, 'merge')?.rows ?? []) {
    const member = row.merge?.member ?? row.focus;
    // A PR stacked on one that has not merged waits for it: its base is the next step. Only a passing merge is a row.
    const gate = mergeGate(row, member, current(input, member));
    if (!row.merge || (gate !== 'approved' && !(gate === 'unreviewed' && current(input, member)?.checks.state === 'success'))) continue;
    const review = row.merge.notes[0];
    const unblocks = openAbove(row.item.subject, member).length;
    // The check state shows passing on the row: the words do not say "green" again.
    const why = [review.kind === 'approved' ? review.text.replace(/^Approved/, 'approved') : 'no review', unblocks ? waitOnIt(unblocks) : '']
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
    const words = fix === 'restack' && row.entries.length === 1 ? rebaseWords(row.item.subject, lead) : FIX_WORDS[fix];
    add({ kind: 'fix', row, title: row.title, member: lead, fix, rank, urls: entryMembers(row).map((member) => member.url), why: stackPrefix(row) + words, ...(unblocks ? { unblocks } : {}) });
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
    unreviewed: ready.unreviewed.filter((url) => !listed.has(url) && !starred.has(url)),
    moreApproved: [...ready.approved, ...ready.other].filter((url) => !listed.has(url) && !starred.has(url)),
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
export type Place = 'starred' | 'next' | 'decide' | 'you' | 'others' | 'hidden';
export const PLACE_LABEL: Readonly<Record<Exclude<Place, 'hidden' | 'others'>, string>> = { starred: 'Starred', next: 'Next up', decide: 'Needs a decision', you: 'Waiting on you' };
/**
 * Where a PR stands in its stack's chain. The first is "Next". Every PR after it is "Waiting" (on the PR below it),
 * whatever its own checks or review say: its check state shows beside it. "Conflicts" is the one exception, because
 * the PR needs you whatever happens below it. "Ready" is not used in chains: no PR above an open base can merge.
 */
export type ChainStatus = 'next' | 'waiting' | 'conflicts';
export const CHAIN_STATUS_LABEL: Readonly<Record<ChainStatus, string>> = { next: 'First', waiting: 'Waiting', conflicts: 'Conflicts' };

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
  /** Under You: why the PR needs you, and in words: "Failing checks", "Needs rebasing after #35390 merged". */
  reason?: FixReason;
  reasonText?: string;
  /** In a stack's chain: where the PR stands. */
  status?: ChainStatus;
  /** The accessible description, before the check state: "#377, waiting, after #376". */
  description: string;
  /** Its state changed since the last visit (`OverviewEntry.isNew`): the unread dot. */
  isNew?: boolean;
  /** A stack's base whose title names the stack: the header says it, so the line shows its number alone. */
  bare?: boolean;
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
   * "Merge #376; 3 PRs wait on it", "Merge #376 (no review, no checks); 3 PRs wait on it", "#36948 is waiting on
   * checks", "#379 waits on review from lena", "#379 has conflicts", "Review 6 PRs again first, then merge #35392".
   */
  text: string;
  /**
   * A merge: what the merge goes ahead without, in Next up's words: "no review", "no checks", "failing checks",
   * "checks running". Empty for an approved, passing base. The header and its button's tooltip both say them.
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
  /** The step is a Next up row already: the stack's line points there ("next step in Next up") with no action of its own. */
  inNext?: boolean;
  /** The step's PR is in Starred: the stack's line points there ("next step in Starred") with no action of its own. */
  inStarred?: boolean;
}
export interface PersonGroup {
  /** `person:lena`, `unassigned`, `team`, `team:org/name`, `review`, `ci`, `stack:owner/repo#380`, `stacks`, `you`. */
  key: string;
  kind: 'person' | 'unassigned' | 'team' | 'ci' | 'stack' | 'stacks' | 'you' | 'review';
  /** "lena", "Your team", "Checks", "Launcher i18n", "Waiting for earlier PRs in a stack to merge", "you". */
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
/**
 * A stack's one line, as the page shows it collapsed: its name, its repository, how many PRs, and its step, or where
 * its step is when Next up lists it. "Launcher i18n · seed-launcher · 5 PRs · #379 has conflicts".
 */
export function stackLine(stack: Pick<PersonGroup, 'label' | 'repos' | 'chain' | 'urls' | 'step'>, names: ReadonlyMap<string, string> = new Map()): string {
  const size = stack.chain?.length ?? stack.urls.length;
  const repo = stack.repos.length === 1 ? repositoryLabel(names, stack.repos[0]) : `${stack.repos.length} repos`;
  return [stack.label, repo, prs(size), stack.step?.inNext ? 'next step in Next up' : stack.step?.inStarred ? 'next step in Starred' : stack.step?.text].filter(Boolean).join(' · ');
}
/** Chain rows name their repository when stacks from several repositories are on the page: #384 is never ambiguous. */
export const qualifyChains = (stacks: Pick<PersonGroup, 'repos'>) => stacks.repos.length > 1;
/** A chain row's number: "seed-launcher#384" when `qualify`, else "#384". */
export const chainNumber = (member: Pick<ReviewMember, 'repo' | 'number'>, qualify: boolean, names: ReadonlyMap<string, string> = new Map()) =>
  qualify ? `${repositoryLabel(names, member.repo)}#${member.number}` : `#${member.number}`;

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
    const isNew = row.entries.some((entry) => entry.member.url === member.url && entry.isNew);
    return {
      id: member.url, row, member, title: member.title, since, source, target: prTarget(member.url) ?? row.target, check: checksOf(input, [member]),
      ...(comments !== undefined ? { comments } : {}), ...(isNew ? { isNew } : {}), description: `#${member.number}`, ...extra,
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
 * first; then PRs whose requester is not known ("Unknown requester"), and team requests last: "Your team · 3 review requests".
 * A PR in two lanes (a reply and a re-review) is listed once, under its oldest wait. PRs in `claimed` are left out.
 */
export function waitingOnYou(input: Pick<MorningInput, 'model' | 'now' | 'login' | 'signals'>, claimed = new Map<string, Place>()): PersonGroup[] {
  const { add, groups } = grouper(input, claimed, 'you');
  const rows = [...(lanes(input.model, 'answer')?.rows ?? []), ...(lanes(input.model, 'review')?.rows ?? [])].sort((a, b) => a.since - b.since);
  for (const row of rows) {
    const team = row.lane === 'review' && !row.reasons.includes('updated-since-review') && row.entries.every((entry) => reviewRequest(entry.member, input.login) === 'team');
    const person = row.person ?? (row.lane === 'review' && !same(row.focus.author, input.login) ? row.focus.author : undefined);
    for (const { member } of row.entries) {
      if (team) add('team', () => ({ kind: 'team', label: 'Your team' }), row, member);
      else if (person) add(`person:${person.toLowerCase()}`, () => ({ kind: 'person', label: person }), row, member);
      else add('unassigned', () => ({ kind: 'unassigned', label: 'Unknown requester' }), row, member);
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
 * checks" or "checks running". An approved, passing PR has none.
 */
export function mergeCaveats(row: Pick<OverviewRow, 'merge'>, checks?: Pick<CheckView, 'state'>): string[] {
  const caveats: string[] = [];
  if (row.merge?.notes[0]?.kind !== 'approved') caveats.push('no review');
  const words: Partial<Record<CheckView['state'], string>> = { neutral: 'no checks', failure: 'failing checks', pending: 'checks running' };
  const word = checks && words[checks.state];
  if (word) caveats.push(word);
  return caveats;
}

/**
 * What one open PR needs, from its rows in the lanes: the per-PR rule that stack steps (`stackStep`) and Starred
 * (`lib/overview-starred.ts`) share, so a PR reads the same wherever it is. People blocked on you come first, as in
 * Next up (`NEXT_TIER`): a reply or a change request, then a fix, a merge (with its `MergeGate`; a PR with a fix is
 * never in Merge), a parked merge, waiting on others, your review, nothing. A fix behind an answer stays known
 * (`fix`), so the line can say both. A stack step still names its base's fix first (`stackStep`).
 */
export interface PrNeed {
  kind: 'fix' | 'answer' | 'merge' | 'parked' | 'waiting' | 'review' | 'none';
  row?: OverviewRow;
  /** The PR's own entry in that row: its reasons there, and since when. */
  entry?: OverviewEntry;
  /** Its reasons in every lane, such as a reply that is also an update since your review. */
  all: ReadonlySet<OverviewReason>;
  /** Merge and parked: what the row lets you do with this PR. */
  gate?: MergeGate;
  /** `base-open`: the PR that has to merge first: its open parent, else the row's merge PR. */
  base?: ReviewMember;
  /** Its Fix row, also when an answer leads: "Awaiting your reply · failing checks". */
  fix?: OverviewRow;
  /**
   * Merge and parked: a review you owe on a PR of its stack. As in Next up, the review comes first and this PR merges
   * after it, so it offers no Merge and is not counted as work (`reviewFirst`).
   */
  owed?: OverviewRow;
}
/** "Review #61 first", "Review 3 PRs again first": what a stack's merge waits on when you owe a review in it. */
export const reviewFirst = (owed: Pick<OverviewRow, 'entries' | 'focus' | 'reasons'>) =>
  `Review ${owed.entries.length > 1 ? prs(owed.entries.length) : `#${owed.focus.number}`}${owed.reasons.includes('updated-since-review') ? ' again' : ''} first`;
export function prNeed(model: Pick<OverviewModel, 'lanes'>, member: ReviewMember, signals: MorningInput['signals']): PrNeed {
  const holds = (row: OverviewRow) => row.entries.some((entry) => entry.member.url === member.url);
  const find = (lane: OverviewRow['lane'], parked = false) => {
    const state = lanes(model, lane);
    return (parked ? state?.parked : state?.rows)?.find(holds);
  };
  const all = new Set<OverviewReason>();
  for (const state of model.lanes)
    for (const row of [...state.rows, ...state.parked])
      for (const entry of row.entries) if (entry.member.url === member.url) for (const reason of entry.reasons) all.add(reason);
  const need = (kind: PrNeed['kind'], row?: OverviewRow, extra: Partial<PrNeed> = {}): PrNeed => ({ kind, all, ...(row ? { row, entry: row.entries.find((entry) => entry.member.url === member.url) } : {}), ...extra });
  const merging = (row: OverviewRow, kind: 'merge' | 'parked') => {
    const gate = mergeGate(row, member, current({ signals }, member));
    // The PR directly below it in the stack, else the row's merge PR: in A→B→C, C waits for B.
    const base = gate !== 'base-open' ? undefined : (openParent(row.item.subject, member) ?? (row.merge && row.merge.member.url !== member.url ? row.merge.member : undefined));
    const owed = (lanes(model, 'review')?.rows ?? []).find((candidate) => candidate.item.subject.members.some((other) => other.url === member.url));
    // Parked or not, a PR that waits for another to merge first says so.
    return need(kind, row, { gate: kind === 'parked' && gate !== 'base-open' ? 'parked' : gate, ...(base ? { base } : {}), ...(owed ? { owed } : {}) });
  };
  const fix = find('fix');
  const answer = find('answer');
  if (answer) return need('answer', answer, fix ? { fix } : {});
  if (fix) return need('fix', fix, { fix });
  const merge = find('merge');
  if (merge) return merging(merge, 'merge');
  const parked = find('merge', true);
  if (parked) return merging(parked, 'parked');
  const waiting = find('waiting');
  if (waiting) return need('waiting', waiting);
  const review = find('review');
  if (review) return need('review', review);
  return need('none');
}

/**
 * What to do about one PR, decided once from its `prNeed` for stack steps and Starred, by Next up's rules:
 * - `verb`: a reply wins over a change request on the same PR (Next up's Reply); an update since your review is a
 *   re-review; a merge PR with a review owed in its stack (merge, checks running or parked alike) is `owed`, and opens
 *   that review; only an approved, passing merge PR merges.
 * - `row` and `target`: where the action lands: the owed review's row for `owed`, else the PR's own row.
 * - `fix`: its fix, leading or behind an answer, in Next up's words (`fixText`, "needs rebasing after #12 merged"
 *   from the fix row's stack), and `conflicts` when conflicts are the fix, for the icon.
 * - `isNew`: any entry it names changed since the last visit: its own, its fix's.
 */
export interface PrDecision {
  verb?: 'reply' | 'changes' | 'review' | 'rereview' | 'fix' | 'merge' | 'owed';
  row?: OverviewRow;
  target?: DeepLinkTarget;
  isNew: boolean;
  fix?: FixReason;
  fixText?: string;
  conflicts: boolean;
  /** `owed`: "Review #161 first, then merge #160", as the stack step says it. */
  owedText?: string;
}
export function prDecision(need: PrNeed, member: ReviewMember): PrDecision {
  const own = (row: OverviewRow | undefined) => row?.entries.find((entry) => entry.member.url === member.url);
  const fixEntry = own(need.fix);
  const fix = need.fix ? fixReason(fixEntry?.reasons ?? need.fix.reasons) : undefined;
  const fixText = need.fix && fix ? (fix === 'restack' ? rebaseWords(need.fix.item.subject, member) : FIX_WORDS[fix]) : undefined;
  const targetOf = (row: OverviewRow) => (row.focus.url === member.url ? row.target : (prTarget(member.url) ?? row.target));
  const base = { isNew: !!need.entry?.isNew || !!fixEntry?.isNew, conflicts: fix === 'conflicts', ...(fix ? { fix, fixText } : {}) };
  const row = need.row;
  if (!row) return base;
  const reasons = need.entry?.reasons ?? row.reasons;
  const merging = row.merge?.member.url === member.url;
  if (need.owed && ((need.kind === 'merge' && merging) || need.kind === 'parked'))
    return { ...base, verb: 'owed', row: need.owed, target: need.owed.target, owedText: `${reviewFirst(need.owed)}, then merge #${member.number}` };
  const verb: PrDecision['verb'] =
    need.kind === 'answer' ? (reasons.includes('replies') ? 'reply' : 'changes')
      : need.kind === 'review' ? (reasons.includes('updated-since-review') ? 'rereview' : 'review')
        : need.kind === 'fix' ? 'fix'
          : need.kind === 'merge' && need.gate === 'approved' ? 'merge'
            : undefined;
  return { ...base, ...(verb ? { verb } : {}), row, target: targetOf(row) };
}

/**
 * What the PR a stack waits on is waiting on itself, from its row in the lanes (`prNeed`, `prDecision`), and the
 * action that moves it. `checks`: the PR's check state, so a merge says what it goes ahead without (`mergeCaveats`).
 */
export function stackStep(model: Pick<OverviewModel, 'lanes'>, member: ReviewMember, login: string, unblocks: number, checks?: Pick<CheckView, 'state'>, signals: MorningInput['signals'] = () => undefined): StackStep {
  const n = `#${member.number}`;
  const need = prNeed(model, member, signals);
  const decision = prDecision(need, member);
  const reasons = need.entry?.reasons ?? need.row?.reasons ?? [];
  // A stack's base names its own fix first: the stack cannot merge until it is fixed.
  const fix = need.fix;
  if (fix && decision.fix) {
    const reason = decision.fix;
    return { member, row: fix, action: 'open', actionable: true, ...(decision.conflicts ? { conflicts: true } : {}), text: `${n} ${{ failing: 'has failing checks', conflicts: 'has conflicts', restack: decision.fixText ?? '' }[reason]}` };
  }
  const answer = need.kind === 'answer' ? need.row : undefined;
  if (answer) return { member, row: answer, action: 'open', actionable: true, text: reasons.includes('changes-requested') ? `${n} has changes requested` : `${n} waits on your reply` };
  // The row merges this PR (it is the row's merge PR), or it is set aside as Parked.
  const merge = need.kind === 'merge' && need.row?.merge?.member.url === member.url ? need.row : undefined;
  const parked = need.kind === 'parked' ? need.row : undefined;
  // In a Merge row that merges another PR first: it merges after that one.
  if (need.kind === 'merge' && !merge) return { member, action: 'open', actionable: false, text: `${n} has to merge first` };
  // You owe a review on a PR of this stack: the review comes first, and the base merges after it.
  if (decision.verb === 'owed' && decision.row && decision.owedText) {
    return { member, row: decision.row, action: 'review', actionable: true, text: decision.owedText };
  }
  if (merge) {
    const caveats = mergeCaveats(merge, checks);
    const merging = `Merge ${n}${caveats.length ? ` (${caveats.join(', ')})` : ''}`;
    // Only an approved, passing base gets the Merge button; one nobody reviewed, or without checks, opens the PR.
    return { member, row: merge, action: caveats.length ? 'open' : 'merge', actionable: true, caveats, text: unblocks ? `${merging}; ${waitOnIt(unblocks)}` : merging };
  }
  if (parked) return { member, row: parked, action: 'open', actionable: true, text: parked.merge?.notes[0]?.kind === 'approved' ? `${n} is approved and can merge` : `${n} can merge without review` };
  const waiting = need.kind === 'waiting' ? need.row : undefined;
  if (waiting) {
    if (reasons.includes('review-pending')) {
      const reviewer = member.requestedReviewers.find((name) => !same(name, login));
      const team = member.requestedTeams[0];
      if (reviewer) return { member, row: waiting, action: 'nudge', reviewer, actionable: false, text: `${n} waits on review from ${reviewer}` };
      return { member, row: waiting, action: 'open', actionable: false, text: team ? `${n} waits on review from ${team}` : `${n} waits on a review` };
    }
    return { member, row: waiting, action: 'open', actionable: false, text: `${n} is waiting on checks` };
  }
  const review = need.kind === 'review' ? need.row : undefined;
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
    const step = stackStep(model, root, login, openAbove(subject, root).length, checksOf(input, [root]), input.signals);
    // The step is a Next up row already: a review of the stack, or the base's own merge or fix.
    const stepUrls = step.action === 'review' && step.row ? step.row.entries.map((entry) => entry.member.url) : [step.member.url];
    if (stepUrls.some((url) => claimed.get(url) === 'next')) step.inNext = true;
    // Or Starred lists it: the line points there, and does not repeat its action.
    else if (stepUrls.some((url) => claimed.get(url) === 'starred')) step.inStarred = true;
    // Named by the stack, else by its base's title; the base's line then shows its number alone.
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
    node(root, step.action === 'review' ? row : (step.row ?? row), { status: 'next', description: `#${root.number}, merges first. ${step.text}`, ...(label === root.title ? { bare: true } : {}) });
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
      if (entry.reasons.includes('checks-pending')) add('ci', () => ({ kind: 'ci', label: 'Checks' }), row, entry.member, { description: `#${entry.member.number}, checks running` });
  }
  for (const row of lanes(model, 'fix')?.rows ?? [])
    for (const entry of row.entries) {
      const reason = fixReason(entry.reasons);
      const text = reason === 'restack' ? rebaseWords(row.item.subject, entry.member) : FIX_LABEL[reason].toLowerCase();
      add('you', () => ({ kind: 'you', label: 'you' }), row, entry.member, { reason, reasonText: `${text.charAt(0).toUpperCase()}${text.slice(1)}`, description: `#${entry.member.number}, ${text}` });
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
      const words: [FixReason, string, string][] = [['failing', 'failing check', 'failing checks'], ['conflicts', 'conflict', 'conflicts'], ['restack', 'needs rebasing', 'need rebasing']];
      group.detail = words.filter(([reason]) => count(reason)).map(([reason, one, many]) => plural(count(reason), one, many)).join(', ');
      // Failing first, then conflicts, then rebasing; oldest first within each.
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
  /** "Failing checks", "No approval", "No activity". The age is its own column (`since`). */
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
    else if (row.merge && row.merge.notes[0]?.kind === 'unapproved' && now - created >= DECISION_MS) item = { reason: 'unapproved', label: 'No approval', since: created, source: 'opened' };
    else if (now - updated >= DECISION_MS) item = { reason: 'idle', label: 'No activity', since: updated, source: 'updated' };
    if (item) {
      seen.add(member.url);
      const comments = commentsOf(input, [member]);
      const conflicts = row.entries.find((entry) => entry.member.url === member.url)?.reasons.includes('conflicts') ?? false;
      items.push({ id: `decide|${row.id}`, row, member, ...item, check: checksOf(input, [member]), ...(comments !== undefined ? { comments } : {}), ...(conflicts ? { conflicts } : {}) });
    }
  }
  return items.sort((a, b) => a.since - b.since || a.row.title.localeCompare(b.row.title));
}

/** The tab count: PRs in Next up and Waiting on you, and starred PRs that need you or can merge, each once. */
export function morningCount(next: readonly Pick<NextItem, 'urls'>[], you: readonly Pick<PersonGroup, 'urls'>[], starred: readonly string[] = []): number {
  return new Set([...next.flatMap((item) => item.urls), ...you.flatMap((group) => group.urls), ...starred]).size;
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
  /**
   * Starred holds PRs that would otherwise be in these sections, so their empty states say "else": "Nothing else needs
   * you right now." Waiting on you names them in its note instead (`YouElsewhere.starred`).
   */
  starredHolds: { next: boolean; others: boolean; decide: boolean };
}
export interface YouElsewhere {
  /** Next up's rows that hold PRs waiting on you: "#377", "#37286’s stack (6 PRs)". */
  next: { label: string; urls: string[] }[];
  /** PRs waiting on you that Needs a decision lists. */
  decide: string[];
  /** PRs waiting on you that Starred lists. */
  starred?: string[];
}

/** A link in a sentence: it scrolls to and focuses the rows of `place` that list `urls`. */
export interface PageLink {
  text: string;
  urls: string[];
  place: AlsoPlace;
}
/**
 * What Waiting on you says about the PRs waiting on you that it does not list: where they are, by name, as links.
 * "Shown in Next up: #377 and #37286’s stack (6 PRs).", "Shown in Next up: #311. Shown in Needs a
 * decision: 2 PRs.", and
 * "Nobody is waiting on you." when nobody is. Empty when the section lists them all.
 */
export function waitingOnYouNote(listed: number, elsewhere: YouElsewhere): { parts: (string | PageLink)[]; text: string } {
  const parts: (string | PageLink)[] = [];
  const names = elsewhere.next.map((entry) => entry.label);
  const decide = elsewhere.decide.length;
  const starred = elsewhere.starred ?? [];
  if (!names.length && !decide && !starred.length) {
    const text = listed ? '' : 'Nobody is waiting on you.';
    return { parts: text ? [text] : [], text };
  }
  if (starred.length) parts.push('Shown in Starred: ', { text: prs(starred.length), urls: starred, place: 'starred' }, '.');
  if (names.length) {
    if (parts.length) parts.push(' ');
    const shown = names.length > 3 ? [...names.slice(0, 2), `${names.length - 2} more`] : names;
    const list = shown.length > 1 ? `${shown.slice(0, -1).join(', ')} and ${shown.at(-1)}` : shown[0];
    parts.push('Shown in Next up: ', { text: list, urls: elsewhere.next.flatMap((entry) => entry.urls), place: 'next' }, '.');
  }
  if (decide) {
    if (parts.length) parts.push(' ');
    parts.push('Shown in Needs a decision: ', { text: prs(decide), urls: elsewhere.decide, place: 'decide' }, '.');
  }
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
 *   re-reviews, each saying how many sit in stacks: "7 updated PRs (6 in one stack) are waiting on your review."
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
  // Two clauses that each name people or kinds ("lena and owen …, and 7 reviews …") take a comma before "and".
  const sentence = (clauses: Clause[], comma = false) => {
    if (!clauses.length) return;
    if (parts.length) parts.push(' ');
    clauses.forEach((clause, i) => {
      if (i) parts.push(i < clauses.length - 1 ? ', ' : clauses.length > 2 || comma ? ', and ' : ' and ');
      parts.push(...clause);
    });
    parts.push('.');
  };

  // Who is blocked on you.
  const blocked: Clause[] = [];
  const answer = open(lanes(input.model, 'answer')?.rows ?? []);
  const people = unique(answer.map(({ row }) => row.person).filter((person): person is string => !!person));
  // One PR per person: "lena and owen are waiting on your replies". More PRs than people: "… on your reply on 3 PRs".
  const perPerson = people.length > 0 && answer.flatMap(({ urls }) => urls).length <= people.length;
  const replies = count('replies', answer.flatMap(({ urls }) => urls), (n) => (perPerson ? (n === 1 ? 'your reply' : 'your replies') : prs(n)));
  if (replies) {
    const who = people.length > 2 ? `${people[0]}, ${people[1]} and ${plural(people.length - 2, 'other', 'others')}` : people.join(' and ');
    const are = people.length > 1 ? 'are' : 'is';
    if (!people.length) blocked.push([replies, ` ${replies.count === 1 ? 'is' : 'are'} waiting on your reply`]);
    else if (perPerson) blocked.push([`${who} ${are} waiting on `, replies]);
    else blocked.push([`${who} ${are} waiting on your reply on `, replies]);
  }
  const review = open(lanes(input.model, 'review')?.rows ?? []);
  const reviewClause: Clause = [];
  let reviews = 0;
  for (const kind of [
    { key: 'reviews' as const, rows: review.filter(({ row }) => !row.reasons.includes('updated-since-review')), one: 'PR', many: 'PRs' },
    { key: 'rereviews' as const, rows: review.filter(({ row }) => row.reasons.includes('updated-since-review')), one: 'updated PR', many: 'updated PRs' },
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
  if (reviewClause.length) blocked.push([...reviewClause, ` ${reviews === 1 ? 'is' : 'are'} waiting on your review`]);
  sentence(blocked, true);

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
  // Starred is first on the page: it claims its PRs before every other section.
  for (const url of input.starred?.urls ?? []) if (!claimed.has(url)) claimed.set(url, 'starred');
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
    starred: (input.starred?.urls ?? []).filter((url) => yours.has(url)),
  };
  const starred = input.starred;
  const lines = (starred?.entries ?? []).flatMap((entry) => entry.lines);
  const starredHolds = {
    next: (starred?.actionable.length ?? 0) > 0,
    others: lines.some((line) => line.tier === 'others' || (line.tier === 'you' && line.row?.lane === 'fix')),
    decide: all.some((item) => claimed.get(item.member.url) === 'starred'),
  };
  // Starred moves PRs out of the sections below, but not out of the work there is. The briefing counts each PR in its
  // own section as if nothing were starred (a starred decision is still a decision, a starred PR waiting on others
  // still waits), and the tab count is the distinct work: Next up as it would be without stars, Waiting on you, and
  // the starred PRs that are work. Starring a PR Next up listed never raises it, though Next up refills.
  let briefing = morningBriefing(input, { next, decide, others });
  let count = morningCount(next.items, waiting);
  if (starred?.urls.length) {
    const plain = { ...input, starred: undefined };
    const plainNext = nextUp({ ...plain, stale: new Set(all.map((item) => item.member.url)) });
    const plainClaimed = new Map<string, Place>([...hidden].map((url) => [url, 'hidden' as const]));
    for (const item of plainNext.items) for (const url of item.urls) plainClaimed.set(url, 'next');
    const plainDecide = all.filter((item) => !plainClaimed.has(item.member.url));
    for (const item of plainDecide) plainClaimed.set(item.member.url, 'decide');
    // Waiting on you claims its PRs before Waiting on others, as on the page.
    waitingOnYou(plain, plainClaimed);
    const plainOthers = waitingOnOthers(plain, plainClaimed);
    briefing = morningBriefing(plain, { next: plainNext, decide: plainDecide, others: plainOthers });
    // A starred PR that needs a decision counts only where an unstarred one would: in Next up, or waiting on you.
    const stale = new Set(all.map((item) => item.member.url));
    count = morningCount(plainNext.items, waiting, starred.actionable.filter((url) => !stale.has(url)));
  }
  return { next, decide, you, others, youElsewhere, count, briefing, starredHolds };
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
    title: `Remind ${reviewer}?`,
    body: `Gnosis asks GitHub to request ${reviewer}’s review again on ${members.length === 1 ? 'PR' : 'PRs'} ${list}. GitHub notifies ${reviewer}.`,
    action: `Remind ${reviewer}`,
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
