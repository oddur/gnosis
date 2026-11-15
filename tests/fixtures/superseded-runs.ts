import type { PrCheck } from '../../lib/pr-checks';
import type { WorkflowRunInfo } from '../../lib/workflow-graph';

/**
 * One commit with three rounds of `pull_request` workflow runs. A concurrency group cancelled the first two
 * rounds when newer events arrived, so their jobs are cancelled and two "Result" gates failed. The third round
 * is green. GitHub's merge box shows only the newest run of each workflow, so the PR is all green.
 * Synthetic data only.
 */
export const supersededRepo = 'https://github.com/acme/widgets';
type Outcome = 'success' | 'failure' | 'cancelled' | 'skipped';
interface Workflow {
  id: number;
  name: string;
  path: string;
  /** Rounds with a run of this workflow (1, 2 or 3), and each round's job outcomes. */
  rounds: Partial<Record<1 | 2 | 3, Record<string, Outcome>>>;
}
export const supersededWorkflows: Workflow[] = [
  {
    id: 101,
    name: 'Build Pipeline',
    path: '.github/workflows/build.yml',
    rounds: {
      1: {
        'Detect changes': 'success',
        'Build client': 'cancelled',
        'Build server': 'cancelled',
        'Build Pipeline Result': 'cancelled',
      },
      2: {
        'Detect changes': 'cancelled',
        'Build client': 'cancelled',
        'Build server': 'skipped',
        'Build Pipeline Result': 'cancelled',
      },
      3: {
        'Detect changes': 'success',
        'Build client': 'success',
        'Build server': 'skipped',
        'Build Pipeline Result': 'success',
      },
    },
  },
  {
    id: 102,
    name: 'Test Pipeline',
    path: '.github/workflows/test.yml',
    rounds: {
      // "Detect changes" also runs in Build Pipeline: same name, different workflow, so both count.
      1: {
        'Detect changes': 'cancelled',
        'Unit tests': 'cancelled',
        'Integration tests': 'skipped',
        'Test Pipeline Result': 'failure',
      },
      2: {
        'Detect changes': 'cancelled',
        'Unit tests': 'cancelled',
        'Integration tests': 'skipped',
        'Test Pipeline Result': 'cancelled',
      },
      3: {
        'Detect changes': 'success',
        'Unit tests': 'success',
        'Integration tests': 'skipped',
        'Test Pipeline Result': 'success',
      },
    },
  },
  {
    id: 103,
    name: 'Update Dependencies',
    path: '.github/workflows/deps.yml',
    rounds: {
      1: { 'Check pins': 'cancelled', 'Update Dependencies Result': 'failure' },
      2: { 'Check pins': 'cancelled', 'Update Dependencies Result': 'cancelled' },
      3: { 'Check pins': 'success', 'Update Dependencies Result': 'success' },
    },
  },
  {
    // Two rounds only: the second run is still the newest of its workflow.
    id: 104,
    name: 'API Change Summary',
    path: '.github/workflows/api.yml',
    rounds: { 1: { 'Detect API changes': 'cancelled' }, 2: { 'Detect API changes': 'success' } },
  },
  {
    // One round only: an early run with nothing newer stays current.
    id: 105,
    name: 'Release Notes',
    path: '.github/workflows/notes.yml',
    rounds: { 1: { 'Draft notes': 'success' } },
  },
];
export const supersededRunId = (workflow: number, round: number) => round * 1000 + workflow;
/** The re-run attempt in round three: "Unit tests" first failed, then passed on attempt 2. */
export const rerunJob = { workflow: 102, name: 'Unit tests' };

