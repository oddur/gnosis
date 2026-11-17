/**
 * Change signals: two cheap reads that tell Gnosis which PRs changed, so it reads only those (#337, #338).
 *
 * - The notifications feed, `GET /notifications`, polled with the validators of the last response. GitHub answers
 *   304 Not Modified when nothing changed, and a 304 does not count against the rate limit. `X-Poll-Interval` sets
 *   the shortest gap. Threads are never marked read.
 * - One GraphQL search for the reader's PRs updated since a cursor: `involves:@me` and `review-requested:@me` as two
 *   aliases of one query, about 1 point. It catches what the feed misses: muted threads, unwatched repositories and
 *   tokens without notifications access.
 *
 * Both only name PRs. Main reads those PRs again through the scheduler, and a new head runs the head invalidation in
 * lib/pr-heads.ts. Nothing here runs while sync is off, and sources slow to the watch cadence while nobody is at the
 * computer. Pure apart from the injected reads, so cadence, mapping and fallback are tested without timers.
 */
import { WATCH_INTERVAL_MS, type SyncMode } from './notification-cadence';
import { COMMENT_REASONS, COMMENT_READS_PER_POLL, type CommentCandidate } from './notification-comments';

/** One thread of `GET /notifications`, as far as Gnosis reads it. */
export interface NotificationThread {
  id: string;
  reason: string;
  unread?: boolean;
  updated_at: string;
  subject: { type: string; url: string | null; title?: string };
  repository?: { full_name?: string };
}
export type NotificationsResponse =
  | { status: 200; threads: unknown; lastModified?: string; etag?: string; pollInterval?: number }
  | { status: 304; pollInterval?: number }
  /** The token cannot read notifications: a fine-grained token, a GitHub App token or a missing scope. */
  | { status: 'unavailable'; code: number };

/** One PR the search returned: ids and the head only. */
export interface ChangedPr {
  id: string;
  url: string;
  updatedAt: string;
  headRefOid: string;
}
export interface ChangedPrsResult {
  prs: ChangedPr[];
  /** GraphQL points the query cost, from `rateLimit.cost`. */
  cost?: number;
  /** More PRs matched than one page holds. Discovery reads the rest. */
  truncated: boolean;
}

/** Sync mode: the feed's own minimum. GitHub sends 60 s today; a larger `X-Poll-Interval` wins. */
export const NOTIFICATIONS_INTERVAL_MS = 60_000;
/** Sync mode: one changed-PR search every two minutes, 30 points an hour. */
export const SEARCH_INTERVAL_MS = 120_000;
/** The search cursor starts this far before the last search, for clock skew and search indexing lag. */
export const SEARCH_OVERLAP_MS = 3 * 60_000;
/** The first search after launch or sign-in looks back this far. Discovery covers anything older. */
export const SEARCH_FIRST_LOOKBACK_MS = 10 * 60_000;
/** The page size of each search alias and of the feed. */
export const CHANGE_PAGE = 50;
/** After the feed refuses the token, ask again this much later: the reader can grant the scope. */
export const NOTIFICATIONS_RECHECK_MS = 6 * 60 * 60_000;
/** No one has touched the computer for this long: sources slow to the watch cadence. */
export const IDLE_SECONDS = 300;
const MAX_ERROR_DELAY_MS = 10 * 60_000;

/** Reasons that can add a PR to the queue, or change its section, before discovery sees it. */
const DISCOVERY_REASONS = new Set(['review_requested', 'assign', 'author', 'mention', 'team_mention', 'approval_requested']);

/** The github.com PR a notification thread is about, or undefined for issues, releases, discussions and other hosts. */
export function notificationPrUrl(thread: Pick<NotificationThread, 'subject'>): string | undefined {
  if (thread.subject.type !== 'PullRequest' || typeof thread.subject.url !== 'string') return;
  const match = /^https:\/\/api\.github\.com\/repos\/([\w.-]+)\/([\w.-]+)\/pulls\/([1-9]\d*)$/.exec(thread.subject.url);
  return match ? `https://github.com/${match[1]}/${match[2]}/pull/${match[3]}` : undefined;
}

function parseThreads(value: unknown): NotificationThread[] {
  if (!Array.isArray(value)) return [];
  return value.filter((thread): thread is NotificationThread => {
    const t = thread as Partial<NotificationThread> | null;
    return (
      !!t &&
      typeof t.id === 'string' &&
      typeof t.reason === 'string' &&
      typeof t.updated_at === 'string' &&
      Number.isFinite(Date.parse(t.updated_at)) &&
      !!t.subject &&
      typeof t.subject.type === 'string'
    );
  });
}

