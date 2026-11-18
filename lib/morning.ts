/**
 * The Overview's morning page (#390): the questions a reviewer asks on arrival, in order. Pure; built from the lane
 * model (`lib/overview.ts`) and a few reads the page adds. `morningPage` builds every section at once.
 *
 * 1. **Since yesterday:** `lib/since-log.ts`.
 * 2. **Next up** (`nextUp`): the next few things to do, cheapest first, each with one action and its effort.
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
 * so the section says where it went (`waitingOnYouNote`): "All 7 are in Next up." when it is empty for that reason,
 * "2 more are in Next up." under its rows. "Nobody is waiting on you." only when nobody is. The briefing's reviews
 * are the PRs in all three places.
 *
 * **Next up** (`nextUp`), at most `NEXT_LIMIT` items, whenever there is any work in Waiting on you, Fix or Merge:
 * - Candidates: ready merges (approved, or nobody reviewed and the branch rules require no review), replies, change
 *   requests, re-reviews, reviews of any size, and fixes (failing checks, conflicts, restacks).
 * - Order: estimated effort, cheapest first; then approved before not reviewed; then the merge that unblocks most
 *   PRs; then PRs within `QUICK_LINES` changed lines before larger ones; then the longest wait. Size never excludes.
 *   PRs that need a decision (stuck over a week) come after the rest, so they stay in Needs a decision unless there is
 *   nothing else to do.
 * - A stacked PR whose base has not merged is not the next step; its base is. A ready base says what it unblocks:
 *   "not reviewed · green · unblocks 3 PRs".
 * - **One row per stack, with its one next step.** When you owe a review or re-review on any PR of a stack (its base
 *   included), the review is the next step: the base's merge is not offered, and the review row says what follows
 *   ("6 PRs · updated since your review · then merge #35392"). Otherwise the stack's cheapest step is its row. A stack
 *   row leads with the number of its first PR in merge order that needs you, like any other row.
 * - Merges nobody reviewed keep the "not reviewed" label, at most `UNREVIEWED_LIMIT` of them. The rest are counted
 *   on a quiet line (`nextMoreLine`): "N more ready, not reviewed" when some are listed, "N ready to merge without
 *   review" when none are. It opens the review queue grouped by Action at Merge.
 * - The oldest review request always gets a slot, whatever its size: it replaces the last item when the rest fill
 *   the section.
 * - The heading's hint is the sum of the items' efforts: "~45 min".
 *
 * **Effort** (`nextEffort`), in minutes, rough on purpose. Over 15 minutes it rounds to 5; an item shows "1 h+" from
 * an hour (`effortShort`).
 * - Merge a green PR: 1. Reply to a thread: 3. Address requested changes: 15.
 * - Fix: failing checks 10, conflicts 15, a restack 5, per PR.
 * - Re-review: 2, plus 1 for every 50 lines changed since your review up to 400, then 1 for every 80 (5 when the size
 *   is not known yet).
 * - Review: 3, plus 1 for every 40 lines up to 400, then 1 for every 60 lines; `UNKNOWN_REVIEW_LINES` when the size
 *   is not known yet. A ready explanation takes a third off. A 1,060-line review is ~25 min, 2,800 lines ~55 min.
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
/** Mergeable PRs nobody reviewed, listed at most in Next up. The rest are counted under it. */
export const UNREVIEWED_LIMIT = 2;
/** Size only orders Next up: within equal effort, PRs this small (or a stack in total) come first. */
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
  /** A merge of a PR nobody reviewed: the branch rules require no review. Capped at `UNREVIEWED_LIMIT`. */
  unreviewed?: boolean;
  /** A merge of a stack's base: the open PRs above it, which can merge once it has. */
  unblocks?: number;
  /** A fix: what is wrong. */
  fix?: FixReason;
  /** One line: "approved by lena · green", "not reviewed · green · unblocks 3 PRs", "1060 lines", "failing checks". */
  why: string;
  /** Estimated minutes (`nextEffort`). */
  minutes: number;
  /** Changed lines, when known: only orders items of equal effort. */
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
  /** Ready merges nobody reviewed that are not listed, and whose stack has no row in Next up. */
  moreUnreviewed: number;
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

