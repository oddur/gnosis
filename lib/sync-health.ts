/**
 * Sync health: a drift detector that compares what Gnosis shows with a fresh GitHub read.
 *
 * GitHub's own computed fields are the ground truth: `state`, `merged`, `isDraft`, `headRefOid`, `reviewDecision`,
 * `mergeStateStatus`, the check rollup with superseded workflow runs left out, unresolved review threads,
 * `totalCommentsCount` and `latestOpinionatedReviews`. A difference that timing explains is staleness, not drift:
 * GitHub changed the field after Gnosis last read it. Staleness is recorded separately.
 *
 * Everything here is pure. `src/drift-detector.ts` schedules samples, reads GitHub and saves the state.
 */

/** Background samples: a few PRs, rarely. */
export const DRIFT_SAMPLE_INTERVAL_MS = 12 * 60_000;
export const DRIFT_SAMPLE_SIZE = 3;
/** The same PR is not sampled again in the background within this time, unless a mismatch waits for confirmation. */
export const DRIFT_RESAMPLE_MS = 60 * 60_000;
/** A mismatch that waits for confirmation is sampled again after this time. */
export const DRIFT_CONFIRM_MS = 3 * 60_000;
/** PRs opened within this time count as seen recently. */
export const DRIFT_SEEN_WINDOW_MS = 24 * 60 * 60_000;
/** Local and GitHub clocks differ. A change this close to Gnosis's read counts as after it. */
export const DRIFT_CLOCK_SKEW_MS = 60_000;
export const SYNC_HEALTH_LIMITS = { drifts: 100, stale: 50, runs: 30, suspects: 50, sampled: 200 } as const;

export type DriftField =
  | 'state'
  | 'draft'
  | 'head'
  | 'review-decision'
  | 'merge-state'
  | 'checks'
  | 'unresolved-threads'
  | 'comments'
  | 'approvals'
  | 'changes-requested'
  | 'attention:checks-failed'
  | 'attention:changes-requested';
export const DRIFT_FIELD_LABEL: Readonly<Record<DriftField, string>> = {
  state: 'State',
  draft: 'Draft',
  head: 'Head commit',
  'review-decision': 'Review decision',
  'merge-state': 'Merge state',
  checks: 'Checks',
  'unresolved-threads': 'Unresolved threads',
  comments: 'Comments',
  approvals: 'Approvals',
  'changes-requested': 'Changes requested',
  'attention:checks-failed': 'Needs you: checks failed',
  'attention:changes-requested': 'Needs you: changes requested',
};
/** Where Gnosis's value comes from. */
export type DriftSource = 'queue' | 'signals' | 'status' | 'discussion' | 'attention';

// ── Ground truth ──

/** The GraphQL selection for one PR. One query per PR; GitHub charges 1 point. */
export const GROUND_TRUTH_SELECTION = `updatedAt state merged isDraft headRefOid reviewDecision mergeStateStatus totalCommentsCount
  reviewThreads(first:100) { totalCount nodes { isResolved } }
  latestOpinionatedReviews(first:100, writersOnly:true) { nodes { state author { login } } }
  commits(last:1) { nodes { commit { oid statusCheckRollup { state contexts(first:100) { totalCount nodes {
    __typename
    ... on CheckRun { status conclusion startedAt completedAt checkSuite { workflowRun { databaseId event workflow { databaseId } } } }
    ... on StatusContext { state createdAt }
  } } } } } }`;