export interface ChangePlan {
  /** Known PRs to read again. */
  refresh: string[];
  /** Unknown PRs that the reader is involved in: discovery should run soon. */
  discover: string[];
  /** The newest `updated_at` seen, the next cursor. */
  cursor: number;
  /** Every thread of the page is newer than the cursor: some changes may be on the next page. */
  saturated: boolean;
  /**
   * Known PRs whose thread may hold a mention or a reply to the reader, newest first, at most
   * `COMMENT_READS_PER_POLL`. Each costs one discussion read.
   */
  comments: CommentCandidate[];
}

/**
 * Which PRs a page of notifications names, newer than `cursor`. Known PRs are read again; unknown PRs with a
 * reason that can bring them into the queue ask for discovery. Other threads (issues, releases, PRs in watched
 * repositories the reader has no part in) cost nothing.
 */
export function planNotifications(
  raw: unknown,
  cursor: number | undefined,
  known: (url: string) => boolean
): ChangePlan {
  const threads = parseThreads(raw);
  const refresh = new Set<string>();
  const discover = new Set<string>();
  const comments = new Map<string, CommentCandidate>();
  let newest = cursor ?? 0;
  for (const thread of threads) {
    const at = Date.parse(thread.updated_at);
    newest = Math.max(newest, at);
    // The first page after launch only sets the cursor. Discovery at launch covers what came before.
    if (cursor === undefined || at <= cursor) continue;
    const url = notificationPrUrl(thread);
    if (!url) continue;
    if (known(url)) {
      refresh.add(url);
      const previous = comments.get(url);
      if (COMMENT_REASONS.has(thread.reason) && (!previous || at > previous.updatedAt))
        comments.set(url, { url, reason: thread.reason, since: cursor, updatedAt: at });
    } else if (DISCOVERY_REASONS.has(thread.reason)) discover.add(url);
  }
  const saturated =
    cursor !== undefined && threads.length >= CHANGE_PAGE && threads.every((thread) => Date.parse(thread.updated_at) > cursor);
  const candidates = [...comments.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, COMMENT_READS_PER_POLL);
  return { refresh: [...refresh], discover: [...discover], cursor: newest, saturated, comments: candidates };
}

/** GitHub search dates are whole seconds in UTC. */
const searchDate = (ms: number) => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z');
/** The two search strings for PRs updated at or after `since`, newest first. */
export function changedPrQueries(since: number) {
  const updated = `updated:>=${searchDate(since)}`;
  return {
    involves: `is:pr involves:@me ${updated} sort:updated-desc`,
    // `involves` covers author, assignee, mentions and comments, not review requests, direct or by team.
    requested: `is:pr review-requested:@me ${updated} sort:updated-desc`,
  };
}
/** One query, two aliases. Only ids, links, update times and heads: `rateLimit.cost` is 1 for both pages. */
export const CHANGED_PRS_QUERY = `query GnosisChangedPrs($involves: String!, $requested: String!, $first: Int!) {
  rateLimit { cost remaining resetAt }
  involves: search(type: ISSUE, query: $involves, first: $first) { issueCount nodes { ... on PullRequest { id url updatedAt headRefOid } } }
  requested: search(type: ISSUE, query: $requested, first: $first) { issueCount nodes { ... on PullRequest { id url updatedAt headRefOid } } }
}`;

/** The search response, with anything malformed left out. */
export function parseChangedPrs(data: unknown): ChangedPrsResult {
  const root = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  const prs = new Map<string, ChangedPr>();
  let truncated = false;
  for (const alias of ['involves', 'requested']) {
    const search = root[alias] as { issueCount?: unknown; nodes?: unknown } | undefined;
    if (!search || !Array.isArray(search.nodes)) continue;
    if (typeof search.issueCount === 'number' && search.issueCount > search.nodes.length) truncated = true;
    for (const node of search.nodes as (Partial<ChangedPr> | null)[]) {
      if (
        !node ||
        typeof node.url !== 'string' ||
        !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/[1-9]\d*$/.test(node.url) ||
        typeof node.updatedAt !== 'string' ||
        typeof node.headRefOid !== 'string'
      )
        continue;
      const previous = prs.get(node.url);
      if (!previous || Date.parse(node.updatedAt) > Date.parse(previous.updatedAt))
        prs.set(node.url, { id: typeof node.id === 'string' ? node.id : '', url: node.url, updatedAt: node.updatedAt, headRefOid: node.headRefOid });
    }
  }
  const rateLimit = root.rateLimit as { cost?: unknown } | undefined;
  const cost = typeof rateLimit?.cost === 'number' && Number.isFinite(rateLimit.cost) ? rateLimit.cost : undefined;
  return { prs: [...prs.values()], cost, truncated };
}