const roundEffort = (minutes: number) => (minutes > 15 ? Math.round(minutes / 5) * 5 : minutes);
const FIX_MINUTES: Readonly<Record<FixReason, number>> = { failing: 10, conflicts: 15, restack: 5 };
/** Minutes an item takes. See "Effort" at the top of this file. */
export function nextEffort(kind: NextKind, lines?: number, explanation = false, fix: FixReason = 'failing'): number {
  if (kind === 'merge') return 1;
  if (kind === 'reply') return 3;
  if (kind === 'changes') return 15;
  if (kind === 'fix') return FIX_MINUTES[fix];
  if (kind === 'rereview') return lines === undefined ? 5 : roundEffort(2 + Math.ceil(Math.min(lines, 400) / 50) + Math.ceil(Math.max(0, lines - 400) / 80));
  const size = lines ?? UNKNOWN_REVIEW_LINES;
  const minutes = 3 + Math.ceil(Math.min(size, 400) / 40) + Math.ceil(Math.max(0, size - 400) / 60);
  return roundEffort(explanation ? Math.max(1, Math.round((minutes * 2) / 3)) : minutes);
}
/** An item's effort: "~25 min", and "1 h+" from an hour. */
export const effortShort = (minutes: number) => (minutes >= 60 ? '1 h+' : `~${minutes} min`);
/** A total: "~10 min", "~1 h 20 min". */
export function effortLabel(minutes: number): string {
  if (minutes < 60) return `~${minutes} min`;
  const rest = minutes % 60;
  return `~${Math.floor(minutes / 60)} h${rest ? ` ${rest} min` : ''}`;
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

/** The order of Next up. See the rules at the top of this file. */
const nextOrder = (stale: ReadonlySet<string>) => {
  const tier = (item: NextItem) => (item.urls.some((url) => stale.has(url)) ? 1 : 0);
  const large = (item: NextItem) => (item.lines !== undefined && item.lines > QUICK_LINES ? 1 : 0);
  return (a: NextItem, b: NextItem) =>
    tier(a) - tier(b) ||
    a.minutes - b.minutes ||
    Number(!!a.unreviewed) - Number(!!b.unreviewed) ||
    (b.unblocks ?? 0) - (a.unblocks ?? 0) ||
    large(a) - large(b) ||
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
      kind: 'merge', row, title: member.title, member, why, minutes: nextEffort('merge'), lines: memberLines(member), urls: [member.url],
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
        minutes: nextEffort('rereview', lines),
      });
      continue;
    }
    const lines = quickSize(row);
    const explanation = !!row.explanation;
    add({
      kind: 'review', row, title: row.title, member: leadMember(row), urls, lines,
      why: stackPrefix(row) + [lines === undefined ? 'size not known yet' : plural(lines, 'line', 'lines'), explanation ? 'explanation ready' : ''].filter(Boolean).join(' · '),
      minutes: nextEffort('review', lines, explanation),
    });
    const item = candidates.at(-1);
    if (item?.row === row && row.reasons.includes('review-requested')) requests.push(item);
  }
  for (const row of lanes(model, 'answer')?.rows ?? []) {
    const urls = entryMembers(row).map((member) => member.url);
    if (row.reasons.includes('replies')) {
      const reply = input.replies?.[row.focus.url];
      add({
        kind: 'reply', row, title: row.title, member: leadMember(row), urls, minutes: nextEffort('reply'),
        why: reply ? `${reply.author}: “${quote(reply.text)}”` : `${row.person ?? 'Someone'} is waiting on your reply`,
      });
    } else if (row.reasons.includes('changes-requested'))
      add({ kind: 'changes', row, title: row.title, member: leadMember(row), urls, minutes: nextEffort('changes'), why: `${row.person ? `${row.person} requested` : 'Requested'} changes` });
  }
  for (const row of lanes(model, 'fix')?.rows ?? []) {
    const fix = fixReason(row.reasons);
    const minutes = roundEffort(row.entries.reduce((total, entry) => total + nextEffort('fix', undefined, false, fixReason(entry.reasons)), 0));
    add({ kind: 'fix', row, title: row.title, member: leadMember(row), fix, minutes, urls: entryMembers(row).map((member) => member.url), why: stackPrefix(row) + FIX_WORDS[fix] });
  }
  // A stack you owe a review on: the review is its next step, and its base merges after it.
  const reviewing = new Set(candidates.filter((item) => item.kind === 'review' || item.kind === 'rereview').map(stackKey));
  const deferred = new Map<string, NextItem>();
  const pool = candidates.filter((item) => {
    if (item.kind !== 'merge' || !reviewing.has(stackKey(item))) return true;
    deferred.set(stackKey(item), item);
    return false;
  });
  for (const item of pool) {
    const merge = (item.kind === 'review' || item.kind === 'rereview') && deferred.get(stackKey(item));
    if (merge) item.why = `${item.why} · then merge #${merge.member.number}`;
  }
  const order = nextOrder(input.stale ?? new Set());
  pool.sort(order);
  const items: NextItem[] = [];
  let unreviewed = 0;
  for (const item of pool) {
    if (items.length >= NEXT_LIMIT) break;
    // One row per stack: its cheapest step.
    if (items.some((listed) => stackKey(listed) === stackKey(item))) continue;
    if (item.unreviewed && unreviewed >= UNREVIEWED_LIMIT) continue;
    if (item.unreviewed) unreviewed++;
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
  const shown = new Set(items.map(stackKey));
  const moreUnreviewed = (lanes(model, 'merge')?.rows ?? []).filter(
    (row) =>
      row.merge?.notes[0]?.kind === 'no-review' && !row.merge.notes.some((note) => note.kind === 'base-open') &&
      !shown.has(row.item.subject.id) && !reviewing.has(row.item.subject.id) && !hidden.has(row.merge.member.url)
  ).length;
  return { items, moreUnreviewed };
}
/** The quiet line under Next up: "2 more ready, not reviewed" when some are listed, else "6 ready to merge without review". */
export function nextMoreLine(next: NextUp): string | undefined {
  if (next.moreUnreviewed <= 0) return undefined;
  return next.items.some((item) => item.unreviewed) ? `${next.moreUnreviewed} more ready, not reviewed` : `${next.moreUnreviewed} ready to merge without review`;
}
export const nextMinutes = (items: readonly Pick<NextItem, 'minutes'>[]) => items.reduce((total, item) => total + item.minutes, 0);
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
    return { member, row: merge, action: 'merge', actionable: true, caveats, text: unblocks ? `${merging} to unblock ${prs(unblocks)}` : merging };
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
    // The base can merge first, then a base that needs you, then the rest; the oldest first within each.
    const rank = (group: PersonGroup) => (group.step?.action === 'merge' ? 0 : group.step?.actionable ? 1 : 2);
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
  /** PRs waiting on you that an earlier section lists instead: Next up, Needs a decision. */
  youElsewhere: { next: number; decide: number };
  /** The tab count (`morningCount`). */
  count: number;
}