export interface GroundTruthContext {
  __typename: 'CheckRun' | 'StatusContext';
  status?: string;
  conclusion?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  state?: string;
  createdAt?: string;
  checkSuite?: {
    workflowRun?: { databaseId: number | null; event: string; workflow: { databaseId: number | null } } | null;
  } | null;
}
export interface GroundTruthPull {
  updatedAt: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  merged: boolean;
  isDraft: boolean;
  headRefOid: string;
  reviewDecision: string | null;
  mergeStateStatus: string;
  totalCommentsCount: number | null;
  reviewThreads: { totalCount: number; nodes: ({ isResolved: boolean } | null)[] | null } | null;
  latestOpinionatedReviews: { nodes: ({ state: string; author: { login: string } | null } | null)[] | null } | null;
  commits: {
    nodes:
      | ({
          commit: {
            oid: string;
            statusCheckRollup: {
              state: string;
              contexts: { totalCount: number; nodes: (GroundTruthContext | null)[] | null };
            } | null;
          };
        } | null)[]
      | null;
  };
}
export type ChecksState = 'success' | 'failure' | 'pending' | 'neutral';
export interface GroundTruth {
  url: string;
  /** Local time of the read. */
  readAt: number;
  updatedAt: string;
  state: 'open' | 'closed' | 'merged';
  isDraft: boolean;
  headSha: string;
  reviewDecision: string | null;
  mergeState: string;
  /** GitHub's own rollup, which also counts jobs of superseded workflow runs. */
  rollup: string | null;
  /** Current checks: the rollup's contexts without superseded runs. Undefined when GitHub has more than 100. */
  checks?: { state: ChecksState; failed: number; running: number; total: number; changedAt?: number };
  /** Undefined when the PR has more than 100 threads. */
  unresolvedThreads?: number;
  totalComments: number | null;
  approvals: number;
  changesRequested: number;
  /** Logins with an open request for changes. */
  changesRequestedBy: string[];
}

const FAILED = ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STALE', 'STARTUP_FAILURE'];
const time = (value: string | null | undefined) => {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
};
/**
 * Leaves out check runs of superseded workflow runs: for each workflow and event, only the newest run counts, as on
 * GitHub's PR page. Commit statuses are already one per context.
 */
export function currentContexts(contexts: GroundTruthContext[]): GroundTruthContext[] {
  const newest = new Map<string, number>();
  for (const context of contexts) {
    const run = context.checkSuite?.workflowRun;
    if (!run?.databaseId || !run.workflow.databaseId) continue;
    const key = `${run.workflow.databaseId}:${run.event}`;
    newest.set(key, Math.max(newest.get(key) ?? 0, run.databaseId));
  }
  return contexts.filter((context) => {
    const run = context.checkSuite?.workflowRun;
    if (!run?.databaseId || !run.workflow.databaseId) return true;
    return newest.get(`${run.workflow.databaseId}:${run.event}`) === run.databaseId;
  });
}
export function checksTruth(contexts: GroundTruthContext[]): NonNullable<GroundTruth['checks']> {
  let failed = 0,
    running = 0,
    changedAt: number | undefined;
  const current = currentContexts(contexts);
  for (const context of current) {
    const check = context.__typename === 'CheckRun';
    const done = check ? context.status === 'COMPLETED' : !['PENDING', 'EXPECTED'].includes(context.state ?? '');
    if (!done) running++;
    else if (FAILED.includes((check ? context.conclusion : context.state) ?? '')) failed++;
    for (const at of [context.startedAt, context.completedAt, context.createdAt].map(time))
      if (at !== undefined) changedAt = Math.max(changedAt ?? at, at);
  }
  return {
    state: failed ? 'failure' : running ? 'pending' : current.length ? 'success' : 'neutral',
    failed,
    running,
    total: current.length,
    ...(changedAt !== undefined ? { changedAt } : {}),
  };
}
export function groundTruthFrom(url: string, pr: GroundTruthPull, readAt: number): GroundTruth {
  const rollup = pr.commits.nodes?.[0]?.commit.statusCheckRollup ?? null;
  const contexts = (rollup?.contexts.nodes ?? []).flatMap((node) => (node ? [node] : []));
  const complete = !rollup || rollup.contexts.totalCount <= contexts.length;
  const opinions = (pr.latestOpinionatedReviews?.nodes ?? []).flatMap((node) => (node ? [node] : []));
  const threads = pr.reviewThreads;
  const threadNodes = (threads?.nodes ?? []).flatMap((node) => (node ? [node] : []));
  return {
    url,
    readAt,
    updatedAt: pr.updatedAt,
    state: pr.merged || pr.state === 'MERGED' ? 'merged' : pr.state === 'CLOSED' ? 'closed' : 'open',
    isDraft: pr.isDraft,
    headSha: pr.headRefOid,
    reviewDecision: pr.reviewDecision,
    mergeState: pr.mergeStateStatus,
    rollup: rollup?.state ?? null,
    // Over 100 contexts the superseded runs cannot all be left out. Only a green rollup is then certain.
    ...(complete
      ? { checks: checksTruth(contexts) }
      : rollup.state === 'SUCCESS'
        ? { checks: { state: 'success' as const, failed: 0, running: 0, total: rollup.contexts.totalCount } }
        : {}),
    ...(threads && threads.totalCount <= threadNodes.length
      ? { unresolvedThreads: threadNodes.filter((thread) => !thread.isResolved).length }
      : {}),
    totalComments: pr.totalCommentsCount,
    approvals: opinions.filter((review) => review.state === 'APPROVED').length,
    changesRequested: opinions.filter((review) => review.state === 'CHANGES_REQUESTED').length,
    changesRequestedBy: opinions.flatMap((review) =>
      review.state === 'CHANGES_REQUESTED' && review.author ? [review.author.login] : []
    ),
  };
}

