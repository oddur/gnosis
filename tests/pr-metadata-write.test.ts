/* eslint-disable @typescript-eslint/require-await -- Async API test doubles. */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { Octokit } from '@octokit/rest';
import {
  createPrMetadataWriteService,
  prPeopleChange,
  validatePrPeopleEdit,
  PR_PEOPLE_ACCESS_TTL_MS,
  PR_PEOPLE_CANDIDATES_TTL_MS,
} from '../src/pr-metadata-write-service';
import { createOptimisticService } from '../src/optimistic-service';
import { GITHUB_WRITE_EFFECTS, type GitHubWriteAction, type WriteDetails } from '../lib/github-write-refresh';
import { createOptimisticLayer, failureTitle } from '../lib/optimistic-patches';
import { diffSelection, editList, metadataShows, prPeopleGate, type PrPeopleEdit } from '../lib/pr-people';
import type { PrMetadata } from '../lib/types';

const url = 'https://github.com/klang/engine/pull/7';

/** A synthetic GitHub: one PR, its repository's people, teams, labels and milestones. Records every request. */
function fixture(options: { permission?: string; archived?: boolean; owner?: string; users?: number } = {}) {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const queries: Record<string, unknown>[] = [];
  const failures = new Map<string, Error & { status?: number }>();
  const people = Array.from({ length: options.users ?? 4 }, (_, i) => ({ login: `dev-${i + 1}`, name: `Dev ${i + 1}`, avatarUrl: '' }));
  people.unshift({ login: 'lena', name: 'Lena', avatarUrl: '' });
  const call = (method: string, result: unknown = {}) =>
    async (params: Record<string, unknown>) => {
      calls.push({ method, params });
      const failure = failures.get(method);
      if (failure) throw failure;
      return { data: typeof result === 'function' ? (result as (p: Record<string, unknown>) => unknown)(params) : result };
    };
  const client = {
    graphql: async (query: string, params: Record<string, unknown>) => {
      queries.push({ ...params, kind: /assignableUsers/.test(query) ? 'users' : /labels\(/.test(query) ? 'labels' : /milestones\(/.test(query) ? 'milestones' : 'access' });
      if (/assignableUsers/.test(query)) {
        const q = typeof params.q === 'string' ? params.q.toLowerCase() : '';
        const matches = people.filter((p) => !q || p.login.includes(q) || p.name.toLowerCase().includes(q));
        const first = params.first as number;
        return { repository: { assignableUsers: { pageInfo: { hasNextPage: matches.length > first }, nodes: matches.slice(0, first) } } };
      }
      if (/labels\(/.test(query))
        return { repository: { labels: { pageInfo: { hasNextPage: false }, nodes: [{ name: 'bug', color: 'd73a4a', description: null }, { name: 'docs', color: '0075ca', description: 'Docs' }] } } };
      if (/milestones\(/.test(query))
        return { repository: { milestones: { pageInfo: { hasNextPage: false }, nodes: [{ number: 3, title: 'v1', dueOn: null }] } } };
      return {
        viewer: { login: 'oddur' },
        repository: {
          isArchived: options.archived ?? false,
          viewerPermission: options.permission ?? 'WRITE',
          owner: { __typename: options.owner ?? 'Organization', login: 'klang' },
          pullRequest: {
            author: { login: 'lena' },
            milestone: null,
            reviewRequests: { nodes: [{ requestedReviewer: { __typename: 'Team', slug: 'core', name: 'Core team' } }, { requestedReviewer: { __typename: 'User', login: 'sam' } }] },
            suggestedReviewers: [{ reviewer: { login: 'lena', name: 'Lena', avatarUrl: '' } }, { reviewer: { login: 'owen', name: null, avatarUrl: 'a' } }],
          },
        },
      };
    },
    pulls: {
      requestReviewers: call('pulls.requestReviewers'),
      removeRequestedReviewers: call('pulls.removeRequestedReviewers'),
    },
    issues: {
      addAssignees: call('issues.addAssignees', (p: Record<string, unknown>) => ({ assignees: (p.assignees as string[]).filter((l) => l !== 'ghost').map((login) => ({ login })) })),
      removeAssignees: call('issues.removeAssignees'),
      addLabels: call('issues.addLabels'),
      removeLabel: call('issues.removeLabel'),
      update: call('issues.update'),
    },
    repos: { listTeams: call('repos.listTeams', [{ slug: 'core', name: 'Core team' }, { slug: 'release', name: 'Release crew' }]) },
  } as unknown as Octokit;

  // Main's optimistic layer over one PR copy, and the write refresh as a recorder.
  const metadata: PrMetadata = {
    url, title: 'Fix', description: '', author: 'lena', assignees: ['lena'], baseBranch: 'main', headBranch: 'fix', baseSha: 'b', headSha: 'h',
    merged: false, state: 'open', createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z', labels: ['bug'],
    labelDetails: [{ name: 'bug', color: 'd73a4a' }], mergeable: true, isDraft: false, commitCount: 1, requestedReviewers: ['sam'],
    requestedTeams: ['Core team'], mergeableState: 'clean', autoMerge: null, milestone: null,
  };
  const published: string[] = [];
  const optimistic = createOptimisticService({ viewer: () => ({ login: 'oddur', avatarUrl: '' }), before: () => ({}), changed: (_u, kinds) => published.push(kinds.join('+')) });
  const shownDuringWrite: PrMetadata[] = [];
  const refreshes: { action: GitHubWriteAction; urls: string[]; details: Omit<WriteDetails, 'before'>; failed?: boolean }[] = [];
  let clock = 1_000;
  const service = createPrMetadataWriteService({
    now: () => clock,
    optimistic: (u, change, write) =>
      optimistic.run(u, change, async () => {
        shownDuringWrite.push(optimistic.metadata(metadata));
        return write();
      }),
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
    writes: () => calls.filter((c) => !c.method.startsWith('repos.')),
  };
}
const reviewers = (edit: Partial<Extract<PrPeopleEdit, { field: 'reviewers' }>>): PrPeopleEdit => ({
  url, field: 'reviewers', add: [], remove: [], addTeams: [], removeTeams: [], ...edit,
});

void test('the permission gate: triage or more, never on an archived repository', () => {
  for (const permission of ['TRIAGE', 'WRITE', 'MAINTAIN', 'ADMIN']) assert.equal(prPeopleGate({ permission, archived: false, repo: 'o/r' }).canEdit, true);
  for (const permission of ['READ', null]) {
    const gate = prPeopleGate({ permission, archived: false, repo: 'o/r' });
    assert.equal(gate.canEdit, false);
    assert.match(gate.reason ?? '', /triage or write access to o\/r/);
  }
  assert.match(prPeopleGate({ permission: 'ADMIN', archived: true, repo: 'o/r' }).reason ?? '', /archived/);
});

void test('access names the author, team slugs and suggestions without the author', async () => {
  const f = fixture();
  const access = await f.service.access(f.client, url);
  assert.equal(access.canEdit, true);
  assert.equal(access.author, 'lena');
  assert.equal(access.viewer, 'oddur');
  assert.deepEqual(access.requestedTeams, [{ slug: 'core', name: 'Core team' }]);
  assert.deepEqual(access.suggestedReviewers.map((p) => p.login), ['owen'], 'GitHub refuses a request from the author');
  await f.service.access(f.client, url);
  assert.equal(f.queries.length, 1, 'Saved for a minute');
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
  await f.service.edit(f.client, reviewers({ add: ['dev-1'], remove: ['sam'], addTeams: [{ slug: 'release', name: 'Release crew' }], removeTeams: [{ slug: 'core', name: 'Core team' }] }));
  assert.deepEqual(f.writes(), [
    { method: 'pulls.requestReviewers', params: { owner: 'klang', repo: 'engine', pull_number: 7, reviewers: ['dev-1'], team_reviewers: ['release'] } },
    { method: 'pulls.removeRequestedReviewers', params: { owner: 'klang', repo: 'engine', pull_number: 7, reviewers: ['sam'], team_reviewers: ['core'] } },
  ]);
  const shown = f.shownDuringWrite[0];
  assert.deepEqual(shown.requestedReviewers, ['dev-1']);
  assert.deepEqual(shown.requestedTeams, ['Release crew'], 'Teams show by name, as PR copies hold them');
  assert.equal(f.refreshes[0].action, 'edit-reviewers');
  assert.deepEqual(f.refreshes[0].details.expect, {
    requestedReviewers: { add: ['dev-1'], remove: ['sam'] },
    requestedTeams: { add: ['Release crew'], remove: ['Core team'] },
  });
  // Confirmed: still shown until a fresh read shows it.
  assert.deepEqual(f.optimistic.metadata(f.metadata).requestedReviewers, ['dev-1']);
  f.optimistic.observe(url, 'metadata', { ...f.metadata, requestedReviewers: ['dev-1'], requestedTeams: ['Release crew'] });
  f.optimistic.observe(url, 'discussion', { headSha: 'h', baseSha: 'b', threads: [], feedback: { comments: [], reviews: [], requestedReviewers: ['dev-1'], viewerCanUpdate: true, state: 'OPEN' } });
  assert.equal(f.optimistic.layer.list().length, 0, 'GitHub shows it everywhere: the patch is cleared');
});

void test('re-requesting a review from someone who already reviewed is one request', async () => {
  const f = fixture();
  await f.service.edit(f.client, reviewers({ add: ['maya'] }));
  assert.deepEqual(f.writes().map((c) => [c.method, c.params.reviewers]), [['pulls.requestReviewers', ['maya']]]);
});

void test('GitHub refuses a review request from the author', async () => {
  const f = fixture();
  await assert.rejects(f.service.edit(f.client, reviewers({ add: ['Lena'] })), /author/);
  assert.deepEqual(f.writes(), []);
});

void test('a refused write rolls the change back and still reads the PR again', async () => {
  const f = fixture();
  f.failures.set('issues.addLabels', Object.assign(new Error('Validation Failed'), { status: 422 }));
  await assert.rejects(f.service.edit(f.client, { url, field: 'labels', add: [{ name: 'docs', color: '0075ca' }], remove: ['bug'] }), /Validation Failed/);
  assert.deepEqual(f.shownDuringWrite[0].labels, ['docs'], 'Shown at once');
  assert.deepEqual(f.shownDuringWrite[0].labelDetails, [{ name: 'docs', color: '0075ca' }], 'With its color');
  assert.deepEqual(f.optimistic.metadata(f.metadata).labels, ['bug'], 'Rolled back');
  assert.equal(f.optimistic.layer.list().length, 0);
  assert.deepEqual(f.refreshes.map((r) => [r.action, r.failed]), [['edit-labels', true]]);
  assert.deepEqual(f.published, ['metadata', 'metadata'], 'Every window saw the change and its rollback');
  assert.equal(failureTitle('edit-labels'), 'Labels weren’t changed.');
});

void test('labels: add in one request, remove one by one, a label already gone is fine', async () => {
  const f = fixture();
  f.failures.set('issues.removeLabel', Object.assign(new Error('Label does not exist'), { status: 404 }));
  await f.service.edit(f.client, { url, field: 'labels', add: [{ name: 'docs' }], remove: ['bug'] });
  assert.deepEqual(f.writes().map((c) => [c.method, c.params.labels ?? c.params.name]), [['issues.addLabels', ['docs']], ['issues.removeLabel', 'bug']]);
  assert.deepEqual(f.refreshes[0].details.expect, { labels: { add: ['docs'], remove: ['bug'] } });
});

void test('assignees: GitHub skipping someone counts as a failure', async () => {
  const f = fixture();
  await f.service.edit(f.client, { url, field: 'assignees', add: ['dev-1'], remove: ['lena'] });
  assert.deepEqual(f.writes().map((c) => [c.method, c.params.assignees, c.params.issue_number]), [['issues.addAssignees', ['dev-1'], 7], ['issues.removeAssignees', ['lena'], 7]]);
  assert.deepEqual(f.shownDuringWrite[0].assignees, ['dev-1']);
  const g = fixture();
  await assert.rejects(g.service.edit(g.client, { url, field: 'assignees', add: ['ghost'], remove: [] }), /didn’t assign ghost/);
  assert.deepEqual(g.optimistic.metadata(g.metadata).assignees, ['lena'], 'Rolled back');
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
  assert.throws(() => validatePrPeopleEdit({ url: 'https://example.com/pull/1', field: 'labels', add: [], remove: [] }), /Choose a GitHub PR/);
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

void test('reviewer candidates leave out the author and show teams as teams', async () => {
  const f = fixture();
  const list = await f.service.candidates(f.client, { url, field: 'reviewers' });
  assert.ok(!list.users.some((u) => u.login === 'lena'));
  assert.deepEqual(list.teams, [{ slug: 'core', name: 'Core team' }, { slug: 'release', name: 'Release crew' }]);
  const personal = fixture({ owner: 'User' });
  const mine = await personal.service.candidates(personal.client, { url, field: 'reviewers' });
  assert.deepEqual(mine.teams, []);
  assert.ok(!personal.calls.some((c) => c.method === 'repos.listTeams'), 'A personal repository has no teams to read');
  const hidden = fixture();
  hidden.failures.set('repos.listTeams', Object.assign(new Error('Resource not accessible'), { status: 403 }));
  const people = await hidden.service.candidates(hidden.client, { url, field: 'reviewers' });
  assert.equal(people.teamsUnavailable, true);
  assert.ok(people.users.length > 0, 'People still load without teams');
  const labels = await f.service.candidates(f.client, { url, field: 'labels', query: 'doc' });
  assert.deepEqual(labels.labels, [{ name: 'docs', color: '0075ca', description: 'Docs' }]);
});

void test('write refresh: what each edit makes stale, and when GitHub shows it', () => {
  assert.deepEqual(GITHUB_WRITE_EFFECTS['edit-reviewers'].kinds, ['metadata', 'signals', 'discussion']);
  assert.equal(GITHUB_WRITE_EFFECTS['edit-reviewers'].queue, true, 'A review request moves the PR between sections');
  for (const action of ['edit-assignees', 'edit-labels', 'edit-milestone'] as const) {
    assert.deepEqual(GITHUB_WRITE_EFFECTS[action].kinds, ['metadata']);
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

void test('optimistic edits stack: a second edit applies over the first, and each rolls back alone', () => {
  const layer = createOptimisticLayer({ id: (() => { let n = 0; return () => String(++n); })() });
  const base = { url, labels: ['bug'], labelDetails: [{ name: 'bug', color: 'd73a4a' }], requestedReviewers: [], isDraft: false, autoMerge: null } as unknown as PrMetadata;
  const viewer = { login: 'oddur', avatarUrl: '' };
  const one = layer.begin({ url, viewer, change: prPeopleChange({ url, field: 'labels', add: [{ name: 'docs' }], remove: [] }) });
  layer.begin({ url, viewer, change: prPeopleChange({ url, field: 'labels', add: [], remove: ['bug'] }) });
  assert.deepEqual(layer.metadata(base).labels, ['docs']);
  layer.fail(one.id);
  assert.deepEqual(layer.metadata(base).labels, []);
  assert.deepEqual(editList(['a', 'B'], ['b', 'c'], ['a']), ['B', 'c']);
  assert.deepEqual(diffSelection(['a', 'b'], ['b', 'c']), { add: ['c'], remove: ['a'] });
});
