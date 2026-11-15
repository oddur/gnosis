import type { CiCheck } from './types';
export interface PrCheck extends CiCheck {
  id: string;
  databaseId: number;
  nodeId?: string;
  kind: 'check' | 'status';
  provider: string;
  required: boolean | null;
  startedAt: string | null;
  completedAt: string | null;
  description?: string;
  /**
   * Actions jobs only: the workflow run the job belongs to. A commit can hold several runs of one workflow,
   * for example when concurrency cancels older runs; only the newest run of each workflow and event counts.
   */
  workflowRun?: { id: number; workflowId: number; event: string };
}
export interface CheckTarget {
  url: string;
  headSha: string;
}
export interface PrChecks extends CheckTarget {
  checkedAt: number;
  checks: PrCheck[];
  details?: Partial<Record<string, CheckDetails>>;
  warning?: string;
}
export interface CheckSelection extends CheckTarget {
  id: string;
}
export interface CheckDetails extends CheckSelection {
  checkedAt?: number;
  state?: Pick<PrCheck, 'status' | 'conclusion' | 'startedAt' | 'completedAt'>;
  title: string;
  summary: string;
  text: string;
  annotations: { path: string; startLine: number; endLine: number; level: string; title: string; message: string }[];
  job?: {
    id: number;
    runId: number;
    attempt: number;
    status: string;
    canRerun: boolean;
    steps: CheckStep[];
  };
  warning?: string;
}
export interface CheckStep {
  name: string;
  number: number;
  status: string;
  conclusion: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
}

