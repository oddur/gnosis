import { stageWorkflow, focusWorkflow } from './workflow-stages';
import { compactWorkflow } from './workflow-visibility';
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
async function cached<T>(
  client: Octokit,
  key: string,
  ttl: number,
  read: () => Promise<T>,
  force = false,
  storeValue: (value: T) => boolean = () => true
): Promise<T> {
  const cache = githubCacheFor(client);
  const validate = (v: unknown): v is Saved<T> =>
    !!v && typeof v === 'object' && 'value' in v && 'at' in v && typeof v.at === 'number';
  const memory = cache?.get(key, validate);
  const disk = memory ? undefined : await cache?.getPrepared(key, validate);
  const saved = memory ?? (disk ? { value: disk, revalidate: false } : undefined);
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
    if (cache?.version() === generation && storeValue(value)) cache?.set(key, { value, at: Date.now() });
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
class DefinitionError extends Error {}
interface DefinitionBudget {
  files: Set<string>;
  calls: number;
  retryable: boolean;
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
  budget: DefinitionBudget = { files: new Set(), calls: 0, retryable: false }
): Promise<WorkflowDefinitionJob[]> {
  if (!/^[a-f\d]{40}$/i.test(sha) || !/^\.github\/workflows\/[^/]+\.ya?ml$/.test(path))
    throw new DefinitionError('Workflow source path or revision is unavailable.');
  const identity = `${owner}/${repo}/${path}@${sha}`;
  if (chain.includes(identity)) throw new DefinitionError('Reusable workflow cycle detected.');
  if (chain.length >= 10) throw new DefinitionError('Reusable workflows exceed ten nesting levels.');
  if (++budget.calls > 500) throw new DefinitionError('Workflow expands to more than 500 reusable calls.');
  if (!budget.files.has(identity)) {
    if (budget.files.size >= 50) throw new DefinitionError('Workflow uses more than 50 distinct source files.');
    budget.files.add(identity);
  }
  const inputKey = createHash('sha256')
    .update(JSON.stringify(Object.entries(inputs).sort(([a], [b]) => a.localeCompare(b))))
    .digest('hex');
  const parsed = await cached(client, `workflow-parsed:v1:${identity}:${inputKey}`, Infinity, async () => {
    const source = await cached(client, `workflow-source:v1:${identity}`, Infinity, async () => {
      const { data } = await client.repos.getContent({ owner, repo, path, ref: sha });
      if (
        Array.isArray(data) ||
        data.type !== 'file' ||
        !('content' in data) ||
        data.encoding !== 'base64' ||
        data.size > 512_000
      )
        throw new DefinitionError('Workflow source is unavailable or too large.');
      return Buffer.from(data.content, 'base64').toString('utf8');
    });
    try {
      return parseWorkflow(source, inputs);
    } catch (error) {
      throw new DefinitionError(error instanceof Error ? error.message : 'Workflow YAML could not be parsed.');
    }
  });
  // Recursive resolution must never mutate the cached parse (inputs and callers differ).
  const jobs = structuredClone(parsed);
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
          if (!match) throw new DefinitionError('Reusable workflow reference is not supported.');
          [, childOwner, childRepo, childPath] = match;
          const reference = references.filter(
            (ref) => ref.path === job.uses || ref.path.startsWith(`${childOwner}/${childRepo}/${childPath}@`)
          );
          childSha = /^[a-f\d]{40}$/i.test(match[4]) ? match[4] : reference.length === 1 ? reference[0].sha : '';
          if (!childSha) throw new DefinitionError('The run did not report an exact reusable-workflow revision.');
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
        if (!(error instanceof DefinitionError)) budget.retryable = true;
        warnings.push(`${job.name}: ${error instanceof Error ? error.message : 'Reusable workflow unavailable'}`);
      }
    }
  return jobs;
}
async function resolvedDefinitions(
  client: Octokit,
  owner: string,
  repo: string,
  run: WorkflowRunInfo,
  references: Reference[]
) {
  const refs = references.map((r) => [r.path, r.sha]).sort(([a], [b]) => a.localeCompare(b));
  const fingerprint = createHash('sha256').update(JSON.stringify(refs)).digest('hex');
  return cached(
    client,
    `workflow-definitions:v2:${owner}/${repo}/${run.path}@${run.sha}:${fingerprint}`,
    Infinity,
    async () => {
      const warnings: string[] = [];
      const budget: DefinitionBudget = { files: new Set(), calls: 0, retryable: false };
      let jobs: WorkflowDefinitionJob[] = [];
      try {
        jobs = await definitions(client, owner, repo, run.path, run.sha, references, warnings, {}, [], budget);
      } catch (error) {
        budget.retryable = !(error instanceof DefinitionError);
        warnings.push(
          `Dependencies unavailable: ${error instanceof Error ? error.message : 'Could not read workflow source'}`
        );
      }
      return { jobs, warnings, retryable: budget.retryable };
    },
    false,
    (result) => !result.retryable
  );
}
interface RunData {
  run: WorkflowRunInfo;
  jobs: WorkflowJob[];
  definitions: WorkflowDefinitionJob[];
  definitionRetryable?: boolean;
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
  const dataKey = `workflow-data:v2:${input.url}@${input.headSha}:${input.runId}`;
  let data: RunData | undefined;
  const runCache = githubCacheFor(client);
  const validate = (v: unknown): v is Saved<RunData> => !!v && typeof v === 'object' && 'value' in v;
  const memory = runCache?.get(dataKey, validate);
  const disk = memory ? undefined : await runCache?.getPrepared(dataKey, validate);
  const saved = memory ?? (disk ? { value: disk } : undefined);
  if (options.cachedOnly) data = saved?.value.value;
  else {
    const runs = await readWorkflowRuns(client, input);
    const current = runs?.runs.find((run) => run.id === input.runId);
    const finished =
      current?.status === 'completed' &&
      saved?.value.value.run.status === 'completed' &&
      current.attempt === saved.value.value.run.attempt &&
      !saved.value.value.definitionRetryable;
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
        const resolved = await resolvedDefinitions(client, owner, repo, runInfo, run.referenced_workflows ?? []);
        return {
          run: runInfo,
          jobs,
          definitions: resolved.jobs,
          definitionRetryable: resolved.retryable,
          warnings: [...warnings, ...resolved.warnings],
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
  const stages = stageWorkflow(assembled.nodes, assembled.edges, expanded);
  const focused = focusWorkflow(stages.nodes, stages.edges, input.focusNodeId);
  const compact = compactWorkflow(focused.nodes, focused.edges, input);
  // Status changes preserve layout unless a visibility group changes.
  const topology = createHash('sha256')
    .update(JSON.stringify([compact.nodes.map((n) => [n.id, n.height]), compact.edges.map((e) => e.id)]))
    .digest('hex');
  const routed = await cached(client, `workflow-layout:v3:${topology}`, Infinity, () =>
    layoutWorkflow(compact.nodes, compact.edges)
  );
  const byId = new Map(routed.nodes.map((n) => [n.id, n]));
  const edgesById = new Map(routed.edges.map((e) => [e.id, e.points]));
  return {
    target: { url: input.url, headSha: input.headSha },
    run: data.run,
    nodes: compact.nodes.map((n) => ({
      ...n,
      x: byId.get(n.id)?.x ?? 0,
      y: byId.get(n.id)?.y ?? 0,
      ports: byId.get(n.id)?.ports,
    })),
    edges: compact.edges.map((e) => ({ ...e, points: edgesById.get(e.id) })),
    groups: [...assembled.groups, ...stages.groups],
    focus: focused.focus,
    totalJobs: data.jobs.length,
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
