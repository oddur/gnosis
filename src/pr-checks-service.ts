import type { Octokit } from '@octokit/rest';
import { githubCacheFor } from '../lib/github-client';
import { readCommitChecks } from '../lib/github-checks';
import {
  checkKey,
  type CheckTarget,
  type PrChecks,
  type CheckSelection,
  type CheckDetails,
  type CheckLog,
} from '../lib/pr-checks';
import { prActionTarget } from './pr-actions-service';
import { createGitHubWork, joinGitHubWork, type GitHubWork } from '../lib/github-scheduler';
const pending = new WeakMap<Octokit, Map<string, GitHubWork<PrChecks>>>();
function target(input: CheckTarget) {
  const parsed = prActionTarget(input.url);
  if (typeof input.headSha !== 'string' || !/^[a-f\d]{40}$/i.test(input.headSha))
    throw Error('The check revision is missing. Refresh the PR.');
  return parsed;
}
export async function readPrChecks(
  client: Octokit,
  input: CheckTarget,
  options: { cachedOnly?: boolean; force?: boolean } = {}
): Promise<PrChecks | undefined> {
  const { owner, repo, pull_number } = target(input);
  const cache = githubCacheFor(client),
    key = `pr-checks:v1:${checkKey(input)}`;
  const saved = cache?.get(
    key,
    (v): v is PrChecks => !!v && typeof v === 'object' && 'checks' in v && Array.isArray(v.checks) && 'checkedAt' in v
  );
  if (
    options.cachedOnly ||
    (!options.force && saved && !saved.revalidate && Date.now() - saved.value.checkedAt < 25_000)
  )
    return saved?.value;
  let work = pending.get(client);
  if (!work) {
    work = new Map();
    pending.set(client, work);
  }
  const current = work.get(key);
  if (current) return joinGitHubWork(current);
  const version = cache?.version();
  const job = createGitHubWork(async () => {
    const { checks } = await readCommitChecks(client, owner, repo, input.headSha, true);
    let warning: string | undefined;
    const requirementsKey = `pr-check-requirements:v1:${checkKey(input)}`;
    const old = cache?.get(
      requirementsKey,
      (v): v is { at: number; values: Record<string, boolean> } =>
        !!v && typeof v === 'object' && 'values' in v && 'at' in v
    );
    let requirements = old && !options.force && Date.now() - old.value.at < 120_000 ? old.value.values : undefined;
    if (!requirements) {
      requirements = {};
      try {
        const ids = checks.flatMap((c) => (c.nodeId ? [c.nodeId] : []));
        for (let i = 0; i < ids.length; i += 100) {
          const data = await client.graphql<{ nodes: ({ id: string; isRequired: boolean } | null)[] }>(
            `query($ids:[ID!]!,$number:Int!){nodes(ids:$ids){...on CheckRun{id isRequired(pullRequestNumber:$number)} ...on StatusContext{id isRequired(pullRequestNumber:$number)}}}`,
            { ids: ids.slice(i, i + 100), number: pull_number }
          );
          for (const node of data.nodes)
            if (node && typeof node.isRequired === 'boolean') requirements[node.id] = node.isRequired;
        }
        if (cache?.version() === version) cache?.set(requirementsKey, { at: Date.now(), values: requirements });
      } catch {
        warning = 'GitHub could not confirm which checks are required. Requirements are shown as unknown.';
      }
    }
    for (const check of checks) check.required = check.nodeId ? (requirements[check.nodeId] ?? null) : null;
    const result: PrChecks = { ...input, checks, checkedAt: Date.now(), warning };
    if (cache?.version() === version) cache?.set(key, result);
    return result;
  });
  work.set(key, job);
  try {
    return await job.promise;
  } finally {
    if (work.get(key) === job) work.delete(key);
  }
}
async function checkedRun(client: Octokit, input: CheckSelection) {
  const { owner, repo, pull_number } = target(input);
  const match = /^check:([1-9]\d*)$/.exec(input.id);
  if (!match || !Number.isSafeInteger(Number(match[1]))) throw Error('Choose a GitHub check run.');
  const { data: run } = await client.checks.get({
    owner,
    repo,
    check_run_id: Number(match[1]),
    headers: { 'cache-control': 'no-cache' },
  });
  if (run.head_sha !== input.headSha) throw Error('This check belongs to a different commit. Open its results again.');
  return { owner, repo, pull_number, run };
}
function actionJob(url: string | null, owner: string, repo: string) {
  if (!url) return;
  try {
    const value = new URL(url);
    const match = /^\/([^/]+)\/([^/]+)\/actions\/runs\/(\d+)\/job\/(\d+)$/.exec(value.pathname);
    if (
      value.origin === 'https://github.com' &&
      match &&
      match[1].toLowerCase() === owner.toLowerCase() &&
      match[2].toLowerCase() === repo.toLowerCase()
    )
      return { runId: Number(match[3]), jobId: Number(match[4]) };
  } catch {
    /* No Actions job for this provider. */
  }
}
export async function readCheckDetails(client: Octokit, input: CheckSelection): Promise<CheckDetails> {
  const { owner, repo, run } = await checkedRun(client, input);
  const result: CheckDetails = {
    ...input,
    title: run.output.title ?? run.name,
    summary: run.output.summary ?? '',
    text: run.output.text ?? '',
    annotations: [],
  };
  try {
    const annotations = await client.paginate(client.checks.listAnnotations, {
      owner,
      repo,
      check_run_id: run.id,
      per_page: 100,
    });
    result.annotations = annotations.map((a) => ({
      path: a.path,
      startLine: a.start_line,
      endLine: a.end_line,
      level: a.annotation_level ?? 'notice',
      title: a.title ?? '',
      message: a.message ?? '',
    }));
  } catch {
    result.warning = 'Annotations could not be loaded. Open the check on GitHub for the full result.';
  }
  const job = run.app?.slug === 'github-actions' ? actionJob(run.html_url ?? run.details_url, owner, repo) : undefined;
  if (job) {
    try {
      const [{ data: details }, { data: repository }] = await Promise.all([
        client.actions.getJobForWorkflowRun({
          owner,
          repo,
          job_id: job.jobId,
          headers: { 'cache-control': 'no-cache' },
        }),
        client.repos.get({ owner, repo }),
      ]);
      result.job = {
        id: details.id,
        runId: details.run_id,
        attempt: details.run_attempt ?? 1,
        status: details.status,
        canRerun: !!repository.permissions?.push,
        steps: (details.steps ?? []).map((s) => ({
          name: s.name,
          number: s.number,
          status: s.status,
          conclusion: s.conclusion,
        })),
      };
    } catch {
      result.warning = 'Actions job details are unavailable. Check repository access, or open the job on GitHub.';
    }
  }
  return result;
}
export async function readCheckLog(client: Octokit, input: CheckSelection): Promise<CheckLog> {
  const { owner, repo, run } = await checkedRun(client, input);
  const job = run.app?.slug === 'github-actions' ? actionJob(run.html_url ?? run.details_url, owner, repo) : undefined;
  if (!job) throw Error('Logs for this check are available from its provider.');
  const response = await client.actions.downloadJobLogsForWorkflowRun({
    owner,
    repo,
    job_id: job.jobId,
    request: { redirect: 'manual', cache: 'no-store' },
  });
  const location = response.headers.location;
  if (!location) throw Error('GitHub has not made these logs available. They may still be running or have expired.');
  const url = new URL(location);
  if (url.protocol !== 'https:' || !/(?:\.blob\.core\.windows\.net|\.githubusercontent\.com)$/.test(url.hostname))
    throw Error('Open GitHub to download these logs.');
  const logs = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(30_000) });
  if (!logs.ok || !logs.body) throw Error('Could not download the job log. Retry or open GitHub.');
  const reader = logs.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0,
    truncated = false;
  try {
    while (size < 2_000_000) {
      const { value, done } = await reader.read();
      if (done) break;
      const keep = value.subarray(0, Math.max(0, 2_000_000 - size));
      chunks.push(keep);
      size += keep.length;
      if (size >= 2_000_000) {
        truncated = true;
        await reader.cancel();
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
  return {
    text: Buffer.concat(chunks)
      .toString('utf8')
      // eslint-disable-next-line no-control-regex -- Strip terminal formatting from plain-text logs.
      .replace(/\u001b\[[0-9;]*[A-Za-z]/g, ''),
    truncated,
  };
}
export async function rerunChecks(client: Octokit, input: CheckSelection & { mode: 'failed' | 'all' }) {
  // IPC inputs require runtime validation even when TypeScript callers use the union.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (input.mode !== 'failed' && input.mode !== 'all') throw Error('Choose which jobs to rerun.');
  const { owner, repo, pull_number, run } = await checkedRun(client, input);
  const job = run.app?.slug === 'github-actions' ? actionJob(run.html_url ?? run.details_url, owner, repo) : undefined;
  if (!job) throw Error('Re-run this check from its provider.');
  const [{ data: pr }, { data: workflow }] = await Promise.all([
    client.pulls.get({ owner, repo, pull_number, headers: { 'cache-control': 'no-cache' } }),
    client.actions.getWorkflowRun({ owner, repo, run_id: job.runId, headers: { 'cache-control': 'no-cache' } }),
  ]);
  if (pr.head.sha !== input.headSha || workflow.head_sha !== input.headSha)
    throw Error('New commits arrived. Open the latest results before rerunning jobs.');
  if (workflow.status !== 'completed') throw Error('This workflow is already queued or running.');
  if (input.mode === 'failed') await client.actions.reRunWorkflowFailedJobs({ owner, repo, run_id: job.runId });
  else await client.actions.reRunWorkflow({ owner, repo, run_id: job.runId });
  githubCacheFor(client)?.delete(`pr-checks:v1:${checkKey(input)}`);
}
