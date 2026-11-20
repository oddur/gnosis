import type { Octokit } from '@octokit/rest';
import type { GitHubWriteAction, WriteDetails } from '../lib/github-write-refresh';
import type { OptimisticChange } from '../lib/optimistic-patches';
import {
  editIsEmpty,
  expectationOf,
  isLabelName,
  isLogin,
  isTeamSlug,
  matchesQuery,
  prPeopleGate,
  same,
  type PrMilestoneCandidate,
  type PrPeopleAccess,
  type PrPeopleCandidateRequest,
  type PrPeopleCandidates,
  type PrPeopleEdit,
  type PrPeopleField,
  type PrPersonCandidate,
  type PrTeamCandidate,
} from '../lib/pr-people';
import { parseGitHubLabels } from '../lib/github-labels';
import type { PrLabel } from '../lib/types';

/**
 * Reviewers, assignees, labels and the milestone of a PR: who may change them, the candidates to pick from, and the
 * writes. Main wires the writes through its optimistic layer and the write refresh (`deps`), as every other GitHub
 * write is: the change shows at once, rolls back when GitHub refuses it, and the PR is read again until GitHub shows it.
 */
export interface PrMetadataWriteDeps {
  now?: () => number;
  /** Shows `change` at once and rolls it back when the write throws: main's `optimistic.run`. */
  optimistic: <T>(url: string, change: OptimisticChange, write: () => Promise<T>) => Promise<T>;
  /** Runs the write, then reads the PR again until it shows the change: main's `gitHubWrite`. */
  refresh: <T>(
    action: GitHubWriteAction,
    urls: string[],
    write: () => Promise<T>,
    details: (result: T) => Omit<WriteDetails, 'before'>
  ) => Promise<T>;
}

/** Who may edit changes rarely; a minute keeps opening several PRs of one repository to one read each. */
export const PR_PEOPLE_ACCESS_TTL_MS = 60_000;
/** Candidates per repository and query. A big organization is read a page at a time, as the reader types. */
export const PR_PEOPLE_CANDIDATES_TTL_MS = 10 * 60_000;
const CANDIDATE_ENTRIES = 300;
const PAGE = { users: 50, labels: 100, milestones: 50, teams: 100 } as const;
type CandidateKind = keyof typeof PAGE;

const PR_URL = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/([1-9]\d*)$/;
function target(url: unknown) {
  const match = typeof url === 'string' ? PR_URL.exec(url) : null;
  if (!match) throw new Error('Choose a GitHub PR.');
  return { owner: match[1], repo: match[2], number: Number(match[3]), full: `${match[1]}/${match[2]}` };
}

interface AccessQuery {
  viewer: { login: string };
  repository: {
    isArchived: boolean;
    viewerPermission: string | null;
    owner: { __typename: string; login: string };
    pullRequest: {
      author: { login: string } | null;
      reviewRequests: {
        nodes: ({ requestedReviewer: { __typename: string; login?: string; slug?: string; name?: string } | null } | null)[] | null;
      } | null;
      suggestedReviewers: ({ reviewer: { login: string; name: string | null; avatarUrl: string } | null } | null)[] | null;
      milestone: { number: number; title: string; dueOn: string | null } | null;
    } | null;
  } | null;
}
interface Page<T> {
  pageInfo: { hasNextPage: boolean };
  nodes: (T | null)[] | null;
}
const nodes = <T>(page: Page<T> | null | undefined) => (page?.nodes ?? []).flatMap((node) => (node ? [node] : []));
const person = (user: { login: string; name?: string | null; avatarUrl?: string }): PrPersonCandidate => ({
  login: user.login,
  ...(user.name ? { name: user.name } : {}),
  ...(user.avatarUrl ? { avatarUrl: user.avatarUrl } : {}),
});
const strings = (value: unknown, valid: (item: unknown) => boolean, what: string): string[] => {
  if (!Array.isArray(value) || value.length > 100 || !value.every(valid)) throw new Error(`Choose valid ${what}.`);
  return [...new Set(value as string[])];
};
const teams = (value: unknown): PrTeamCandidate[] => {
  if (!Array.isArray(value) || value.length > 100) throw new Error('Choose valid teams.');
  return value.map((team: unknown) => {
    const t = team as Partial<PrTeamCandidate> | null;
    if (!t || !isTeamSlug(t.slug) || typeof t.name !== 'string' || !t.name.trim()) throw new Error('Choose valid teams.');
    return { slug: t.slug, name: t.name };
  });
};

