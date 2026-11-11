import { workflowGrouping, withWorkflowSteps } from '../lib/workflow-graph';
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
  event: run.event,
});
const jobCountKey = (input: CheckTarget, run: WorkflowRunInfo) =>
  `workflow-job-count:v1:${input.url}@${input.headSha}:${run.id}:${run.attempt}`;
interface JobCount {
  count: number;
  checkedAt: number;
}
const isJobCount = (value: unknown): value is JobCount =>
  !!value &&
  typeof value === 'object' &&
  'count' in value &&
  typeof value.count === 'number' &&
  Number.isSafeInteger(value.count) &&
  value.count >= 0 &&
  'checkedAt' in value &&
  typeof value.checkedAt === 'number';
export async function readWorkflowRuns(
  client: Octokit,
  input: CheckTarget,
  options: { cachedOnly?: boolean; force?: boolean } = {}
): Promise<WorkflowRuns | undefined> {
  const { owner, repo, pull_number } = target(input);
  const key = `workflow-runs:v1:${input.url}@${input.headSha}`;
  const cache = githubCacheFor(client);
  const validate = (v: unknown): v is Saved<WorkflowRuns> => !!v && typeof v === 'object' && 'value' in v;
  const result = options.cachedOnly
    ? (cache?.get(key, validate)?.value ?? (await cache?.getPrepared(key, validate)))?.value
    : await cached(
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
            ...(data.total_count > 100
              ? { warning: 'Showing workflows from the latest 100 runs on this commit.' }
              : {}),
          };
        },
        options.force
      );
  if (!result) return;
  return {
    ...result,
    runs: await Promise.all(
      result.runs.map(async (run) => {
        const key = jobCountKey(input, run);
        const count = cache?.get(key, isJobCount)?.value ?? (await cache?.getPrepared(key, isJobCount));
        return count ? { ...run, jobCount: count.count } : run;
      })
    ),
  };
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
  await Promise.all(
    jobs.map(async (job) => {
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
    })
  );
  return jobs;
}
interface SourceFile {
  owner: string;
  repo: string;
  path: string;
  sha: string;
}
interface Blob {
  text: string | null;
  byteSize: number;
  isTruncated: boolean;
  isBinary: boolean;
}
type SourceResponse = Record<string, Record<string, Blob | null> | null>;
const sourceKey = (file: SourceFile) => `workflow-source:v1:${file.owner}/${file.repo}/${file.path}@${file.sha}`;
const isSavedSource = (v: unknown): v is Saved<string> =>
  !!v && typeof v === 'object' && 'value' in v && 'at' in v && typeof v.at === 'number';
/**
 * Reads the root workflow and every pinned reusable workflow in one GraphQL query, at most 32 files
 * per query and 50 in total, and saves each usable blob under its REST cache key. Anything it cannot
 * save is left for `definitions()` to read through REST. Never throws.
 */
