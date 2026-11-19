import type { FeedbackEvent } from './review-threads';
import type { ReviewMember } from './workbench';
import type { FeedbackItem } from './feedback';

/**
 * The Feedback tab's one-page timeline (#418): a PR's description, comments, reviews, code threads, commits and
 * events, oldest first, the way the conversation happened. Consecutive commits read as one push, and consecutive
 * comments from one bot collapse into one row, so automation does not bury what people said.
 */
export type TimelineEntry =
  | { type: 'description'; key: string; at: string; member: ReviewMember }
  | { type: 'item'; key: string; at: string; item: FeedbackItem; bot: boolean }
  | { type: 'bots'; key: string; at: string; login: string; items: FeedbackItem[] }
  | { type: 'commits'; key: string; at: string; member: ReviewMember; author: string | null; commits: Extract<FeedbackEvent, { kind: 'commit' }>[] }
  | { type: 'event'; key: string; at: string; member: ReviewMember; event: Exclude<FeedbackEvent, { kind: 'commit' }> }
  /** Several force-pushes or review requests in a row, by one person: one row that summarizes them. */
  | { type: 'events'; key: string; at: string; member: ReviewMember; kind: 'force-push' | 'review-requested'; actor: string | null; events: Exclude<FeedbackEvent, { kind: 'commit' }>[] }
  | { type: 'earlier'; key: string; at: string; member: ReviewMember };

/** A bot by GitHub's account type, or by the `[bot]` suffix older saved discussions carry. */
export const isBotItem = (item: FeedbackItem) =>
  item.comments.every((c) => c.author?.__typename === 'Bot' || /\[bot\]$/i.test(c.author?.login ?? ''));

/** Where an item belongs in time: when its conversation started. A thread stays where it began, as on GitHub. */
export const itemTime = (item: FeedbackItem) => item.comments[0]?.createdAt ?? '';

export function buildTimeline(
  members: ReviewMember[],
  items: FeedbackItem[],
  events: ReadonlyMap<string, { events?: FeedbackEvent[]; earlierEvents?: boolean }>,
  { conversationOnly = false }: { conversationOnly?: boolean } = {}
): TimelineEntry[] {
  const raw: TimelineEntry[] = [];
  for (const member of members) {
    if (conversationOnly) break;
    // Every PR opens with its description, even an empty one, so the page always starts where the PR did.
    raw.push({ type: 'description', key: `${member.url}#description`, at: member.createdAt, member });
    const known = events.get(member.url);
    if (known?.earlierEvents)
      raw.push({ type: 'earlier', key: `${member.url}#earlier`, at: known.events?.[0]?.at ?? member.createdAt, member });
    for (const event of known?.events ?? []) {
      if (event.kind === 'commit')
        raw.push({ type: 'commits', key: `${member.url}#${event.id}`, at: event.at, member, author: event.author, commits: [event] });
      else raw.push({ type: 'event', key: `${member.url}#${event.id}`, at: event.at, member, event });
    }
  }
  for (const item of items)
    raw.push({ type: 'item', key: `${item.member.url}#${item.id}`, at: itemTime(item), item, bot: !item.thread && isBotItem(item) });
  // Stable: equal times keep the order above, so a description leads its PR's first push.
  const order = (entry: TimelineEntry) => (entry.type === 'description' ? 0 : entry.type === 'earlier' ? 1 : 2);
  raw.sort((a, b) => a.at.localeCompare(b.at) || order(a) - order(b));
  const result: TimelineEntry[] = [];
  for (const entry of raw) {
    const last = result.at(-1);
    if (entry.type === 'commits' && last?.type === 'commits' && last.member.url === entry.member.url && last.author === entry.author) {
      result[result.length - 1] = { ...last, commits: [...last.commits, ...entry.commits] };
      continue;
    }
    const login = entry.type === 'item' && entry.bot ? entry.item.comments[0]?.author?.login : undefined;
    if (login && last?.type === 'bots' && last.login === login) {
      result[result.length - 1] = { ...last, items: [...last.items, (entry as Extract<TimelineEntry, { type: 'item' }>).item] };
      continue;
    }
    if (login && last?.type === 'item' && last.bot && last.item.comments[0]?.author?.login === login) {
      result[result.length - 1] = { type: 'bots', key: `${last.key}+bots`, at: last.at, login, items: [last.item, (entry as Extract<TimelineEntry, { type: 'item' }>).item] };
      continue;
    }
    // Force-pushes and review requests by one person in a row read as one row.
    if (entry.type === 'event' && (entry.event.kind === 'force-push' || entry.event.kind === 'review-requested')) {
      const kind = entry.event.kind;
      if (last?.type === 'events' && last.kind === kind && last.actor === entry.event.actor && last.member.url === entry.member.url) {
        result[result.length - 1] = { ...last, events: [...last.events, entry.event] };
        continue;
      }
      if (last?.type === 'event' && last.event.kind === kind && last.event.actor === entry.event.actor && last.member.url === entry.member.url) {
        result[result.length - 1] = { type: 'events', key: `${last.key}+events`, at: last.at, member: last.member, kind, actor: last.event.actor, events: [last.event, entry.event] };
        continue;
      }
    }
    result.push(entry);
  }
  return result;
}

