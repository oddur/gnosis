import type { CheckDetails, CheckSelection, CheckTarget, PrChecks, PrCheck } from '../../lib/pr-checks';
export function checksMocks() {
  let newer = false;
  const check = (id: number, name: string, conclusion: string | null, extra: Partial<PrCheck> = {}): PrCheck => ({
    id: `check:${id}`,
    databaseId: id,
    name,
    conclusion,
    status: conclusion ? 'completed' : 'in_progress',
    kind: 'check',
    provider: 'GitHub Actions',
    required: true,
    startedAt: '2026-10-27T10:00:00Z',
    completedAt: conclusion ? '2026-10-27T10:02:03Z' : null,
    url: 'https://github.com/klang/engine/actions/runs/9/job/' + String(id),
    ...extra,
  });
  const snapshots = new Map<string, PrChecks>();
  const getPrChecks = (input: CheckTarget) => {
    let value = snapshots.get(input.url);
    if (!value || newer) {
      value = {
        ...input,
        headSha: newer ? 'new-head' : input.headSha,
        checkedAt: Date.now(),
        checks: [
          check(1, 'Tests / macOS', 'failure'),
          check(2, 'TypeScript', 'failure'),
          check(3, 'Build / Linux', null),
          check(4, 'Lint', 'success'),
          check(5, 'Deploy preview', 'neutral', { required: false }),
          check(6, 'Buildkite / integration', 'error', {
            id: 'status:6',
            kind: 'status',
            provider: 'Buildkite',
            required: null,
            description: 'Integration test service is unavailable. Retry from Buildkite.',
          }),
        ],
      };
      snapshots.set(input.url, value);
    }
    return Promise.resolve(value);
  };
  Object.assign(window, {
    checksFixture: {
      advance: () => {
        newer = true;
      },
      snapshots,
    },
  });
  return {
    getPrChecks,
    getCheckDetails: (input: CheckSelection): Promise<CheckDetails> =>
      Promise.resolve({
        ...input,
        title: 'One test failed',
        summary:
          '## Connection recovery\n\nThe reconnect test exceeded its **5-second timeout**.\n\nExpected the pending command to be replayed after the connection reopened.',
        text: '```text\nAssertionError: expected queue.length to be 0, received 1\n```',
        annotations: [
          {
            path: 'src/worker.ts',
            startLine: 35,
            endLine: 35,
            level: 'failure',
            title: 'Pending command was not replayed',
            message: 'The reconnect callback left one command in the pending queue.',
          },
        ],
        job: {
          id: 1,
          runId: 9,
          attempt: 1,
          status: 'completed',
          canRerun: input.id === 'check:1',
          steps: [
            { name: 'Set up job', number: 1, status: 'completed', conclusion: 'success' },
            { name: 'Install dependencies', number: 2, status: 'completed', conclusion: 'success' },
            { name: 'Run unit tests', number: 3, status: 'completed', conclusion: 'failure' },
          ],
        },
      }),
    getCheckLog: (input: CheckSelection) => {
      document.body.dataset.checkLogCalls = String(Number(document.body.dataset.checkLogCalls ?? 0) + 1);
      return Promise.resolve({
        text: `Job ${input.id}\nFAIL reconnect.test.ts\nExpected 0 commands, received 1.`,
        truncated: false,
      });
    },
    rerunChecks: () => {
      document.body.dataset.rerunCalls = String(Number(document.body.dataset.rerunCalls ?? 0) + 1);
      return Promise.resolve();
    },
  };
}
