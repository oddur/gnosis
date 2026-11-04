import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import type { Octokit } from '@octokit/rest';
import { layoutWorkflow } from './workflow-layout';
import { githubCacheFor } from '../lib/github-client';
import { createGitHubWork, joinGitHubWork, type GitHubWork } from '../lib/github-scheduler';
import { prActionTarget } from './pr-actions-service';
import type { CheckTarget } from '../lib/pr-checks';
import type {
  WorkflowRunInfo,
  WorkflowRuns,
  WorkflowGraph,
  WorkflowGraphInput,
  WorkflowDefinitionJob,
  WorkflowJob,
} from '../lib/workflow-graph';
import { assembleWorkflow, parseWorkflow } from './workflow-definition';

const cacheScope = new AsyncLocalStorage<{ client: Octokit; generation: number | undefined }>();
const pending = new WeakMap<Octokit, Map<string, GitHubWork<unknown>>>();
interface Saved<T> {
  value: T;
  at: number;
}
async function cached<T>(client: Octokit, key: string, ttl: number, read: () => Promise<T>, force = false): Promise<T> {
  const cache = githubCacheFor(client);
  const saved = cache?.get(
    key,
    (v): v is Saved<T> => !!v && typeof v === 'object' && 'value' in v && 'at' in v && typeof v.at === 'number'
  );
  if (!force && saved && !saved.revalidate && Date.now() - saved.value.at < ttl) return saved.value.value;
  let work = pending.get(client);
  if (!work) {
    work = new Map();
    pending.set(client, work);
  }
  const current = work.get(key);
  if (current) return joinGitHubWork(current) as Promise<T>;
  const scope = cacheScope.getStore();
  const generation = scope?.client === client ? scope.generation : cache?.version();
  const job = createGitHubWork(async () => {
    const value = await read();
    if (cache?.version() === generation) cache?.set(key, { value, at: Date.now() });
    return value;
  });
  work.set(key, job);
  void job.promise
    .finally(() => {
      if (work.get(key) === job) work.delete(key);
    })
    .catch(() => {});
  return job.promise;
}
function target(input: CheckTarget) {
  if (!/^[a-f\d]{40}$/i.test(input.headSha)) throw Error('Refresh the PR to load its workflow runs.');
  return prActionTarget(input.url);
}
type ApiRun = Awaited<ReturnType<Octokit['actions']['getWorkflowRun']>>['data'];
const info = (run: ApiRun): WorkflowRunInfo => ({
  id: run.id,
  name: run.name ?? run.path,
  path: run.path.split('@')[0],
  sha: run.head_sha,
  attempt: run.run_attempt ?? 1,
  status: run.status ?? 'queued',
  conclusion: run.conclusion,
  url: run.html_url,
});
export async function readWorkflowRuns(
  client: Octokit,
  input: CheckTarget,
  options: { cachedOnly?: boolean; force?: boolean } = {}
): Promise<WorkflowRuns | undefined> {
  const { owner, repo, pull_number } = target(input);
  const key = `workflow-runs:v1:${input.url}@${input.headSha}`;
  if (options.cachedOnly)
    return githubCacheFor(client)?.get(
      key,
      (v): v is Saved<WorkflowRuns> => !!v && typeof v === 'object' && 'value' in v
    )?.value.value;
  return cached(
    client,
    key,
    25_000,
    async () => {
      const { data } = await client.actions.listWorkflowRunsForRepo({
        owner,
        repo,
        head_sha: input.headSha,
        per_page: 100,
        headers: { 'cache-control': 'no-cache' },
      });
      const runs = data.workflow_runs.filter(
        (run) =>
          run.head_sha === input.headSha &&
          (!run.pull_requests?.length || run.pull_requests.some((pr) => pr.number === pull_number))
      );
      // The latest execution of each workflow/event is the relevant one, not historical reruns.
      const latest = new Map<string, ApiRun>();
      for (const run of runs) {
        const key = `${run.workflow_id}:${run.event}`;
        const previous = latest.get(key);
        if (!previous || run.id > previous.id) latest.set(key, run);
      }
      return {
        ...input,
        runs: [...latest.values()].map(info),
        checkedAt: Date.now(),
        ...(data.total_count > 100 ? { warning: 'Showing workflows from the latest 100 runs on this commit.' } : {}),
      };
    },
    options.force
  );
}
interface Reference {
  path: string;
  sha: string;
  ref?: string;
}
async function definitions(
  client: Octokit,
  owner: string,
  repo: string,
  path: string,
  sha: string,
  references: Reference[],
  warnings: string[],
  inputs: Record<string, string | number | boolean> = {},
  chain: string[] = [],
  budget = { files: 0 }
): Promise<WorkflowDefinitionJob[]> {
  if (!/^[a-f\d]{40}$/i.test(sha) || !/^\.github\/workflows\/[^/]+\.ya?ml$/.test(path))
    throw Error('Workflow source path or revision is unavailable.');
  const identity = `${owner}/${repo}/${path}@${sha}`;
  if (chain.includes(identity) || chain.length >= 5 || budget.files++ >= 20)
    throw Error('Nested workflow limit reached.');
  const source = await cached(client, `workflow-source:v1:${identity}`, Infinity, async () => {
    const { data } = await client.repos.getContent({ owner, repo, path, ref: sha });
    if (
      Array.isArray(data) ||
      data.type !== 'file' ||
      !('content' in data) ||
      data.encoding !== 'base64' ||
      data.size > 512_000
    )
      throw Error('Workflow source is unavailable or too large.');
    return Buffer.from(data.content, 'base64').toString('utf8');
  });
  const jobs = parseWorkflow(source, inputs);
  for (const job of jobs)
    if (job.uses) {
      try {
        let childOwner = owner,
          childRepo = repo,
          childPath: string,
          childSha = sha;
        if (job.uses.startsWith('./')) childPath = job.uses.slice(2);
        else {
          const match = /^([\w.-]+)\/([\w.-]+)\/(\.github\/workflows\/[^/]+\.ya?ml)@(.+)$/.exec(job.uses);
          if (!match) throw Error('Reusable workflow reference is not supported.');
          [, childOwner, childRepo, childPath] = match;
          const reference = references.filter(
            (ref) => ref.path === job.uses || ref.path.startsWith(`${childOwner}/${childRepo}/${childPath}@`)
          );
          childSha = /^[a-f\d]{40}$/i.test(match[4]) ? match[4] : reference.length === 1 ? reference[0].sha : '';
          if (!childSha) throw Error('The run did not report an exact reusable-workflow revision.');
        }
        job.children = await definitions(
          client,
          childOwner,
          childRepo,
          childPath,
          childSha,
          references,
          warnings,
          job.inputs,
          [...chain, identity],
          budget
        );
      } catch (error) {
        warnings.push(`${job.name}: ${error instanceof Error ? error.message : 'Reusable workflow unavailable'}`);
      }
    }
  return jobs;
}
interface RunData {
  run: WorkflowRunInfo;
  jobs: WorkflowJob[];
  definitions: WorkflowDefinitionJob[];
  warnings: string[];
  checkedAt: number;
  definitionUrl?: string;
}
async function readGraph(
  client: Octokit,
  input: WorkflowGraphInput,
  options: { cachedOnly?: boolean; force?: boolean } = {}
): Promise<WorkflowGraph | undefined> {
  const { owner, repo } = target(input);
  if (!Number.isSafeInteger(input.runId) || input.runId < 1) throw Error('Select a workflow run.');
  const expanded = [...new Set((input.expanded ?? []).filter((v) => typeof v === 'string' && v.length < 500))]
    .slice(0, 100)
    .sort();
  const dataKey = `workflow-data:v1:${input.url}@${input.headSha}:${input.runId}`;
  let data: RunData | undefined;
  const saved = githubCacheFor(client)?.get(
    dataKey,
    (v): v is Saved<RunData> => !!v && typeof v === 'object' && 'value' in v
  );
  if (options.cachedOnly) data = saved?.value.value;
  else {
    const runs = await readWorkflowRuns(client, input);
    const current = runs?.runs.find((run) => run.id === input.runId);
    const finished =
      current?.status === 'completed' &&
      saved?.value.value.run.status === 'completed' &&
      current.attempt === saved.value.value.run.attempt &&
      !saved.value.value.warnings.length;
    data = await cached(
      client,
      dataKey,
      finished ? Infinity : 25_000,
      async () => {
        const { data: run } = await client.actions.getWorkflowRun({
          owner,
          repo,
          run_id: input.runId,
          headers: { 'cache-control': 'no-cache' },
        });
        if (run.head_sha !== input.headSha)
          throw Error('This workflow belongs to another commit. Open its current results.');
        const jobs: WorkflowJob[] = [],
          warnings: string[] = [];
        for (let page = 1; page <= 5; page++) {
          const { data: batch } = await client.actions.listJobsForWorkflowRunAttempt({
            owner,
            repo,
            run_id: run.id,
            attempt_number: run.run_attempt ?? 1,
            per_page: 100,
            page,
            headers: { 'cache-control': 'no-cache' },
          });
          for (const job of batch.jobs) {
            const checkId = /\/check-runs\/(\d+)$/.exec(job.check_run_url)?.[1];
            jobs.push({
              id: job.id,
              ...(checkId ? { checkId: `check:${checkId}` } : {}),
              name: job.name,
              status: job.status,
              conclusion: job.conclusion,
              startedAt: job.started_at,
              completedAt: job.completed_at,
              url: job.html_url ?? '',
              steps: job.steps ?? [],
            });
          }
          if (page * 100 >= batch.total_count) break;
          if (page === 5) warnings.push('Showing the first 500 jobs. Open GitHub for the full run.');
        }
        const runInfo = info(run);
        let defs: WorkflowDefinitionJob[] = [];
        try {
          defs = await definitions(
            client,
            owner,
            repo,
            runInfo.path,
            run.head_sha,
            run.referenced_workflows ?? [],
            warnings
          );
        } catch (error) {
          warnings.push(
            `Dependencies unavailable: ${error instanceof Error ? error.message : 'Could not read workflow source'}`
          );
        }
        return {
          run: runInfo,
          jobs,
          definitions: defs,
          warnings,
          checkedAt: Date.now(),
          definitionUrl: `https://github.com/${owner}/${repo}/blob/${run.head_sha}/${runInfo.path}`,
        };
      },
      options.force || (!!current && !!saved && current.attempt !== saved.value.value.run.attempt)
    );
  }
  if (!data) return;
  const assembled = assembleWorkflow(data.definitions, data.jobs, expanded);
  if (assembled.nodes.length > 600 || assembled.edges.length > 3000)
    throw Error('This graph is too large. Collapse groups or use List view.');
  // Layout is cached separately from statuses, so live updates never move nodes.
  const topology = createHash('sha256')
    .update(JSON.stringify([assembled.nodes.map((n) => n.id), assembled.edges.map((e) => e.id)]))
    .digest('hex');
  const routed = await cached(client, `workflow-layout:v2:${topology}`, Infinity, () =>
    layoutWorkflow(assembled.nodes, assembled.edges)
  );
  const byId = new Map(routed.nodes.map((n) => [n.id, n]));
  const edgesById = new Map(routed.edges.map((e) => [e.id, e.points]));
  return {
    target: { url: input.url, headSha: input.headSha },
    run: data.run,
    nodes: assembled.nodes.map((n) => ({
      ...n,
      x: byId.get(n.id)?.x ?? 0,
      y: byId.get(n.id)?.y ?? 0,
      ports: byId.get(n.id)?.ports,
    })),
    edges: assembled.edges.map((e) => ({ ...e, points: edgesById.get(e.id) })),
    groups: assembled.groups,
    checkedAt: data.checkedAt,
    warnings: [
      ...data.warnings,
      ...(assembled.unmatched
        ? [
            `${assembled.unmatched} ${assembled.unmatched === 1 ? 'job could' : 'jobs could'} not be matched to a definition. Their statuses are shown without dependency arrows.`,
          ]
        : []),
    ],
    definitionUrl: data.definitionUrl,
  };
}

/** Cache clearing also invalidates nested source/layout reads from an older operation. */
export function readWorkflowGraph(
  client: Octokit,
  input: WorkflowGraphInput,
  options: { cachedOnly?: boolean; force?: boolean } = {}
) {
  return cacheScope.run({ client, generation: githubCacheFor(client)?.version() }, () =>
    readGraph(client, input, options)
  );
}