/**
 * A timeline group this large shows a summary, a short preview and Show all instead of every line (#418). One
 * threshold for pushes, bot runs and runs of events.
 */
export const BIG_GROUP = 8;
/** How many lines a collapsed group previews. */
export const GROUP_PREVIEW = 4;

const PREFIXES = ['feat', 'fix', 'refactor', 'docs', 'test', 'chore', 'content', 'perf', 'style', 'ci', 'build'] as const;
type Commit = Extract<FeedbackEvent, { kind: 'commit' }>;

/** The branch a merge commit brought in, from Git's and GitHub's merge messages; undefined when it is not a merge. */
export function mergeSource(message: string): string | undefined {
  const match =
    /^Merge (?:remote-tracking )?branch '([^']+)'/i.exec(message) ??
    /^Merge pull request #\d+ from (\S+)/i.exec(message) ??
    /^Merge (?:remote-tracking )?branch (\S+)/i.exec(message);
  if (match) return match[1];
  return /^Merge\b/i.test(message) ? 'other branches' : undefined;
}

/** A commit's conventional prefix (`feat`, `fix(scope)!:` …), or `other`. */
export function commitKind(message: string): string {
  const match = /^([a-z]+)(?:\([^)]*\))?!?:/i.exec(message.trim());
  const prefix = match?.[1].toLowerCase();
  return prefix && (PREFIXES as readonly string[]).includes(prefix) ? prefix : 'other';
}

/** Fixups and near-empty subjects say nothing about the change; they are not previewed. */
const meaningful = (message: string) => !/^(fixup!|squash!|amend!|wip\b)/i.test(message.trim()) && message.trim().length > 3;

/**
 * A deterministic summary of a push: counts by conventional prefix, merges grouped by the branch they brought in, and
 * the first few meaningful subjects as a preview. "31 refactor · 8 content · 6 fix · 11 merges from local/cv2-scope".
 */
export function summarizeCommits(commits: readonly Commit[]) {
  const kinds = new Map<string, number>();
  const merges = new Map<string, Commit[]>();
  for (const commit of commits) {
    const source = mergeSource(commit.message);
    if (source) merges.set(source, [...(merges.get(source) ?? []), commit]);
    else kinds.set(commitKind(commit.message), (kinds.get(commitKind(commit.message)) ?? 0) + 1);
  }
  const counted = [...kinds.entries()]
    .filter(([kind]) => kind !== 'other')
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([kind, n]) => `${n} ${kind}`);
  if (kinds.get('other')) counted.push(`${kinds.get('other')} other`);
  for (const [source, list] of merges) counted.push(`${list.length} ${list.length === 1 ? 'merge' : 'merges'} from ${source}`);
  const nonMerge = commits.filter((commit) => !mergeSource(commit.message));
  return {
    line: counted.join(' · '),
    merges,
    preview: nonMerge.filter((commit) => meaningful(commit.message)).slice(0, GROUP_PREVIEW),
  };
}

/** A push's lines when shown whole: commits in order, with each branch's merges as one line where its first one was. */
export type CommitLine = { type: 'commit'; commit: Commit } | { type: 'merges'; source: string; commits: Commit[] };
export function commitLines(commits: readonly Commit[]): CommitLine[] {
  const merges = summarizeCommits(commits).merges;
  const seen = new Set<string>();
  return commits.flatMap((commit): CommitLine[] => {
    const source = mergeSource(commit.message);
    if (!source) return [{ type: 'commit', commit }];
    if (seen.has(source)) return [];
    seen.add(source);
    return [{ type: 'merges', source, commits: merges.get(source) ?? [commit] }];
  });
}

/** The items an entry carries, for read state, filters and navigation. */
export const entryItems = (entry: TimelineEntry): FeedbackItem[] =>
  entry.type === 'item' ? [entry.item] : entry.type === 'bots' ? entry.items : [];

/** A one-line summary of a bot's comments: "Static Data Validation Passed, Update Migration Test Passed, …". */
export function botSummary(texts: string[], limit = 3): string {
  const shown = texts.filter(Boolean).slice(0, limit);
  return shown.join(', ') + (texts.length > limit ? ', …' : '');
}