/**
 * The PRs of a search page that changed since Gnosis last saw them: a newer update time or a different head than
 * the saved copy. PRs that Gnosis does not hold ask for discovery instead.
 */
export function planChangedPrs(
  prs: readonly ChangedPr[],
  known: (url: string) => { updatedAt: string; headSha: string } | undefined
): { refresh: string[]; discover: string[] } {
  const refresh: string[] = [];
  const discover: string[] = [];
  for (const pr of prs) {
    const saved = known(pr.url);
    if (!saved) discover.push(pr.url);
    else if (saved.headSha !== pr.headRefOid || Date.parse(pr.updatedAt) > Date.parse(saved.updatedAt)) refresh.push(pr.url);
  }
  return { refresh, discover };
}

export type ChangeSource = 'notifications' | 'search';
export interface ChangeSignalsDeps {
  now?: () => number;
  /** The same rules as watch mode: `sync` while a window or the menu bar panel is visible, `off` when signed out, asleep or offline. */
  mode: () => SyncMode;
  /** Seconds since the reader last used the computer. */
  idleSeconds?: () => number;
  /** The watch cadence, longer on battery. */
  watchInterval?: () => number;
  /** The signed-in account. State is kept per account. */
  account: () => string | null;
  /** When automatic reads of this resource may run again, if paused for the budget or a rate limit. */
  blockedUntil?: (resource: 'core' | 'graphql') => number | undefined;
  /** `GET /notifications` with these validators. Throws on errors other than missing access. */
  notifications: (validators: { lastModified?: string; etag?: string }) => Promise<NotificationsResponse>;
  /** The changed-PR search. */
  search: (queries: { involves: string; requested: string }) => Promise<ChangedPrsResult>;
  /** The saved copy of a PR, local only. */
  known: (url: string) => { updatedAt: string; headSha: string } | undefined;
  /** A read revealed this head: main's `noteHeadSha`. */
  head: (url: string, sha: string, updatedAt: string) => void;
  /** Read these PRs again through the scheduler. */
  refresh: (urls: string[], source: ChangeSource) => Promise<void>;
  /** Bring discovery forward: an unknown PR involves the reader, or a page was full. */
  discover: (source: ChangeSource) => void;
  /** PRs the reader muted: never a reason for discovery. */
  ignored?: (url: string) => boolean;
  /** Feed threads that may hold a mention or a reply: main reads their discussions once and notifies. */
  comments?: (candidates: CommentCandidate[]) => void;
  log?: (line: string) => void;
}
interface SourceState {
  due: number;
  pending: boolean;
  failures: number;
}
interface AccountState {
  notifications: SourceState & {
    lastModified?: string;
    etag?: string;
    pollInterval: number;
    cursor?: number;
    unavailable?: { code: number; until: number };
    /** The fallback is logged once per account. */
    logged?: boolean;
  };
  search: SourceState & { cursor?: number; asked: Map<string, string> };
  /** The last time each source answered, to tell whether signals are healthy. */
  answered: Partial<Record<ChangeSource, number>>;
}
export interface ChangeSignalStats {
  notifications: { requests: number; notModified: number; refreshed: number; unavailable: number };
  search: { requests: number; points: number; refreshed: number };
}

/**
 * The change-signal loop. Main calls `tick` every second; each source runs when it is due and never overlaps itself.
 * Errors back off, rate limits wait for their reset, and nothing runs in `off` mode.
 */
