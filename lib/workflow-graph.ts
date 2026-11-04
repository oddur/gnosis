import type { CheckTarget, CheckStep, PrCheck, CheckDetails } from './pr-checks';

export interface WorkflowRunInfo {
  jobCount?: number;
  event?: string;
  id: number;
  name: string;
  path: string;
  sha: string;
  attempt: number;
  status: string;
  conclusion: string | null;
  url: string;
}
export interface WorkflowRuns extends CheckTarget {
  runs: WorkflowRunInfo[];
  checkedAt: number;
  warning?: string;
}
export interface WorkflowJob {
  id: number;
  checkId?: string;
  name: string;
  status: string;
  conclusion: string | null;
  startedAt: string | null;
  completedAt: string | null;
  url: string;
  steps: CheckStep[];
}
export interface WorkflowDefinitionJob {
  id: string;
  name: string;
  needs: string[];
  names: string[];
  matrix: boolean;
  uses?: string;
  inputs?: Record<string, string | number | boolean>;
  children?: WorkflowDefinitionJob[];
}
export interface WorkflowPort {
  id: string;
  type: 'source' | 'target';
  x: number;
  y: number;
}
export interface WorkflowGraphNode {
  annotationsExpanded?: boolean;
  /** Direct prerequisites omitted by dependency focus; retain their reported state. */
  outsidePrerequisites?: Pick<WorkflowGraphNode, 'id' | 'name' | 'jobs'>[];
  stage?: { count: number; names: string[]; unreported: number };
  height?: number;
  collapsed?: 'skipped' | 'completed';
  ports?: WorkflowPort[];
  id: string;
  name: string;
  group?: string;
  groupId?: string;
  expandable?: boolean;
  jobs: WorkflowJob[];
  definition?: string;
  unmapped?: boolean;
  x: number;
  y: number;
}
export interface WorkflowGraph {
  focus?: { id: string; name: string };
  totalJobs?: number;
  target: CheckTarget;
  run: WorkflowRunInfo;
  nodes: WorkflowGraphNode[];
  edges: { id: string; source: string; target: string; points?: { x: number; y: number }[] }[];
  groups: { id: string; name: string }[];
  checkedAt: number;
  warnings: string[];
  definitionUrl?: string;
}
export type WorkflowGrouping = 'adaptive' | 'compact' | 'off';
export function workflowGrouping(value: unknown): WorkflowGrouping {
  return value === 'compact' || value === 'off' ? value : 'adaptive';
}
export interface WorkflowGraphInput extends CheckTarget {
  expandedAnnotations?: string[];
  grouping?: WorkflowGrouping;
  runId: number;
  focusNodeId?: string;
  showSkipped?: boolean;
  showCompleted?: boolean;
  expanded?: string[];
}
export function workflowJobCheck(job: WorkflowJob, checks: PrCheck[]): PrCheck | undefined {
  if (!job.checkId) return;
  return (
    checks.find((check) => check.id === job.checkId) ?? {
      id: job.checkId,
      databaseId: Number(job.checkId.replace('check:', '')),
      kind: 'check',
      name: job.name,
      provider: 'GitHub Actions',
      required: null,
      status: job.status === 'completed' ? 'completed' : job.status === 'in_progress' ? 'in_progress' : 'queued',
      conclusion: job.conclusion,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      url: job.url,
    }
  );
}

/** Match the exact Actions attempt; never put old failure output on a rerun. */
export function workflowJobDetails(job: WorkflowJob, run: WorkflowRunInfo, detail?: CheckDetails) {
  if (!detail || detail.headSha !== run.sha || detail.id !== job.checkId) return;
  if (!detail.job || detail.job.id !== job.id || detail.job.runId !== run.id || detail.job.attempt !== run.attempt)
    return;
  return detail;
}
export function workflowFailureInsight(job: WorkflowJob, detail?: CheckDetails) {
  if (job.status !== 'completed' || ['success', 'neutral', 'skipped'].includes(job.conclusion ?? '')) return;
  const seen = new Set<string>();
  const failures = (detail?.annotations ?? []).filter((annotation) => {
    if (annotation.level !== 'failure') return false;
    const key = JSON.stringify([
      annotation.path,
      annotation.startLine,
      annotation.endLine,
      annotation.title,
      annotation.message,
    ]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const step = (detail?.job?.steps ?? job.steps).find(
    (step) => step.status === 'completed' && step.conclusion === 'failure'
  );
  return { annotation: failures.at(0), annotations: failures, count: failures.length, step: step?.name };
}