/**
 * What Waiting on you says about the PRs waiting on you that it does not list (`MorningPage.youElsewhere`).
 * `empty`: the text when it lists none. `more`: the quiet line under its rows when it lists some.
 */
export function waitingOnYouNote(listed: number, elsewhere: MorningPage['youElsewhere']): { empty: string; more?: string } {
  const { next, decide } = elsewhere;
  const total = next + decide;
  const is = (n: number) => (n === 1 ? 'is' : 'are');
  const where = next && decide ? `${next} in Next up and ${decide} in Needs a decision` : next ? 'in Next up' : 'in Needs a decision';
  if (!total) return { empty: 'Nobody is waiting on you.' };
  if (!listed) {
    const empty = next && decide ? `${total} ${is(total)} waiting on you: ${where}.` : total === 1 ? `The one PR waiting on you is ${where}.` : `All ${total} are ${where}.`;
    return { empty };
  }
  return { empty: '', more: next && decide ? `${total} more: ${where}.` : `${total} more ${is(total)} ${where}.` };
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
  const youElsewhere = { next: 0, decide: 0 };
  for (const url of waiting.flatMap((group) => group.urls)) {
    const place = claimed.get(url);
    if (place === 'next' || place === 'decide') youElsewhere[place]++;
  }
  const count = morningCount(next.items, waiting);
  return { next, decide, you, others, youElsewhere, count };
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
