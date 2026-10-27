import type { Octokit } from '@octokit/rest';
import type { PrCheck } from './pr-checks';
import { checkCounts } from './pr-checks';
/** GitHub returns newest check runs and commit statuses first. Keep the latest result per provider/context. */
export async function readCommitChecks(client: Octokit, owner: string, repo: string, ref: string, fresh = false) {
  const headers = fresh ? { 'cache-control': 'no-cache' } : undefined;
  const runs = await client.paginate(client.checks.listForRef, {
    owner,
    repo,
    ref,
    filter: 'latest',
    per_page: 100,
    headers,
  });
  const statuses = await client.paginate(client.repos.listCommitStatusesForRef, {
    owner,
    repo,
    ref,
    per_page: 100,
    headers,
  });
  const seen = new Set<string>();
  const checks: PrCheck[] = [];
  for (const run of runs) {
    checks.push({
      id: `check:${run.id}`,
      databaseId: run.id,
      nodeId: run.node_id,
      kind: 'check',
      name: run.name,
      provider: run.app?.name ?? 'GitHub check',
      required: null,
      status: run.status === 'completed' ? 'completed' : run.status === 'in_progress' ? 'in_progress' : 'queued',
      conclusion: run.conclusion,
      url: run.html_url ?? run.details_url,
      startedAt: run.started_at,
      completedAt: run.completed_at,
    });
  }
  seen.clear();
  for (const status of statuses) {
    if (seen.has(status.context)) continue;
    seen.add(status.context);
    checks.push({
      id: `status:${status.id}`,
      databaseId: status.id,
      nodeId: status.node_id,
      kind: 'status',
      name: status.context,
      provider: status.creator?.login ?? 'External CI',
      required: null,
      status: status.state === 'pending' ? 'in_progress' : 'completed',
      conclusion: status.state === 'pending' ? null : status.state,
      url: status.target_url,
      startedAt: status.created_at,
      completedAt: status.state === 'pending' ? null : status.updated_at,
      description: status.description ?? undefined,
    });
  }
  const counts = checkCounts(checks);
  const conclusion = counts.attention ? 'failure' : counts.running ? 'pending' : checks.length ? 'success' : 'neutral';
  return { checks, conclusion } as const;
}
