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
    result.push(entry);
  }
  return result;
}

/** The items an entry carries, for read state, filters and navigation. */
export const entryItems = (entry: TimelineEntry): FeedbackItem[] =>
  entry.type === 'item' ? [entry.item] : entry.type === 'bots' ? entry.items : [];

/** A one-line summary of a bot's comments: "Static Data Validation Passed, Update Migration Test Passed, …". */
export function botSummary(texts: string[], limit = 3): string {
  const shown = texts.filter(Boolean).slice(0, limit);
  return shown.join(', ') + (texts.length > limit ? ', …' : '');
}
