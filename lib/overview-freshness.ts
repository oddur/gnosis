/**
 * The Overview's freshness line: whether the page is up to date, and if not, the one specific reason.
 *
 * "Up to date" is decided from what the page depends on, not from the background full refresh:
 *
 * - every PR the page reads status for has readiness and checks no older than `STATUS_FRESH_MS`;
 * - the change signals (the notifications feed or the changed-PR search, lib/github-change-signals.ts) answered within
 *   their normal interval, so a new review request or reply reaches the page within a minute or two (`sync.signals`);
 * - no sync error or rate-limit pause is active, and the PR list has been read in full at least once.
 *
 * The time it shows ("Up to date · 2m ago") is the oldest status read among the page's PRs. That is the oldest input
 * the page shows. The change signals only gate the claim: they answer every minute or two while healthy, and main
 * tells the windows when that flips rather than on every poll, so their exact time is not on the renderer.
 *
 * The background full refresh (discovery) re-reads every PR a few at a time, paced inside the automatic GitHub budget,
 * and a pass on a large account can take over 10 minutes. It is a quiet note beside the line ("Refreshing PR list ·
 * 120 of 273"), never a spinner. The spinner is only for a pass the reader asked for (Refresh), until its first results.
 *
 * Precedence, first match wins: rate limit, could not reach GitHub, the reader's refresh, a pass that finished with
 * warnings, status reads, an abnormally old PR list, change signals not answering, then up to date.
 */
import { freshnessLabel } from './focus-refresh';
import { OVERVIEW_STATUS_SWEEP_MS, QUEUE_SIGNALS_TTL, queueSignalKey, type QueueSignalRequest, type QueueSignals } from './queue-signals';
import type { WorkbenchSync } from './workbench';

/**
 * Status older than this is stale. The Overview reads a PR again once its status passes `QUEUE_SIGNALS_TTL` (2 min),
 * found by a sweep every `OVERVIEW_STATUS_SWEEP_MS` (30 s), and main may answer from its own cache of up to another
 * `QUEUE_SIGNALS_TTL`. Status older than all three together (4.5 min) means a read failed or is held back.
 */
export const STATUS_FRESH_MS = 2 * QUEUE_SIGNALS_TTL + OVERVIEW_STATUS_SWEEP_MS;
/** A status read pending for less than this has just started: the line says "Checking", not that it is missing. */
export const STATUS_GRACE_MS = 10_000;
/**
 * One full discovery pass, as expected on a large account: about 300 PR reads at the automatic pace of 3.6 s per
 * read (20% of 5,000 REST requests an hour, lib/github-budget.ts) is 18 minutes, plus up to 5 minutes between passes
 * (src/main.ts, `DISCOVERY_WITH_SIGNALS_MS`). Rounded up to 30 minutes.
 */
export const EXPECTED_PASS_MS = 30 * 60_000;
/**
 * "PR list last fully refreshed 3h ago" shows only past twice the expected pass (1 hour), and only while no pass is
 * running: a slow pass in progress is normal, a list nobody is refreshing is not.
 */
export const LIST_STALE_MS = 2 * EXPECTED_PASS_MS;

/** What the page's status reads look like now. */
export interface StatusFreshness {
  /** PRs the page reads status for. */
  total: number;
  /** PRs with no status yet. */
  missing: number;
  /** PRs whose status is older than `STATUS_FRESH_MS`. */
  stale: number;
  /** Of the missing and stale PRs, those with a read in flight. */
  pending: number;
  /** When the oldest of those reads started. */
  pendingSince?: number;
  /** The oldest status among the PRs that have one. */
  oldestAt?: number;
}

