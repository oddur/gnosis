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
}
export interface CheckTarget {
  url: string;
  headSha: string;
}
export interface PrChecks extends CheckTarget {
  checkedAt: number;
  checks: PrCheck[];
  warning?: string;
}
export interface CheckSelection extends CheckTarget {
  id: string;
}
export interface CheckDetails extends CheckSelection {
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
    steps: { name: string; number: number; status: string; conclusion: string | null }[];
  };
  warning?: string;
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
export function orderedChecks(checks: PrCheck[], filter: CheckFilter) {
  const rank = { attention: 0, running: 1, passed: 2, skipped: 3 };
  return checks
    .filter((c) => filter === 'all' || checkGroup(c) === filter)
    .sort((a, b) => rank[checkGroup(a)] - rank[checkGroup(b)] || a.name.localeCompare(b.name));
}
export const checkKey = (target: CheckTarget) => `${target.url}@${target.headSha}`;

export interface ChecksOptions {
  cachedOnly?: boolean;
  force?: boolean;
  background?: boolean;
}