// ── What Gnosis shows ──

export interface GnosisView {
  url: string;
  /** The queue or tab copy of the PR, with GitHub's `updatedAt` from the read behind it. */
  member?: {
    updatedAt: string;
    state: 'open' | 'closed' | 'merged';
    isDraft: boolean;
    headSha: string;
    /** The badge count without signals: the REST conversation plus inline comment counts (`prCommentTotal`). */
    comments?: number;
  };
  /** Signals for the member's head: badges, readiness and attention come from these. */
  signals?: {
    checkedAt: number;
    headSha: string;
    reviewDecision?: string | null;
    mergeState?: string;
    checks: ChecksState;
    /** `totalCommentsCount`, which the badge shows through `prCommentTotal`. */
    comments: number;
  };
  /** Needs-you kinds Gnosis raises for this PR. Only for the reader's own open PRs. */
  attention?: { checkedAt: number; headSha: string; checksFailed: boolean; changesRequested: boolean };
  /** The PR summary's review counts. */
  status?: { checkedAt: number; headSha: string; approvals: number; changesRequested: number };
  /** The saved discussion behind Feedback and the queue's thread counts. */
  threads?: { checkedAt: number; unresolved: number };
}

// ── Classification ──

export interface Suspect {
  url: string;
  field: DriftField;
  github: string;
  /** The first ground-truth read that showed this value. */
  readAt: number;
}
export interface Finding {
  url: string;
  field: DriftField;
  source: DriftSource;
  gnosis: string;
  github: string;
  /** How old Gnosis's value was at the read: ground-truth read time minus Gnosis's read time. */
  ageMs: number;
  /**
   * `drift`: Gnosis read after GitHub's last change and still shows another value.
   * `stale`: GitHub changed after Gnosis's read.
   * `unconfirmed`: GitHub does not say when this field changed; it becomes drift if it persists after Gnosis reads again.
   */
  kind: 'drift' | 'stale' | 'unconfirmed';
}
const text = (value: string | number | boolean | null | undefined) =>
  value === null || value === undefined ? 'none' : typeof value === 'boolean' ? (value ? 'yes' : 'no') : String(value);

/**
 * Compares one PR. `changedAt` is when GitHub last changed the field, when GitHub says. Without it, a mismatch first
 * waits as a suspect: it is drift only if a later read still shows it after Gnosis has read the PR again.
 */
