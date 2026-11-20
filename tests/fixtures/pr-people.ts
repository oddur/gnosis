import { createOptimisticService } from '../../src/optimistic-service';
import { sameLogin as same } from '../../lib/github-actors';
import { editList, matchesQuery, prPeopleChange, prPeopleGate, type PrPeopleCandidateRequest, type PrPeopleCandidates, type PrPeopleEdit, type PrPeopleEditResult } from '../../lib/pr-people';
import type { GitHubSyncInterest, GitHubSyncUpdate } from '../../lib/github-sync';
import type { GitHubWriteEvent } from '../../lib/github-write-refresh';
import type { GitHubReviewThreads } from '../../lib/review-threads';
import type { PrLabel, PrStatus } from '../../lib/types';
import type { QueueItem, ReviewMember, WorkbenchQueue } from '../../lib/workbench';

/**
 * Reviewers, assignees, labels and the milestone (tests/pr-people-labels-browser.ts). Main's real optimistic layer
 * stands in for main; a synthetic GitHub holds the PR, the repository's people, teams, labels and milestones, and its
 * writes wait until the test settles them. `?pr-people-readonly` signs in with read access only; `?pr-people-access-fail`
 * fails the first access read. Nothing reaches GitHub.
 */
export function installPrPeopleFixture(mocks: Record<string, unknown>, items: QueueItem[]) {
  const sync = (
    window as unknown as {
      syncFixture: { emit: (update: GitHubSyncUpdate) => void; changed: () => void; subscriptions: Map<string, GitHubSyncInterest> };
    }
  ).syncFixture;
  const members = () => items.flatMap((item) => item.subject.members);
  const found = members().find((m) => m.title.includes('Fix reconnect'));
  if (!found) throw Error('The PR people fixture needs the Fix reconnect PR');
  const target: ReviewMember = found;
  const url = target.url;
  const readOnly = new URLSearchParams(location.search).has('pr-people-readonly');
  let accessFailures = new URLSearchParams(location.search).has('pr-people-access-fail') ? 1 : 0;
  /** Typed queries GitHub refuses until the test clears them. */
  const failingQueries = new Set<string>();
  const stamp = '2026-11-18T09:00:00Z';
  // The PR on GitHub. A successful write changes it; the page sees it on `refresh`, like the read after a write.
  target.requestedReviewers = ['sam'];
  target.requestedTeams = ['Platform reviewers'];
  target.assignees = ['lena'];
  target.labels = ['bug'];
  target.labelDetails = [{ name: 'bug', color: 'd73a4a', description: 'Something isn’t working' }];
  target.milestone = null;
  const github: Pick<ReviewMember, 'requestedReviewers' | 'requestedTeams' | 'labels' | 'milestone'> & {
    assignees: string[];
    labelDetails: PrLabel[];
  } = structuredClone({
    requestedReviewers: target.requestedReviewers,
    requestedTeams: target.requestedTeams,
    assignees: target.assignees ?? [],
    labels: target.labels,
    labelDetails: target.labelDetails ?? [],
    milestone: target.milestone,
  });
  const by = (login: string) => ({ login, avatarUrl: '' });
  const discussion = (): GitHubReviewThreads => ({
    headSha: target.headSha,
    baseSha: target.baseSha,
    checkedAt: Date.now(),
    threads: [],
    feedback: {
      comments: [],
      // maya approved earlier: picking her, or her row's button, asks her to review again.
      reviews: [
        { id: 'r-maya', body: 'Looks good.', createdAt: stamp, updatedAt: stamp, url: `${url}#r-maya`, author: by('maya'), state: 'APPROVED', submittedAt: stamp },
        // A bot's review: GitHub takes no review request from it, so it is never offered one.
        { id: 'r-bot', body: 'Coverage unchanged.', createdAt: stamp, updatedAt: stamp, url: `${url}#r-bot`, author: { login: 'coverage-app', avatarUrl: '', __typename: 'Bot' }, state: 'COMMENTED', submittedAt: stamp },
      ],
      requestedReviewers: [...github.requestedReviewers],
      viewerCanUpdate: true,
      state: 'OPEN',
    },
  });

  // The repository's people: more than one page, so a typed query asks GitHub.
  const people = [
    { login: 'lena', name: 'Lena Berg' },
    { login: 'maya', name: 'Maya Chen' },
    { login: 'sam', name: 'Sam Ortiz' },
    { login: 'owen', name: 'Owen Hart' },
    { login: 'oddur', name: 'Oddur Sigurdsson' },
    ...Array.from({ length: 60 }, (_, i) => ({ login: `dev-${String(i + 1).padStart(2, '0')}`, name: `Developer ${i + 1}` })),
    { login: 'zelda-ops', name: 'Zelda Park' },
  ].map((person) => ({ ...person, avatarUrl: '' }));
  const teams = [
    { slug: 'platform-reviewers', name: 'Platform reviewers' },
    { slug: 'release-crew', name: 'Release crew' },
  ];
  const labels = [
    { name: 'bug', color: 'd73a4a', description: 'Something isn’t working' },
    { name: 'documentation', color: '0075ca', description: 'Improvements or additions to documentation' },
    { name: 'needs-review', color: 'fbca04' },
    { name: 'performance', color: '0052cc', description: 'Makes something faster' },
    { name: 'transport', color: 'c5def5' },
  ];
  const milestones = [
    // As GitHub stores them: current milestones at midnight UTC, older ones at local midnight (here US Pacific).
    { number: 3, title: 'v0.42', dueOn: '2026-12-01T00:00:00Z' },
    { number: 4, title: 'v0.43', dueOn: '2026-12-15T08:00:00Z' },
    { number: 5, title: 'Backlog', dueOn: null },
  ];
  const record = { access: 0, candidates: [] as string[], edits: [] as PrPeopleEdit[], settled: [] as string[], results: [] as PrPeopleEditResult[] };
  const held: { edit: PrPeopleEdit; settle: (outcome: string) => void }[] = [];
  const refreshed = new Set<(event: GitHubWriteEvent) => void>();

  const service = createOptimisticService({
    viewer: () => ({ login: 'oddur', avatarUrl: '' }),
    before: () => ({}),
    changed: (prUrl, kinds) => publish(prUrl, kinds),
  });
  const discussionListeners = new Set<(event: { url: string; discussion: GitHubReviewThreads }) => void>();
  /** Main's push after a patch begins, confirms or rolls back. */
  function publish(prUrl: string, kinds: string[]) {
    if (prUrl !== url) return;
    if (kinds.includes('discussion')) {
      const value = service.discussion(url, discussion());
      discussionListeners.forEach((listener) => listener({ url, discussion: value }));
    }
    if (kinds.includes('metadata')) sync.emit({ kind: 'metadata', url, value: service.metadata({ ...target }) });
    sync.changed();
  }
  /** GitHub's copy after a successful edit. */
  function onGitHub(edit: PrPeopleEdit) {
    switch (edit.field) {
      case 'reviewers':
        github.requestedReviewers = editList(github.requestedReviewers, edit.add, edit.remove);
        github.requestedTeams = editList(github.requestedTeams, edit.addTeams.map((t) => t.name), edit.removeTeams.map((t) => t.name));
        break;
      case 'assignees':
        github.assignees = editList(github.assignees, edit.add, edit.remove);
        break;
      case 'labels':
        github.labels = editList(github.labels, edit.add.map((l) => l.name), edit.remove);
        github.labelDetails = github.labels.map((name) => [...labels, ...edit.add].find((l) => same(l.name, name)) ?? { name });
        break;
      case 'milestone':
        github.milestone = edit.milestone && { title: edit.milestone.title, dueOn: edit.milestone.dueOn };
        break;
    }
  }

  const readQueue = mocks.workbenchQueue as () => Promise<WorkbenchQueue>;
  const overlay = async (read: Promise<WorkbenchQueue>) => {
    const queue = await read;
    return {
      ...queue,
      items: queue.items.map((item) => ({
        ...item,
        subject: { ...item.subject, members: item.subject.members.map((m) => service.metadata(m)) },
      })),
    };
  };
  const readStatus = mocks.getPrStatus as (prUrl: string, ...rest: unknown[]) => Promise<PrStatus | null>;
  const page = <T>(list: T[], query: string, text: (item: T) => (string | undefined)[], size: number) => {
    const matches = list.filter((item) => matchesQuery(query, ...text(item)));
    return { items: matches.slice(0, size), complete: matches.length <= size };
  };
  Object.assign(mocks, {
    workbenchQueue: () => overlay(readQueue()),
    workbenchSnapshot: () => overlay(readQueue()),
    getPrStatus: async (prUrl: string, ...rest: unknown[]) => {
      const status = await readStatus(prUrl, ...rest);
      if (!status || prUrl !== url) return status;
      return service.status(url, {
        ...status,
        requestedReviewers: target.requestedReviewers,
        requestedTeams: target.requestedTeams,
        labels: target.labels,
        milestone: target.milestone,
      });
    },
    onGitHubOptimistic: (callback: (event: { url: string; discussion: GitHubReviewThreads }) => void) => {
      discussionListeners.add(callback);
      return () => discussionListeners.delete(callback);
    },
    getCachedReviewThreads: (prUrl: string) => Promise.resolve(prUrl === url ? service.discussion(url, discussion()) : undefined),
    getReviewThreads: (prUrl: string) => {
      if (prUrl !== url) return Promise.resolve({ headSha: '', baseSha: '', threads: [] });
      const data = discussion();
      service.observe(url, 'discussion', data);
      return Promise.resolve(service.discussion(url, data));
    },
    onGitHubWriteRefreshed: (callback: (event: GitHubWriteEvent) => void) => {
      refreshed.add(callback);
      return () => refreshed.delete(callback);
    },
    getPrPeopleAccess: (prUrl: string) => {
      record.access++;
      if (accessFailures > 0) {
        accessFailures--;
        return Promise.reject(new Error('GitHub is not responding.'));
      }
      const permission = readOnly ? 'READ' : 'WRITE';
      return Promise.resolve({
        url: prUrl,
        permission,
        ...prPeopleGate({ permission, archived: false, repo: 'klang/engine', open: target.state === 'open' && !target.merged }),
        author: target.author,
        viewer: 'oddur',
        organization: true,
        requestedTeams: teams.filter((team) => github.requestedTeams.some((name) => same(name, team.name))),
        milestone: milestones.find((m) => same(m.title, github.milestone?.title)) ?? null,
        checkedAt: Date.now(),
      });
    },
    getPrPeopleCandidates: (request: PrPeopleCandidateRequest): Promise<PrPeopleCandidates> => {
      const query = request.query ?? '';
      record.candidates.push(`${request.field}:${query}`);
      if (failingQueries.has(query)) return Promise.reject(new Error('Search is temporarily unavailable.'));
      const empty = { field: request.field, query, users: [], teams: [], labels: [], milestones: [], suggested: [], complete: true };
      const users = page(people, query, (p) => [p.login, p.name], 50);
      switch (request.field) {
        case 'reviewers':
          return Promise.resolve({
            ...empty,
            users: users.items.filter((p) => !same(p.login, target.author)),
            teams: teams.filter((t) => matchesQuery(query, t.name, t.slug)),
            suggested: query ? [] : [{ login: 'owen', name: 'Owen Hart', avatarUrl: '' }],
            complete: users.complete,
          });
        case 'assignees':
          return Promise.resolve({ ...empty, users: users.items, complete: users.complete });
        case 'labels':
          return Promise.resolve({ ...empty, labels: labels.filter((l) => matchesQuery(query, l.name, l.description)) });
        case 'milestone':
          return Promise.resolve({ ...empty, milestones: milestones.filter((m) => matchesQuery(query, m.title)) });
      }
    },
    editPrPeople: async (edit: PrPeopleEdit): Promise<PrPeopleEditResult> => {
      record.edits.push(structuredClone(edit));
      if (readOnly) throw new Error('You need triage or write access to klang/engine.');
      // Like main: a write GitHub took in part rolls back, then the part it took is shown again.
      let partial: Extract<PrPeopleEditResult, { status: 'partial' }> | undefined;
      try {
        await service.run(
          url,
          prPeopleChange(edit),
          () =>
            new Promise<void>((resolve, reject) => {
              held.push({
                edit,
                settle: (outcome) => {
                  record.settled.push(`${edit.field}:${outcome === 'ok' ? 'ok' : outcome === 'partial' ? 'partial' : 'failed'}`);
                  if (outcome === 'ok') {
                    onGitHub(edit);
                    resolve();
                  } else if (outcome === 'partial' && edit.field === 'reviewers') {
                    // GitHub took the additions and refused the removals.
                    const applied: PrPeopleEdit = { ...edit, remove: [], removeTeams: [] };
                    onGitHub(applied);
                    partial = { status: 'partial', applied, remaining: { ...edit, add: [], addTeams: [] }, error: 'Reviews may only be removed by a maintainer.' };
                    reject(new Error(partial.error));
                  } else reject(new Error(outcome));
                },
              });
            })
        );
      } catch (error) {
        if (!partial) throw error;
        await service.run(url, prPeopleChange(partial.applied), () => Promise.resolve());
        record.results.push(partial);
        return partial;
      }
      record.results.push({ status: 'done' });
      return { status: 'done' };
    },
  });
  Object.assign(window, {
    prPeopleFixture: {
      url,
      record,
      github: () => structuredClone(github),
      held: () => held.map((write) => write.edit.field),
      /** Answers the oldest write: `ok`, or GitHub's error message. */
      settle: (outcome = 'ok') => {
        const next = held.shift();
        if (!next) throw Error('No write is waiting');
        next.settle(outcome);
      },
      /** The read after a write: GitHub's copy reaches the page and clears the patches it shows. */
      /** The PR is closed on GitHub, and main reads it again, as after Close or a change seen on GitHub. */
      close: () => {
        target.state = 'closed';
        target.updatedAt = new Date(Date.parse(target.updatedAt) + 60_000).toISOString();
        publish(url, ['metadata']);
        refreshed.forEach((listener) => listener({ action: 'close-pr', urls: [url], phase: 'settled' }));
      },
      refresh: () => {
        Object.assign(target, structuredClone(github));
        service.observe(url, 'metadata', target);
        service.observe(url, 'discussion', discussion());
        publish(url, ['discussion', 'metadata']);
        refreshed.forEach((listener) => listener({ action: 'edit-labels', urls: [url], phase: 'settled' }));
      },
      patches: () => service.layer.list().map((patch) => `${patch.change.action}:${patch.status}`),
      failSearch: (query: string) => failingQueries.add(query),
      clearSearchFailures: () => failingQueries.clear(),
    },
  });
}
