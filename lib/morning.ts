/**
 * The Overview's morning page (#390): the questions a reviewer asks on arrival, in order. Pure; built from the lane
 * model (`lib/overview.ts`) and a few reads the page adds. See the last comment of #390 for the spec.
 *
 * 1. **Since yesterday:** `lib/since-log.ts`.
 * 2. **Move forward now:** quick wins across the lanes, each with one action and why it is quick (`moveForward`).
 * 3. **Waiting on you:** people blocked on you, grouped by person, oldest wait first, then PRs whose requester is
 *    not known ("unassigned") and team requests.
 * 4. **Waiting on others:** your PRs grouped by what blocks them: each requested reviewer (with Nudge), teams, CI,
 *    an earlier PR in a stack that has not merged yet, and you (failing checks, conflicts).
 * 5. **Needs a decision:** your PRs failing, never approved or idle for over a week. Close or snooze them.
 *
 * **Counts.** Every section heading is the sum of the PRs its rows stand for (`sectionCount`, `moveCount`), so the
 * heading always matches what the section lists. A row counts PRs, not rows: a stack of five PRs waiting on you is
 * "5 PRs". Within Waiting on you and Waiting on others each PR is listed under one row only.
 *
 * **Move forward now** (`moveForward`), at most `MOVE_LIMIT` rows:
 * - First, by effort, then the longest wait: approved merges, replies, re-reviews and small reviews.
 * - Then mergeable PRs nobody reviewed ("not reviewed · green": the branch rules require no review), at most
 *   `UNREVIEWED_LIMIT`, oldest first. The rest are counted on a quiet line under the section ("N more ready, not
 *   reviewed"), which opens the review queue grouped by Action at Merge.
 * - The oldest small review request always gets a slot when one qualifies: it replaces the last row when the others
 *   fill the section.
 * - A PR stacked on one that has not merged is not a quick win: it waits under its stack in Waiting on others.
 * - Size: a PR over `QUICK_LINES` changed lines, or a stack whose open PRs total more, is never a quick win, reviewed
 *   or not. It stays in the Merge counts and the queue. Replies are exempt: answering a thread does not depend on the
 *   PR's size. A PR whose size is not known yet waits until it is.
 *
 * **Effort heuristic** (`moveEffort`), in minutes, rough on purpose: it only orders the quick wins.
 * - Merge a green PR: 1.
 * - Reply to a thread: 3.
 * - Re-review: 2, plus 1 for every 50 lines changed since your review (5 when the size is not known yet).
 * - A small review (at most `SMALL_REVIEW_LINES` lines; twice that with an explanation ready, never over
 *   `QUICK_LINES`): 3, plus 1 for every 40 lines. A ready explanation takes a third off.
 *
 * **Tab count** (`morningCount`): the PRs in Move forward now and Waiting on you, each PR once. Work on your own PRs
 * that waits on others, and decisions, are not counted.
 */
import { reviewRequest } from './attention';
import { prTarget, type DeepLinkTarget } from './deep-link';
import { repoName, waitingLabel, type OverviewModel, type OverviewRow } from './overview';
import type { QueueSignals } from './queue-signals';
import type { ReviewMember } from './workbench';

const DAY_MS = 86_400_000;
/** Quick wins listed at most. */
export const MOVE_LIMIT = 6;
/** Mergeable PRs nobody reviewed, listed at most in Move forward now. The rest are counted under it. */
export const UNREVIEWED_LIMIT = 2;
/** A PR, or a stack in total, over this many changed lines is never a quick win. */
export const QUICK_LINES = 300;
/** A review this small, in changed lines, is a quick win (twice this with an explanation, up to `QUICK_LINES`). */
export const SMALL_REVIEW_LINES = 200;
/** Over this many stacks waiting on earlier PRs, Waiting on others folds them into one row. */
export const STACKS_SHOWN = 3;
/** Needs a decision: failing, never approved or idle for this long. */
export const DECISION_MS = 7 * DAY_MS;
/** Characters of a reply quoted on its row. */
export const QUOTE_LENGTH = 60;