export function classifyDrift(
  view: GnosisView,
  truth: GroundTruth,
  suspects: readonly Suspect[] = [],
  skew = DRIFT_CLOCK_SKEW_MS
): {
  findings: Finding[];
  suspects: Suspect[];
} {
  const findings: Finding[] = [];
  const next: Suspect[] = [];
  const updatedAt = time(truth.updatedAt) ?? truth.readAt;
  const compare = (
    field: DriftField,
    source: DriftSource,
    gnosis: string | number | boolean | null | undefined,
    github: string | number | boolean | null | undefined,
    observedAt: number,
    changedAt: number | undefined
  ) => {
    const ours = text(gnosis),
      theirs = text(github);
    const ageMs = Math.max(0, truth.readAt - observedAt);
    if (ours === theirs) return;
    const finding = { url: view.url, field, source, gnosis: ours, github: theirs, ageMs };
    if (changedAt !== undefined) {
      findings.push({ ...finding, kind: changedAt > observedAt - skew ? 'stale' : 'drift' });
      return;
    }
    // GitHub moved after Gnosis's read: timing explains it.
    if (updatedAt > observedAt - skew) {
      findings.push({ ...finding, kind: 'stale' });
      return;
    }
    const earlier = suspects.find(
      (suspect) => suspect.url === view.url && suspect.field === field && suspect.github === theirs
    );
    if (earlier && observedAt > earlier.readAt + skew) {
      findings.push({ ...finding, kind: 'drift' });
      return;
    }
    findings.push({ ...finding, kind: 'unconfirmed' });
    next.push({ url: view.url, field, github: theirs, readAt: earlier?.readAt ?? truth.readAt });
  };

  const member = view.member;
  if (member) {
    // The member carries GitHub's own `updatedAt`, so no clock is involved: the same value means the same revision.
    const same = member.updatedAt === truth.updatedAt;
    const observedAt = time(member.updatedAt) ?? truth.readAt;
    const memberChange = same ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
    compare('state', 'queue', member.state, truth.state, observedAt, memberChange);
    compare('draft', 'queue', member.isDraft, truth.isDraft, observedAt, memberChange);
    compare('head', 'queue', member.headSha.slice(0, 7), truth.headSha.slice(0, 7), observedAt, memberChange);
  }
  // Signals, status and attention describe one head. For another head the difference is the head itself.
  const signals = view.signals?.headSha === truth.headSha ? view.signals : undefined;
  if (signals) {
    compare('review-decision', 'signals', signals.reviewDecision, truth.reviewDecision, signals.checkedAt, updatedAt);
    if (signals.mergeState && signals.mergeState !== 'UNKNOWN' && truth.mergeState !== 'UNKNOWN')
      compare('merge-state', 'signals', signals.mergeState, truth.mergeState, signals.checkedAt, undefined);
    if (truth.checks)
      compare(
        'checks',
        'signals',
        signals.checks,
        truth.checks.state,
        signals.checkedAt,
        Math.max(updatedAt, truth.checks.changedAt ?? 0)
      );
    if (truth.totalComments !== null)
      compare('comments', 'signals', signals.comments, truth.totalComments, signals.checkedAt, updatedAt);
  } else if (member?.comments !== undefined && truth.totalComments !== null) {
    // No signals for this head: the badge falls back to the queue copy's REST counts.
    compare(
      'comments',
      'queue',
      member.comments,
      truth.totalComments,
      time(member.updatedAt) ?? truth.readAt,
      member.updatedAt === truth.updatedAt ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY
    );
  }
  const attention = view.attention?.headSha === truth.headSha && truth.state === 'open' ? view.attention : undefined;
  if (attention) {
    if (truth.checks)
      compare(
        'attention:checks-failed',
        'attention',
        attention.checksFailed,
        truth.checks.state === 'failure',
        attention.checkedAt,
        Math.max(updatedAt, truth.checks.changedAt ?? 0)
      );
    compare(
      'attention:changes-requested',
      'attention',
      attention.changesRequested,
      truth.changesRequested > 0 || truth.reviewDecision === 'CHANGES_REQUESTED',
      attention.checkedAt,
      updatedAt
    );
  }
  const status = view.status?.headSha === truth.headSha ? view.status : undefined;
  if (status) {
    compare('approvals', 'status', status.approvals, truth.approvals, status.checkedAt, updatedAt);
    compare(
      'changes-requested',
      'status',
      status.changesRequested,
      truth.changesRequested,
      status.checkedAt,
      updatedAt
    );
  }
  if (view.threads && truth.unresolvedThreads !== undefined)
    compare(
      'unresolved-threads',
      'discussion',
      view.threads.unresolved,
      truth.unresolvedThreads,
      view.threads.checkedAt,
      undefined
    );
  return { findings, suspects: next };
}

