import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createMutedPrStore } from '../src/muted-pr-store';
import { createWorkbenchService } from '../src/workbench-service';
import { groupSubjects, type ReviewMember } from '../lib/workbench';
import { isMutedReview } from '../lib/muted-prs';
import { snapshot } from '../lib/workbench';
import type { ReviewHistoryEntry } from '../lib/types';
import { createCommandSearchService } from '../src/command-search-service';
import { DEFAULT_QUEUE_FILTERS } from '../lib/queue-filters';
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
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gnosis-mutes-'));
  return { directory, cleanup: () => fs.rmSync(directory, { recursive: true, force: true }) };
}
void test('mutes persist independently of queue discovery, stay account scoped and are idempotent', () => {
  const f = fixture();
  try {
    const store = createMutedPrStore(
      () => f.directory,
      () => 1_000_000
    );
    store.set('Alice', { members: [member(1), member(2)], muted: true });
    store.set('alice', { members: [member(1)], muted: true });
    const restart = createMutedPrStore(() => f.directory);
    assert.equal(restart.load('ALICE').length, 2);
    assert.deepEqual(restart.load('bob'), []);
    const copy = restart.load('alice');
    copy[0].member.title = 'Changed outside store';
    assert.equal(restart.load('alice')[0].member.title, 'PR 1');
    restart.set('alice', { members: [member(1)], muted: false });
    assert.deepEqual(
      restart.load('alice').map((e) => e.member.number),
      [2]
    );
    assert.throws(() =>
      restart.set('alice', { members: [{ ...member(3), url: 'https://evil.example/3' }], muted: true })
    );
  } finally {
    f.cleanup();
  }
});
void test('failed writes leave the previous mute set intact', () => {
  const f = fixture();
  let directory = f.directory;
  try {
    const store = createMutedPrStore(() => directory);
    store.set('me', { members: [member(1)], muted: true });
    directory = path.join(f.directory, 'not-a-directory');
    fs.writeFileSync(directory, 'blocked');
    assert.throws(() => store.set('me', { members: [member(2)], muted: true }));
    assert.deepEqual(
      store.load('me').map((e) => e.member.number),
      [1]
    );
  } finally {
    f.cleanup();
  }
});

void test('muting projects stacks, hides saved reviews and stars, stops briefings and restores without network', () => {
  const f = fixture();
  try {
    const parent = member(1),
      child = { ...member(2), baseBranch: parent.headBranch },
      grandchild = { ...member(3), baseBranch: child.headBranch };
    const subjects = groupSubjects([parent, child, grandchild, member(4)]);
    const stack = subjects.find((s) => s.kind === 'stack');
    assert.ok(stack);
    const history: ReviewHistoryEntry[] = [
      {
        id: 'stack-review',
        prUrl: parent.url,
        prTitle: parent.title,
        author: parent.author,
        riskLevel: 'low',
        savedAt: new Date().toISOString(),
        status: 'completed',
        snapshot: snapshot(stack),
      },
    ];
    fs.writeFileSync(
      path.join(f.directory, 'workbench.json'),
      JSON.stringify({ account: 'me', subjects, overrides: [], briefs: {}, day: '', used: 0 })
    );
    let busy = true;
    const deps = {
      directory: () => f.directory,
      auth: () => ({ login: 'me', token: 'token' }),
      preferences: () => ({
        provider: 'claude' as const,
        model: DEFAULT_CLAUDE_MODEL,
        watchedRepos: [],
        autoBriefings: true,
        briefingDailyLimit: 10,
      }),
      history: () => history,
      busy: () => busy,
      client: () => {
        throw Error('Unexpected GitHub request');
      },
    };
    const service = createWorkbenchService(deps);
    service.starPrs({ members: [child], starred: true });
    service.setFilters(DEFAULT_QUEUE_FILTERS);
    const result = service.mutePrs({ members: [child], muted: true });
    const remaining = result.items.find((i) => i.subject.kind === 'stack');
    assert.ok(remaining);
    assert.deepEqual(
      remaining.subject.members.map((m) => m.number),
      [1, 3]
    );
    assert.equal(remaining.review, undefined, 'A shared saved explanation must not reveal a muted member');
    assert.equal(result.starredItems?.length, 0);
    assert.equal(result.mutedPrs?.length, 1);
    assert.ok(service.isMutedReview(history[0]));
    service.mutePrs({ members: [parent, grandchild], muted: true });
    assert.deepEqual(
      service.cached().items.flatMap((i) => i.subject.members.map((m) => m.number)),
      [4]
    );
    assert.ok(service.activity().every((task) => task.subjectId !== stack.id));
    assert.throws(() => service.retry(stack.id, true));
    service.mutePrs({ members: [member(4)], muted: true });
    busy = false;
    assert.deepEqual(service.activity(), [], 'No automatic jobs start for a fully muted queue');
    busy = true;
    service.mutePrs({ members: [member(4)], muted: false });
    const restart = createWorkbenchService(deps);
    assert.equal(restart.cached().mutedPrs?.length, 3);
    const restored = restart.mutePrs({ members: [parent, child, grandchild], muted: false });
    assert.equal(restored.items.find((i) => i.subject.kind === 'stack')?.subject.members.length, 3);
    assert.equal(restored.starredItems?.length, 1, 'Unmuting restores existing bookmarks');
    assert.equal(isMutedReview(history[0], restart.mutedUrls()), false);
    assert.equal(restored.items.find((i) => i.subject.kind === 'stack')?.review?.id, 'stack-review');
  } finally {
    f.cleanup();
  }
});
void test('search removes muted saved content and recents immediately, even with a warm index', async () => {
  const f = fixture();
  try {
    const pr = member(1);
    const subject = groupSubjects([pr])[0];
    const history: ReviewHistoryEntry[] = [
      {
        id: 'saved',
        prUrl: pr.url,
        prTitle: pr.title,
        author: pr.author,
        riskLevel: 'low',
        savedAt: new Date().toISOString(),
        status: 'completed',
        snapshot: snapshot(subject),
      },
    ];
    fs.writeFileSync(
      path.join(f.directory, 'saved.json'),
      JSON.stringify({
        prUrl: pr.url,
        prTitle: pr.title,
        prDescription: 'Needle description',
        author: pr.author,
        summary: 'Needle summary',
        slides: [],
        snapshot: snapshot(subject),
      })
    );
    const muted = new Set<string>();
    const search = createCommandSearchService({
      directory: () => f.directory,
      queue: () => ({ items: [{ subject, attention: 'other' }], warnings: [], remaining: 0 }),
      history: () => history,
      account: () => 'me',
      ignoreBots: () => false,
      mutedUrls: () => muted,
      threads: () => undefined,
    });
    const before = await search.search('Needle');
    assert.ok(before.hits.length);
    muted.add(pr.url);
    assert.equal((await search.search('Needle')).hits.length, 0);
    assert.equal((await search.search('PR 1')).hits.length, 0);
    assert.ok(
      (
        await search.search(
          '',
          false,
          before.hits.map((hit) => hit.document.id)
        )
      ).hits.every((hit) => hit.document.kind === 'repository')
    );
    muted.clear();
    assert.ok((await search.search('Needle')).hits.length);
  } finally {
    f.cleanup();
  }
});