const same = (a: string | undefined, b: string) => !!a && a.toLowerCase() === b.toLowerCase();
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const time = (value: string | undefined) => {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
};
const lanes = (model: Pick<OverviewModel, 'lanes'>, lane: OverviewRow['lane']) => model.lanes.find((state) => state.lane === lane);
const memberLines = (member: Pick<ReviewMember, 'additions' | 'deletions'>) =>
  member.additions === undefined && member.deletions === undefined ? undefined : (member.additions ?? 0) + (member.deletions ?? 0);
const isOpen = (member: ReviewMember) => member.state === 'open' && !member.merged;
const unique = <T,>(values: Iterable<T>) => [...new Set(values)];

/**
 * The size a quick win is judged by: a PR's changed lines, or the total of a stack's open PRs. Undefined while any of
 * them is not known.
 */
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

export type MoveKind = 'merge' | 'rereview' | 'reply' | 'review';
export interface MoveItem {
  /** `move|${row.id}` */
  id: string;
  kind: MoveKind;
  row: OverviewRow;
  /** A merge of a PR nobody reviewed: the branch rules require no review. Ranked after the rest, and capped. */
  unreviewed?: boolean;
  /** One line: "approved by lena · green", "not reviewed · green", "+42 lines since your review", "38 lines". */
  why: string;
  /** Estimated minutes (`moveEffort`). */
  minutes: number;
  /** The PRs the row's action covers: the one a merge merges, else the row's PRs. */
  urls: string[];
}
export interface MoveForward {
  items: MoveItem[];
  /** Ready merges nobody reviewed that are not listed: "N more ready, not reviewed". */
  moreUnreviewed: number;
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
}

/** Minutes a quick win takes. See the heuristic at the top of this file. */
export function moveEffort(kind: MoveKind, lines: number | undefined, explanation = false): number {
  if (kind === 'merge') return 1;
  if (kind === 'reply') return 3;
  if (kind === 'rereview') return lines === undefined ? 5 : 2 + Math.ceil(lines / 50);
  const minutes = 3 + Math.ceil((lines ?? SMALL_REVIEW_LINES) / 40);
  return explanation ? Math.max(1, Math.round((minutes * 2) / 3)) : minutes;
}
/** "~10 min", "~1 h 20 min". */
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

const entryUrls = (row: OverviewRow) => row.entries.map((entry) => entry.member.url);
/** "3 PRs · " before a stack row's reason, so the row says how many PRs it stands for. */
const stackPrefix = (row: OverviewRow) => (row.entries.length > 1 ? `${row.entries.length} PRs · ` : '');
const byEffort = (a: MoveItem, b: MoveItem) => a.minutes - b.minutes || a.row.since - b.row.since;