// ── Sampling ──

export interface DriftCandidate {
  url: string;
  /** When the reader last opened this PR. */
  seenAt?: number;
  inQueue: boolean;
}
/**
 * At most `limit` PRs: suspects waiting for confirmation first, then PRs seen recently, newest first, then queue PRs.
 * A PR sampled within `resampleMs` is skipped, so a background round never reads the same PRs again.
 */
export function pickDriftSample(input: {
  candidates: readonly DriftCandidate[];
  sampledAt: Readonly<Record<string, number>>;
  suspects: readonly Suspect[];
  now: number;
  limit?: number;
  resampleMs?: number;
}): string[] {
  const limit = Math.max(0, input.limit ?? DRIFT_SAMPLE_SIZE);
  const resample = input.resampleMs ?? DRIFT_RESAMPLE_MS;
  const known = new Map(input.candidates.map((candidate) => [candidate.url, candidate]));
  const picked: string[] = [];
  const add = (url: string) => {
    if (picked.length < limit && !picked.includes(url)) picked.push(url);
  };
  for (const suspect of [...input.suspects].sort((a, b) => a.readAt - b.readAt))
    if (
      known.has(suspect.url) &&
      input.now - (input.sampledAt[suspect.url] ?? Number.NEGATIVE_INFINITY) >= DRIFT_CONFIRM_MS
    )
      add(suspect.url);
  const due = input.candidates.filter(
    (candidate) => input.now - (input.sampledAt[candidate.url] ?? Number.NEGATIVE_INFINITY) >= resample
  );
  const seen = due
    .filter((candidate) => candidate.seenAt !== undefined && input.now - candidate.seenAt <= DRIFT_SEEN_WINDOW_MS)
    .sort((a, b) => (b.seenAt ?? 0) - (a.seenAt ?? 0));
  for (const candidate of seen) add(candidate.url);
  // Queue PRs least recently sampled first, so the whole queue is covered over time.
  const queue = due
    .filter((candidate) => candidate.inQueue)
    .sort((a, b) => (input.sampledAt[a.url] ?? 0) - (input.sampledAt[b.url] ?? 0));
  for (const candidate of queue) add(candidate.url);
  return picked;
}

// ── Saved state ──

export interface DriftRecord {
  url: string;
  field: DriftField;
  source: DriftSource;
  gnosis: string;
  github: string;
  /** Age of Gnosis's value at the latest read that showed this mismatch. */
  ageMs: number;
  firstSeenAt: number;
  lastSeenAt: number;
  count: number;
}
export interface StaleRecord {
  url: string;
  at: number;
  fields: DriftField[];
  /** Age of the oldest stale value. */
  ageMs: number;
  reason: 'github-changed' | 'unconfirmed';
}
export interface SampleRun {
  at: number;
  trigger: 'background' | 'manual';
  sampled: number;
  /** GraphQL points GitHub charged. */
  cost: number;
  drift: number;
  stale: number;
  failed: number;
}
export interface SyncHealthState {
  version: 1;
  enabled: boolean;
  drifts: DriftRecord[];
  stale: StaleRecord[];
  runs: SampleRun[];
  suspects: Suspect[];
  sampledAt: Record<string, number>;
}
export const emptySyncHealth = (): SyncHealthState => ({
  version: 1,
  enabled: true,
  drifts: [],
  stale: [],
  runs: [],
  suspects: [],
  sampledAt: {},
});
const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const FIELDS = new Set(Object.keys(DRIFT_FIELD_LABEL));
const SOURCES = new Set(['queue', 'signals', 'status', 'discussion', 'attention']);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const prUrl = (value: unknown): value is string =>
  typeof value === 'string' && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/[1-9]\d*$/.test(value);
