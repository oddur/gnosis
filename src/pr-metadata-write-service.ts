import type { Octokit } from '@octokit/rest';
import type { GitHubWriteAction, WriteDetails } from '../lib/github-write-refresh';
import type { OptimisticChange } from '../lib/optimistic-patches';
import { sameLogin } from '../lib/github-actors';
import { githubWriteError } from '../lib/github-access';
import {
  canBeRequested,
  editIsEmpty,
  expectationOf,
  fieldBlockedReason,
  isLabelName,
  isLogin,
  isRemovableLogin,
  isTeamSlug,
  matchesQuery,
  prPeopleChange,
  prPeopleGate,
  type PrMilestoneCandidate,
  type PrPeopleAccess,
  type PrPeopleCandidateRequest,
  type PrPeopleCandidates,
  type PrPeopleEdit,
  type PrPeopleEditResult,
  type PrPeopleField,
  type PrPersonCandidate,
  type PrTeamCandidate,
} from '../lib/pr-people';
import { parseGitHubLabels } from '../lib/github-labels';
import { prActionTarget } from './pr-actions-service';
import type { PrLabel } from '../lib/types';

/**
 * Reviewers, assignees, labels and the milestone of a PR: who may change them, the candidates to pick from, and the
 * writes. Main wires the writes through its optimistic layer and the write refresh (`deps`), as every other GitHub
 * write is: the change shows at once, rolls back when GitHub refuses it, and the PR is read again until GitHub shows it.
 *
 * Access is its own small read rather than `prActions.read`: that state keeps only `canWrite` (WRITE or more), while
 * triage access is enough here, and it lives in a file another change is reworking. The URL parser is shared.
 */
