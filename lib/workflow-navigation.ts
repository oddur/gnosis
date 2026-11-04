import { checkCounts, checkGroup, checkLabel, type PrChecks } from './pr-checks';
import type { WorkflowGraphNode, WorkflowJob, WorkflowRunInfo } from './workflow-graph';

export function workflowRunLabel(run: WorkflowRunInfo) {
  return `${run.name} · ${checkLabel({ name: run.name, url: run.url, status: run.status === 'completed' ? 'completed' : run.status === 'in_progress' ? 'in_progress' : 'queued', conclusion: run.conclusion })} · Attempt ${run.attempt}`;
}
export function workflowJobCount(run: WorkflowRunInfo, snapshot?: PrChecks, knownCount = run.jobCount) {
  const matching =
    snapshot?.headSha === run.sha
      ? snapshot.checks.filter((check) => {
          if (check.kind !== 'check') return false;
          const job = snapshot.details?.[check.id]?.job;
          if (job) return job.runId === run.id && job.attempt === run.attempt;
          // Without attempt evidence, a reused run URL must not count jobs from an earlier rerun.
          return run.attempt === 1 && !!check.url?.startsWith(`${run.url}/job/`);
        })
      : [];
  const reported = new Set(matching.map((check) => check.id)).size;
  if (knownCount !== undefined && knownCount >= reported) return { count: knownCount, exact: true };
  return reported ? { count: reported, exact: false } : undefined;
}
export function preferredWorkflow(runs: WorkflowRunInfo[]): WorkflowRunInfo | undefined {
  const rank = (run: WorkflowRunInfo) =>
    run.status !== 'completed'
      ? 1
      : ['error', 'failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure', 'stale'].includes(
            run.conclusion ?? ''
          )
        ? 0
        : 2;
  return [...runs].sort((a, b) => rank(a) - rank(b))[0];
}
export function prChecksHint(snapshot?: PrChecks) {
  if (!snapshot) return 'Checks not loaded';
  const counts = checkCounts(snapshot.checks);
  return counts.attention
    ? `${counts.attention} need attention`
    : counts.running
      ? `${counts.running} running`
      : snapshot.checks.length
        ? 'No issues reported'
        : 'No checks';
}
export function attentionJobs(nodes: WorkflowGraphNode[]) {
  const seen = new Set<number>();
  return nodes.flatMap((node) =>
    node.jobs
      .filter((job) => {
        if (
          seen.has(job.id) ||
          checkGroup({
            name: job.name,
            url: job.url,
            status: job.status === 'completed' ? 'completed' : job.status === 'in_progress' ? 'in_progress' : 'queued',
            conclusion: job.conclusion,
          }) !== 'attention'
        )
          return false;
        seen.add(job.id);
        return true;
      })
      .map((job) => ({ node, job }))
  );
}
export function nextAttentionJob(
  items: { node: WorkflowGraphNode; job: WorkflowJob }[],
  selectedId?: string,
  direction: 1 | -1 = 1
) {
  const current = items.findIndex((item) => item.job.checkId === selectedId);
  return items.at(current < 0 ? (direction === 1 ? 0 : -1) : (current + direction + items.length) % items.length);
}
export interface WorkflowViewState {
  expandedAnnotations?: string[];
  workflowsOpen?: boolean;
  memberUrl?: string;
  runId?: number;
  expanded: string[];
  showSkipped: boolean;
  showCompleted: boolean;
  focusNodeId?: string;
  viewport?: { x: number; y: number; zoom: number };
  viewportKey?: string;
}
const sessions = new Map<string, WorkflowViewState>();
/** Only exploration state, account/revision scoped by the caller; no GitHub payloads. */
export function workflowSession(key: string): WorkflowViewState {
  let state = sessions.get(key);
  if (!state) {
    state = { expanded: [], showSkipped: true, showCompleted: true };
    sessions.set(key, state);
    while (sessions.size > 24) sessions.delete(sessions.keys().next().value as string);
  }
  return state;
}