export function createChangeSignals(deps: ChangeSignalsDeps) {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  const accounts = new Map<string, AccountState>();
  const stats: ChangeSignalStats = {
    notifications: { requests: 0, notModified: 0, refreshed: 0, unavailable: 0 },
    search: { requests: 0, points: 0, refreshed: 0 },
  };
  const stateFor = (account: string) => {
    let state = accounts.get(account);
    if (!state) {
      state = {
        notifications: { due: 0, pending: false, failures: 0, pollInterval: NOTIFICATIONS_INTERVAL_MS },
        search: { due: 0, pending: false, failures: 0, asked: new Map() },
        answered: {},
      };
      accounts.set(account, state);
    }
    return state;
  };
  /** Sync mode with someone at the computer: full cadence. Watch mode, or nobody there: the watch cadence. */
  const interval = (normal: number) => {
    const slow = deps.watchInterval?.() ?? WATCH_INTERVAL_MS;
    if (deps.mode() !== 'sync' || (deps.idleSeconds?.() ?? 0) >= IDLE_SECONDS) return Math.max(normal, slow);
    return normal;
  };
  const retryAt = (error: unknown) => {
    const value = (error as { retryAt?: unknown } | null)?.retryAt;
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  };
  const failed = (source: SourceState, error: unknown, normal: number) => {
    source.failures++;
    const limited = retryAt(error);
    source.due = Math.max(limited ?? 0, now() + Math.min(MAX_ERROR_DELAY_MS, normal * 2 ** Math.min(source.failures - 1, 4)));
    return limited;
  };

  async function pollNotifications(account: string, state: AccountState) {
    const feed = state.notifications;
    const started = now();
    stats.notifications.requests++;
    let response: NotificationsResponse;
    try {
      response = await deps.notifications({ lastModified: feed.lastModified, etag: feed.etag });
    } catch (error) {
      const limited = failed(feed, error, interval(feed.pollInterval));
      log(`[change-signals] notifications failed: ${error instanceof Error ? error.message : String(error)}; next in ${Math.round((feed.due - now()) / 1000)}s${limited ? ' (rate limit)' : ''}`);
      return;
    }
    if (deps.account() !== account) return;
    feed.failures = 0;
    if (response.status === 'unavailable') {
      stats.notifications.unavailable++;
      feed.unavailable = { code: response.code, until: now() + NOTIFICATIONS_RECHECK_MS };
      feed.due = feed.unavailable.until;
      // The search covers these PRs. Say so once, not on every recheck.
      if (!feed.logged) console.log(`[change-signals] The notifications feed is not available to this GitHub token (HTTP ${response.code}). Using the changed-PR search only.`);
      feed.logged = true;
      return;
    }
    feed.unavailable = undefined;
    state.answered.notifications = now();
    if (response.pollInterval && Number.isFinite(response.pollInterval) && response.pollInterval > 0)
      feed.pollInterval = Math.max(NOTIFICATIONS_INTERVAL_MS, response.pollInterval * 1000);
    feed.due = now() + interval(feed.pollInterval);
    if (response.status === 304) {
      stats.notifications.notModified++;
      log(`[change-signals] notifications: 304 not modified (free), 0 PRs; next in ${Math.round((feed.due - now()) / 1000)}s`);
      return;
    }
    feed.lastModified = response.lastModified ?? feed.lastModified;
    feed.etag = response.etag ?? feed.etag;
    const plan = planNotifications(response.threads, feed.cursor, (url) => !!deps.known(url));
    feed.cursor = plan.cursor;
    if (plan.discover.some((url) => !deps.ignored?.(url)) || plan.saturated) deps.discover('notifications');
    stats.notifications.refreshed += plan.refresh.length;
    log(
      `[change-signals] notifications: 200, ${plan.refresh.length} changed PR${plan.refresh.length === 1 ? '' : 's'}` +
        `${plan.discover.length ? `, ${plan.discover.length} new` : ''}${plan.saturated ? ', page full' : ''}, 1 core request in ${now() - started}ms; next in ${Math.round((feed.due - now()) / 1000)}s`
    );
    const comments = plan.comments.filter((candidate) => !deps.ignored?.(candidate.url));
    if (comments.length) deps.comments?.(comments);
    if (plan.refresh.length) await deps.refresh(plan.refresh, 'notifications');
  }

  async function runSearch(account: string, state: AccountState) {
    const search = state.search;
    const started = now();
    const since = search.cursor === undefined ? started - SEARCH_FIRST_LOOKBACK_MS : search.cursor - SEARCH_OVERLAP_MS;
    stats.search.requests++;
    let result: ChangedPrsResult;
    try {
      result = await deps.search(changedPrQueries(since));
    } catch (error) {
      const limited = failed(search, error, interval(SEARCH_INTERVAL_MS));
      log(`[change-signals] search failed: ${error instanceof Error ? error.message : String(error)}; next in ${Math.round((search.due - now()) / 1000)}s${limited ? ' (rate limit)' : ''}`);
      return;
    }
    if (deps.account() !== account) return;
    search.failures = 0;
    // The next search starts from when this one started, less the overlap.
    search.cursor = started;
    search.due = now() + interval(SEARCH_INTERVAL_MS);
    state.answered.search = now();
    stats.search.points += result.cost ?? 1;
    // Compare with the saved copies before a head report updates them.
    const plan = planChangedPrs(result.prs, deps.known);
    for (const pr of result.prs) if (deps.known(pr.url)) deps.head(pr.url, pr.headRefOid, pr.updatedAt);
    // A PR that discovery leaves out (muted, closed, inactive, ignored) asks once per update, not on every overlap.
    const fresh = plan.discover.filter((url) => {
      const key = result.prs.find((pr) => pr.url === url)?.updatedAt ?? '';
      if (deps.ignored?.(url) || search.asked.get(url) === key) return false;
      search.asked.delete(url);
      search.asked.set(url, key);
      while (search.asked.size > 500) search.asked.delete(search.asked.keys().next().value as string);
      return true;
    });
    if (fresh.length || result.truncated) deps.discover('search');
    stats.search.refreshed += plan.refresh.length;
    log(
      `[change-signals] search: ${result.prs.length} PR${result.prs.length === 1 ? '' : 's'} since ${new Date(since).toISOString()}, ` +
        `${plan.refresh.length} changed${fresh.length ? `, ${fresh.length} new` : ''}${result.truncated ? ', page full' : ''}, ` +
        `cost ${result.cost ?? '?'} GraphQL point${result.cost === 1 ? '' : 's'} in ${now() - started}ms; next in ${Math.round((search.due - now()) / 1000)}s`
    );
    if (plan.refresh.length) await deps.refresh(plan.refresh, 'search');
  }

  const run = (source: SourceState, work: () => Promise<void>) => {
    source.pending = true;
    void work()
      .catch((error: unknown) => log(`[change-signals] ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => {
        source.pending = false;
      });
  };

  return {
    tick() {
      const account = deps.account();
      if (!account || deps.mode() === 'off') return;
      const state = stateFor(account);
      const time = now();
      const feed = state.notifications;
      if (!feed.pending && time >= feed.due && !((deps.blockedUntil?.('core') ?? 0) > time)) run(feed, () => pollNotifications(account, state));
      const search = state.search;
      if (!search.pending && time >= search.due && !((deps.blockedUntil?.('graphql') ?? 0) > time)) run(search, () => runSearch(account, state));
    },
    /** Back at the computer, or a window opened: both sources run within a few seconds. Never earlier than a rate limit or the feed's own interval. */
    wake() {
      const account = deps.account();
      if (!account) return;
      const state = stateFor(account);
      const soon = now() + 3_000;
      if (!state.notifications.unavailable && !state.notifications.failures) {
        const earliest = (state.answered.notifications ?? 0) + state.notifications.pollInterval;
        state.notifications.due = Math.min(state.notifications.due, Math.max(soon, earliest));
      }
      if (!state.search.failures) state.search.due = Math.min(state.search.due, Math.max(soon, (state.answered.search ?? 0) + 30_000));
    },
    /**
     * At least one source answered within twice its interval. Broader polling, such as discovery, can then run less
     * often: these signals bring it forward when they see something new.
     */
    healthy(): boolean {
      const account = deps.account();
      const state = account ? accounts.get(account) : undefined;
      if (!state) return false;
      const time = now();
      const recent = (source: ChangeSource, every: number) => time - (state.answered[source] ?? -Infinity) <= 2 * interval(every) + 30_000;
      return recent('search', SEARCH_INTERVAL_MS) || recent('notifications', state.notifications.pollInterval);
    },
    /** Whether the feed refused this account's token. */
    notificationsUnavailable: () => {
      const account = deps.account();
      return !!(account && accounts.get(account)?.notifications.unavailable);
    },
    /** The search cursor of an account, for tests and diagnostics. */
    cursor: (account: string) => accounts.get(account)?.search.cursor,
    stats: () => structuredClone(stats),
    /** Signing out forgets the account's cursors and validators. */
    forget: (account: string) => accounts.delete(account),
  };
}
