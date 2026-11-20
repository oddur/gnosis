/* eslint-disable @typescript-eslint/require-await -- Async API test doubles. */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { Octokit } from '@octokit/rest';
import {
  createPrMetadataWriteService,
  validatePrPeopleEdit,
  PR_PEOPLE_ACCESS_TTL_MS,
  PR_PEOPLE_CANDIDATES_TTL_MS,
  TRANSIENT_TTL_MS,
} from '../src/pr-metadata-write-service';
import { createOptimisticService } from '../src/optimistic-service';
import { GITHUB_WRITE_EFFECTS, type GitHubWriteAction, type WriteDetails } from '../lib/github-write-refresh';
import { applyToMetadata, createOptimisticLayer, failureTitle, type OptimisticPatch } from '../lib/optimistic-patches';
import {
  canBeRequested,
  diffSelection,
  editList,
  formatDueOn,
  isLogin,
  metadataShows,
  prPeopleChange,
  prPeopleGate,
  prPeopleView,
  type PrPeopleEdit,
} from '../lib/pr-people';
import type { PrMetadata } from '../lib/types';
import { commandRunner, createAfterClose } from '../lib/after-close';

const url = 'https://github.com/klang/engine/pull/7';
type Failure = Error & { status?: number };

/** A synthetic GitHub: one PR, its repository's people, teams, labels and milestones. Records every request. */
function fixture(options: { permission?: string; archived?: boolean; owner?: string; users?: number; teams?: number; state?: string; prLabels?: string[] } = {}) {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const queries: Record<string, unknown>[] = [];
  const failures = new Map<string, Failure>();
  const people = Array.from({ length: options.users ?? 4 }, (_, i) => ({ login: `dev-${i + 1}`, name: `Dev ${i + 1}`, avatarUrl: '' }));
  people.unshift({ login: 'lena', name: 'Lena', avatarUrl: '' });
  const allTeams = Array.from({ length: options.teams ?? 2 }, (_, i) => (i === 0 ? { slug: 'core', name: 'Core team' } : { slug: `team-${i}`, name: `Team ${i}` }));
  let prLabels = options.prLabels ?? ['bug'];
  const repoLabels = [{ name: 'bug', color: 'd73a4a', description: null }, { name: 'docs', color: '0075ca', description: 'Docs' }];
  const call = (method: string, result: unknown = {}) =>
    async (params: Record<string, unknown>) => {
      calls.push({ method, params });
      const failure = failures.get(method) ?? failures.get(`${method}:page${String(params.page)}`);
      if (failure) throw failure;
      return { data: typeof result === 'function' ? (result as (p: Record<string, unknown>) => unknown)(params) : result };
    };
  const client = {
    graphql: async (query: string, params: Record<string, unknown>) => {
      const kind = /assignableUsers/.test(query) ? 'users' : /labels\(/.test(query) ? 'labels' : /milestones\(/.test(query) ? 'milestones' : /suggestedReviewers/.test(query) ? 'suggested' : 'access';
      queries.push({ ...params, kind });
      if (kind === 'users') {
        const q = typeof params.q === 'string' ? params.q.toLowerCase() : '';
        const matches = people.filter((p) => !q || p.login.includes(q) || p.name.toLowerCase().includes(q));
        const first = params.first as number;
        return { repository: { assignableUsers: { pageInfo: { hasNextPage: matches.length > first }, nodes: matches.slice(0, first) } } };
      }
      if (kind === 'labels') {
        const q = typeof params.q === 'string' ? params.q.toLowerCase() : '';
        return { repository: { labels: { pageInfo: { hasNextPage: false }, nodes: repoLabels.filter((l) => l.name.includes(q)) } } };
      }
      if (kind === 'milestones')
        return { repository: { milestones: { pageInfo: { hasNextPage: false }, nodes: [{ number: 3, title: 'v1', dueOn: null }] } } };
      if (kind === 'suggested')
        return {
          repository: {
            pullRequest: {
              suggestedReviewers: [
                { reviewer: { __typename: 'User', login: 'lena', name: 'Lena', avatarUrl: '' } },
                { reviewer: { __typename: 'User', login: 'owen', name: null, avatarUrl: 'a' } },
                { reviewer: { __typename: 'Bot', login: 'review-app', name: null, avatarUrl: '' } },
              ],
            },
          },
        };
      return {
        viewer: { login: 'oddur' },
        repository: {
          isArchived: options.archived ?? false,
          viewerPermission: options.permission ?? 'WRITE',
          owner: { __typename: options.owner ?? 'Organization', login: 'klang' },
          pullRequest: {
            state: options.state ?? 'OPEN',
            author: { login: 'lena' },
            milestone: null,
            reviewRequests: { nodes: [{ requestedReviewer: { __typename: 'Team', slug: 'core', name: 'Core team' } }, { requestedReviewer: { __typename: 'User', login: 'sam' } }] },
          },
        },
      };
    },
    paginate: async (method: (params: Record<string, unknown>) => Promise<{ data: unknown }>, params: Record<string, unknown>) => (await method(params)).data,
    pulls: {
      requestReviewers: call('pulls.requestReviewers'),
      removeRequestedReviewers: call('pulls.removeRequestedReviewers'),
    },
    issues: {
      addAssignees: call('issues.addAssignees', (p: Record<string, unknown>) => ({ assignees: (p.assignees as string[]).filter((l) => !l.startsWith('ghost')).map((login) => ({ login })) })),
      removeAssignees: call('issues.removeAssignees'),
      addLabels: call('issues.addLabels'),
      listLabelsOnIssue: call('issues.listLabelsOnIssue', () => prLabels.map((name) => ({ name }))),
      removeLabel: async (p: Record<string, unknown>) => {
        calls.push({ method: 'issues.removeLabel', params: p });
        const failure = failures.get('issues.removeLabel');
        if (failure) throw failure;
        if (!prLabels.includes(p.name as string)) throw fail('Label does not exist', 404);
        prLabels = prLabels.filter((name) => name !== p.name);
        return { data: [] };
      },
      // An exact lookup also finds labels the search's first page leaves out.
      getLabel: async (p: Record<string, unknown>) => {
        calls.push({ method: 'issues.getLabel', params: p });
        if (![...repoLabels.map((l) => l.name), 'zz-archived'].includes(p.name as string)) throw fail('Not Found', 404);
        return { data: { name: p.name, color: 'ededed' } };
      },
      update: call('issues.update'),
    },
    repos: {
      listTeams: call('repos.listTeams', (p: Record<string, unknown>) => {
        const n = p.page as number;
        return allTeams.slice((n - 1) * 100, n * 100);
      }),
    },
  } as unknown as Octokit;

  // Main's optimistic layer over one PR copy, and the write refresh as a recorder.
  const metadata = {
    url, title: 'Fix', description: '', author: 'lena', assignees: ['lena'], baseBranch: 'main', headBranch: 'fix', baseSha: 'b', headSha: 'h',
    merged: false, state: 'open', createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z', labels: ['bug'],
    labelDetails: [{ name: 'bug', color: 'd73a4a' }], mergeable: true, isDraft: false, commitCount: 1, requestedReviewers: ['sam'],
    requestedTeams: ['Core team'], mergeableState: 'clean', autoMerge: null, milestone: null,
  } satisfies PrMetadata;
  const published: string[] = [];
  const optimistic = createOptimisticService({ viewer: () => ({ login: 'oddur', avatarUrl: '' }), before: () => ({}), changed: (_u, kinds) => published.push(kinds.join('+')) });
  const shownDuringWrite: PrMetadata[] = [];
  /** Runs while a write is in flight, such as the reader starting another edit. */
  let duringWrite: (() => void | Promise<void>) | undefined;
  const refreshes: { action: GitHubWriteAction; urls: string[]; details: Omit<WriteDetails, 'before'>; failed?: boolean }[] = [];
  let clock = 1_000;
  const service = createPrMetadataWriteService({
    now: () => clock,
    optimistic: (u, change, write, narrow) =>
      optimistic.run(
        u,
        change,
        async () => {
          shownDuringWrite.push(optimistic.metadata(metadata));
          await duringWrite?.();
          return write();
        },
        undefined,
        narrow
      ),
    refresh: async (action, urls, write, details) => {
      try {
        const value = await write();
        refreshes.push({ action, urls, details: details(value) });
        return value;
      } catch (error) {
        refreshes.push({ action, urls, details: {}, failed: true });
        throw error;
      }
    },
  });
  return {
    client, service, calls, queries, failures, metadata, optimistic, shownDuringWrite, refreshes, published,
    tick: (ms: number) => (clock += ms),
    whileWriting: (run: () => void | Promise<void>) => (duringWrite = run),
    writes: () => calls.filter((c) => !c.method.startsWith('repos.') && c.method !== 'issues.listLabelsOnIssue' && c.method !== 'issues.getLabel'),
    /** Someone else labels the PR on GitHub. */
    labelOnGitHub: (name: string) => (prLabels = [...prLabels, name]),
    labelsOnPr: () => prLabels,
  };
}
const fail = (message: string, status = 422): Failure => Object.assign(new Error(message), { status });
const reviewers = (edit: Partial<Extract<PrPeopleEdit, { field: 'reviewers' }>>): PrPeopleEdit => ({
  url, field: 'reviewers', add: [], remove: [], addTeams: [], removeTeams: [], ...edit,
});

void test('the permission gate: triage or more, never on an archived repository; reviews need an open PR', () => {
  for (const permission of ['TRIAGE', 'WRITE', 'MAINTAIN', 'ADMIN']) assert.equal(prPeopleGate({ permission, archived: false, repo: 'o/r', open: true }).canEdit, true);
  for (const permission of ['READ', null]) {
    const gate = prPeopleGate({ permission, archived: false, repo: 'o/r', open: true });
    assert.equal(gate.canEdit, false);
    assert.match(gate.reason ?? '', /triage or write access to o\/r/);
  }
  assert.match(prPeopleGate({ permission: 'ADMIN', archived: true, repo: 'o/r', open: true }).reason ?? '', /archived/);
  const closed = prPeopleGate({ permission: 'WRITE', archived: false, repo: 'o/r', open: false });
  assert.deepEqual([closed.canEdit, closed.canRequestReviews], [true, false], 'Labels and assignees still work on a closed PR');
});

void test('a closed PR takes labels but no review requests', async () => {
  const f = fixture({ state: 'MERGED' });
  await assert.rejects(f.service.edit(f.client, reviewers({ add: ['dev-1'] })), /open PR/);
  await f.service.edit(f.client, { url, field: 'labels', add: [{ name: 'docs' }], remove: [] });
  assert.deepEqual(f.writes().map((c) => c.method), ['issues.addLabels']);
});

void test('access names the author and team slugs, and is saved for a minute', async () => {
  const f = fixture();
  const access = await f.service.access(f.client, url);
  assert.equal(access.canEdit, true);
  assert.equal(access.author, 'lena');
  assert.equal(access.viewer, 'oddur');
  assert.deepEqual(access.requestedTeams, [{ slug: 'core', name: 'Core team' }]);
  assert.ok(!f.queries.some((q) => q.kind === 'suggested'), 'Suggestions are read only when the reviewer picker opens');
  await f.service.access(f.client, url);
  assert.equal(f.queries.length, 1);
  f.tick(PR_PEOPLE_ACCESS_TTL_MS + 1);
  await f.service.access(f.client, url);
  assert.equal(f.queries.length, 2);
});

void test('a read-only account writes nothing and hears why', async () => {
  const f = fixture({ permission: 'READ' });
  await assert.rejects(f.service.edit(f.client, { url, field: 'labels', add: [{ name: 'docs' }], remove: [] }), /triage or write access to klang\/engine/);
  assert.deepEqual(f.writes(), []);
  assert.deepEqual(f.refreshes, [], 'No optimistic change and no refresh');
  const archived = fixture({ archived: true });
  await assert.rejects(archived.service.edit(archived.client, { url, field: 'assignees', add: ['dev-1'], remove: [] }), /archived/);
});

void test('reviewers: users and teams in one request each, the change shown while GitHub answers', async () => {
  const f = fixture();
  await f.service.edit(f.client, reviewers({ add: ['dev-1'], remove: ['sam'], addTeams: [{ slug: 'team-1', name: 'Team 1' }], removeTeams: [{ slug: 'core', name: 'Core team' }] }));
  assert.deepEqual(f.writes(), [
    { method: 'pulls.requestReviewers', params: { owner: 'klang', repo: 'engine', pull_number: 7, reviewers: ['dev-1'], team_reviewers: ['team-1'] } },
    { method: 'pulls.removeRequestedReviewers', params: { owner: 'klang', repo: 'engine', pull_number: 7, reviewers: ['sam'], team_reviewers: ['core'] } },
  ]);
  const shown = f.shownDuringWrite[0];
  assert.deepEqual(shown.requestedReviewers, ['dev-1']);
  assert.deepEqual(shown.requestedTeams, ['Team 1'], 'Teams show by name, as PR copies hold them');
  assert.equal(f.refreshes[0].action, 'edit-reviewers');
  assert.deepEqual(f.refreshes[0].details.expect, {
    requestedReviewers: { add: ['dev-1'], remove: ['sam'] },
    requestedTeams: { add: ['Team 1'], remove: ['Core team'] },
  });
  f.optimistic.observe(url, 'metadata', { ...f.metadata, requestedReviewers: ['dev-1'], requestedTeams: ['Team 1'] });
  f.optimistic.observe(url, 'discussion', { headSha: 'h', baseSha: 'b', threads: [], feedback: { comments: [], reviews: [], requestedReviewers: ['dev-1'], viewerCanUpdate: true, state: 'OPEN' } });
  assert.equal(f.optimistic.layer.list().length, 0, 'GitHub shows it everywhere: the patch is cleared');
});

void test('re-requesting a review from someone who already reviewed is one request', async () => {
  const f = fixture();
  await f.service.edit(f.client, reviewers({ add: ['maya'] }));
  assert.deepEqual(f.writes().map((c) => [c.method, c.params.reviewers]), [['pulls.requestReviewers', ['maya']]]);
});

void test('GitHub refuses a review request from the author or a bot', async () => {
  const f = fixture();
  await assert.rejects(f.service.edit(f.client, reviewers({ add: ['Lena'] })), /author/);
  await assert.rejects(f.service.edit(f.client, reviewers({ add: ['github-actions'] })), /review requests for github-actions/);
  assert.deepEqual(f.writes(), []);
  assert.equal(canBeRequested('renovate[bot]', 'lena'), false);
  assert.equal(canBeRequested('review-app', 'lena', 'Bot'), false);
  assert.equal(canBeRequested('maya', 'lena', 'User'), true);
});

void test('Enterprise Managed User logins, with an underscore, are accepted', async () => {
  assert.ok(isLogin('maya_acme'));
  assert.ok(!isLogin('_maya'));
  const f = fixture();
  await f.service.edit(f.client, { url, field: 'assignees', add: ['maya_acme'], remove: [] });
  assert.deepEqual(f.writes().map((c) => c.params.assignees), [['maya_acme']]);
});

void test('a refused write rolls the change back and still reads the PR again', async () => {
  const f = fixture();
  f.failures.set('issues.addLabels', fail('Validation Failed'));
  await assert.rejects(f.service.edit(f.client, { url, field: 'labels', add: [{ name: 'docs', color: '0075ca' }], remove: [] }), /Validation Failed/);
  assert.deepEqual(f.shownDuringWrite[0].labels, ['bug', 'docs'], 'Shown at once');
  assert.deepEqual(f.shownDuringWrite[0].labelDetails, [{ name: 'bug', color: 'd73a4a' }, { name: 'docs', color: '0075ca' }], 'With its color');
  assert.deepEqual(f.optimistic.metadata(f.metadata).labels, ['bug'], 'Rolled back');
  assert.equal(f.optimistic.layer.list().length, 0);
  assert.deepEqual(f.refreshes.map((r) => [r.action, r.failed]), [['edit-labels', true]]);
  assert.deepEqual(f.published, ['metadata', 'metadata'], 'Every window saw the change and its rollback');
  assert.equal(failureTitle('edit-labels'), 'Labels weren’t changed.');
});

void test('a partial success keeps what GitHub took and returns the rest for Retry', async () => {
  const f = fixture();
  f.failures.set('pulls.requestReviewers', fail('Reviews may only be requested from collaborators.'));
  const result = await f.service.edit(f.client, reviewers({ add: ['outsider'], remove: ['sam'] }));
  // The removal still ran after the addition failed.
  assert.deepEqual(f.writes().map((c) => c.method), ['pulls.requestReviewers', 'pulls.removeRequestedReviewers']);
  assert.ok(result.status === 'partial');
  assert.deepEqual([result.applied, result.remaining], [reviewers({ remove: ['sam'] }), reviewers({ add: ['outsider'] })]);
  assert.match(result.error, /collaborators/);
  // Right after the partial result, every window still shows the part GitHub took: sam is no longer requested. The
  // refused addition is gone.
  assert.deepEqual(f.optimistic.metadata(f.metadata).requestedReviewers, []);
  assert.deepEqual(f.optimistic.layer.list().map((p) => p.change), [prPeopleChange(reviewers({ remove: ['sam'] }))]);
  // Retry sends only the remaining part.
  f.failures.clear();
  f.calls.length = 0;
  assert.deepEqual(await f.service.edit(f.client, result.remaining), { status: 'done' });
  assert.deepEqual(f.writes().map((c) => [c.method, c.params.reviewers]), [['pulls.requestReviewers', ['outsider']]]);
});

void test('assignees: GitHub skipping some counts as a partial change, skipping all as a failure', async () => {
  const f = fixture();
  const result = await f.service.edit(f.client, { url, field: 'assignees', add: ['dev-1', 'ghost'], remove: ['lena'] });
  assert.ok(result.status === 'partial');
  assert.deepEqual(result.applied, { url, field: 'assignees', add: ['dev-1'], remove: ['lena'] });
  assert.deepEqual(result.remaining, { url, field: 'assignees', add: ['ghost'], remove: [] });
  assert.match(result.error, /didn’t assign ghost/);
  assert.deepEqual(f.optimistic.metadata(f.metadata).assignees, ['dev-1'], 'The part GitHub took still shows');
  const g = fixture();
  await assert.rejects(g.service.edit(g.client, { url, field: 'assignees', add: ['ghost'], remove: [] }), /didn’t assign ghost/);
  assert.deepEqual(g.optimistic.metadata(g.metadata).assignees, ['lena'], 'Rolled back');
});

void test('labels: added in one request, removed one by one, never overwriting labels others added', async () => {
  const f = fixture({ prLabels: ['bug'] });
  // Someone else adds a label while the reader edits: it stays.
  f.labelOnGitHub('later-added');
  await f.service.edit(f.client, { url, field: 'labels', add: [{ name: 'docs' }], remove: ['bug'] });
  assert.deepEqual(f.writes().map((c) => [c.method, c.params.labels ?? c.params.name]), [['issues.addLabels', ['docs']], ['issues.removeLabel', 'bug']]);
  assert.ok(!f.calls.some((c) => c.method === 'issues.setLabels'), 'The label list is never replaced');
  assert.deepEqual(f.labelsOnPr(), ['later-added']);
  assert.deepEqual(f.refreshes[0].details.expect, { labels: { add: ['docs'], remove: ['bug'] } });
});

void test('removing a label: a 404 is success only when the label is really gone', async () => {
  const gone = fixture({ prLabels: [] });
  assert.deepEqual(await gone.service.edit(gone.client, { url, field: 'labels', add: [], remove: ['bug'] }), { status: 'done' });
  const present = fixture({ prLabels: ['bug'] });
  present.failures.set('issues.removeLabel', fail('Not Found', 404));
  await assert.rejects(present.service.edit(present.client, { url, field: 'labels', add: [], remove: ['bug'] }), /Not Found/);
  assert.deepEqual(present.optimistic.metadata(present.metadata).labels, ['bug'], 'Rolled back');
});

void test('a label the repository lacks is refused, never created', async () => {
  const f = fixture();
  await assert.rejects(f.service.edit(f.client, { url, field: 'labels', add: [{ name: 'from-another-repo' }], remove: [] }), /no label named “from-another-repo”/);
  assert.deepEqual(f.writes(), []);
});

void test('milestone: set by number, cleared with null', async () => {
  const f = fixture();
  await f.service.edit(f.client, { url, field: 'milestone', milestone: { number: 3, title: 'v1', dueOn: null } });
  await f.service.edit(f.client, { url, field: 'milestone', milestone: null });
  assert.deepEqual(f.writes().map((c) => c.params.milestone), [3, null]);
  assert.deepEqual(f.refreshes.map((r) => [r.action, r.details.expect?.milestone]), [['edit-milestone', 'v1'], ['edit-milestone', null]]);
});

void test('an edit that changes nothing makes no request', async () => {
  const f = fixture();
  await f.service.edit(f.client, reviewers({}));
  assert.deepEqual([f.writes(), f.queries, f.refreshes], [[], [], []]);
});

void test('IPC input is checked', () => {
  assert.throws(() => validatePrPeopleEdit({ url: 'https://example.com/pull/1', field: 'labels', add: [], remove: [] }), /valid GitHub pull request/);
  assert.throws(() => validatePrPeopleEdit({ url, field: 'assignees', add: ['not a login'], remove: [] }), /valid assignees/);
  assert.throws(() => validatePrPeopleEdit({ url, field: 'reviewers', add: [], remove: [], addTeams: [{ slug: '../x', name: 'x' }], removeTeams: [] }), /valid teams/);
  assert.throws(() => validatePrPeopleEdit({ url, field: 'milestone', milestone: { number: -1, title: 'x' } }), /milestone/);
  assert.throws(() => validatePrPeopleEdit({ url, field: 'title' }), /Unknown/);
  assert.deepEqual(validatePrPeopleEdit({ url, field: 'assignees', add: ['a', 'a'], remove: [] }), { url, field: 'assignees', add: ['a'], remove: [] });
});

void test('candidates: saved per repository, searched on GitHub only past a partial first page', async () => {
  const small = fixture();
  const all = await small.service.candidates(small.client, { url, field: 'assignees' });
  assert.equal(all.complete, true);
  assert.deepEqual(all.users.map((u) => u.login), ['lena', 'dev-1', 'dev-2', 'dev-3', 'dev-4']);
  const narrowed = await small.service.candidates(small.client, { url, field: 'assignees', query: 'dev-3' });
  assert.deepEqual(narrowed.users.map((u) => u.login), ['dev-3']);
  assert.equal(small.queries.filter((q) => q.kind === 'users').length, 1, 'A complete page answers every narrower query');

  const big = fixture({ users: 120 });
  const first = await big.service.candidates(big.client, { url, field: 'assignees' });
  assert.equal(first.complete, false);
  assert.equal(first.users.length, 50);
  const found = await big.service.candidates(big.client, { url, field: 'assignees', query: 'dev-119' });
  assert.deepEqual(found.users.map((u) => u.login), ['dev-119']);
  await big.service.candidates(big.client, { url, field: 'assignees', query: 'dev-119' });
  assert.deepEqual(big.queries.filter((q) => q.kind === 'users').map((q) => q.q), [null, 'dev-119'], 'Each query once');
  big.tick(PR_PEOPLE_CANDIDATES_TTL_MS + 1);
  await big.service.candidates(big.client, { url, field: 'assignees' });
  assert.equal(big.queries.filter((q) => q.kind === 'users').length, 3, 'Read again after ten minutes');
});

void test('reviewer candidates: no author, no bots, teams as teams, suggestions read with the picker', async () => {
  const f = fixture();
  const list = await f.service.candidates(f.client, { url, field: 'reviewers' });
  assert.ok(!list.users.some((u) => u.login === 'lena'));
  assert.deepEqual(list.suggested.map((p) => p.login), ['owen'], 'Neither the author nor a bot is suggested');
  assert.deepEqual(list.teams, [{ slug: 'core', name: 'Core team' }, { slug: 'team-1', name: 'Team 1' }]);
  const personal = fixture({ owner: 'User' });
  const mine = await personal.service.candidates(personal.client, { url, field: 'reviewers' });
  assert.deepEqual([mine.teams, mine.teamsUnavailable], [[], undefined], 'A personal repository has no teams, and no error');
  const labels = await f.service.candidates(f.client, { url, field: 'labels', query: 'doc' });
  assert.deepEqual(labels.labels, [{ name: 'docs', color: '0075ca', description: 'Docs' }]);
});

void test('teams past the first page are listed; the list is complete once every page is read', async () => {
  const f = fixture({ teams: 150 });
  const list = await f.service.candidates(f.client, { url, field: 'reviewers', query: 'Team 149' });
  assert.deepEqual(list.teams.map((t) => t.slug), ['team-149']);
  assert.deepEqual(f.calls.filter((c) => c.method === 'repos.listTeams').map((c) => c.params.page), [1, 2]);
  assert.equal(list.complete, true);
});

void test('a refused team list is saved for the candidate lifetime; people still load', async () => {
  const f = fixture();
  f.failures.set('repos.listTeams', fail('Resource not accessible', 403));
  const first = await f.service.candidates(f.client, { url, field: 'reviewers' });
  assert.equal(first.teamsUnavailable, true);
  assert.ok(first.users.length > 0);
  await f.service.candidates(f.client, { url, field: 'reviewers', query: 'dev' });
  assert.equal(f.calls.filter((c) => c.method === 'repos.listTeams').length, 1, 'Not asked again on every keystroke');
  f.tick(PR_PEOPLE_CANDIDATES_TTL_MS + 1);
  await f.service.candidates(f.client, { url, field: 'reviewers' });
  assert.equal(f.calls.filter((c) => c.method === 'repos.listTeams').length, 2);
});

void test('reviewer candidates read access, people and teams together', async () => {
  const f = fixture();
  let inFlight = 0;
  let most = 0;
  const graphql = f.client.graphql.bind(f.client);
  const listTeams = f.client.repos.listTeams.bind(f.client.repos);
  const track = <T>(run: () => Promise<T>) => {
    most = Math.max(most, ++inFlight);
    return new Promise((resolve) => setTimeout(resolve, 5)).then(run).finally(() => inFlight--);
  };
  Object.assign(f.client, { graphql: (q: string, p: Record<string, unknown>) => track(() => graphql(q, p)) });
  Object.assign(f.client.repos, { listTeams: (p: Parameters<typeof listTeams>[0]) => track(() => listTeams(p)) });
  await f.service.candidates(f.client, { url, field: 'reviewers' });
  assert.ok(most >= 3, `access, people and teams overlap (${most} at once)`);
});

void test('write refresh: what each edit makes stale, and when GitHub shows it', () => {
  assert.deepEqual(GITHUB_WRITE_EFFECTS['edit-reviewers'].kinds, ['metadata', 'signals', 'discussion']);
  for (const action of ['edit-reviewers', 'edit-assignees', 'edit-labels', 'edit-milestone'] as const) {
    assert.equal(GITHUB_WRITE_EFFECTS[action].queue, true, `${action} brings searches forward`);
    assert.deepEqual(GITHUB_WRITE_EFFECTS[action].probes, ['metadata']);
  }
  const seen = GITHUB_WRITE_EFFECTS['edit-labels'].seen;
  assert.ok(seen);
  const meta = (labels: string[]) => ({ metadata: { labels } as PrMetadata });
  const expect = { labels: { add: ['docs'], remove: ['bug'] } };
  assert.equal(seen(meta(['bug', 'docs']), { expect }), false, 'GitHub still shows the removed label');
  assert.equal(seen(meta(['DOCS']), { expect }), true, 'Compared without case');
  assert.equal(metadataShows({ milestone: null }, { milestone: null }), true);
  assert.equal(metadataShows({ milestone: { title: 'v1', dueOn: null } }, { milestone: null }), false);
});

const viewer = { login: 'oddur', avatarUrl: '' };
const layerWithIds = () => createOptimisticLayer({ id: (() => { let n = 0; return () => String(++n); })() });
const base = { url, labels: ['bug'], labelDetails: [{ name: 'bug', color: 'd73a4a' }], requestedReviewers: [], requestedTeams: [], isDraft: false, autoMerge: null, milestone: null } as unknown as PrMetadata;

void test('edits stack: a later edit replaces what an earlier one decided about the same item', () => {
  const layer = layerWithIds();
  const add = layer.begin({ url, viewer, change: prPeopleChange({ url, field: 'labels', add: [{ name: 'docs' }], remove: [] }) });
  layer.confirm(add.id);
  const remove = layer.begin({ url, viewer, change: prPeopleChange({ url, field: 'labels', add: [], remove: ['docs'] }) });
  assert.deepEqual(layer.metadata(base).labels, ['bug'], 'Adding then removing a label leaves it off');
  assert.equal(layer.list().length, 2, 'Both apply while the removal is pending');
  layer.confirm(remove.id);
  assert.equal(layer.list().length, 1, 'Once GitHub takes the removal, the earlier add no longer applies');
  assert.deepEqual(layer.metadata(base).labels, ['bug']);
  // Unrelated items of an earlier edit stay.
  const two = layerWithIds();
  two.begin({ url, viewer, change: prPeopleChange({ url, field: 'labels', add: [{ name: 'docs' }, { name: 'perf' }], remove: [] }) });
  const later = two.begin({ url, viewer, change: prPeopleChange({ url, field: 'labels', add: [], remove: ['docs'] }) });
  assert.deepEqual(two.metadata(base).labels, ['bug', 'perf']);
  two.fail(later.id);
  assert.deepEqual(two.metadata(base).labels, ['bug', 'docs', 'perf'], 'Each rolls back alone: the refused removal leaves docs on');
  // Milestones: the latest choice wins.
  const m = layerWithIds();
  m.begin({ url, viewer, change: prPeopleChange({ url, field: 'milestone', milestone: { number: 1, title: 'A', dueOn: null } }) });
  const b = m.begin({ url, viewer, change: prPeopleChange({ url, field: 'milestone', milestone: { number: 2, title: 'B', dueOn: null } }) });
  assert.equal(m.metadata(base).milestone?.title, 'B');
  m.confirm(b.id);
  assert.equal(m.list().length, 1);
  assert.equal(m.metadata(base).milestone?.title, 'B');
  assert.deepEqual(editList(['a', 'B'], ['b', 'c'], ['a']), ['B', 'c']);
  assert.deepEqual(diffSelection(['a', 'b'], ['b', 'c']), { add: ['c'], remove: ['a'] });
});

void test('removing your own review request takes the PR out of Review requested, as a review does', () => {
  const patch = { id: '1', key: 'k', url, viewer, startedAt: 0, status: 'pending', before: {}, settled: [], change: prPeopleChange(reviewers({ remove: ['oddur'] })) } as OptimisticPatch;
  const member = { ...base, requestedReviewers: ['oddur'], author: 'lena', role: 'review-requested' };
  const shown = applyToMetadata(patch, member as PrMetadata) as PrMetadata & { role?: string };
  assert.deepEqual([shown.requestedReviewers, shown.role], [[], 'watched']);
  const other = { ...patch, change: prPeopleChange(reviewers({ remove: ['sam'] })) } as OptimisticPatch;
  assert.equal((applyToMetadata(other, member as PrMetadata) as { role?: string }).role, 'review-requested');
});

void test('a status read without a milestone means none, not the queue copy’s', () => {
  const member = { ...base, milestone: { title: 'Old', dueOn: null } };
  assert.equal(prPeopleView(member, { requestedReviewers: [], requestedTeams: [], milestone: null }).milestone, null);
  assert.equal(prPeopleView(member).milestone?.title, 'Old');
});

void test('a due date is the day GitHub stored, whichever midnight it used, in every time zone', () => {
  const expected = new Date(Date.UTC(2026, 11, 1)).toLocaleDateString(undefined, { dateStyle: 'medium', timeZone: 'UTC' });
  /** Midnight on 1 December at a UTC offset in minutes, as GitHub stores it. */
  const midnight = (offset: number) => new Date(Date.UTC(2026, 11, 1) - offset * 60_000).toISOString();
  // −10 Hawaii, −8 Pacific, −5 Eastern, 0, +1, +9, +12:45 Chatham, +13 New Zealand summer, +13:45 Chatham summer.
  for (const offset of [-10 * 60, -9.5 * 60, -8 * 60, -5 * 60, 0, 60, 9 * 60, 12 * 60 + 45, 13 * 60, 13 * 60 + 45])
    assert.equal(formatDueOn(midnight(offset)), expected, `UTC${offset / 60}`);
  // −12 is the same instant as +12, and +14 as −10: one timestamp, two days. The populated zones win.
  assert.equal(midnight(-12 * 60), new Date(Date.UTC(2026, 11, 2) - 12 * 3_600_000).toISOString());
  assert.equal(formatDueOn(midnight(12 * 60)), expected, '+12 (New Zealand winter) over −12 (uninhabited)');
  assert.equal(midnight(14 * 60), new Date(Date.UTC(2026, 10, 30) + 10 * 3_600_000).toISOString());
  assert.equal(formatDueOn(midnight(-10 * 60)), expected, '−10 (Hawaii) over +14 (Line Islands)');
  assert.equal(formatDueOn('2026-12-01T00:00:00Z'), expected, 'The format current milestones use');
});

void test('a lookup after a 404 that fails keeps the labels already removed', async () => {
  const f = fixture({ prLabels: ['bug', 'docs'] });
  let removals = 0;
  const remove = f.client.issues.removeLabel.bind(f.client.issues);
  Object.assign(f.client.issues, {
    removeLabel: (p: Parameters<typeof remove>[0]) => (++removals === 2 ? Promise.reject(fail('Not Found', 404)) : remove(p)),
    listLabelsOnIssue: () => Promise.reject(fail('Bad gateway', 502)),
  });
  const result = await f.service.edit(f.client, { url, field: 'labels', add: [], remove: ['bug', 'docs'] });
  assert.ok(result.status === 'partial');
  assert.deepEqual([result.applied, result.remaining], [
    { url, field: 'labels', add: [], remove: ['bug'] },
    { url, field: 'labels', add: [], remove: ['docs'] },
  ]);
  assert.match(result.error, /Bad gateway/);
});

void test('after a partial edit, GitHub’s order of steps decides, not the order the edits began', async () => {
  const f = fixture();
  f.failures.set('pulls.requestReviewers', fail('Reviews may only be requested from collaborators.'));
  // While the first edit runs, the reader asks maya, and GitHub takes that before the first edit's steps.
  f.whileWriting(() => {
    f.whileWriting(() => undefined);
    const again = f.optimistic.layer.begin({ url, viewer, change: prPeopleChange(reviewers({ add: ['maya'] })) });
    f.optimistic.layer.confirm(again.id);
  });
  // The first edit's removal of maya runs after that request: on GitHub, maya ends up not requested.
  const result = await f.service.edit(f.client, reviewers({ add: ['outsider'], remove: ['maya'] }));
  assert.ok(result.status === 'partial');
  assert.ok(!f.optimistic.metadata(f.metadata).requestedReviewers.includes('maya'), 'The earlier request no longer shows maya');
  assert.deepEqual(f.optimistic.layer.list().map((p) => p.change), [prPeopleChange(reviewers({ remove: ['maya'] }))], 'Only the part GitHub took');
});

void test('a forget during an access read keeps that read from being saved', async () => {
  const f = fixture();
  // The first access read waits until the test releases it.
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => (release = resolve));
  let first = true;
  const graphql = f.client.graphql.bind(f.client);
  Object.assign(f.client, {
    graphql: async (q: string, p: Record<string, unknown>) => {
      if (/viewer\{login\}/.test(q) && first) {
        first = false;
        await held;
      }
      return graphql(q, p);
    },
  });
  const stale = f.service.access(f.client, url);
  await new Promise((resolve) => setTimeout(resolve, 0));
  f.service.forget(f.client, [url]);
  const fresh = f.service.access(f.client, url);
  release();
  await Promise.all([stale, fresh]);
  await f.service.access(f.client, url);
  assert.equal(f.queries.filter((q) => q.kind === 'access').length, 2, 'The read after forget is its own, and the stale one was not kept');
});

void test('sync seeing a PR close or merge forgets its access; an unchanged state keeps it', async () => {
  const f = fixture();
  await f.service.access(f.client, url);
  f.service.observe(f.client, { url, state: 'open', merged: false });
  await f.service.access(f.client, url);
  assert.equal(f.queries.filter((q) => q.kind === 'access').length, 1);
  f.service.observe(f.client, { url, state: 'closed', merged: true });
  await f.service.access(f.client, url);
  assert.equal(f.queries.filter((q) => q.kind === 'access').length, 2);
});

void test('a PR closing while access is being read keeps that read from being saved', async () => {
  const f = fixture();
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => (release = resolve));
  let first = true;
  const graphql = f.client.graphql.bind(f.client);
  Object.assign(f.client, {
    graphql: async (q: string, p: Record<string, unknown>) => {
      if (/viewer\{login\}/.test(q) && first) {
        first = false;
        await held;
      }
      return graphql(q, p);
    },
  });
  f.service.observe(f.client, { url, state: 'open', merged: false });
  const stale = f.service.access(f.client, url);
  await new Promise((resolve) => setTimeout(resolve, 0));
  // Nothing is saved yet; the read reports the PR open, but it closed meanwhile.
  f.service.observe(f.client, { url, state: 'closed', merged: false });
  release();
  assert.equal((await stale).open, true);
  await f.service.access(f.client, url);
  assert.equal(f.queries.filter((q) => q.kind === 'access').length, 2, 'The open answer was not kept');
});