/** Move forward now: see the rules at the top of this file. */
export function moveForward(input: MorningInput): MoveForward {
  const { model } = input;
  const ranked: MoveItem[] = [];
  const unreviewed: MoveItem[] = [];
  const requests: MoveItem[] = [];
  const quick = (row: OverviewRow) => {
    const size = quickSize(row);
    return size !== undefined && size <= QUICK_LINES;
  };
  for (const row of lanes(model, 'merge')?.rows ?? []) {
    const member = row.merge?.member ?? row.focus;
    const signals = input.signals(member);
    // A PR stacked on one that has not merged waits for it: it is under its stack in Waiting on others.
    if (!row.merge?.ready || row.merge.notes.some((note) => note.kind === 'base-open')) continue;
    if (signals?.headSha !== member.headSha || signals.checks.state !== 'success' || !quick(row)) continue;
    const review = row.merge.notes[0];
    const merge = { id: `move|${row.id}`, kind: 'merge' as const, row, minutes: moveEffort('merge', undefined), urls: [member.url] };
    if (review.kind === 'approved') ranked.push({ ...merge, why: `${review.text.replace(/^Approved/, 'approved')} · green` });
    else if (review.kind === 'no-review') unreviewed.push({ ...merge, unreviewed: true, why: 'not reviewed · green' });
  }
  for (const row of lanes(model, 'review')?.rows ?? []) {
    if (!quick(row)) continue;
    if (row.reasons.includes('updated-since-review')) {
      const lines = input.rereviewLines?.[row.focus.url];
      ranked.push({
        id: `move|${row.id}`,
        kind: 'rereview',
        row,
        why: stackPrefix(row) + (lines === undefined ? 'updated since your review' : `+${plural(lines, 'line', 'lines')} since your review`),
        minutes: moveEffort('rereview', lines),
        urls: entryUrls(row),
      });
      continue;
    }
    const lines = quickSize(row) ?? 0;
    const explanation = !!row.explanation;
    if (lines > Math.min(QUICK_LINES, SMALL_REVIEW_LINES * (explanation ? 2 : 1))) continue;
    const item: MoveItem = {
      id: `move|${row.id}`,
      kind: 'review',
      row,
      why: stackPrefix(row) + [plural(lines, 'line', 'lines'), explanation ? 'explanation ready' : ''].filter(Boolean).join(' · '),
      minutes: moveEffort('review', lines, explanation),
      urls: entryUrls(row),
    };
    ranked.push(item);
    if (row.reasons.includes('review-requested')) requests.push(item);
  }
  for (const row of lanes(model, 'answer')?.rows ?? []) {
    if (!row.reasons.includes('replies')) continue;
    const reply = input.replies?.[row.focus.url];
    ranked.push({
      id: `move|${row.id}`,
      kind: 'reply',
      row,
      why: reply ? `${reply.author}: “${quote(reply.text)}”` : `${row.person ?? 'Someone'} is waiting on your reply`,
      minutes: moveEffort('reply', undefined),
      urls: entryUrls(row),
    });
  }
  ranked.sort(byEffort);
  unreviewed.sort((a, b) => a.row.since - b.row.since || a.row.title.localeCompare(b.row.title));
  const items = ranked.slice(0, MOVE_LIMIT);
  items.push(...unreviewed.slice(0, Math.min(UNREVIEWED_LIMIT, MOVE_LIMIT - items.length)));
  // A slot for the oldest small review request, when one qualifies: it replaces the last row.
  const oldest = [...requests].sort((a, b) => a.row.since - b.row.since)[0];
  if (oldest && !items.includes(oldest)) {
    if (items.length >= MOVE_LIMIT) items.pop();
    items.push(oldest);
  }
  const rank = (item: MoveItem) => (item.unreviewed ? 1 : 0);
  items.sort((a, b) => rank(a) - rank(b) || (rank(a) ? a.row.since - b.row.since : byEffort(a, b)));
  const shown = new Set(items.map((item) => item.row.id));
  const moreUnreviewed = (lanes(model, 'merge')?.rows ?? []).filter(
    (row) => row.merge?.notes[0]?.kind === 'no-review' && !row.merge.notes.some((note) => note.kind === 'base-open') && !shown.has(row.id)
  ).length;
  return { items, moreUnreviewed };
}
export const moveMinutes = (items: readonly Pick<MoveItem, 'minutes'>[]) => items.reduce((total, item) => total + item.minutes, 0);

