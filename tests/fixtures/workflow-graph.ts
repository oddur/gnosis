import { withWorkflowSteps } from '../../lib/workflow-graph';
import type { WorkflowGraph, WorkflowGraphInput, WorkflowJob, WorkflowRuns } from '../../lib/workflow-graph';
import type { CheckTarget, PrChecks } from '../../lib/pr-checks';
import { supersededWorkflowRuns } from './superseded-runs';
/** Three rounds of the same workflows on one commit; Graph lists the newest run of each. */
function supersededWorkflowMocks(snapshots: Map<string, PrChecks>) {
  return {
    getWorkflowRuns: (input: CheckTarget): Promise<WorkflowRuns> =>
      Promise.resolve({ ...input, runs: supersededWorkflowRuns(input.headSha), checkedAt: Date.now() }),
    getWorkflowGraph: (input: WorkflowGraphInput): Promise<WorkflowGraph> => {
      const runs = supersededWorkflowRuns(input.headSha);
      const run = runs.find((r) => r.id === input.runId) ?? runs[0];
      const jobs = (snapshots.get(input.url)?.checks ?? [])
        .filter((check) => check.workflowRun?.id === run.id)
        .map(
          (check): WorkflowJob => ({
            id: check.databaseId,
            checkId: check.id,
            name: check.name,
            status: check.status,
            conclusion: check.conclusion,
            startedAt: check.startedAt,
            completedAt: check.completedAt,
            url: check.url ?? '',
            steps: [],
          })
        );
      return Promise.resolve({
        target: input,
        run,
        totalJobs: jobs.length,
        checkedAt: Date.now(),
        warnings: [],
        groups: [],
        nodes: jobs.map((job, i) => ({ id: `job-${job.id}`, name: job.name, jobs: [job], x: 0, y: i * 140 })),
        edges: [],
      });
    },
  };
}
/** Four passing Actions workflows; their jobs have no dependencies between them. */
function externalWorkflowMocks(snapshots: Map<string, PrChecks>) {
  const runs = [
    { id: 21, name: 'Required gate: Server check', path: '.github/workflows/server.yml', checks: [11] },
    { id: 22, name: 'Required gate: Client check', path: '.github/workflows/client.yml', checks: [12] },
    { id: 23, name: 'Required gate: Schema lint', path: '.github/workflows/schema.yml', checks: [13] },
    { id: 24, name: 'Security', path: '.github/workflows/security.yml', checks: [14, 15] },
  ];
  const info = (run: (typeof runs)[number], sha: string) => ({
    id: run.id,
    name: run.name,
    path: run.path,
    sha,
    attempt: 1,
    jobCount: run.checks.length,
    status: 'completed',
    conclusion: 'success',
    url: `https://github.com/klang/engine/actions/runs/${run.id}`,
  });
  return {
    getWorkflowRuns: (input: CheckTarget): Promise<WorkflowRuns> =>
      Promise.resolve({
        ...input,
        runs: runs.map((run) => info(run, input.headSha)),
        checkedAt: Date.now(),
      }),
    getWorkflowGraph: (input: WorkflowGraphInput): Promise<WorkflowGraph> => {
      const checks = snapshots.get(input.url)?.checks ?? [];
      const run = runs.find((r) => r.id === input.runId) ?? runs[0];
      const jobs = run.checks.flatMap((id): WorkflowJob[] => {
        const check = checks.find((c) => c.id === `check:${id}`);
        if (!check) return [];
        return [
          {
            id,
            checkId: check.id,
            name: check.name,
            status: check.status,
            conclusion: check.conclusion,
            startedAt: check.startedAt,
            completedAt: check.completedAt,
            url: check.url ?? '',
            steps: [],
          },
        ];
      });
      return Promise.resolve({
        target: input,
        run: info(run, input.headSha),
        totalJobs: jobs.length,
        checkedAt: Date.now(),
        warnings:
          run.id === 24
            ? ['1 job could not be matched to a definition. Their statuses are shown without dependency arrows.']
            : [],
        groups: [],
        nodes: jobs.map((job, i) => ({ id: `job-${job.id}`, name: job.name, jobs: [job], x: 0, y: i * 140 })),
        edges: [],
      });
    },
  };
}
export function workflowMocks(snapshots: Map<string, PrChecks>) {
  if (typeof location !== 'undefined' && new URLSearchParams(location.search).has('superseded-runs'))
    return supersededWorkflowMocks(snapshots);
  if (typeof location !== 'undefined' && new URLSearchParams(location.search).has('external-checks'))
    return externalWorkflowMocks(snapshots);
  const run = {
    id: 9,
    name: 'Build and test',
    path: '.github/workflows/ci.yml',
    sha: '',
    attempt: 1,
    jobCount: 5,
    status: 'in_progress',
    conclusion: null,
    url: 'https://github.com/klang/engine/actions/runs/9',
  };
  return {
    getWorkflowRuns: async (input: CheckTarget): Promise<WorkflowRuns> => ({
      ...input,
      runs: [{ ...run, sha: input.headSha }],
      checkedAt: Date.now(),
    }),
    getWorkflowGraph: async (input: WorkflowGraphInput): Promise<WorkflowGraph> => {
      const snapshot = snapshots.get(input.url)!;
      const job = (id: number): WorkflowJob => {
        const check = snapshot.checks.find((c) => c.id === `check:${id}`)!;
        return {
          id,
          checkId: check.id,
          name: check.name,
          status: check.status,
          conclusion: check.conclusion,
          startedAt: check.startedAt,
          completedAt: check.completedAt,
          url: check.url ?? '',
          steps:
            id === 4
              ? [
                  'Set up job',
                  'Checkout',
                  'Install dependencies',
                  'Lint source',
                  'Check formatting',
                  'Complete job',
                ].map((name, i) => ({
                  name,
                  number: i + 1,
                  status: 'completed',
                  conclusion: 'success',
                  startedAt: '2026-11-04T10:00:00Z',
                  completedAt: '2026-11-04T10:00:12Z',
                }))
              : id === 3
                ? [{ name: 'Build application', number: 1, status: 'in_progress', conclusion: null }]
                : [],
        };
      };
      const expanded = input.expanded?.includes('test');
      return {
        target: input,
        run: { ...run, sha: input.headSha },
        totalJobs: 5,
        checkedAt: Date.now(),
        warnings: [],
        definitionUrl: 'https://github.com/klang/engine/blob/' + input.headSha + '/.github/workflows/ci.yml',
        groups: [{ id: 'test', name: 'Platform tests' }],
        nodes: [
          { id: 'lint', name: 'Lint', jobs: [job(4)], x: 0, y: 90, definition: 'lint' },
          {
            id: 'types',
            name: 'TypeScript',
            height: input.expandedAnnotations?.includes('types') ? 440 : 232,
            annotationsExpanded: input.expandedAnnotations?.includes('types'),
            jobs: [job(2)],
            x: 315,
            y: 0,
            definition: 'types',
          },
          ...(expanded
            ? [
                {
                  id: 'test/mac',
                  name: 'Tests / macOS',
                  height: 232,
                  group: 'Platform tests',
                  groupId: 'test',
                  jobs: [job(1)],
                  x: 315,
                  y: 140,
                },
                {
                  id: 'test/linux',
                  name: 'Build / Linux',
                  group: 'Platform tests',
                  groupId: 'test',
                  jobs: [job(3)],
                  x: 315,
                  y: 280,
                },
              ]
            : [{ id: 'test', name: 'Platform tests', expandable: true, jobs: [job(1), job(3)], x: 315, y: 140 }]),
          { id: 'deploy', name: 'Deploy preview', jobs: [job(5)], x: 630, y: 90, definition: 'deploy' },
        ].map((node) => withWorkflowSteps(node, input.expandedSteps)),
        edges: (expanded
          ? [
              ['lint', 'types'],
              ['lint', 'test/mac'],
              ['lint', 'test/linux'],
              ['types', 'deploy'],
              ['test/mac', 'deploy'],
              ['test/linux', 'deploy'],
            ]
          : [
              ['lint', 'types'],
              ['lint', 'test'],
              ['types', 'deploy'],
              ['test', 'deploy'],
            ]
        ).map(([source, target]) => ({ id: source + '-' + target, source, target })),
      };
    },
  };
}