void test('label checks before a write skip the client’s saved answers', async () => {
  const f = fixture({ prLabels: [] });
  await f.service.edit(f.client, { url, field: 'labels', add: [{ name: 'docs' }], remove: ['bug'] });
  for (const method of ['issues.getLabel', 'issues.listLabelsOnIssue']) {
    const call = f.calls.find((c) => c.method === method);
    assert.deepEqual(call?.params.headers, { 'cache-control': 'no-cache' }, method);
  }
});

void test('a label deleted since the candidates were read is refused, not re-created', async () => {
  const f = fixture();
  await f.service.candidates(f.client, { url, field: 'labels' });
  // `docs` is deleted on GitHub; the saved page still lists it.
  Object.assign(f.client.issues, { getLabel: () => Promise.reject(fail('Not Found', 404)) });
  await assert.rejects(f.service.edit(f.client, { url, field: 'labels', add: [{ name: 'docs' }], remove: [] }), /no label named “docs”/);
  assert.deepEqual(f.writes(), []);
});

void test('a failed newer write leaves the earlier one as it was', () => {
  const layer = layerWithIds();
  const add = layer.begin({ url, viewer, change: prPeopleChange({ url, field: 'labels', add: [{ name: 'docs' }], remove: [] }) });
  layer.confirm(add.id);
  const remove = layer.begin({ url, viewer, change: prPeopleChange({ url, field: 'labels', add: [], remove: ['docs'] }) });
  layer.fail(remove.id);
  assert.deepEqual(layer.metadata(base).labels, ['bug', 'docs'], 'The confirmed add still shows');
  const m = layerWithIds();
  const a = m.begin({ url, viewer, change: prPeopleChange({ url, field: 'milestone', milestone: { number: 1, title: 'A', dueOn: null } }) });
  m.confirm(a.id);
  const b = m.begin({ url, viewer, change: prPeopleChange({ url, field: 'milestone', milestone: { number: 2, title: 'B', dueOn: null } }) });
  m.fail(b.id);
  assert.equal(m.metadata(base).milestone?.title, 'A', 'A failed newer milestone restores the earlier choice');
});

