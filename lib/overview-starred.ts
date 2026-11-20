/**
 * The Overview's Starred section: the PRs and stacks the user starred as their top work, first on the page. Pure; built
 * from the starred queue entries (`WorkbenchQueue.starredItems`), the lane model (`lib/overview.ts`) and saved status.
 *
 * - **What is starred.** Only PRs can be starred. A stack counts as starred when any of its PRs is
 *   (`isStarredSubject`), and it is one entry: the stack, with every PR of it in merge order, base first.
 * - **Each PR once.** Starred claims its open PRs before every other section (`lib/morning.ts`), so a starred PR is
 *   listed here and nowhere else on the page. A stack chain elsewhere that holds one links here ("↑ Starred").
 * - **Order** (`STARRED_TIERS`), as the Overview ranks work: needs you (replies, change requests, reviews, then fixes),
 *   then ready to merge, then waiting on others, then quiet (open, nothing to do), then done. Action tiers list the
 *   longest wait first, as the lanes do; quiet and done rows list the latest change first. A stack takes the tier of
 *   its most actionable open PR, and its line says which PR that is.
 * - **Merged and closed.** A starred PR (or a stack with no open PR) that merged or closed stays while it is starred,
 *   as a quiet done row at the end: "Merged", "Closed". Unstar removes it.
 * - **Cap.** The section shows `STARRED_SHOWN` entries; "Show all N" opens the rest.
 *
 * Every line says the state it is acted on in: why (the lane reason, a merge's notes, who it waits on, the review
 * decision), the check state, comments, how long it has waited, and draft, merged or closed (`PrStateIcon`, and the
 * "Draft" leading its why).
 */
import { checkView, type CheckView } from './check-summary';
import { prTarget, type DeepLinkTarget } from './deep-link';
import { commentsOf, mergeCaveats, prNeed, rebaseWords } from './morning';
import { isOpenPr } from './pr-lifecycle';
import { sameLogin } from './github-actors';
import { OVERVIEW_REASON_LABEL, type OverviewModel, type OverviewRow, type OverviewSinceSource } from './overview';
import { stackDependencyOrder } from './stack-overview';
import type { QueueSignals } from './queue-signals';
import type { QueueItem, ReviewMember } from './workbench';

/** Most actionable first. */
export type StarredTier = 'you' | 'merge' | 'others' | 'quiet' | 'done';
export const STARRED_TIERS: readonly StarredTier[] = ['you', 'merge', 'others', 'quiet', 'done'];
/** Entries shown before "Show all N". */
export const STARRED_SHOWN = 8;
/** The one action a line offers, as Next up's rows do. Absent: Enter opens it. */
export type StarredAction = 'merge' | 'review' | 'rereview' | 'reply' | 'rerun' | 'open';

export interface StarredLine {
  /** The PR's URL. */
  id: string;
  member: ReviewMember;
  tier: StarredTier;
  /** "Review requested", "lena requested changes", "Ready to merge · approved by lena", "Waits on review from lena", "Merged". */
  why: string;
  /** The PR's row in the lanes, when it has one: its actions and where it opens. */
  row?: OverviewRow;
  target: DeepLinkTarget;
  /** Open PRs only. */
  check?: CheckView;
  comments?: number;
  since: number;
  source: OverviewSinceSource;
  /** Its lane state changed since the last visit (`OverviewEntry.isNew`). */
  isNew?: boolean;
  action?: StarredAction;
  /** The PR has merge conflicts: shown with the conflict icon. */
  conflicts?: boolean;
  /** Orders lines within a tier: people blocked on you before fixes, approved merges before the rest. */
  rank: number;
  /** Work Next up would list: it needs you, or it is an approved, passing merge. The tab count counts it. */
  actionable: boolean;
}
export interface StarredEntry {
  /** `starred|${subject.id}` */
  id: string;
  item: QueueItem;
  kind: 'pr' | 'stack';
  title: string;
  tier: StarredTier;
  /** The PR the entry leads with: a PR's own line, a stack's most actionable PR. */
  lead: StarredLine;
  /** A stack's PRs in merge order, base first; a PR's own line. */
  lines: StarredLine[];
  /** The open PRs it lists, which no other section lists. */
  urls: string[];
  /** A stack: "3 PRs · #362 review requested". A PR: its line's why. */
  why: string;
  check?: CheckView;
  comments?: number;
  since: number;
  source: OverviewSinceSource;
  isNew: boolean;
}
export interface StarredSection {
  entries: StarredEntry[];
  /** Every open PR the section lists: the PRs it claims from the other sections. */
  urls: string[];
  /** Its PRs that are work (`StarredLine.actionable`), for the tab count and Next up's empty state. */
  actionable: string[];
}
export interface StarredInput {
  /** The starred queue entries. */
  items: readonly QueueItem[];
  model: Pick<OverviewModel, 'lanes'>;
  signals: (member: ReviewMember) => QueueSignals | undefined;
  login: string;
  now: number;
  /** PRs leaving the page, such as ones closing on GitHub. */
  hidden?: ReadonlySet<string>;
  /** PRs left out, such as muted ones. */
  excluded?: ReadonlySet<string>;
}