const shortText = (value: unknown): value is string => typeof value === 'string' && value.length <= 200;
/** Saved state is local input: keep only valid rows, within the limits. */
export function normalizeSyncHealth(value: unknown): SyncHealthState {
  const empty = emptySyncHealth();
  if (!isRecord(value) || value.version !== 1) return empty;
  const list = (key: string) => (Array.isArray(value[key]) ? (value[key] as unknown[]).filter(isRecord) : []);
  const drifts = list('drifts').filter(
    (row): row is Record<string, unknown> & DriftRecord =>
      prUrl(row.url) &&
      FIELDS.has(String(row.field)) &&
      SOURCES.has(String(row.source)) &&
      shortText(row.gnosis) &&
      shortText(row.github) &&
      [row.ageMs, row.firstSeenAt, row.lastSeenAt, row.count].every(finite)
  );
  const stale = list('stale').filter(
    (row): row is Record<string, unknown> & StaleRecord =>
      prUrl(row.url) &&
      finite(row.at) &&
      finite(row.ageMs) &&
      Array.isArray(row.fields) &&
      row.fields.every((field) => FIELDS.has(String(field))) &&
      (row.reason === 'github-changed' || row.reason === 'unconfirmed')
  );
  const runs = list('runs').filter(
    (row): row is Record<string, unknown> & SampleRun =>
      (row.trigger === 'background' || row.trigger === 'manual') &&
      [row.at, row.sampled, row.cost, row.drift, row.stale, row.failed].every(finite)
  );
  const suspects = list('suspects').filter(
    (row): row is Record<string, unknown> & Suspect =>
      prUrl(row.url) && FIELDS.has(String(row.field)) && shortText(row.github) && finite(row.readAt)
  );
  const sampled = isRecord(value.sampledAt)
    ? Object.entries(value.sampledAt).filter((entry): entry is [string, number] => prUrl(entry[0]) && finite(entry[1]))
    : [];
  return {
    version: 1,
    enabled: value.enabled !== false,
    drifts: drifts
      .map(({ url, field, source, gnosis, github, ageMs, firstSeenAt, lastSeenAt, count }) => ({
        url,
        field,
        source,
        gnosis,
        github,
        ageMs,
        firstSeenAt,
        lastSeenAt,
        count,
      }))
      .slice(0, SYNC_HEALTH_LIMITS.drifts),
    stale: stale
      .map(({ url, at, fields, ageMs, reason }) => ({ url, at, fields, ageMs, reason }))
      .slice(0, SYNC_HEALTH_LIMITS.stale),
    runs: runs
      .map(({ at, trigger, sampled, cost, drift, stale, failed }) => ({
        at,
        trigger,
        sampled,
        cost,
        drift,
        stale,
        failed,
      }))
      .slice(0, SYNC_HEALTH_LIMITS.runs),
    suspects: suspects
      .map(({ url, field, github, readAt }) => ({ url, field, github, readAt }))
      .slice(0, SYNC_HEALTH_LIMITS.suspects),
    sampledAt: Object.fromEntries(sampled.sort((a, b) => b[1] - a[1]).slice(0, SYNC_HEALTH_LIMITS.sampled)),
  };
}

/** One PR's result in a sample. `findings` is undefined when GitHub could not be read. */
export interface SampleResult {
  url: string;
  readAt: number;
  findings?: Finding[];
  suspects?: Suspect[];
}
/**
 * Adds one sample run. Newest first everywhere, each list cut to its limit. A repeated mismatch updates its row
 * instead of adding one.
 */