/** Summarizes the page's status reads: `values` by `queueSignalKey`, `pending` reads by key with their start time. */
export function statusFreshness(
  requests: readonly QueueSignalRequest[],
  values: ReadonlyMap<string, Pick<QueueSignals, 'checkedAt'>>,
  pending: ReadonlyMap<string, number>,
  now: number
): StatusFreshness {
  let missing = 0, stale = 0, waiting = 0;
  let pendingSince: number | undefined, oldestAt: number | undefined;
  for (const request of requests) {
    const key = queueSignalKey(request);
    const value = values.get(key);
    if (value) oldestAt = Math.min(oldestAt ?? Infinity, value.checkedAt);
    const unresolved = !value ? 'missing' : now - value.checkedAt > STATUS_FRESH_MS ? 'stale' : undefined;
    if (!unresolved) continue;
    if (unresolved === 'missing') missing++;
    else stale++;
    const started = pending.get(key);
    if (started !== undefined) {
      waiting++;
      pendingSince = Math.min(pendingSince ?? Infinity, started);
    }
  }
  return { total: requests.length, missing, stale, pending: waiting, ...(pendingSince !== undefined ? { pendingSince } : {}), ...(oldestAt !== undefined ? { oldestAt } : {}) };
}

export type FreshnessKind =
  | 'up-to-date'
  | 'updated'
  | 'requested'
  | 'checking-status'
  | 'status-missing'
  | 'status-stale'
  | 'rate-limited'
  | 'offline'
  | 'incomplete'
  | 'list-stale';
export interface FreshnessLine {
  kind: FreshnessKind;
  text: string;
  title: string;
  /** The time the line names, for a `<time>` element. */
  at?: number;
  /** Only for the reader's own refresh. */
  spinner?: boolean;
  /** Something is wrong: the line reads in the text colour, not muted. */
  problem?: boolean;
  /** The link that fixes it. */
  action?: 'retry' | 'refresh' | 'activity';
}
export interface OverviewFreshness {
  line?: FreshnessLine;
  /** The background full refresh, as a quiet note beside the line. */
  progress?: { text: string; title: string };
}
export interface FreshnessInput {
  sync?: WorkbenchSync;
  status: StatusFreshness;
  now: number;
  /** The reader pressed Refresh and main has not answered with a new sync state yet. */
  asked?: boolean;
  /** The snapshot saved last session is on screen while main reads GitHub again. */
  saved?: boolean;
}

const prs = (n: number) => `${n} ${n === 1 ? 'PR' : 'PRs'}`;
/** "just now", "2m ago", "3h ago": the app's own relative times (lib/focus-refresh.ts). */
export const ago = (at: number, now: number) => freshnessLabel(at, now).replace(/^Checked /, '');
const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const stamp = (at: number) => new Date(at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });

export const REFRESH_NOTE_TITLE =
  'Gnosis re-reads every PR in the background, a few at a time, to catch anything the notifications missed. The page updates as it goes.';
function progressNote(progress: WorkbenchSync['progress']) {
  return {
    text: progress && progress.total > 0 ? `Refreshing PR list · ${Math.min(progress.done, progress.total)} of ${progress.total}` : 'Refreshing PR list…',
    title: REFRESH_NOTE_TITLE,
  };
}