const time = (value: string | undefined) => {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
};
const prs = (n: number) => `${n} ${n === 1 ? 'PR' : 'PRs'}`;
const lower = (text: string) => (/^[A-Z][a-z]/.test(text) ? `${text.charAt(0).toLowerCase()}${text.slice(1)}` : text);
const tierRank = (tier: StarredTier) => STARRED_TIERS.indexOf(tier);

/** The status the lanes read, when it is for the PR's current commit. */
const current = (input: Pick<StarredInput, 'signals'>, member: ReviewMember) => {
  const value = input.signals(member);
  return value && value.url === member.url && value.headSha === member.headSha ? value : undefined;
};

/** One PR's line: its tier, why, action and age, from what it needs (`prNeed`). An open draft's why says "Draft". */
export function starredLine(input: Pick<StarredInput, 'signals' | 'login' | 'model'>, item: QueueItem, member: ReviewMember): StarredLine {
  const line = needLine(input, item, member);
  return member.isDraft && line.tier !== 'done' && line.why !== 'Draft' ? { ...line, why: `Draft · ${line.why}` } : line;
}
function needLine(input: Pick<StarredInput, 'signals' | 'login' | 'model'>, item: QueueItem, member: ReviewMember): StarredLine {
  const fresh = current(input, member);
  const base = { id: member.url, member, target: prTarget(member.url) ?? { kind: 'queue' as const }, actionable: false };
  const updated = time(member.updatedAt) ?? time(member.createdAt) ?? 0;
  if (!isOpenPr(member)) return { ...base, tier: 'done', why: member.merged ? 'Merged' : 'Closed', since: updated, source: 'updated', rank: 0 };
  const comments = commentsOf(input, [member]);
  const open = { ...base, check: checkView([fresh]), ...(comments !== undefined ? { comments } : {}) };
  const need = prNeed(input.model, member, input.signals);
  const { row, entry } = need;
  if (!row || !entry) {
    const decision = fresh?.readiness?.reviewDecision;
    const why = member.isDraft ? 'Draft' : decision === 'APPROVED' ? 'Approved' : decision === 'CHANGES_REQUESTED' ? 'Changes requested' : decision === 'REVIEW_REQUIRED' ? 'Review required' : fresh?.readiness && decision === null ? 'No review required' : 'Open';
    return { ...open, tier: 'quiet', why, since: updated, source: 'updated', rank: 0 };
  }
  const reasons = entry.reasons;
  const lined = { ...open, row, target: row.focus.url === member.url ? row.target : base.target, since: entry.since, source: entry.source, ...(entry.isNew ? { isNew: true } : {}) };
  // Updated since your review, when another reason leads: a reply on a PR that also changed.
  const also = need.kind !== 'review' && need.all.has('updated-since-review') ? ' · updated since your review' : '';
  const first = reasons[0];
  if (need.kind === 'answer') {
    const person = row.focus.url === member.url ? row.person : undefined;
    if (first === 'replies') return { ...lined, tier: 'you', rank: 0, actionable: true, action: 'reply', why: `${person ? `${person} is waiting on your reply` : OVERVIEW_REASON_LABEL.replies}${also}` };
    return { ...lined, tier: 'you', rank: 0, actionable: true, action: 'open', why: `${person ? `${person} requested changes` : OVERVIEW_REASON_LABEL['changes-requested']}${also}` };
  }
  if (need.kind === 'review') {
    const again = reasons.includes('updated-since-review');
    return { ...lined, tier: 'you', rank: 0, actionable: true, action: again ? 'rereview' : 'review', why: again ? OVERVIEW_REASON_LABEL['updated-since-review'] : OVERVIEW_REASON_LABEL['review-requested'] };
  }
  if (need.kind === 'fix') {
    const why = first === 'checks-failed' ? 'Failing checks' : first === 'conflicts' ? 'Conflicts' : rebaseWords(item.subject, member).replace(/^n/, 'N');
    return { ...lined, tier: 'you', rank: 1, actionable: true, action: first === 'checks-failed' ? 'rerun' : 'open', why: `${why}${also}`, ...(reasons.includes('conflicts') ? { conflicts: true } : {}) };
  }
  if (need.kind === 'merge' || need.kind === 'parked') {
    // Another PR merges first: this one waits for it, and is not work yet.
    if (need.gate === 'base-open') return { ...lined, tier: 'others', rank: 0, why: need.base ? `Waits for #${need.base.number} to merge` : 'Waits for its base to merge' };
    const notes = row.merge?.notes ?? [];
    const words = notes.map((note) => note.text);
    if (need.gate === 'parked') return { ...lined, tier: 'quiet', rank: 0, action: 'open', why: words.join(' · ') || 'Mergeable' };
    if (need.gate === 'checks') return { ...lined, tier: 'others', rank: 0, why: fresh?.checks.state === 'failure' ? 'Failing checks' : OVERVIEW_REASON_LABEL['checks-pending'] };
    // Ready to merge, as `readyMerges` counts it. Only an approved, passing PR gets the Merge button and counts as
    // work, as in Next up; one without review or checks says what it goes ahead without, and opens.
    const caveats = mergeCaveats(row, checkView([fresh]));
    const approved = need.gate === 'approved';
    return { ...lined, tier: 'merge', rank: approved ? 0 : 1, actionable: approved, action: approved ? 'merge' : 'open', why: ['Ready to merge', ...words.map(lower), ...(approved ? [] : caveats.filter((caveat) => caveat !== 'no review'))].join(' · ') };
  }
  // Waiting on others: who it waits on.
  if (reasons.includes('review-pending')) {
    const reviewer = member.requestedReviewers.find((name) => !sameLogin(name, input.login)) ?? member.requestedTeams[0];
    return { ...lined, tier: 'others', rank: 0, why: reviewer ? `Waits on review from ${reviewer}` : 'Awaiting review' };
  }
  return { ...lined, tier: 'others', rank: 0, why: OVERVIEW_REASON_LABEL['checks-pending'] };
}