void test('Feedback’s review request and a reviewer edit on the same login supersede each other both ways', () => {
  const asked = layerWithIds();
  const request = asked.begin({ url, viewer, change: { action: 'request-review', reviewer: 'maya' } });
  asked.confirm(request.id);
  const removal = asked.begin({ url, viewer, change: prPeopleChange(reviewers({ remove: ['Maya'] })) });
  asked.confirm(removal.id);
  assert.deepEqual(asked.list().map((patch) => patch.change.action), ['edit-reviewers']);
  assert.deepEqual(asked.metadata(base).requestedReviewers, []);
  const edited = layerWithIds();
  const edit = edited.begin({ url, viewer, change: prPeopleChange(reviewers({ remove: ['maya'], add: ['sam'] })) });
  edited.confirm(edit.id);
  const again = edited.begin({ url, viewer, change: { action: 'request-review', reviewer: 'maya' } });
  edited.confirm(again.id);
  assert.deepEqual(edited.metadata({ ...base, requestedReviewers: ['maya'] }).requestedReviewers, ['maya', 'sam'], 'The later request wins; sam stays');
});

void test('removal accepts bots that are requested or assigned; adding them is still refused', async () => {
  const f = fixture();
  await f.service.edit(f.client, reviewers({ remove: ['dependabot[bot]'] }));
  await f.service.edit(f.client, { url, field: 'assignees', add: [], remove: ['copilot-swe-agent[bot]'] });
  assert.deepEqual(f.writes().map((c) => c.params.reviewers ?? c.params.assignees), [['dependabot[bot]'], ['copilot-swe-agent[bot]']]);
  assert.throws(() => validatePrPeopleEdit(reviewers({ add: ['dependabot[bot]'] })), /valid reviewers/);
});

