import { withWorkflowSteps } from '../../lib/workflow-graph';
import type { WorkflowGraph, WorkflowGraphInput, WorkflowJob, WorkflowRuns } from '../../lib/workflow-graph';
import type { CheckTarget, PrChecks } from '../../lib/pr-checks';
export function workflowMocks(snapshots: Map<string, PrChecks>) {
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