export function recordSample(
  state: SyncHealthState,
  run: Omit<SampleRun, 'sampled' | 'drift' | 'stale' | 'failed'>,
  results: readonly SampleResult[]
): SyncHealthState {
  const drifts = [...state.drifts];
  const stale: StaleRecord[] = [];
  const sampledAt = { ...state.sampledAt };
  const read = new Set(results.filter((result) => result.findings).map((result) => result.url));
  // A PR read again replaces its suspects: confirmed, still waiting, or gone.
  let suspects = state.suspects.filter((suspect) => !read.has(suspect.url));
  let driftCount = 0,
    staleCount = 0;
  for (const result of results) {
    sampledAt[result.url] = result.readAt;
    if (!result.findings) continue;
    suspects = [...(result.suspects ?? []), ...suspects];
    for (const finding of result.findings.filter((item) => item.kind === 'drift')) {
      driftCount++;
      const index = drifts.findIndex(
        (row) =>
          row.url === finding.url &&
          row.field === finding.field &&
          row.gnosis === finding.gnosis &&
          row.github === finding.github
      );
      const previous = index >= 0 ? drifts.splice(index, 1)[0] : undefined;
      drifts.unshift({
        url: finding.url,
        field: finding.field,
        source: finding.source,
        gnosis: finding.gnosis,
        github: finding.github,
        ageMs: finding.ageMs,
        firstSeenAt: previous?.firstSeenAt ?? result.readAt,
        lastSeenAt: result.readAt,
        count: (previous?.count ?? 0) + 1,
      });
    }
    for (const reason of ['github-changed', 'unconfirmed'] as const) {
      const late = result.findings.filter(
        (item) => item.kind === (reason === 'github-changed' ? 'stale' : 'unconfirmed')
      );
      if (!late.length) continue;
      staleCount++;
      stale.push({
        url: result.url,
        at: result.readAt,
        fields: late.map((item) => item.field),
        ageMs: Math.max(...late.map((item) => item.ageMs)),
        reason,
      });
    }
  }
  const failed = results.filter((result) => !result.findings).length;
  return {
    ...state,
    drifts: drifts.slice(0, SYNC_HEALTH_LIMITS.drifts),
    stale: [...stale, ...state.stale].slice(0, SYNC_HEALTH_LIMITS.stale),
    runs: [{ ...run, sampled: results.length, drift: driftCount, stale: staleCount, failed }, ...state.runs].slice(
      0,
      SYNC_HEALTH_LIMITS.runs
    ),
    suspects: suspects.slice(0, SYNC_HEALTH_LIMITS.suspects),
    sampledAt: Object.fromEntries(
      Object.entries(sampledAt)
        .sort((a, b) => b[1] - a[1])
        .slice(0, SYNC_HEALTH_LIMITS.sampled)
    ),
  };
}

/** What Settings › Diagnostics shows. */
export interface SyncHealthSnapshot {
  enabled: boolean;
  /** Background sampling runs now: enabled, signed in and sync active. */
  active: boolean;
  checking: boolean;
  nextAt?: number;
  drifts: DriftRecord[];
  stale: StaleRecord[];
  runs: SampleRun[];
  unconfirmed: number;
}

/** `owner/repo#123`. */
export const prLabel = (url: string) => {
  const match = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(url);
  return match ? `${match[1]}#${match[2]}` : url;
};
export const formatAge = (ms: number) => {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`;
};
/** One log line per mismatch. */
export const driftLogLine = (finding: Finding) =>
  `[sync-health] ${finding.kind === 'drift' ? 'Drift' : finding.kind === 'stale' ? 'Stale' : 'Unconfirmed'} ${prLabel(finding.url)} ` +
  `${DRIFT_FIELD_LABEL[finding.field]}: Gnosis ${finding.gnosis}, GitHub ${finding.github} (Gnosis read ${formatAge(finding.ageMs)} earlier)`;
