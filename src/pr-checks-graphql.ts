import type { Octokit } from '@octokit/rest';
import type { CheckTarget, PrCheck, PrChecks } from '../lib/pr-checks';
import { prActionTarget } from './pr-actions-service';

interface Context {
  __typename: 'CheckRun' | 'StatusContext';
  id: string;
  databaseId?: number;
  name?: string;
  context?: string;
  status?: string;
  conclusion?: string | null;
  state?: string;
  isRequired?: boolean | null;
  url?: string;
  detailsUrl?: string | null;
  targetUrl?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
  description?: string | null;
  checkSuite?: { app: { name: string } | null } | null;
  creator?: { login: string } | null;
}
interface PullChecks {
  headRefOid: string;
  commits: {
    nodes: {
      commit: {
        oid: string;
        statusCheckRollup: {
          contexts: { nodes: (Context | null)[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
        } | null;
      };
    }[];
  };
}
type Response = Record<string, { pullRequest: PullChecks | null } | null>;

function normalize(node: Context): PrCheck {
  const check = node.__typename === 'CheckRun';
  if (check && (!node.databaseId || !Number.isSafeInteger(node.databaseId)))
    throw Error('GitHub returned a check without a valid ID. Refresh checks.');
  const status = check ? node.status?.toLowerCase() : node.state === 'PENDING' ? 'in_progress' : 'completed';
  return {
    id: check ? `check:${node.databaseId}` : `status:${node.id}`,
    databaseId: node.databaseId ?? 0,
    nodeId: node.id,
    kind: check ? 'check' : 'status',
    name: (check ? node.name : node.context) ?? 'Check',
    provider: check ? (node.checkSuite?.app?.name ?? 'GitHub check') : (node.creator?.login ?? 'External CI'),
    required: typeof node.isRequired === 'boolean' ? node.isRequired : null,
    status: status === 'completed' ? 'completed' : status === 'in_progress' ? 'in_progress' : 'queued',
    conclusion: check
      ? (node.conclusion?.toLowerCase() ?? null)
      : status === 'completed'
        ? (node.state?.toLowerCase() ?? null)
        : null,
    url: check ? (node.detailsUrl ?? node.url ?? null) : (node.targetUrl ?? null),
    startedAt: check ? (node.startedAt ?? null) : (node.createdAt ?? null),
    completedAt: check ? (node.completedAt ?? null) : status === 'completed' ? (node.updatedAt ?? null) : null,
    ...(!check && node.description ? { description: node.description } : {}),
  };
}

/** At most 500 contexts per round trip; paginate each PR independently and pin every page to its head. */
export async function readChecksGraphQL(client: Octokit, targets: CheckTarget[]): Promise<PrChecks[]> {
  if (!targets.length) return [];
  if (targets.length > 5) throw Error('Load at most five PR check lists together.');
  const states = targets.map((target) => ({
    target,
    parsed: prActionTarget(target.url),
    checks: new Map<string, PrCheck>(),
    cursor: null as string | null,
    done: false,
  }));
  while (states.some((state) => !state.done)) {
    const active = states.filter((state) => !state.done);
    const query = `query { ${active
      .map(
        (
          { parsed: { owner, repo, pull_number }, cursor },
          i
        ) => `p${i}: repository(owner:${JSON.stringify(owner)},name:${JSON.stringify(repo)}) {
      pullRequest(number:${pull_number}) { headRefOid commits(last:1) { nodes { commit { oid statusCheckRollup {
        contexts(first:100,after:${JSON.stringify(cursor)}) { pageInfo { hasNextPage endCursor } nodes {
          __typename
          ... on CheckRun { id databaseId name status conclusion isRequired(pullRequestNumber:${pull_number}) url detailsUrl startedAt completedAt checkSuite { app { name } } }
          ... on StatusContext { id context state isRequired(pullRequestNumber:${pull_number}) targetUrl createdAt updatedAt description creator { login } }
        } }
      } } } } }
    }`
      )
      .join('\n')} }`;
    let data: Response;
    try {
      data = await client.graphql<Response>(query);
    } catch (error) {
      const partial = error as { data?: Response; errors?: { path?: (string | number)[] }[] };
      // Unknown requirements must not erase otherwise usable results. Other errors keep the old snapshot.
      if (!partial.data || !partial.errors?.length || partial.errors.some((e) => e.path?.at(-1) !== 'isRequired'))
        throw error;
      data = partial.data;
    }
    for (const [i, state] of active.entries()) {
      const pr = data[`p${i}`]?.pullRequest;
      const commit = pr?.commits.nodes[0]?.commit;
      if (!pr || !commit) throw Error('GitHub could not load this PR’s checks. Refresh checks.');
      if (pr.headRefOid !== state.target.headSha || commit.oid !== state.target.headSha)
        throw Error('New commits arrived. Refresh the PR to load its latest checks.');
      const connection = commit.statusCheckRollup?.contexts;
      for (const node of connection?.nodes ?? []) {
        if (!node) throw Error('GitHub returned incomplete checks. Refresh checks.');
        const check = normalize(node);
        state.checks.set(check.id, check);
      }
      state.done = !connection?.pageInfo.hasNextPage;
      if (!state.done) {
        const cursor = connection?.pageInfo.endCursor;
        if (!cursor || cursor === state.cursor)
          throw Error('GitHub returned an incomplete check list. Refresh checks.');
        state.cursor = cursor;
      }
    }
  }
  return states.map(({ target, checks }) => ({
    ...target,
    checkedAt: Date.now(),
    checks: [...checks.values()],
    ...([...checks.values()].some((check) => check.required === null)
      ? { warning: 'GitHub could not confirm which checks are required. Requirements are shown as unknown.' }
      : {}),
  }));
}
