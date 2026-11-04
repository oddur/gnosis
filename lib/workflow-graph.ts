import type { CheckTarget, CheckStep, PrCheck } from './pr-checks';

export interface WorkflowRunInfo {
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
export interface WorkflowGraphNode {
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
  target: CheckTarget;
  run: WorkflowRunInfo;
  nodes: WorkflowGraphNode[];
  edges: { id: string; source: string; target: string }[];
  groups: { id: string; name: string }[];
  checkedAt: number;
  warnings: string[];
  definitionUrl?: string;
}
export interface WorkflowGraphInput extends CheckTarget {
  runId: number;
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