/** One PR line under an expanded group. */
export interface GroupLine {
  /** `${row.id}` for a row, `${row.id}|${member.url}` for one PR of a stack row. */
  id: string;
  row: OverviewRow;
  /** The PR the line names; a stack row's line names the stack and opens its first PR. */
  member: ReviewMember;
  title: string;
  since: number;
  /** Where a click lands. */
  target: DeepLinkTarget;
  /** After the title, for a PR waiting on an earlier one: "after #380". */
  note?: string;
  /** The tooltip and accessible description, when the line needs more than its words. */
  hint?: string;
}
/** The open PR a stack waits on, and what it waits on itself. */
export interface StackBase {
  member: ReviewMember;
  /** "#380 is ready to merge", "#380 has failing checks", "#380 waits on lena’s review". */
  status?: string;
  /** Merge it from the stack row (your PR, ready), or open it. */
  action: 'merge' | 'open';
  /** Its row in the lanes: Merge acts on it. */
  row?: OverviewRow;
}
export interface PersonGroup {
  /** `person:lena`, `unassigned`, `team`, `team:org/name`, `review`, `ci`, `stack:owner/repo#380`, `stacks`, `you`. */
  key: string;
  kind: 'person' | 'unassigned' | 'team' | 'ci' | 'stack' | 'stacks' | 'you' | 'review';
  /** "lena", "team", "CI", "Launcher i18n", "Waiting for earlier PRs in a stack to merge", "you". */
  label: string;
  /** "2 PRs · oldest 4 d", "3 running", "16 failing checks, 2 conflicts", "4 PRs wait for #380 to merge". */
  detail: string;
  rows: OverviewRow[];
  /** The PRs this row stands for, each once: its share of the section heading. */
  urls: string[];
  /** The repositories of those PRs, each once. */
  repos: string[];
  /** Its PRs, one line each, when expanded. */
  lines: GroupLine[];
  /** When the longest wait in the group began. */
  oldest: number;
  /** A requested reviewer of your PRs: Nudge re-requests their review on these PRs. */
  nudge?: { reviewer: string; members: ReviewMember[] };
  /** A stack row: the PR that has to merge first. */
  base?: StackBase;
  /** The folded stacks row: one row per stack, when expanded. */
  children?: PersonGroup[];
}
const prs = (n: number) => plural(n, 'PR', 'PRs');
/** A section heading: the sum of the PRs its rows stand for. */
export const sectionCount = (groups: readonly Pick<PersonGroup, 'urls'>[]) => groups.reduce((total, group) => total + group.urls.length, 0);
/** Move forward now's heading: the PRs its rows act on. */
export const moveCount = (items: readonly Pick<MoveItem, 'urls'>[]) => items.reduce((total, item) => total + item.urls.length, 0);

type GroupSeed = Pick<PersonGroup, 'kind' | 'label'> & Partial<Pick<PersonGroup, 'nudge' | 'base'>>;
/** Builds groups that list each PR once: the first group a PR is added to keeps it. */
function grouper() {
  const groups = new Map<string, PersonGroup>();
  const claimed = new Set<string>();
  const add = (key: string, seed: () => GroupSeed, row: OverviewRow, members: readonly ReviewMember[], line?: (member: ReviewMember) => Pick<GroupLine, 'note' | 'hint'>) => {
    const fresh = members.filter((member) => !claimed.has(member.url));
    if (!fresh.length) return undefined;
    const group: PersonGroup = groups.get(key) ?? { key, detail: '', rows: [], urls: [], repos: [], lines: [], oldest: row.since, ...seed() };
    if (!group.rows.includes(row)) group.rows.push(row);
    for (const member of fresh) {
      claimed.add(member.url);
      group.urls.push(member.url);
      if (!group.repos.includes(member.repo)) group.repos.push(member.repo);
      if (line) {
        const since = row.entries.find((entry) => entry.member.url === member.url)?.since ?? row.since;
        group.lines.push({ id: `${row.id}|${member.url}`, row, member, title: member.title, since, target: prTarget(member.url) ?? row.target, ...line(member) });
      } else if (!group.lines.some((entry) => entry.row === row)) group.lines.push({ id: row.id, row, member: row.focus, title: row.title, since: row.since, target: row.target });
    }
    group.oldest = Math.min(group.oldest, row.since);
    groups.set(key, group);
    return group;
  };
  return { groups, add };
}
const sortLines = (group: PersonGroup) => {
  group.rows.sort((a, b) => a.since - b.since);
  group.lines.sort((a, b) => a.since - b.since || a.title.localeCompare(b.title));
};

/**
 * Waiting on you: review requests and re-reviews by author, replies and change requests by who wrote, oldest wait
 * first; then PRs whose requester is not known ("unassigned"), and team requests last: "team · 3 review requests".
 * A PR in two lanes (a reply and a re-review) is listed once, under its oldest wait.
 */