/** Pending and timestamp-less steps must not invent a duration. */
export function checkDuration(
  value: { status: string; startedAt?: string | null; completedAt?: string | null },
  now = Date.now()
) {
  if (!value.startedAt || !['in_progress', 'completed'].includes(value.status)) return '';
  const start = Date.parse(value.startedAt);
  const end = value.status === 'completed' ? Date.parse(value.completedAt ?? '') : now;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return '';
  const seconds = Math.floor((end - start) / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m ${seconds % 60}s`;
}
export interface CheckLog {
  text: string;
  truncated: boolean;
}
export type CheckFilter = 'all' | 'attention' | 'running';
export function checkGroup(check: CiCheck): 'attention' | 'running' | 'passed' | 'skipped' {
  if (check.status !== 'completed') return 'running';
  if (check.conclusion === 'success') return 'passed';
  if (['skipped', 'neutral'].includes(check.conclusion ?? '')) return 'skipped';
  return 'attention';
}
export function checkLabel(check: CiCheck) {
  if (check.status !== 'completed') return check.status === 'in_progress' ? 'Running' : 'Queued';
  return (
    (
      {
        success: 'Passed',
        failure: 'Failed',
        timed_out: 'Timed out',
        cancelled: 'Cancelled',
        action_required: 'Action required',
        stale: 'Stale',
        startup_failure: 'Could not start',
        skipped: 'Skipped',
        neutral: 'Neutral',
        error: 'Error',
      } as Record<string, string>
    )[check.conclusion ?? ''] ?? 'Needs attention'
  );
}
export function checkCounts(checks: CiCheck[]) {
  const counts = { attention: 0, running: 0, passed: 0, skipped: 0 };
  for (const check of checks) counts[checkGroup(check)]++;
  return counts;
}
/** Compact outcomes without making skipped or neutral checks look like failures. */
export function checkSummary(checks: CiCheck[]) {
  if (!checks.length) return 'No checks reported';
  const counts = checkCounts(checks);
  if (counts.attention)
    return `${counts.attention} ${counts.attention === 1 ? 'check needs' : 'checks need'} attention`;
  const skipped = checks.filter((c) => c.status === 'completed' && c.conclusion === 'skipped').length;
  const neutral = counts.skipped - skipped;
  return [
    counts.running && `${counts.running} running`,
    counts.passed && `${counts.passed} passed`,
    skipped && `${skipped} skipped`,
    neutral && `${neutral} neutral`,
  ]
    .filter(Boolean)
    .join(' · ');
}

export function orderedChecks(checks: PrCheck[], filter: CheckFilter) {
  const rank = { attention: 0, running: 1, passed: 2, skipped: 3 };
  return checks
    .filter((c) => filter === 'all' || checkGroup(c) === filter)
    .sort((a, b) => rank[checkGroup(a)] - rank[checkGroup(b)] || a.name.localeCompare(b.name));
}
export const checkKey = (target: CheckTarget) => `${target.url}@${target.headSha}`;
/** v2: snapshots hold only current check runs, without jobs from superseded workflow runs. */
export const prChecksCacheKey = (target: CheckTarget) => `pr-checks:v2:${checkKey(target)}`;

const ACTIONS_JOB_URL = /^https:\/\/github\.com\/[^/]+\/[^/]+\/actions\/runs\/(\d+)\/job\/\d+/;
/** The workflow run of an Actions job, from its job URL. */
export function actionsRunId(check: Pick<PrCheck, 'kind' | 'url'>): number | undefined {
  if (check.kind !== 'check') return;
  const match = check.url?.match(ACTIONS_JOB_URL);
  return match ? Number(match[1]) : undefined;
}

/**
 * The check runs GitHub counts for a commit, and the superseded ones it hides. A commit's check rollup also
 * lists jobs of older runs of the same workflow, such as runs cancelled by a concurrency group when newer
 * events arrived. GitHub's merge box, `gh pr checks` and branch protection use only the newest run of each
 * workflow and event, and the newest attempt of each job in it. Runs of different workflows never replace
 * each other, even when their jobs share a name. Commit statuses and other apps' check runs stay as reported.
 */
export function currentChecks(checks: PrCheck[]): { checks: PrCheck[]; superseded: PrCheck[] } {
  const latestRun = new Map<string, number>();
  const workflowKey = (run: NonNullable<PrCheck['workflowRun']>) => `${run.workflowId}:${run.event}`;
  for (const check of checks) {
    if (check.kind !== 'check' || !check.workflowRun) continue;
    const key = workflowKey(check.workflowRun);
    latestRun.set(key, Math.max(latestRun.get(key) ?? 0, check.workflowRun.id));
  }
  const newest = new Map<string, PrCheck>();
  const superseded: PrCheck[] = [];
  for (const check of checks) {
    if (check.kind !== 'check') continue;
    if (check.workflowRun && check.workflowRun.id !== latestRun.get(workflowKey(check.workflowRun))) {
      superseded.push(check);
      continue;
    }
    // A re-run adds a new check run with the same name to the same workflow run; the newest attempt wins.
    const run = check.workflowRun?.id ?? actionsRunId(check);
    if (run === undefined) continue;
    const key = `${run}:${check.name}`;
    const previous = newest.get(key);
    if (!previous) newest.set(key, check);
    else if (check.databaseId > previous.databaseId) {
      superseded.push(previous);
      newest.set(key, check);
    } else superseded.push(check);
  }
  if (!superseded.length) return { checks, superseded };
  const hidden = new Set(superseded);
  return { checks: checks.filter((check) => !hidden.has(check)), superseded };
}

export interface ChecksOptions {
  cachedOnly?: boolean;
  force?: boolean;
  background?: boolean;
  /** The user opened these checks and nothing is shown yet, so the read is interactive and not paced. */
  opened?: boolean;
}

/** Includes attempt timestamps: a rerun can reuse a check ID on the same commit. */
export const checkVersion = (check: Pick<PrCheck, 'status' | 'conclusion' | 'startedAt' | 'completedAt'>) =>
  JSON.stringify([check.status, check.conclusion, check.startedAt, check.completedAt]);
export const checkDetailsKey = (selection: CheckSelection, check: PrCheck) =>
  `${checkKey(selection)}:${selection.id}:${checkVersion(check)}`;