/** An edit as the renderer sent it, checked: IPC payloads are runtime inputs whatever the preload types say. */
export function validatePrPeopleEdit(input: unknown): PrPeopleEdit {
  const edit = (input ?? {}) as Record<string, unknown>;
  const url = edit.url as string;
  target(url);
  switch (edit.field) {
    case 'reviewers':
      return {
        url,
        field: 'reviewers',
        add: strings(edit.add, isLogin, 'reviewers'),
        remove: strings(edit.remove, isLogin, 'reviewers'),
        addTeams: teams(edit.addTeams),
        removeTeams: teams(edit.removeTeams),
      };
    case 'assignees':
      return {
        url,
        field: 'assignees',
        add: strings(edit.add, isLogin, 'assignees'),
        remove: strings(edit.remove, isLogin, 'assignees'),
      };
    case 'labels': {
      if (!Array.isArray(edit.add) || edit.add.length > 100) throw new Error('Choose valid labels.');
      const add = parseGitHubLabels(edit.add as PrLabel[]).map(({ name, color, description }) => ({
        name,
        ...(color ? { color } : {}),
        ...(description ? { description } : {}),
      }));
      if (add.length !== edit.add.length || !add.every((label) => isLabelName(label.name)))
        throw new Error('Choose valid labels.');
      return { url, field: 'labels', add, remove: strings(edit.remove, isLabelName, 'labels') };
    }
    case 'milestone': {
      const m = edit.milestone as Partial<PrMilestoneCandidate> | null | undefined;
      if (m === null) return { url, field: 'milestone', milestone: null };
      if (!m || !Number.isSafeInteger(m.number) || (m.number ?? 0) < 1 || typeof m.title !== 'string')
        throw new Error('Choose a milestone.');
      return {
        url,
        field: 'milestone',
        milestone: { number: m.number as number, title: m.title, dueOn: typeof m.dueOn === 'string' ? m.dueOn : null },
      };
    }
    default:
      throw new Error('Unknown PR change.');
  }
}

/** The change main's optimistic layer shows while the write runs. Teams by name, as PR copies hold them. */
export function prPeopleChange(edit: PrPeopleEdit): OptimisticChange {
  switch (edit.field) {
    case 'reviewers':
      return {
        action: 'edit-reviewers',
        add: edit.add,
        remove: edit.remove,
        addTeams: edit.addTeams.map((team) => team.name),
        removeTeams: edit.removeTeams.map((team) => team.name),
      };
    case 'assignees':
      return { action: 'edit-assignees', add: edit.add, remove: edit.remove };
    case 'labels':
      return { action: 'edit-labels', add: edit.add, remove: edit.remove };
    case 'milestone':
      return {
        action: 'edit-milestone',
        milestone: edit.milestone && { title: edit.milestone.title, dueOn: edit.milestone.dueOn },
      };
  }
}
const writeAction = (field: PrPeopleField): GitHubWriteAction => `edit-${field}`;

const status = (error: unknown) => (error as { status?: number } | null)?.status;