/** The Overview's freshness line and background note. Pure: the page passes the clock. */
export function overviewFreshness({ sync, status, now, asked = false, saved = false }: FreshnessInput): OverviewFreshness {
  const checking = sync?.status === 'checking';
  const results = (sync?.progress?.done ?? 0) > 0;
  const progress = checking ? progressNote(sync.progress) : saved ? progressNote(undefined) : undefined;
  if (sync?.status === 'paused')
    return {
      line: {
        kind: 'rate-limited',
        text: sync.retryAt && sync.retryAt > now ? `GitHub rate limit · showing saved data until ${clock(sync.retryAt)}` : 'GitHub rate limit · showing saved data',
        title: `GitHub asked Gnosis to slow down. The page shows what Gnosis saved${sync.checkedAt ? `, last read in full ${stamp(sync.checkedAt)}` : ''}. Updates resume on their own${sync.retryAt ? ` at ${clock(sync.retryAt)}` : ''}.`,
        problem: true,
      },
    };
  if (sync?.status === 'error' && sync.reason !== 'incomplete')
    return {
      line: {
        kind: 'offline',
        text: 'Could not reach GitHub · showing saved data',
        title: `Gnosis could not read your pull requests from GitHub, so the page shows what it saved${sync.checkedAt ? `, last read in full ${stamp(sync.checkedAt)}` : ''}. Check your connection, then retry.`,
        problem: true,
        action: 'retry',
      },
    };
  // The reader's own refresh: a spinner until the pass's first PRs arrive, then the progress note.
  if ((asked && !(checking && results)) || (checking && sync.requested && !results))
    return { line: { kind: 'requested', text: 'Refreshing…', title: 'Reading your pull requests from GitHub, as you asked. The page updates as they arrive.', spinner: true } };
  const withProgress = (line?: FreshnessLine): OverviewFreshness => ({ ...(line ? { line } : {}), ...(progress ? { progress } : {}) });
  if (sync?.status === 'error')
    return withProgress({
      kind: 'incomplete',
      text: 'Some PRs could not be refreshed',
      title: 'The last full read of your pull requests finished with warnings, such as a repository Gnosis could not read. Those PRs show what Gnosis saved. Activity has the details.',
      problem: true,
      action: 'activity',
    });
  const unresolved = status.missing + status.stale;
  if (unresolved > 0) {
    if (status.pending === unresolved && status.pendingSince !== undefined && now - status.pendingSince < STATUS_GRACE_MS)
      return withProgress({
        kind: 'checking-status',
        text: `Checking status of ${prs(unresolved)}`,
        title: `Reading the checks and merge readiness of ${prs(unresolved)} from GitHub. Each PR joins its section when GitHub answers.`,
      });
    if (status.missing > 0)
      return withProgress({
        kind: 'status-missing',
        text: `Status not checked for ${prs(status.missing)} yet`,
        title: `GitHub has not answered for the checks and merge readiness of ${prs(status.missing)} yet, so they may be missing from their sections. Gnosis keeps asking${status.pending ? '' : ' every 2 minutes'}.`,
        problem: true,
      });
    const oldest = status.oldestAt ?? now;
    return withProgress({
      kind: 'status-stale',
      text: `Status of ${prs(status.stale)} last checked ${ago(oldest, now)}`,
      title: `The checks and merge readiness of ${prs(status.stale)} are older than a few minutes, the oldest from ${stamp(oldest)}. Gnosis keeps asking GitHub.`,
      at: oldest,
      problem: true,
    });
  }
  if (!checking && sync?.checkedAt !== undefined && now - sync.checkedAt > LIST_STALE_MS)
    return withProgress({
      kind: 'list-stale',
      text: `PR list last fully refreshed ${ago(sync.checkedAt, now)}`,
      title: `Gnosis last read every pull request from GitHub ${stamp(sync.checkedAt)}, and no read is running now. New review requests still arrive through GitHub's notifications; Refresh reads the whole list again.`,
      at: sync.checkedAt,
      problem: true,
      action: 'refresh',
    });
  if (sync?.checkedAt === undefined) return withProgress();
  if (sync.signals !== true)
    return withProgress({
      kind: 'updated',
      text: `Updated ${ago(sync.checkedAt, now)}`,
      title: `Gnosis last finished reading every pull request ${stamp(sync.checkedAt)}. GitHub's notifications are not answering right now, so Gnosis finds changes by reading the PR list again every 2 minutes.`,
      at: sync.checkedAt,
    });
  return withProgress({
    kind: 'up-to-date',
    text: status.oldestAt !== undefined ? `Up to date · ${ago(status.oldestAt, now)}` : 'Up to date',
    title:
      (status.total
        ? `The checks and merge readiness of every PR on this page are current${status.oldestAt !== undefined ? `, the oldest read ${stamp(status.oldestAt)}` : ''}. `
        : '') + "GitHub's notifications are answering, so new review requests and replies show up within a minute or two.",
    ...(status.oldestAt !== undefined ? { at: status.oldestAt } : {}),
  });
}