export interface PrMetadataWriteDeps {
  now?: () => number;
  /**
   * Shows `change` at once and rolls it back when the write throws: main's `optimistic.run`. `narrow` names the part
   * GitHub took when it took only part: the change keeps showing that part.
   */
  optimistic: <T>(
    url: string,
    change: OptimisticChange,
    write: () => Promise<T>,
    narrow?: (value: T) => OptimisticChange | undefined
  ) => Promise<T>;
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
/** A list read only in part, after a passing failure: long enough for one search, short enough to retry soon. */
export const TRANSIENT_TTL_MS = 30_000;
const CANDIDATE_ENTRIES = 300;
const PAGE = { users: 50, labels: 100, milestones: 50, teams: 100 } as const;
/** Teams are listed per repository without a search: at most this many pages are read. */
export const TEAM_PAGES = 10;
type CandidateKind = keyof typeof PAGE | 'suggested';

function target(url: unknown) {
  const { owner, repo, pull_number } = prActionTarget(url as string);
  return { owner, repo, number: pull_number, full: `${owner}/${repo}` };
}

interface AccessQuery {
  viewer: { login: string };
  repository: {
    isArchived: boolean;
    viewerPermission: string | null;
    owner: { __typename: string; login: string };
    pullRequest: {
      state: 'OPEN' | 'CLOSED' | 'MERGED';
      author: { login: string } | null;
      reviewRequests: {
        nodes: ({ requestedReviewer: { __typename: string; login?: string; slug?: string; name?: string } | null } | null)[] | null;
      } | null;
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
        remove: strings(edit.remove, isRemovableLogin, 'reviewers'),
        addTeams: teams(edit.addTeams),
        removeTeams: teams(edit.removeTeams),
      };
    case 'assignees':
      return {
        url,
        field: 'assignees',
        add: strings(edit.add, isLogin, 'assignees'),
        remove: strings(edit.remove, isRemovableLogin, 'assignees'),
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

const writeAction = (field: PrPeopleField): GitHubWriteAction => `edit-${field}`;
/** Past the client's saved GET answers, as lib/github.ts reads a PR fresh: these checks decide a write. */
const NO_CACHE = { 'cache-control': 'no-cache' };
const status = (error: unknown) => (error as { status?: number } | null)?.status;
const message = (error: unknown) => githubWriteError(error).message || 'GitHub did not accept the change.';

/** One GitHub request of an edit: the part of the edit it carries out. */
interface Step {
  part: PrPeopleEdit;
  run: () => Promise<void>;
}
/** A request GitHub carried out for some of its part only. */
class StepPartial extends Error {
  constructor(
    message: string,
    readonly done: PrPeopleEdit,
    readonly left: PrPeopleEdit
  ) {
    super(message);
  }
}
/** The parts of a list edit, merged back into one edit. */
function merge(parts: PrPeopleEdit[]): PrPeopleEdit | undefined {
  if (!parts.length) return undefined;
  const [first, ...rest] = parts;
  return rest.reduce<PrPeopleEdit>((all, part) => {
    if (all.field === 'reviewers' && part.field === 'reviewers')
      return { ...all, add: [...all.add, ...part.add], remove: [...all.remove, ...part.remove], addTeams: [...all.addTeams, ...part.addTeams], removeTeams: [...all.removeTeams, ...part.removeTeams] };
    if (all.field === 'assignees' && part.field === 'assignees')
      return { ...all, add: [...all.add, ...part.add], remove: [...all.remove, ...part.remove] };
    if (all.field === 'labels' && part.field === 'labels')
      return { ...all, add: [...all.add, ...part.add], remove: [...all.remove, ...part.remove] };
    return part;
  }, first);
}

export function createPrMetadataWriteService(deps: PrMetadataWriteDeps) {
  const now = deps.now ?? Date.now;
  interface Account {
    access: Map<string, PrPeopleAccess>;
    /** Bumped by `forget`: a read that began before it never stores its answer. */
    generation: Map<string, number>;
    /** Whether each PR was open, as the latest fresh read of it said. */
    observed: Map<string, boolean>;
    candidates: Map<string, { at: number; items: unknown[]; complete: boolean; failed?: boolean; ttl?: number }>;
    pending: Map<string, Promise<unknown>>;
  }
  const accounts = new WeakMap<Octokit, Account>();
  const account = (client: Octokit) => {
    let a = accounts.get(client);
    if (!a) {
      a = { access: new Map(), generation: new Map(), observed: new Map(), candidates: new Map(), pending: new Map() };
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

  async function access(client: Octokit, url: string): Promise<PrPeopleAccess> {
    const pr = target(url);
    const a = account(client);
    const saved = a.access.get(url);
    if (saved && now() - saved.checkedAt < PR_PEOPLE_ACCESS_TTL_MS) return saved;
    const generation = a.generation.get(url) ?? 0;
    return once(a, `access|${url}|${generation}`, async () => {
      const data = await client.graphql<AccessQuery>(
        `query($owner:String!,$repo:String!,$number:Int!){viewer{login} repository(owner:$owner,name:$repo){
        isArchived viewerPermission owner{__typename login}
        pullRequest(number:$number){ state author{login} milestone{number title dueOn}
          reviewRequests(first:100){nodes{requestedReviewer{__typename ... on User{login} ... on Team{slug name}}}}
        }}}`,
        { owner: pr.owner, repo: pr.repo, number: pr.number }
      );
      const repository = data.repository;
      if (!repository?.pullRequest) throw new Error(`GitHub could not find this PR in ${pr.full}, or your account cannot see it.`);
      const request = repository.pullRequest;
      const gate = prPeopleGate({
        permission: repository.viewerPermission,
        archived: repository.isArchived,
        repo: pr.full,
        open: request.state === 'OPEN',
      });
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
        milestone: request.milestone,
        open: request.state === 'OPEN',
        checkedAt: now(),
      };
      // Forgotten while the read ran (a merge or close, say), or a fresher read disagrees: answer, but keep nothing.
      const observed = a.observed.get(url);
      if ((a.generation.get(url) ?? 0) === generation && (observed === undefined || observed === value.open)) a.access.set(url, value);
      return value;
    });
  }

  /** One page of one kind of candidate, from the cache when a saved page answers the query. Failures are saved too. */
  async function page<T>(
    client: Octokit,
    scope: string,
    kind: CandidateKind,
    query: string,
    read: () => Promise<{ items: T[]; complete: boolean; failed?: boolean; transient?: boolean }>
  ): Promise<{ items: T[]; complete: boolean; failed?: boolean }> {
    const a = account(client);
    const needle = query.trim().toLowerCase();
    const fresh = (key: string) => {
      const saved = a.candidates.get(key);
      return saved && now() - saved.at < (saved.ttl ?? PR_PEOPLE_CANDIDATES_TTL_MS) ? saved : undefined;
    };
    // A complete page for a shorter query already holds every match for this one.
    for (let length = needle.length; length >= 0; length--) {
      const saved = fresh(`${scope}|${kind}|${needle.slice(0, length)}`);
      if (saved && (length === needle.length || saved.complete))
        return { items: saved.items as T[], complete: saved.complete, ...(saved.failed ? { failed: true } : {}) };
    }
    const key = `${scope}|${kind}|${needle}`;
    return once(a, `candidates|${key}`, async () => {
      const { transient, ...value } = await read();
      a.candidates.delete(key);
      // A list read only in part after a passing failure (a timeout, a rate limit) is reused for 30 s, by typing and by
      // reopening the picker alike; after that the next read tries again.
      a.candidates.set(key, { at: now(), ...value, ...(transient ? { ttl: TRANSIENT_TTL_MS } : {}) });
      while (a.candidates.size > CANDIDATE_ENTRIES) a.candidates.delete(a.candidates.keys().next().value as string);
      return value;
    });
  }
  type Repo = ReturnType<typeof target>;
  const users = (client: Octokit, repo: Repo, query: string) =>
    page(client, repo.full, 'users', query, async () => {
      const data = await client.graphql<{ repository: { assignableUsers: Page<{ login: string; name: string | null; avatarUrl: string }> } | null }>(
        `query($owner:String!,$repo:String!,$q:String,$first:Int!){repository(owner:$owner,name:$repo){
        assignableUsers(first:$first,query:$q){pageInfo{hasNextPage} nodes{login name avatarUrl}}}}`,
        { owner: repo.owner, repo: repo.repo, q: query.trim() || null, first: PAGE.users }
      );
      const list = data.repository?.assignableUsers;
      return { items: nodes(list).map(person), complete: !list?.pageInfo.hasNextPage };
    });
  // Only teams with access to the repository can review. GitHub lists them per repository without a search, so the
  // pages are read once and narrowed here. A refusal (403, or 404 for a personal repository or a token without
  // `read:org`) is saved as well. Any other failure keeps the pages already read and is tried again next time.
  const repoTeams = (client: Octokit, repo: Repo) =>
    page<PrTeamCandidate>(client, repo.full, 'teams', '', async () => {
      const items: PrTeamCandidate[] = [];
      try {
        for (let n = 1; n <= TEAM_PAGES; n++) {
          const { data } = await client.repos.listTeams({ owner: repo.owner, repo: repo.repo, per_page: PAGE.teams, page: n });
          items.push(...data.map((team) => ({ slug: team.slug, name: team.name })));
          if (data.length < PAGE.teams) return { items, complete: true };
        }
        return { items, complete: false };
      } catch (error) {
        const refused = status(error) === 403 || status(error) === 404;
        return refused ? { items: [], complete: true, failed: true } : { items, complete: false, transient: true };
      }
    });
  const suggested = (client: Octokit, url: string) =>
    page(client, url, 'suggested', '', async () => {
      const pr = target(url);
      const data = await client.graphql<{ repository: { pullRequest: { suggestedReviewers: ({ reviewer: { login: string; name: string | null; avatarUrl: string; __typename?: string } | null } | null)[] | null } | null } | null }>(
        `query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){
        suggestedReviewers{reviewer{__typename login name avatarUrl}}}}}`,
        { owner: pr.owner, repo: pr.repo, number: pr.number }
      );
      // Read here, never as a promise passed in: a saved page would leave that promise's failure unhandled.
      const login = (await access(client, url)).author;
      // GitHub never suggests the author, but a stale suggestion must not offer a request GitHub refuses.
      const items = (data.repository?.pullRequest?.suggestedReviewers ?? []).flatMap((entry) =>
        entry?.reviewer && canBeRequested(entry.reviewer.login, login, entry.reviewer.__typename) ? [person(entry.reviewer)] : []
      );
      return { items, complete: true };
    });
  const labels = (client: Octokit, repo: Repo, query: string) =>
    page(client, repo.full, 'labels', query, async () => {
      const data = await client.graphql<{ repository: { labels: Page<{ name: string; color: string; description: string | null }> } | null }>(
        `query($owner:String!,$repo:String!,$q:String,$first:Int!){repository(owner:$owner,name:$repo){
        labels(first:$first,query:$q,orderBy:{field:NAME,direction:ASC}){pageInfo{hasNextPage} nodes{name color description}}}}`,
        { owner: repo.owner, repo: repo.repo, q: query.trim() || null, first: PAGE.labels }
      );
      const list = data.repository?.labels;
      return { items: parseGitHubLabels(nodes(list)), complete: !list?.pageInfo.hasNextPage };
    });
  const milestones = (client: Octokit, repo: Repo, query: string) =>
    page(client, repo.full, 'milestones', query, async () => {
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
    const empty: PrPeopleCandidates = { field: request.field, query, users: [], teams: [], labels: [], milestones: [], suggested: [], complete: true };
    const narrow = <T>(items: T[], text: (item: T) => (string | undefined)[]) =>
      items.filter((item) => matchesQuery(query, ...text(item)));
    switch (request.field) {
      case 'assignees': {
        const found = await users(client, repo, query);
        return { ...empty, users: narrow(found.items, (u) => [u.login, u.name]), complete: found.complete };
      }
      case 'reviewers': {
        // Who may be asked, the people and the teams are read together.
        const gate = access(client, request.url);
        const [who, found, team, suggestions] = await Promise.all([
          gate,
          users(client, repo, query),
          repoTeams(client, repo),
          query ? Promise.resolve({ items: [] as PrPersonCandidate[] }) : suggested(client, request.url),
        ]);
        return {
          ...empty,
          // GitHub refuses a review request from the PR's author or from a bot.
          users: narrow(found.items, (u) => [u.login, u.name]).filter((u) => canBeRequested(u.login, who.author)),
          teams: who.organization ? narrow(team.items, (t) => [t.slug, t.name]) : [],
          suggested: suggestions.items,
          complete: found.complete && (!who.organization || team.complete),
          ...(who.organization && team.failed ? { teamsUnavailable: true } : {}),
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

  /** The GitHub requests of one edit. Each carries out a part, so a refusal leaves the rest standing. */
  function steps(client: Octokit, edit: PrPeopleEdit): Step[] {
    const { owner, repo, number } = target(edit.url);
    const pr = { owner, repo, pull_number: number };
    const issue = { owner, repo, issue_number: number };
    const url = edit.url;
    switch (edit.field) {
      case 'reviewers': {
        const list: Step[] = [];
        if (edit.add.length || edit.addTeams.length)
          list.push({
            part: { url, field: 'reviewers', add: edit.add, remove: [], addTeams: edit.addTeams, removeTeams: [] },
            run: async () => {
              await client.pulls.requestReviewers({ ...pr, reviewers: edit.add, team_reviewers: edit.addTeams.map((t) => t.slug) });
            },
          });
        if (edit.remove.length || edit.removeTeams.length)
          list.push({
            part: { url, field: 'reviewers', add: [], remove: edit.remove, addTeams: [], removeTeams: edit.removeTeams },
            run: async () => {
              await client.pulls.removeRequestedReviewers({ ...pr, reviewers: edit.remove, team_reviewers: edit.removeTeams.map((t) => t.slug) });
            },
          });
        return list;
      }
      case 'assignees': {
        const list: Step[] = [];
        if (edit.add.length)
          list.push({
            part: { url, field: 'assignees', add: edit.add, remove: [] },
            run: async () => {
              const { data } = await client.issues.addAssignees({ ...issue, assignees: edit.add });
              // GitHub answers success but skips people who cannot be assigned: that part did not happen.
              const assigned = (data.assignees ?? []).map((user) => user.login);
              const skipped = edit.add.filter((login) => !assigned.some((name) => sameLogin(name, login)));
              if (!skipped.length) return;
              const reason = `GitHub didn’t assign ${skipped.join(', ')}. They may not have access to ${owner}/${repo}.`;
              if (skipped.length === edit.add.length) throw new Error(reason);
              throw new StepPartial(
                reason,
                { url, field: 'assignees', add: edit.add.filter((login) => !skipped.includes(login)), remove: [] },
                { url, field: 'assignees', add: skipped, remove: [] }
              );
            },
          });
        if (edit.remove.length)
          list.push({
            part: { url, field: 'assignees', add: [], remove: edit.remove },
            run: async () => {
              await client.issues.removeAssignees({ ...issue, assignees: edit.remove });
            },
          });
        return list;
      }
      case 'labels': {
        // Additions and removals only: setting the whole list would drop a label someone else added meanwhile.
        const list: Step[] = [];
        if (edit.add.length)
          list.push({
            part: { url, field: 'labels', add: edit.add, remove: [] },
            run: async () => {
              await client.issues.addLabels({ ...issue, labels: edit.add.map((label) => label.name) });
            },
          });
        if (edit.remove.length)
          list.push({
            part: { url, field: 'labels', add: [], remove: edit.remove },
            run: async () => {
              const removed: string[] = [];
              for (const name of edit.remove) {
                try {
                  await client.issues.removeLabel({ ...issue, name });
                } catch (error) {
                  // What did not happen: this label and the rest. What did: the labels already removed.
                  const stop = (failure: unknown) => {
                    if (!removed.length) throw failure;
                    const rest = edit.remove.filter((label) => !removed.includes(label));
                    throw new StepPartial(message(failure), { url, field: 'labels', add: [], remove: removed }, { url, field: 'labels', add: [], remove: rest });
                  };
                  if (status(error) !== 404) stop(error);
                  // 404 means the label is not on the PR, or GitHub could not find the PR: check which.
                  let current: { name: string }[] = [];
                  try {
                    current = await client.paginate(client.issues.listLabelsOnIssue, { ...issue, per_page: 100, headers: NO_CACHE });
                  } catch (checkError) {
                    stop(checkError);
                  }
                  if (current.some((label) => sameLogin(label.name, name))) stop(error);
                }
                removed.push(name);
              }
            },
          });
        return list;
      }
      case 'milestone':
        return [
          {
            part: edit,
            run: async () => {
              await client.issues.update({ ...issue, milestone: edit.milestone?.number ?? null });
            },
          },
        ];
    }
  }
  /** Runs every step, also after one fails where the next does not depend on it. */
  async function apply(client: Octokit, edit: PrPeopleEdit): Promise<PrPeopleEditResult> {
    const done: PrPeopleEdit[] = [];
    const left: PrPeopleEdit[] = [];
    let failure: unknown;
    for (const step of steps(client, edit)) {
      try {
        await step.run();
        done.push(step.part);
      } catch (error) {
        if (error instanceof StepPartial) done.push(error.done);
        left.push(error instanceof StepPartial ? error.left : step.part);
        failure ??= error;
      }
    }
    if (!left.length) return { status: 'done' };
    const applied = merge(done);
    if (!applied) throw failure;
    return { status: 'partial', applied, remaining: merge(left) as PrPeopleEdit, error: message(failure) };
  }

  /** Labels must exist in the repository: GitHub would create a missing one instead of refusing it. */
  async function assertLabelsExist(client: Octokit, edit: PrPeopleEdit) {
    if (edit.field !== 'labels') return;
    const repo = target(edit.url);
    // An exact, uncached lookup per label, all at once: a saved candidate page can still list a label deleted since.
    await Promise.all(
      edit.add.map(async (label) => {
        try {
          await client.issues.getLabel({ owner: repo.owner, repo: repo.repo, name: label.name, headers: NO_CACHE });
        } catch (error) {
          if (status(error) === 404) throw new Error(`${repo.full} has no label named “${label.name}”.`);
          throw error;
        }
      })
    );
  }

  async function edit(client: Octokit, input: unknown): Promise<PrPeopleEditResult> {
    const request = validatePrPeopleEdit(input);
    if (editIsEmpty(request)) return { status: 'done' };
    const gate = await access(client, request.url);
    const blocked = fieldBlockedReason(gate, request.field);
    if (blocked) throw new Error(blocked);
    if (request.field === 'reviewers') {
      const refused = request.add.find((login) => !canBeRequested(login, gate.author));
      if (refused)
        throw new Error(
          sameLogin(refused, gate.author) ? 'GitHub doesn’t allow a review request from the PR’s author.' : `GitHub doesn’t take review requests for ${refused}.`
        );
    }
    await assertLabelsExist(client, request);
    const result = await deps.refresh(
      writeAction(request.field),
      [request.url],
      // A partial success keeps showing the part GitHub took, in every window, until the read after the write shows it;
      // the refused part rolls back. The refresh follows the applied part up like any successful write.
      () =>
        deps.optimistic(
          request.url,
          prPeopleChange(request),
          () => apply(client, request),
          (outcome) => (outcome.status === 'partial' ? prPeopleChange(outcome.applied) : undefined)
        ),
      (outcome) => ({ expect: expectationOf(outcome.status === 'partial' ? outcome.applied : request) })
    );
    // Access holds the team requests' slugs and the milestone: keep them current without another read.
    keepAccess(client, result.status === 'partial' ? result.applied : request);
    return result;
  }
  /** The saved access after an edit GitHub took: team requests and the milestone as they are now. */
  function keepAccess(client: Octokit, done: PrPeopleEdit) {
    const a = account(client);
    // An access read that began before the write must not store what it saw then over this.
    a.generation.set(done.url, (a.generation.get(done.url) ?? 0) + 1);
    const saved = a.access.get(done.url);
    if (!saved) return;
    if (done.field === 'reviewers' && (done.addTeams.length || done.removeTeams.length)) {
      const removed = (team: PrTeamCandidate) => done.removeTeams.some((other) => sameLogin(other.slug, team.slug));
      const kept = saved.requestedTeams.filter((team) => !removed(team));
      const added = done.addTeams.filter((team) => !kept.some((other) => sameLogin(other.slug, team.slug)));
      a.access.set(done.url, { ...saved, requestedTeams: [...kept, ...added], checkedAt: now() });
    }
    if (done.field === 'milestone') a.access.set(done.url, { ...saved, milestone: done.milestone, checkedAt: now() });
  }
  /**
   * Who may edit changed: a merge, close or reopen changes whether reviews can be requested, and an edit changes the
   * team requests and the milestone. The next access read goes to GitHub.
   */
  function forget(client: Octokit, urls: string[]) {
    const a = account(client);
    for (const url of urls) {
      a.access.delete(url);
      a.generation.set(url, (a.generation.get(url) ?? 0) + 1);
    }
  }
  /**
   * A fresh read of the PR, from sync, a change signal or a status read. A PR that opened, closed or merged since the
   * last read or observation forgets its access, also while an access read is in flight: that read keeps nothing.
   */
  function observe(client: Octokit, pr: { url: string; state: string; merged: boolean }) {
    const a = account(client);
    const open = pr.state === 'open' && !pr.merged;
    const known = a.access.get(pr.url)?.open ?? a.observed.get(pr.url);
    a.observed.set(pr.url, open);
    if (known !== undefined && known !== open) forget(client, [pr.url]);
  }

  return { access, candidates, edit, forget, observe };
}
export type PrMetadataWriteService = ReturnType<typeof createPrMetadataWriteService>;