export interface SupersededJob {
  databaseId: number;
  workflow: Workflow;
  round: number;
  runId: number;
  name: string;
  conclusion: Outcome;
  attempt: number;
}
/** Every check run GitHub's rollup lists for the commit, oldest first, as databaseIds grow. */
export function supersededJobs(): SupersededJob[] {
  const jobs: SupersededJob[] = [];
  let id = 900_000;
  for (const round of [1, 2, 3] as const)
    for (const workflow of supersededWorkflows)
      for (const [name, conclusion] of Object.entries(workflow.rounds[round] ?? {})) {
        const runId = supersededRunId(workflow.id, round);
        if (round === 3 && workflow.id === rerunJob.workflow && name === rerunJob.name)
          jobs.push({ databaseId: ++id, workflow, round, runId, name, conclusion: 'failure', attempt: 1 });
        jobs.push({
          databaseId: ++id,
          workflow,
          round,
          runId,
          name,
          conclusion,
          attempt: round === 3 && workflow.id === rerunJob.workflow ? 2 : 1,
        });
      }
  return jobs;
}
const jobUrl = (job: SupersededJob) => `${supersededRepo}/actions/runs/${job.runId}/job/${job.databaseId}`;
const startedAt = (job: SupersededJob) => `2026-11-15T10:${String(40 + job.round * 2).padStart(2, '0')}:00Z`;
const completedAt = (job: SupersededJob) => `2026-11-15T10:${String(41 + job.round * 2).padStart(2, '0')}:00Z`;
const required = (name: string) => name.endsWith(' Result');

/** The check runs as the Checks snapshot normalizes them, before superseded runs are dropped. */
export function supersededChecks(): PrCheck[] {
  return supersededJobs().map((job) => ({
    id: `check:${job.databaseId}`,
    databaseId: job.databaseId,
    kind: 'check',
    name: job.name,
    provider: 'GitHub Actions',
    required: required(job.name),
    status: 'completed',
    conclusion: job.conclusion,
    url: jobUrl(job),
    startedAt: startedAt(job),
    completedAt: completedAt(job),
    workflowRun: { id: job.runId, workflowId: job.workflow.id, event: 'pull_request' },
  }));
}

/** The same check runs as GitHub's GraphQL `statusCheckRollup.contexts` nodes. */
export function supersededRollupNodes() {
  return supersededJobs().map((job) => ({
    __typename: 'CheckRun',
    id: `CR_${job.databaseId}`,
    databaseId: job.databaseId,
    name: job.name,
    status: 'COMPLETED',
    conclusion: job.conclusion.toUpperCase(),
    isRequired: required(job.name),
    url: jobUrl(job),
    detailsUrl: jobUrl(job),
    startedAt: startedAt(job),
    completedAt: completedAt(job),
    checkSuite: {
      app: { name: 'GitHub Actions' },
      workflowRun: {
        databaseId: job.runId,
        event: 'pull_request',
        workflow: { databaseId: job.workflow.id },
      },
    },
  }));
}

/** GraphQL `checkSuites` nodes: one suite per workflow run. */
export function supersededSuiteNodes() {
  return supersededWorkflows.flatMap((workflow) =>
    ([1, 2, 3] as const)
      .filter((round) => workflow.rounds[round])
      .map((round) => ({
        workflowRun: {
          databaseId: supersededRunId(workflow.id, round),
          event: 'pull_request',
          workflow: { databaseId: workflow.id },
        },
      }))
  );
}

/** The workflow list Graph shows: the newest run of each workflow, with how many earlier runs it replaced. */
export function supersededWorkflowRuns(headSha: string): WorkflowRunInfo[] {
  return supersededWorkflows.map((workflow) => {
    const rounds = ([1, 2, 3] as const).filter((round) => workflow.rounds[round]);
    const round = rounds.at(-1) ?? 1;
    const id = supersededRunId(workflow.id, round);
    const jobs = Object.keys(workflow.rounds[round] ?? {}).length;
    return {
      id,
      name: workflow.name,
      path: workflow.path,
      sha: headSha,
      attempt: workflow.id === rerunJob.workflow && round === 3 ? 2 : 1,
      jobCount: jobs,
      status: 'completed',
      conclusion: 'success',
      url: `${supersededRepo}/actions/runs/${id}`,
      event: 'pull_request',
      ...(rounds.length > 1 ? { supersededRuns: rounds.length - 1 } : {}),
    };
  });
}

/** Expected current outcome: the newest run of each workflow, newest attempt of each job. */
export function expectedCurrent() {
  const current = supersededJobs().filter((job) => {
    const rounds = ([1, 2, 3] as const).filter((round) => job.workflow.rounds[round]);
    return (
      job.round === rounds.at(-1) &&
      !(job.round === 3 && job.workflow.id === rerunJob.workflow && job.name === rerunJob.name && job.attempt === 1)
    );
  });
  return {
    total: current.length,
    passed: current.filter((job) => job.conclusion === 'success').length,
    skipped: current.filter((job) => job.conclusion === 'skipped').length,
  };
}