export function waitingOnYou(input: Pick<MorningInput, 'model' | 'now' | 'login'>): PersonGroup[] {
  const { add, groups } = grouper();
  const rows = [...(lanes(input.model, 'answer')?.rows ?? []), ...(lanes(input.model, 'review')?.rows ?? [])].sort((a, b) => a.since - b.since);
  for (const row of rows) {
    const members = row.entries.map((entry) => entry.member);
    if (row.lane === 'review' && !row.reasons.includes('updated-since-review') && row.entries.every((entry) => reviewRequest(entry.member, input.login) === 'team')) {
      add('team', () => ({ kind: 'team', label: 'team' }), row, members);
      continue;
    }
    const person = row.person ?? (row.lane === 'review' && !same(row.focus.author, input.login) ? row.focus.author : undefined);
    if (person) add(`person:${person.toLowerCase()}`, () => ({ kind: 'person', label: person }), row, members);
    else add('unassigned', () => ({ kind: 'unassigned', label: 'unassigned' }), row, members);
  }
  const order: PersonGroup['kind'][] = ['person', 'unassigned', 'team'];
  const result = [...groups.values()].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || a.oldest - b.oldest || a.label.localeCompare(b.label));
  for (const group of result) {
    sortLines(group);
    const n = group.urls.length;
    group.detail = group.kind === 'team' ? plural(n, 'review request', 'review requests') : `${prs(n)} · oldest ${waitingLabel(group.oldest, input.now)}`;
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
function openParent(row: OverviewRow, member: ReviewMember): ReviewMember | undefined {
  const subject = row.item.subject;
  return subject.edges
    .filter((edge) => edge.child === member.url)
    .map((edge) => subject.members.find((candidate) => candidate.url === edge.parent))
    .find((parent): parent is ReviewMember => !!parent && isOpen(parent));
}
/** The lowest open PR under `member`: the one that has to merge first. */
function openRoot(row: OverviewRow, member: ReviewMember): ReviewMember | undefined {
  let current = openParent(row, member);
  const seen = new Set<string>();
  while (current && !seen.has(current.url)) {
    seen.add(current.url);
    const next = openParent(row, current);
    if (!next) break;
    current = next;
  }
  return current;
}
/** "This PR is stacked on #380 and can merge only after #380 merges." */
export const stackedHint = (number: number) => `This PR is stacked on #${number} and can merge only after #${number} merges.`;

/** What the PR a stack waits on is waiting on itself, from its row in the lanes. */
export function stackBase(model: Pick<OverviewModel, 'lanes'>, member: ReviewMember, login: string): StackBase {
  const n = `#${member.number}`;
  const find = (lane: OverviewRow['lane'], parked = false) => {
    const state = lanes(model, lane);
    return (parked ? state?.parked : state?.rows)?.find((row) => row.entries.some((entry) => entry.member.url === member.url));
  };
  const reasons = (row: OverviewRow) => row.entries.find((entry) => entry.member.url === member.url)?.reasons ?? row.reasons;
  const fix = find('fix');
  if (fix) {
    const why = reasons(fix);
    const status = why.includes('checks-failed') ? `${n} has failing checks` : why.includes('conflicts') ? `${n} has conflicts` : `${n} needs a restack`;
    return { member, status, action: 'open', row: fix };
  }
  const answer = find('answer');
  if (answer) return { member, status: reasons(answer).includes('changes-requested') ? `${n} has changes requested` : `${n} waits on your reply`, action: 'open', row: answer };
  const merge = find('merge');
  if (merge && merge.merge?.member.url === member.url) return { member, status: `${n} is ready to merge`, action: 'merge', row: merge };
  const parked = find('merge', true);
  if (parked) return { member, status: parked.merge?.notes[0]?.kind === 'approved' ? `${n} is approved and can merge` : `${n} can merge, not reviewed`, action: 'open', row: parked };
  const waiting = find('waiting');
  if (waiting) {
    const why = reasons(waiting);
    const reviewer = member.requestedReviewers.find((name) => !same(name, login)) ?? member.requestedTeams[0];
    const status = why.includes('review-pending') ? (reviewer ? `${n} waits on ${reviewer}’s review` : `${n} waits on a review`) : `${n} has checks running`;
    return { member, status, action: 'open', row: waiting };
  }
  const review = find('review');
  if (review) return { member, status: `${n} waits on your review`, action: 'open', row: review };
  return { member, action: 'open' };
}

/**
 * Waiting on others: your PRs by blocker, each PR under one row. Each requested reviewer is a row with Nudge, oldest
 * wait first (a PR waiting on two reviewers is listed under the first one GitHub names); then requested teams, PRs
 * awaiting a reviewer nobody was asked to be, CI still running, stacks waiting for an earlier PR to merge, and you.
 *
 * Stacks: one row per stack, keyed by the repository and number of the open PR at its bottom (never the number
 * alone), so a stack listed twice is one row and equal numbers in two repositories stay apart. A PR is under its
 * stack only when nothing else blocks it: failing checks put it under you, a requested review under the reviewer.
 * Over `STACKS_SHOWN` stacks fold into one row, "Waiting for earlier PRs in a stack to merge", that expands to them.
 */
export function waitingOnOthers(input: Pick<MorningInput, 'model' | 'now' | 'login'>): PersonGroup[] {
  const { model, now, login } = input;
  const { add, groups } = grouper();
  for (const row of lanes(model, 'waiting')?.rows ?? []) {
    for (const entry of row.entries) {
      const member = entry.member;
      if (!entry.reasons.includes('review-pending')) continue;
      const reviewer = member.requestedReviewers.find((name) => !same(name, login));
      const team = member.requestedTeams[0];
      if (reviewer) {
        const group = add(`person:${reviewer.toLowerCase()}`, () => ({ kind: 'person', label: reviewer, nudge: { reviewer, members: [] } }), row, [member]);
        if (group?.nudge && !group.nudge.members.some((candidate) => candidate.url === member.url)) group.nudge.members.push(member);
      } else if (team) add(`team:${team.toLowerCase()}`, () => ({ kind: 'team', label: team }), row, [member]);
      else add('review', () => ({ kind: 'review', label: 'a reviewer' }), row, [member]);
    }
    for (const entry of row.entries) if (entry.reasons.includes('checks-pending')) add('ci', () => ({ kind: 'ci', label: 'CI' }), row, [entry.member]);
  }
  for (const row of lanes(model, 'fix')?.rows ?? []) add('you', () => ({ kind: 'you', label: 'you' }), row, row.entries.map((entry) => entry.member));
  // A PR waiting for an earlier PR in its stack to merge.
  for (const row of ownRows(model)) {
    for (const entry of row.entries) {
      const parent = openParent(row, entry.member);
      const root = openRoot(row, entry.member);
      if (!parent || !root) continue;
      add(`stack:${root.repo.toLowerCase()}#${root.number}`, () => ({ kind: 'stack', label: row.item.subject.name || root.title, base: stackBase(model, root, login) }), row, [entry.member], () => ({
        note: `after #${parent.number}`,
        hint: stackedHint(parent.number),
      }));
    }
  }
  const order: PersonGroup['kind'][] = ['person', 'team', 'review', 'ci', 'stack', 'you'];
  let result = [...groups.values()].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || a.oldest - b.oldest || a.label.localeCompare(b.label));
  for (const group of result) {
    sortLines(group);
    const n = group.urls.length;
    if (group.kind === 'ci') group.detail = `${n} running`;
    else if (group.kind === 'you') {
      // Per PR, each under its first reason, so the counts add up to the PRs: a stack with two failing PRs counts two,
      // a PR failing with conflicts counts once, and a stack listed twice counts once.
      const entries = group.rows.flatMap((row) => row.entries);
      const first = group.urls.map((url) => {
        const reasons = entries.find((entry) => entry.member.url === url)?.reasons ?? [];
        return reasons.includes('checks-failed') ? 'failing' : reasons.includes('conflicts') ? 'conflicts' : 'restack';
      });
      const failing = first.filter((reason) => reason === 'failing').length;
      const conflicts = first.filter((reason) => reason === 'conflicts').length;
      const restack = first.filter((reason) => reason === 'restack').length;
      group.detail = [failing ? plural(failing, 'failing check', 'failing checks') : '', conflicts ? plural(conflicts, 'conflict', 'conflicts') : '', restack ? plural(restack, 'restack', 'restacks') : '']
        .filter(Boolean)
        .join(', ');
    } else if (group.kind === 'stack' && group.base) {
      // Stack order, base first: each PR follows the one it is stacked on.
      const position = (line: GroupLine) => line.row.item.subject.members.findIndex((candidate) => candidate.url === line.member.url);
      group.lines.sort((a, b) => position(a) - position(b));
      const { member, status, row } = group.base;
      const base = `#${member.number}`;
      group.detail = [`${n === 1 ? '1 PR waits' : `${n} PRs wait`} for ${base} to merge`, status ?? ''].filter(Boolean).join(' · ');
      // The PR that has to land first leads the expanded stack, so it is one click away.
      group.lines.unshift({
        id: `${group.key}|base`,
        row: row ?? group.rows[0],
        member,
        title: member.title,
        since: row?.since ?? group.oldest,
        target: prTarget(member.url) ?? group.rows[0].target,
        note: status ?? `${base} merges first`,
        hint: `${base} has to merge before the rest of this stack can.`,
      });
    } else group.detail = `${prs(n)} · ${waitingLabel(group.oldest, now)}`;
  }
  const stacks = result.filter((group) => group.kind === 'stack');
  if (stacks.length > STACKS_SHOWN) {
    const urls = stacks.flatMap((group) => group.urls);
    const folded: PersonGroup = {
      key: 'stacks',
      kind: 'stacks',
      label: 'Waiting for earlier PRs in a stack to merge',
      detail: `${prs(urls.length)} in ${stacks.length} stacks`,
      rows: unique(stacks.flatMap((group) => group.rows)),
      urls,
      repos: unique(stacks.flatMap((group) => group.repos)),
      lines: [],
      oldest: Math.min(...stacks.map((group) => group.oldest)),
      children: stacks,
    };
    const at = result.indexOf(stacks[0]);
    result = [...result.slice(0, at), folded, ...result.slice(at).filter((group) => group.kind !== 'stack')];
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
  /** "Failing 12 d", "Never approved · 9 d", "Idle 9 d". */
  label: string;
  since: number;
}
/**
 * Needs a decision: your PRs failing checks for over a week, mergeable but never approved over a week after they
 * opened, or idle (no push, review or comment) for over a week. One reason each, in that order; oldest first.
 */
export function needsDecision(input: Pick<MorningInput, 'model' | 'now'>): DecisionItem[] {
  const { now } = input;
  const items: DecisionItem[] = [];
  const seen = new Set<string>();
  for (const row of ownRows(input.model)) {
    if (row.kind === 'stack' && row.entries.length > 1) continue;
    const member = row.focus;
    // One reason per PR: the first lane that gives one (Fix, then Merge, Waiting, Answer).
    if (seen.has(member.url)) continue;
    const updated = time(member.updatedAt) ?? now;
    const created = time(member.createdAt) ?? now;
    const days = (since: number) => waitingLabel(since, now);
    let item: Omit<DecisionItem, 'id' | 'row' | 'member'> | undefined;
    if (row.lane === 'fix' && row.reasons.includes('checks-failed') && now - row.since >= DECISION_MS) item = { reason: 'failing', label: `Failing ${days(row.since)}`, since: row.since };
    else if (row.merge && row.merge.notes[0]?.kind === 'unapproved' && now - created >= DECISION_MS) item = { reason: 'unapproved', label: `Never approved · ${days(created)}`, since: created };
    else if (now - updated >= DECISION_MS) item = { reason: 'idle', label: `Idle ${days(updated)}`, since: updated };
    if (item) {
      seen.add(member.url);
      items.push({ id: `decide|${row.id}`, row, member, ...item });
    }
  }
  return items.sort((a, b) => a.since - b.since || a.row.title.localeCompare(b.row.title));
}

/** The tab count: PRs in Move forward now and Waiting on you, each once. */
export function morningCount(move: readonly Pick<MoveItem, 'urls'>[], you: readonly Pick<PersonGroup, 'urls'>[]): number {
  return new Set([...move.flatMap((item) => item.urls), ...you.flatMap((group) => group.urls)]).size;
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
