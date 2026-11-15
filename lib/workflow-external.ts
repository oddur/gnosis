import { actionsRunId, checkCounts, checkGroup, orderedChecks, type PrCheck, type PrChecks } from './pr-checks';
import type { WorkflowRunInfo } from './workflow-graph';

/** GraphQL reports the check suite's app name; Actions jobs also carry an Actions run URL. */
export const ACTIONS_PROVIDER = 'GitHub Actions';
const RANK = { attention: 0, running: 1, passed: 2, skipped: 3 } as const;
type Outcome = keyof typeof RANK;

export { actionsRunId };

/** Commit statuses and check runs from other apps (Depot, CircleCI, Buildkite…) have no Actions workflow run. */
export function isActionsCheck(check: Pick<PrCheck, 'kind' | 'url' | 'provider'>) {
  return check.kind === 'check' && (check.provider === ACTIONS_PROVIDER || actionsRunId(check) !== undefined);
}

export interface ExternalCheckGroup {
  id: string;
  name: string;
  provider: string;
  /** `unlisted` holds Actions jobs whose run is not in the workflow list, so the graph cannot draw them. */
  source: 'external' | 'unlisted';
  checks: PrCheck[];
  counts: ReturnType<typeof checkCounts>;
  outcome: Outcome;
  label: string;
}

export function runOutcome(run: Pick<WorkflowRunInfo, 'status' | 'conclusion' | 'name' | 'url'>): Outcome {
  return checkGroup({
    ...run,
    status: run.status === 'completed' ? 'completed' : run.status === 'in_progress' ? 'in_progress' : 'queued',
  });
}

/** Status text for a set of checks: the most urgent outcome, with its count. */
export function checkGroupLabel(checks: PrCheck[]) {
  const counts = checkCounts(checks);
  if (counts.attention) {
    const failed = checks.filter((c) => checkGroup(c) === 'attention').every((c) => c.conclusion === 'failure');
    return failed
      ? `${counts.attention} failed`
      : `${counts.attention} ${counts.attention === 1 ? 'needs' : 'need'} attention`;
  }
  if (counts.running) return `${counts.running} running`;
  if (counts.passed) return `${counts.passed} passed`;
  const skipped = checks.filter((c) => c.conclusion === 'skipped').length;
  return skipped === checks.length ? `${skipped} skipped` : `${counts.skipped} skipped / neutral`;
}

function outcomeOf(counts: ReturnType<typeof checkCounts>): Outcome {
  return counts.attention ? 'attention' : counts.running ? 'running' : counts.passed ? 'passed' : 'skipped';
}

/**
 * Checks the workflow graph cannot draw, grouped per provider. With `runs`, Actions jobs from runs
 * missing in that list are grouped too, so every check in the snapshot appears somewhere in Graph.
 */
export function externalCheckGroups(snapshot?: PrChecks, runs?: WorkflowRunInfo[]): ExternalCheckGroup[] {
  if (!snapshot) return [];
  const listed = runs && new Set(runs.map((run) => run.id));
  const groups = new Map<
    string,
    { name: string; provider: string; source: ExternalCheckGroup['source']; checks: PrCheck[] }
  >();
  for (const check of snapshot.checks) {
    let key: string, name: string, source: ExternalCheckGroup['source'];
    if (!isActionsCheck(check)) {
      name = check.provider || (check.kind === 'status' ? 'Commit statuses' : 'Other checks');
      key = `external:${name}`;
      source = 'external';
    } else {
      const runId = actionsRunId(check);
      if (!listed || (runId !== undefined && listed.has(runId))) continue;
      key = 'unlisted:actions';
      name = 'Other GitHub Actions jobs';
      source = 'unlisted';
    }
    const group = groups.get(key) ?? { name, provider: check.provider, source, checks: [] };
    group.checks.push(check);
    groups.set(key, group);
  }
  return [...groups.entries()]
    .map(([id, group]) => {
      const checks = orderedChecks(group.checks, 'all');
      const counts = checkCounts(checks);
      return { id, ...group, checks, counts, outcome: outcomeOf(counts), label: checkGroupLabel(checks) };
    })
    .sort((a, b) => RANK[a.outcome] - RANK[b.outcome] || a.name.localeCompare(b.name, undefined, { numeric: true }));
}

/**
 * Where the failing checks the graph cannot draw come from. Other providers are outside GitHub Actions; unlisted
 * Actions jobs are Actions jobs whose run is not in the workflow list, so the copy never mixes the two.
 */
