import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createStarredPrStore } from '../src/starred-pr-store';
import { createWorkbenchService } from '../src/workbench-service';
import { groupSubjects, type ReviewMember, type QueueItem } from '../lib/workbench';
import { orderQueueItems } from '../lib/starred-prs';
import { DEFAULT_QUEUE_FILTERS, matchesQueueFilters } from '../lib/queue-filters';
import { DEFAULT_CLAUDE_MODEL } from '../lib/models';

function member(number: number): ReviewMember {
  return {
    number,
    repo: 'owner/repo',
    headRepo: 'owner/repo',
    baseRepo: 'owner/repo',
    url: `https://github.com/owner/repo/pull/${number}`,
    title: `PR ${number}`,
    description: 'A saved PR',
    author: 'author',
    role: 'watched',
    baseBranch: 'main',
    headBranch: `feature-${number}`,
    baseSha: 'base',
    headSha: `head-${number}`,
    merged: false,
    state: 'open',
    createdAt: '2026-10-22',
    updatedAt: '2026-10-22',
    labels: [],
    mergeable: null,
    isDraft: false,
    commitCount: 1,
    requestedReviewers: [],
    requestedTeams: [],
    mergeableState: null,
    autoMerge: null,
    milestone: null,
  };
}
function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gnosis-stars-'));
  return { directory, cleanup: () => fs.rmSync(directory, { recursive: true, force: true }) };
}
void test('stars persist independently of queue discovery, stay account scoped and are idempotent', () => {
  const f = fixture();
  try {
    const store = createStarredPrStore(
      () => f.directory,
      () => 1_000_000
    );
    store.set('Alice', { members: [member(1), member(2)], starred: true });
    store.set('alice', { members: [member(1)], starred: true });
    const restart = createStarredPrStore(() => f.directory);
    assert.equal(restart.load('ALICE').length, 2);
    assert.deepEqual(restart.load('bob'), []);
    const copy = restart.load('alice');
    copy[0].member.title = 'Changed outside store';
    assert.equal(restart.load('alice')[0].member.title, 'PR 1');
    restart.set('alice', { members: [member(1)], starred: false });
    assert.deepEqual(
      restart.load('alice').map((e) => e.member.number),
      [2]
    );
    assert.throws(() =>
      restart.set('alice', { members: [{ ...member(3), url: 'https://evil.example/3' }], starred: true })
    );
  } finally {
    f.cleanup();
  }
});
void test('failed writes leave the previous bookmark set intact', () => {
  const f = fixture();
  let directory = f.directory;
  try {
    const store = createStarredPrStore(() => directory);
    store.set('me', { members: [member(1)], starred: true });
    directory = path.join(f.directory, 'not-a-directory');
    fs.writeFileSync(directory, 'blocked');
    assert.throws(() => store.set('me', { members: [member(2)], starred: true }));
    assert.deepEqual(
      store.load('me').map((e) => e.member.number),
      [1]
    );
  } finally {
    f.cleanup();
  }
});
void test('starred PRs precede every attention category while keeping existing order within groups', () => {
  const items: QueueItem[] = groupSubjects([member(1), member(2), member(3), member(4)]).map((subject, i) => ({
    subject,
    attention: i === 0 ? 'updated' : i === 1 ? 'requested' : 'other',
    starred: i === 2 || i === 3,
  }));
  assert.deepEqual(
    orderQueueItems(items).map((i) => i.subject.members[0].number),
    [3, 4, 1, 2]
  );
});
void test('starring uses no GitHub reads, pins stacks and retains completed PRs after discovery drops them', () => {
  const f = fixture();
  try {
    const parent = { ...member(1), author: 'parent-author' },
      child = { ...member(2), baseBranch: parent.headBranch };
    const subjects = groupSubjects([parent, child, member(3)]);
    const state = { account: 'me', subjects, overrides: [], briefs: {}, day: '', used: 0 };
    fs.writeFileSync(path.join(f.directory, 'workbench.json'), JSON.stringify(state));
    const deps = {
      directory: () => f.directory,
      auth: () => ({ login: 'me', token: 'token' }),
      preferences: () => ({
        provider: 'claude' as const,
        model: DEFAULT_CLAUDE_MODEL,
        watchedRepos: [],
        autoBriefings: false,
        briefingDailyLimit: 0,
      }),
      history: () => [],
      busy: () => true,
      client: () => {
        throw Error('Unexpected GitHub request');
      },
    };
    const service = createWorkbenchService(deps);
    const result = service.starPrs({ members: [child], starred: true });
    assert.equal(result.items[0].subject.kind, 'stack');
    assert.equal(result.items[0].starred, true);
    assert.equal(result.starredItems?.length, 1);
    assert.deepEqual(result.items[0].starredUrls, [child.url]);
    const starredFilters = { ...DEFAULT_QUEUE_FILTERS, starredOnly: true };
    assert.equal(matchesQueueFilters(result.items[0], starredFilters), true);
    service.setFilters(starredFilters);
    const savedView = service.viewAction({ type: 'create', name: 'My starred PRs' });
    assert.equal(savedView.savedViews?.views[0].filters.starredOnly, true);
    assert.equal(Object.values(savedView.savedViews.counts)[0], 1);
    assert.equal(
      matchesQueueFilters(result.items[0], { ...starredFilters, author: 'parent-author' }),
      false,
      'One starred member must match all PR filters'
    );
    service.starPrs({ members: [parent], starred: true });
    service.updateStarredMetadata({ ...child, state: 'closed', merged: true });
    fs.writeFileSync(path.join(f.directory, 'workbench.json'), JSON.stringify({ ...state, subjects: [] }));
    const restarted = createWorkbenchService(deps);
    const retained = restarted.cached();
    assert.equal(retained.starredPrs?.length, 2);
    assert.equal(retained.starredItems?.length, 1, 'Retained stack members remain grouped');
    assert.equal(
      restarted.subject(retained.starredItems[0].subject.id)?.members.length,
      2,
      'Saved stacks remain available as a complete explanation subject'
    );
    const retainedChild = retained.starredItems[0].subject.members.find((m) => m.url === child.url);
    assert.equal(retainedChild?.merged, true);
    assert.equal(matchesQueueFilters(retained.starredItems[0], { ...starredFilters, query: 'PR 2' }), true);
    assert.equal(
      retained.starredItems[0].briefing?.status,
      'paused',
      'Archived bookmarks never queue automatic briefings'
    );
  } finally {
    f.cleanup();
  }
});