void test('a label past the search’s first page is found by its exact name', async () => {
  const f = fixture();
  await f.service.edit(f.client, { url, field: 'labels', add: [{ name: 'zz-archived' }], remove: [] });
  assert.deepEqual(f.writes().map((c) => [c.method, c.params.labels]), [['issues.addLabels', ['zz-archived']]]);
});

void test('a partial edit is followed up like a successful write, with what GitHub took as the expectation', async () => {
  const f = fixture();
  f.failures.set('pulls.requestReviewers', fail('Reviews may only be requested from collaborators.'));
  await f.service.edit(f.client, reviewers({ add: ['outsider'], remove: ['sam'] }));
  assert.deepEqual(f.refreshes.map((r) => [r.action, r.failed ?? false, r.details.expect]), [
    ['edit-reviewers', false, { requestedReviewers: { add: [], remove: ['sam'] }, requestedTeams: { add: [], remove: [] } }],
  ]);
});

void test('a passing team list failure keeps the pages read and is tried again; a refusal is saved', async () => {
  const f = fixture({ teams: 150 });
  f.failures.set('repos.listTeams:page2', fail('Server Error', 502));
  const first = await f.service.candidates(f.client, { url, field: 'reviewers' });
  assert.equal(first.teams.length, 100, 'The first page stays');
  assert.equal(first.complete, false);
  assert.equal(first.teamsUnavailable, undefined);
  f.failures.clear();
  // Kept briefly (round 6): the next open after that reads again.
  f.tick(TRANSIENT_TTL_MS + 1);
  const second = await f.service.candidates(f.client, { url, field: 'reviewers' });
  assert.equal(second.teams.length, 150, 'Read again on the next open');
  assert.equal(second.complete, true);
});