/** Best first: tier, then people blocked on you before fixes, then the longest wait (quiet and done: the latest change). */
export function compareStarred(a: Pick<StarredLine, 'tier' | 'rank' | 'since'> & { title?: string }, b: Pick<StarredLine, 'tier' | 'rank' | 'since'> & { title?: string }): number {
  const late = a.tier === 'quiet' || a.tier === 'done';
  return tierRank(a.tier) - tierRank(b.tier) || a.rank - b.rank || (late ? b.since - a.since : a.since - b.since) || (a.title ?? '').localeCompare(b.title ?? '');
}

/** The Starred section. See the rules at the top of this file. */
export function starredSection(input: StarredInput): StarredSection {
  const hidden = input.hidden ?? new Set<string>();
  const excluded = input.excluded ?? new Set<string>();
  const entries: StarredEntry[] = [];
  const seen = new Set<string>();
  for (const item of input.items) {
    const subject = item.subject;
    if (seen.has(subject.id) || !subject.members.length) continue;
    seen.add(subject.id);
    const ordered = subject.kind === 'stack' ? stackDependencyOrder(subject).members : subject.members;
    const members = ordered.filter((member) => !hidden.has(member.url) && !excluded.has(member.url) && !item.snoozedUrls?.includes(member.url));
    if (!members.length) continue;
    const lines = members.map((member) => starredLine(input, item, member));
    const lead = [...lines].sort(compareStarred)[0];
    const openLines = lines.filter((line) => line.tier !== 'done');
    const stack = subject.kind === 'stack' && lines.length > 1;
    const comments = stack ? commentsOf(input, openLines.map((line) => line.member)) : lead.comments;
    const allDone = !openLines.length;
    const why = !stack
      ? lead.why
      : allDone
        ? `${prs(lines.length)} · ${lines.every((line) => line.member.merged) ? 'all merged' : 'all merged or closed'}`
        : `${prs(lines.length)} · #${lead.member.number} ${lower(lead.why)}`;
    entries.push({
      id: `starred|${subject.id}`,
      item,
      kind: stack ? 'stack' : 'pr',
      title: stack ? subject.name || subject.title || lead.member.title : lead.member.title,
      tier: lead.tier,
      lead,
      lines,
      urls: openLines.map((line) => line.member.url),
      why,
      ...(allDone ? {} : { check: stack ? checkView(openLines.map((line) => current(input, line.member))) : lead.check }),
      ...(comments !== undefined ? { comments } : {}),
      since: lead.since,
      source: lead.source,
      isNew: lines.some((line) => line.isNew),
    });
  }
  entries.sort((a, b) => compareStarred({ ...a.lead, title: a.title }, { ...b.lead, title: b.title }));
  const urls = entries.flatMap((entry) => entry.urls);
  return {
    entries,
    urls,
    actionable: entries.flatMap((entry) => entry.lines.filter((line) => line.actionable).map((line) => line.member.url)),
  };
}

/** The starred entries' open PRs, for status reads: their check state and review decision show on their lines. */
export function starredStatusRequests(items: readonly QueueItem[], excluded?: ReadonlySet<string>): { url: string; headSha: string }[] {
  const seen = new Set<string>();
  const result: { url: string; headSha: string }[] = [];
  for (const item of items)
    for (const member of item.subject.members) {
      if (!isOpenPr(member) || seen.has(member.url) || excluded?.has(member.url) || item.snoozedUrls?.includes(member.url)) continue;
      seen.add(member.url);
      result.push({ url: member.url, headSha: member.headSha });
    }
  return result;
}
