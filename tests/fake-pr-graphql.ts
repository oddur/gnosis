/**
 * Answers the aliased PR metadata queries of `lib/pr-metadata-graphql.ts` from REST-shaped `pulls.get` fixtures, so a
 * test can serve the same PRs through either path and compare. Synthetic data only.
 */
export interface RestPull {
  number: number;
  title: string;
  body?: string | null;
  user?: { login: string; type?: string } | null;
  assignees?: { login: string }[];
  base: { ref: string; sha: string; repo: { full_name: string; archived?: boolean } };
  head: { ref: string; sha: string; repo: { full_name: string } | null };
  merged?: boolean;
  state: string;
  created_at: string;
  updated_at: string;
  html_url: string;
  labels?: { name: string; color?: string | null; description?: string | null }[];
  mergeable?: boolean | null;
  draft?: boolean;
  commits?: number;
  changed_files?: number;
  additions?: number;
  deletions?: number;
  comments?: number;
  review_comments?: number;
  requested_reviewers?: { login: string; type?: string }[];
  requested_teams?: { name: string }[];
  mergeable_state?: string | null;
  auto_merge?: { merge_method: string } | null;
  milestone?: { title: string; due_on: string | null } | null;
}

const connection = <T>(nodes: T[]) => ({ totalCount: nodes.length, nodes });
const actor = (user: { login: string; type?: string }) =>
  user.type === 'Bot' ? { __typename: 'Bot', login: user.login.replace(/\[bot\]$/, '') } : { __typename: 'User', login: user.login };

/** The GraphQL node GitHub would return for this REST PR. Review comments sit in one submitted review. */
export function graphPr(pull: RestPull) {
  return {
    number: pull.number,
    title: pull.title,
    url: pull.html_url,
    body: pull.body ?? '',
    createdAt: pull.created_at,
    updatedAt: pull.updated_at,
    state: pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED',
    merged: !!pull.merged,
    isDraft: !!pull.draft,
    mergeable: pull.mergeable === true ? 'MERGEABLE' : pull.mergeable === false ? 'CONFLICTING' : 'UNKNOWN',
    mergeStateStatus: pull.mergeable_state ? pull.mergeable_state.toUpperCase() : 'UNKNOWN',
    additions: pull.additions ?? 0,
    deletions: pull.deletions ?? 0,
    changedFiles: pull.changed_files ?? 0,
    author: pull.user ? actor(pull.user) : null,
    assignees: connection(pull.assignees ?? []),
    assignedActors: { totalCount: (pull.assignees ?? []).length },
    baseRefName: pull.base.ref,
    baseRefOid: pull.base.sha,
    headRefName: pull.head.ref,
    headRefOid: pull.head.sha,
    baseRepository: { nameWithOwner: pull.base.repo.full_name, isArchived: !!pull.base.repo.archived },
    headRepository: pull.head.repo ? { nameWithOwner: pull.head.repo.full_name } : null,
    comments: { totalCount: pull.comments ?? 0 },
    commits: { totalCount: pull.commits ?? 0 },
    reviews: connection(pull.review_comments ? [{ comments: { totalCount: pull.review_comments } }] : []),
    labels: connection((pull.labels ?? []).map((l) => ({ name: l.name, color: l.color ?? null, description: l.description ?? null }))),
    reviewRequests: connection([
      ...(pull.requested_reviewers ?? []).map((u) => ({ requestedReviewer: actor(u) })),
      ...(pull.requested_teams ?? []).map((t) => ({ requestedReviewer: { __typename: 'Team', name: t.name } })),
    ]),
    autoMergeRequest: pull.auto_merge ? { mergeMethod: pull.auto_merge.merge_method.toUpperCase() } : null,
    milestone: pull.milestone ? { title: pull.milestone.title, dueOn: pull.milestone.due_on } : null,
  };
}

/** The PRs an aliased metadata query asks for, in alias order. */
export const queriedPrs = (query: string) =>
  [...query.matchAll(/(p\d+): repository\(owner:("[^"]*"),name:("[^"]*")\) \{ pullRequest\(number:(\d+)\)/g)].map(
    ([, alias, owner, name, number]) => ({
      alias,
      owner: JSON.parse(owner) as string,
      repo: JSON.parse(name) as string,
      number: Number(number),
    })
  );

/** The data of an aliased metadata query; a PR `find` does not know is null, as GitHub answers. */
export function answerPrQuery(query: string, find: (owner: string, repo: string, number: number) => RestPull | undefined) {
  const data: Record<string, unknown> = { rateLimit: { cost: 1 } };
  for (const { alias, owner, repo, number } of queriedPrs(query)) {
    const pull = find(owner, repo, number);
    data[alias] = { pullRequest: pull ? graphPr(pull) : null };
  }
  return data;
}