void test('cached suggestions never leave a failed access read unhandled', async () => {
  const f = fixture();
  await f.service.candidates(f.client, { url, field: 'reviewers' });
  const unhandled: unknown[] = [];
  const listener = (reason: unknown) => unhandled.push(reason);
  process.on('unhandledRejection', listener);
  try {
    f.tick(PR_PEOPLE_ACCESS_TTL_MS + 1);
    const graphql = f.client.graphql.bind(f.client);
    Object.assign(f.client, {
      graphql: (q: string, p: Record<string, unknown>) => (/viewer\{login\}/.test(q) ? Promise.reject(fail('Bad gateway', 502)) : graphql(q, p)),
    });
    await assert.rejects(f.service.candidates(f.client, { url, field: 'reviewers' }), /Bad gateway/);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', listener);
  }
});

void test('an edit keeps the saved access current instead of reading it again', async () => {
  const f = fixture();
  await f.service.access(f.client, url);
  await f.service.edit(f.client, { url, field: 'labels', add: [{ name: 'docs' }], remove: [] });
  await f.service.edit(f.client, reviewers({ addTeams: [{ slug: 'team-1', name: 'Team 1' }], removeTeams: [{ slug: 'core', name: 'Core team' }] }));
  await f.service.edit(f.client, { url, field: 'milestone', milestone: { number: 3, title: 'v1', dueOn: null } });
  const access = await f.service.access(f.client, url);
  assert.equal(f.queries.filter((q) => q.kind === 'access').length, 1, 'No access read after the edits');
  assert.deepEqual(access.requestedTeams, [{ slug: 'team-1', name: 'Team 1' }]);
  assert.equal(access.milestone?.title, 'v1');
});