export function createPrMetadataWriteService(deps: PrMetadataWriteDeps) {
  const now = deps.now ?? Date.now;
  interface Account {
    access: Map<string, PrPeopleAccess>;
    candidates: Map<string, { at: number; items: unknown[]; complete: boolean }>;
    pending: Map<string, Promise<unknown>>;
  }
  const accounts = new WeakMap<Octokit, Account>();
  const account = (client: Octokit) => {
    let a = accounts.get(client);
    if (!a) {
      a = { access: new Map(), candidates: new Map(), pending: new Map() };
      accounts.set(client, a);
    }
    return a;
  };
  /** One read per key at a time. */
  function once<T>(a: Account, key: string, read: () => Promise<T>): Promise<T> {
    const existing = a.pending.get(key) as Promise<T> | undefined;
    if (existing) return existing;
    const request = read().finally(() => {
      if (a.pending.get(key) === request) a.pending.delete(key);
    });
    a.pending.set(key, request);
    return request;
  }

  async function access(client: Octokit, url: string, force = false): Promise<PrPeopleAccess> {
    const pr = target(url);
    const a = account(client);
    const saved = a.access.get(url);
    if (!force && saved && now() - saved.checkedAt < PR_PEOPLE_ACCESS_TTL_MS) return saved;
    return once(a, `access|${url}`, async () => {
      const data = await client.graphql<AccessQuery>(
        `query($owner:String!,$repo:String!,$number:Int!){viewer{login} repository(owner:$owner,name:$repo){
        isArchived viewerPermission owner{__typename login}
        pullRequest(number:$number){ author{login} milestone{number title dueOn}
          reviewRequests(first:100){nodes{requestedReviewer{__typename ... on User{login} ... on Team{slug name}}}}
          suggestedReviewers{reviewer{login name avatarUrl}}
        }}}`,
        { owner: pr.owner, repo: pr.repo, number: pr.number }
      );
      const repository = data.repository;
      if (!repository?.pullRequest) throw new Error(`GitHub could not find this PR in ${pr.full}, or your account cannot see it.`);
      const request = repository.pullRequest;
      const gate = prPeopleGate({ permission: repository.viewerPermission, archived: repository.isArchived, repo: pr.full });
      const value: PrPeopleAccess = {
        url,
        permission: repository.viewerPermission,
        ...gate,
        author: request.author?.login ?? '',
        viewer: data.viewer.login,
        organization: repository.owner.__typename === 'Organization',
        requestedTeams: (request.reviewRequests?.nodes ?? []).flatMap((node) => {
          const reviewer = node?.requestedReviewer;
          return reviewer?.__typename === 'Team' && reviewer.slug && reviewer.name
            ? [{ slug: reviewer.slug, name: reviewer.name }]
            : [];
        }),
        // GitHub never suggests the author, but a stale suggestion must not offer a request GitHub refuses.
        suggestedReviewers: (request.suggestedReviewers ?? []).flatMap((entry) =>
          entry?.reviewer && !same(entry.reviewer.login, request.author?.login) ? [person(entry.reviewer)] : []
        ),
        milestone: request.milestone,
        checkedAt: now(),
      };
      a.access.set(url, value);
      return value;
    });
  }

  /** One page of one kind of candidate, from the cache when a saved page answers the query. */
  async function page<T>(
    client: Octokit,
    repo: ReturnType<typeof target>,
    kind: CandidateKind,
    query: string,
    read: () => Promise<{ items: T[]; complete: boolean }>
  ): Promise<{ items: T[]; complete: boolean }> {
    const a = account(client);
    const needle = query.trim().toLowerCase();
    const fresh = (key: string) => {
      const saved = a.candidates.get(key);
      return saved && now() - saved.at < PR_PEOPLE_CANDIDATES_TTL_MS ? saved : undefined;
    };
    // A complete page for a shorter query already holds every match for this one.
    for (let length = needle.length; length >= 0; length--) {
      const saved = fresh(`${repo.full}|${kind}|${needle.slice(0, length)}`);
      if (saved && (length === needle.length || saved.complete)) return { items: saved.items as T[], complete: saved.complete };
    }
    const key = `${repo.full}|${kind}|${needle}`;
    return once(a, `candidates|${key}`, async () => {
      const value = await read();
      a.candidates.delete(key);
      a.candidates.set(key, { at: now(), ...value });
      while (a.candidates.size > CANDIDATE_ENTRIES) a.candidates.delete(a.candidates.keys().next().value as string);
      return value;
    });
  }
  const users = (client: Octokit, repo: ReturnType<typeof target>, query: string) =>
    page(client, repo, 'users', query, async () => {
      const data = await client.graphql<{ repository: { assignableUsers: Page<{ login: string; name: string | null; avatarUrl: string }> } | null }>(
        `query($owner:String!,$repo:String!,$q:String,$first:Int!){repository(owner:$owner,name:$repo){
        assignableUsers(first:$first,query:$q){pageInfo{hasNextPage} nodes{login name avatarUrl}}}}`,
        { owner: repo.owner, repo: repo.repo, q: query.trim() || null, first: PAGE.users }
      );
      const list = data.repository?.assignableUsers;
      return { items: nodes(list).map(person), complete: !list?.pageInfo.hasNextPage };
    });
  // Only teams with access to the repository can review. GitHub lists them per repository without a search, so one
  // page is read and narrowed here.
  const repoTeams = (client: Octokit, repo: ReturnType<typeof target>) =>
    page(client, repo, 'teams', '', async () => {
      const { data } = await client.repos.listTeams({ owner: repo.owner, repo: repo.repo, per_page: PAGE.teams });
      return { items: data.map((team) => ({ slug: team.slug, name: team.name })), complete: data.length < PAGE.teams };
    });
  const labels = (client: Octokit, repo: ReturnType<typeof target>, query: string) =>
    page(client, repo, 'labels', query, async () => {
      const data = await client.graphql<{ repository: { labels: Page<{ name: string; color: string; description: string | null }> } | null }>(
        `query($owner:String!,$repo:String!,$q:String,$first:Int!){repository(owner:$owner,name:$repo){
        labels(first:$first,query:$q,orderBy:{field:NAME,direction:ASC}){pageInfo{hasNextPage} nodes{name color description}}}}`,
        { owner: repo.owner, repo: repo.repo, q: query.trim() || null, first: PAGE.labels }
      );
      const list = data.repository?.labels;
      return { items: parseGitHubLabels(nodes(list)), complete: !list?.pageInfo.hasNextPage };
    });
  const milestones = (client: Octokit, repo: ReturnType<typeof target>, query: string) =>
    page(client, repo, 'milestones', query, async () => {
      const data = await client.graphql<{ repository: { milestones: Page<PrMilestoneCandidate> } | null }>(
        `query($owner:String!,$repo:String!,$q:String,$first:Int!){repository(owner:$owner,name:$repo){
        milestones(first:$first,query:$q,states:[OPEN],orderBy:{field:DUE_DATE,direction:ASC}){pageInfo{hasNextPage} nodes{number title dueOn}}}}`,
        { owner: repo.owner, repo: repo.repo, q: query.trim() || null, first: PAGE.milestones }
      );
      const list = data.repository?.milestones;
      return { items: nodes(list), complete: !list?.pageInfo.hasNextPage };
    });

  async function candidates(client: Octokit, request: PrPeopleCandidateRequest): Promise<PrPeopleCandidates> {
    const repo = target(request.url);
    const query = typeof request.query === 'string' ? request.query.slice(0, 100) : '';
    const empty: PrPeopleCandidates = { field: request.field, query, users: [], teams: [], labels: [], milestones: [], complete: true };
    const narrow = <T>(items: T[], text: (item: T) => (string | undefined)[]) =>
      items.filter((item) => matchesQuery(query, ...text(item)));
    switch (request.field) {
      case 'assignees': {
        const found = await users(client, repo, query);
        return { ...empty, users: narrow(found.items, (u) => [u.login, u.name]), complete: found.complete };
      }
      case 'reviewers': {
        const gate = await access(client, request.url);
        const [found, team] = await Promise.all([
          users(client, repo, query),
          gate.organization
            ? repoTeams(client, repo).catch(() => undefined)
            : Promise.resolve({ items: [] as PrTeamCandidate[], complete: true }),
        ]);
        return {
          ...empty,
          // GitHub refuses a review request from the PR's author.
          users: narrow(found.items, (u) => [u.login, u.name]).filter((u) => !same(u.login, gate.author)),
          teams: narrow(team?.items ?? [], (t) => [t.slug, t.name]),
          complete: found.complete && (team?.complete ?? true),
          ...(team ? {} : { teamsUnavailable: true }),
        };
      }
      case 'labels': {
        const found = await labels(client, repo, query);
        return { ...empty, labels: narrow(found.items, (l) => [l.name, l.description]), complete: found.complete };
      }
      case 'milestone': {
        const found = await milestones(client, repo, query);
        return { ...empty, milestones: narrow(found.items, (m) => [m.title]), complete: found.complete };
      }
      default:
        throw new Error('Unknown PR field.');
    }
  }

  /** The GitHub calls for one edit. Throws GitHub's error unchanged, so the optimistic change rolls back. */
  async function apply(client: Octokit, edit: PrPeopleEdit) {
    const { owner, repo, number } = target(edit.url);
    const pr = { owner, repo, pull_number: number };
    const issue = { owner, repo, issue_number: number };
    switch (edit.field) {
      case 'reviewers':
        if (edit.add.length || edit.addTeams.length)
          await client.pulls.requestReviewers({ ...pr, reviewers: edit.add, team_reviewers: edit.addTeams.map((t) => t.slug) });
        if (edit.remove.length || edit.removeTeams.length)
          await client.pulls.removeRequestedReviewers({
            ...pr,
            reviewers: edit.remove,
            team_reviewers: edit.removeTeams.map((t) => t.slug),
          });
        return;
      case 'assignees':
        if (edit.add.length) {
          const { data } = await client.issues.addAssignees({ ...issue, assignees: edit.add });
          // GitHub answers success but skips people who cannot be assigned. Say so, and roll back.
          const assigned = (data.assignees ?? []).map((user) => user.login);
          const skipped = edit.add.filter((login) => !assigned.some((name) => same(name, login)));
          if (skipped.length)
            throw new Error(`GitHub didn’t assign ${skipped.join(', ')}. They may not have access to ${owner}/${repo}.`);
        }
        if (edit.remove.length) await client.issues.removeAssignees({ ...issue, assignees: edit.remove });
        return;
      case 'labels':
        if (edit.add.length) await client.issues.addLabels({ ...issue, labels: edit.add.map((label) => label.name) });
        for (const name of edit.remove) {
          try {
            await client.issues.removeLabel({ ...issue, name });
          } catch (error) {
            // Someone else already removed it: the PR shows what the reader asked for.
            if (status(error) !== 404) throw error;
          }
        }
        return;
      case 'milestone':
        await client.issues.update({ ...issue, milestone: edit.milestone?.number ?? null });
        return;
    }
  }

  async function edit(client: Octokit, input: unknown): Promise<void> {
    const request = validatePrPeopleEdit(input);
    if (editIsEmpty(request)) return;
    const gate = await access(client, request.url);
    if (!gate.canEdit) throw new Error(gate.reason ?? 'Your account can’t change this PR.');
    if (request.field === 'reviewers' && request.add.some((login) => same(login, gate.author)))
      throw new Error('GitHub doesn’t allow a review request from the PR’s author.');
    await deps.refresh(
      writeAction(request.field),
      [request.url],
      () => deps.optimistic(request.url, prPeopleChange(request), () => apply(client, request)),
      () => ({ expect: expectationOf(request) })
    );
    // Team requests and the milestone are part of the access read: read them again next time.
    const a = account(client);
    const saved = a.access.get(request.url);
    if (saved) a.access.set(request.url, { ...saved, checkedAt: 0 });
  }

  return { access, candidates, edit };
}
export type PrMetadataWriteService = ReturnType<typeof createPrMetadataWriteService>;