export function attentionSourceSummary(groups: ExternalCheckGroup[], attention: number) {
  const phrase = (count: number, where: string) =>
    `${count === attention ? (count === 1 ? 'It is' : 'All are') : `${count} ${count === 1 ? 'is' : 'are'}`} ${where}`;
  const count = (source: ExternalCheckGroup['source']) =>
    groups.filter((group) => group.source === source).reduce((sum, group) => sum + group.counts.attention, 0);
  const external = count('external'),
    unlisted = count('unlisted');
  return [
    external && phrase(external, 'outside GitHub Actions'),
    unlisted && phrase(unlisted, 'in workflow runs not listed here'),
  ]
    .filter(Boolean)
    .join(' · ');
}

/** The notice for failures the selected workflow cannot show, naming each group and where it comes from. */
export function hiddenFailureNotice(groups: ExternalCheckGroup[]) {
  return `${groups
    .map(
      (group) =>
        `${group.label} in ${group.name}${group.source === 'external' ? ', outside GitHub Actions' : ', from workflow runs not listed here'}`
    )
    .join(' · ')}.`;
}

export type WorkflowSidebarEntry =
  | { kind: 'run'; id: string; name: string; outcome: Outcome; run: WorkflowRunInfo }
  | { kind: 'external'; id: string; name: string; outcome: Outcome; group: ExternalCheckGroup };

/** Failures first, then running, passed, and skipped, like the List view; names break ties. */
export function workflowSidebarEntries(runs: WorkflowRunInfo[], groups: ExternalCheckGroup[]): WorkflowSidebarEntry[] {
  return [
    ...runs.map((run) => ({
      kind: 'run' as const,
      id: `run:${run.id}`,
      name: run.name,
      outcome: runOutcome(run),
      run,
    })),
    ...groups.map((group) => ({
      kind: 'external' as const,
      id: group.id,
      name: group.name,
      outcome: group.outcome,
      group,
    })),
  ].sort(
    (a, b) =>
      RANK[a.outcome] - RANK[b.outcome] ||
      a.name.localeCompare(b.name, undefined, { numeric: true }) ||
      (a.kind === 'run' && b.kind === 'run' ? a.run.id - b.run.id : a.kind === 'run' ? -1 : 1)
  );
}

/** Whether the Actions side has anything to look at first: a failing run, or a failing Actions job. */
export function actionsNeedAttention(snapshot: PrChecks | undefined, runs: WorkflowRunInfo[]) {
  return (
    runs.some((run) => runOutcome(run) === 'attention') ||
    !!snapshot?.checks.some((check) => isActionsCheck(check) && checkGroup(check) === 'attention')
  );
}

/** Link text names where the link goes: GitHub, or the provider that reported the check. */
export function checkLinkLabel(check: Pick<PrCheck, 'url' | 'provider' | 'kind'>) {
  let host = '';
  try {
    host = check.url ? new URL(check.url).hostname : '';
  } catch {
    host = '';
  }
  if (host === 'github.com' || host.endsWith('.github.com')) return 'Open on GitHub';
  return check.provider && check.provider !== ACTIONS_PROVIDER ? `Open in ${check.provider}` : 'Open provider result';
}

/** A short, specific summary of what the graph cannot show, so the disclosure never reads as generic. */
export function workflowWarningSummary(warnings: string[]) {
  const parts: string[] = [];
  let unmatched = 0,
    sources = 0,
    reusable = 0,
    other = 0;
  for (const warning of warnings) {
    const count = warning.match(/^(\d+) jobs? could not be matched/);
    if (count) unmatched += Number(count[1]);
    else if (warning.startsWith('Dependencies unavailable:')) sources++;
    else if (warning.startsWith('Showing the first')) parts.push('Job list is truncated');
    else if (/^[^:]+: /.test(warning)) reusable++;
    else other++;
  }
  if (sources) parts.unshift('Workflow source could not be read, so jobs have no dependency arrows');
  if (unmatched) parts.push(`${unmatched} ${unmatched === 1 ? 'job has' : 'jobs have'} no dependency arrows`);
  if (reusable) parts.push(`${reusable} reusable ${reusable === 1 ? 'workflow is' : 'workflows are'} unavailable`);
  if (other) parts.push(`${other} more ${other === 1 ? 'note' : 'notes'}`);
  return parts.join(' · ');
}