void test('labels are checked by name all at once', async () => {
  const f = fixture();
  let inFlight = 0;
  let most = 0;
  const getLabel = f.client.issues.getLabel.bind(f.client.issues);
  Object.assign(f.client.issues, {
    getLabel: async (p: Parameters<typeof getLabel>[0]) => {
      most = Math.max(most, ++inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return getLabel(p);
    },
  });
  await f.service.edit(f.client, { url, field: 'labels', add: [{ name: 'docs' }, { name: 'bug' }, { name: 'zz-archived' }], remove: [] });
  assert.equal(most, 3);
});

void test('after a passing team list failure, typing filters the pages read instead of reading teams again', async () => {
  const f = fixture({ teams: 150 });
  f.failures.set('repos.listTeams:page2', fail('Server Error', 502));
  await f.service.candidates(f.client, { url, field: 'reviewers' });
  const reads = () => f.calls.filter((c) => c.method === 'repos.listTeams').length;
  const first = reads();
  for (const query of ['t', 'te', 'tea', 'team 9']) await f.service.candidates(f.client, { url, field: 'reviewers', query });
  assert.equal(reads(), first, 'No team reads while typing');
  f.tick(TRANSIENT_TTL_MS + 1);
  f.failures.clear();
  const later = await f.service.candidates(f.client, { url, field: 'reviewers' });
  assert.equal(later.teams.length, 150, 'Read again soon after');
});

void test('forgetting access sends the next read to GitHub, as after a merge or close', async () => {
  const f = fixture();
  await f.service.access(f.client, url);
  f.service.forget(f.client, [url]);
  await f.service.access(f.client, url);
  assert.equal(f.queries.filter((q) => q.kind === 'access').length, 2);
});

void test('a palette command runs once after close, never after a later opening, and reports failures', async () => {
  const reports: string[] = [];
  const after = createAfterClose((message) => reports.push(message));
  let runs = 0;
  after.set(() => void runs++);
  after.clear();
  await after.run();
  assert.equal(runs, 0, 'Opening again drops the stale command');
  after.set(() => void runs++);
  await after.run();
  await after.run();
  assert.equal(runs, 1);
  after.set(() => Promise.reject(new Error('Picker unavailable')));
  await after.run();
  assert.deepEqual(reports, ['Picker unavailable']);
});

void test('both detail views show a milestone due date through the date-only formatter', async () => {
  const { readFileSync } = await import('node:fs');
  assert.match(readFileSync('components/ConversationSidebar.tsx', 'utf8'), /formatDueOn\(view\.milestone\.dueOn\)/);
  assert.match(readFileSync('components/PrDetails.tsx', 'utf8'), /formatDueOn\(meta\.milestone\.dueOn\)/);
});

void test('a command that runs after close waits while another palette action runs, like any command', () => {
  let busy = true;
  const ran: string[] = [];
  const set: string[] = [];
  let closed = 0;
  const runCommand = commandRunner({
    busy: () => busy,
    run: () => ran.push('run'),
    afterClose: { set: () => set.push('set') },
    close: () => closed++,
  });
  runCommand({ perform: () => undefined, afterClose: true });
  runCommand({ perform: () => undefined });
  assert.deepEqual([ran, set, closed], [[], [], 0], 'Nothing starts while busy');
  busy = false;
  runCommand({ perform: () => undefined, afterClose: true });
  runCommand({ perform: () => undefined });
  assert.deepEqual([ran, set, closed], [['run'], ['set'], 1]);
});