async function primeWorkflowSources(client: Octokit, files: SourceFile[]): Promise<void> {
  try {
    const cache = githubCacheFor(client);
    if (!cache) return;
    const scope = cacheScope.getStore();
    const generation = scope?.client === client ? scope.generation : cache.version();
    const unique = [...new Map(files.map((file) => [sourceKey(file), file])).values()];
    const saved = await Promise.all(
      unique
        .slice(0, 50)
        .map(
          async (file) =>
            !!cache.get(sourceKey(file), isSavedSource) || !!(await cache.getPrepared(sourceKey(file), isSavedSource))
        )
    );
    const missing = unique.slice(0, 50).filter((_, i) => !saved[i]);
    const batches: SourceFile[][] = [];
    for (let i = 0; i < missing.length; i += 32) batches.push(missing.slice(i, i + 32));
    await Promise.all(
      batches.map(async (batch) => {
        const repos = [...new Set(batch.map((file) => `${file.owner}/${file.repo}`))];
        const query = `query { rateLimit { cost } ${repos
          .map((name, r) => {
            const [owner, repo] = name.split('/');
            return `r${r}: repository(owner:${JSON.stringify(owner)},name:${JSON.stringify(repo)}) { ${batch
              .flatMap((file, f) =>
                `${file.owner}/${file.repo}` === name
                  ? [
                      `f${f}: object(expression:${JSON.stringify(`${file.sha}:${file.path}`)}) { ... on Blob { text byteSize isTruncated isBinary } }`,
                    ]
                  : []
              )
              .join(' ')} }`;
          })
          .join('\n')} }`;
        let data: SourceResponse | undefined;
        try {
          data = await client.graphql<SourceResponse>(query);
        } catch (error) {
          // A missing file or repository fails only its own field; keep the rest.
          data = (error as { data?: SourceResponse }).data;
        }
        if (!data) return;
        for (const [f, file] of batch.entries()) {
          const blob = data[`r${repos.indexOf(`${file.owner}/${file.repo}`)}`]?.[`f${f}`];
          if (
            !blob ||
            typeof blob.text !== 'string' ||
            blob.isBinary ||
            blob.isTruncated ||
            blob.byteSize > 256_000 ||
            cache.version() !== generation
          )
            continue;
          cache.set(sourceKey(file), { value: blob.text, at: Date.now() } satisfies Saved<string>);
        }
      })
    );
  } catch {
    /* Each source falls back to its own REST read. */
  }
}
const workflowPath = /^\.github\/workflows\/[^/]+\.ya?ml$/;
/** The root workflow and every reusable workflow the run reports with an exact revision. */
function workflowSources(owner: string, repo: string, run: WorkflowRunInfo, references: Reference[]): SourceFile[] {
  const files: SourceFile[] = [];
  if (workflowPath.test(run.path) && /^[a-f\d]{40}$/i.test(run.sha))
    files.push({ owner, repo, path: run.path, sha: run.sha });
  for (const reference of references) {
    const match = /^([\w.-]+)\/([\w.-]+)\/(\.github\/workflows\/[^/]+\.ya?ml)@/.exec(reference.path);
    if (!match || !/^[a-f\d]{40}$/i.test(reference.sha)) continue;
    const [, childOwner, childRepo, path] = match;
    files.push({ owner: childOwner, repo: childRepo, path, sha: reference.sha });
    // A `./` call inside the run's repository resolves at the run's revision.
    if (
      childOwner.toLowerCase() === owner.toLowerCase() &&
      childRepo.toLowerCase() === repo.toLowerCase() &&
      /^[a-f\d]{40}$/i.test(run.sha)
    )
      files.push({ owner, repo, path, sha: run.sha });
  }
  return files;
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
      await primeWorkflowSources(client, workflowSources(owner, repo, run, references));
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
        const runInfo = info(run);
        const jobs: WorkflowJob[] = [],
          warnings: string[] = [];
        const loadJobs = async () => {
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
            runInfo.jobCount = batch.total_count;
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
        };
        const [, resolved] = await Promise.all([
          loadJobs(),
          resolvedDefinitions(client, owner, repo, runInfo, run.referenced_workflows ?? []),
        ]);
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
  // Small per-attempt summaries avoid loading every workflow payload to populate navigation.
  if (data.run.jobCount !== undefined && runCache?.version() === cacheScope.getStore()?.generation) {
    const key = jobCountKey(input, data.run);
    const existing = runCache?.get(key, isJobCount)?.value;
    if (!existing || existing.checkedAt < data.checkedAt)
      runCache?.set(key, { count: data.run.jobCount, checkedAt: data.checkedAt });
  }
  const assembled = assembleWorkflow(data.definitions, data.jobs, expanded);
  if (assembled.nodes.length > 600 || assembled.edges.length > 3000)
    throw Error('This graph is too large. Collapse groups or use List view.');
  for (const node of assembled.nodes) {
    if (node.height === 232 && input.expandedAnnotations?.includes(node.id)) {
      node.annotationsExpanded = true;
      node.height = 440;
    }
  }
  const stages = stageWorkflow(assembled.nodes, assembled.edges, expanded, workflowGrouping(input.grouping));
  const focused = focusWorkflow(stages.nodes, stages.edges, input.focusNodeId);
  const compact = compactWorkflow(focused.nodes, focused.edges, input);
  compact.nodes = compact.nodes.map((node) => withWorkflowSteps(node, input.expandedSteps));
  // Status changes preserve layout unless a visibility group changes.
  const topology = createHash('sha256')
    .update(JSON.stringify([compact.nodes.map((n) => [n.id, n.height]), compact.edges.map((e) => e.id)]))
    .digest('hex');
  const routed = await cached(client, `workflow-layout:v4:${topology}`, Infinity, () =>
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
