import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { createMutedPrStore } from '../src/muted-pr-store';
import { createAppDataStore, createMemoryStorage, type StateStorage } from '../src/app-data-store';
import { createWorkbenchService } from '../src/workbench-service';
import { groupSubjects, type ReviewMember } from '../lib/workbench';
import { isMutedReview } from '../lib/muted-prs';
import { snapshot } from '../lib/workbench';
import type { ReviewHistoryEntry } from '../lib/types';
import { localCommandSearch } from './fixtures/search-backend';
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
    const saved = new Map<string, string>();
    const store = createMutedPrStore(createMemoryStorage(saved), () => 1_000_000);
    store.set('Alice', { members: [member(1), member(2)], muted: true });
    store.set('alice', { members: [member(1)], muted: true });
    const restart = createMutedPrStore(createMemoryStorage(saved));
    assert.equal(restart.index('ALICE').rows.length, 2);
    assert.deepEqual(restart.index('bob').rows, []);
    const shared = restart.index('alice').rows;
    assert.throws(() => {
      (shared[0].member as { title: string }).title = 'Changed outside store';
    }, TypeError);
    assert.equal(restart.index('alice').rows[0].member.title, 'PR 1');
    restart.set('alice', { muted: false, urls: [member(1).url] });
    assert.deepEqual(
      restart.index('alice').rows.map((e) => e.member.number),
      [2]
    );
    assert.throws(() =>
      restart.set('alice', { members: [{ ...member(3), url: 'https://evil.example/3' }], muted: true })
    );
  } finally {
    f.cleanup();
  }
});
void test('a rejected change leaves the previous mute set intact', () => {
  let blocked = false;
  const memory = createMemoryStorage();
  const storage: StateStorage = {
    ...memory,
    patch: (name, change) => {
      if (blocked) throw new Error('Saved work is still loading');
      memory.patch(name, change);
    },
  };
  const store = createMutedPrStore(storage);
  store.set('me', { members: [member(1)], muted: true });
  blocked = true;
  assert.throws(() => store.set('me', { members: [member(2)], muted: true }));
  assert.deepEqual(
    store.index('me').rows.map((e) => e.member.number),
    [1]
  );
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
    const saved = new Map([
      ['workbench:me', JSON.stringify({ account: 'me', subjects, overrides: [], briefs: {}, day: '', used: 0 })],
    ]);
    let busy = true;
    const deps = {
      directory: () => f.directory,
      // Each service reads the saved stores afresh, as after a restart.
      get storage() {
        return createMemoryStorage(saved);
      },
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
    service.mutePrs({ muted: false, urls: [member(4).url] });
    const restart = createWorkbenchService(deps);
    assert.equal(restart.cached().mutedPrs?.length, 3);
    const restored = restart.mutePrs({ muted: false, urls: [parent, child, grandchild].map((m) => m.url) });
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
    const search = localCommandSearch({
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
void test('rows carry summary fields only', () => {
  const f = fixture();
  try {
    const store = createMutedPrStore(createMemoryStorage(), () => 1_000_000);
    store.set('me', { muted: true, members: [{ ...member(1), description: 'x'.repeat(10_000) }] });
    const [row] = store.index('me').rows;
    assert.deepEqual(Object.keys(row.member).sort(), [
      'author',
      'isDraft',
      'merged',
      'number',
      'repo',
      'state',
      'title',
      'url',
    ]);
    assert.ok(Object.isFrozen(row) && Object.isFrozen(row.member));
    assert.equal(store.member('me', member(1).url)?.description.length, 10_000, 'The full PR stays available');
    assert.equal(store.index('me'), store.index('me'), 'Reads share one index until a change is saved');
  } finally {
    f.cleanup();
  }
});
const mutedFile = (account: string) => `muted-prs-${createHash('sha256').update(account).digest('hex')}.json`;
async function reopen(directory: string, run: (storage: StateStorage) => void | Promise<void>) {
  const storage = createAppDataStore();
  await storage.open(directory);
  try {
    await run(storage);
  } finally {
    await storage.close();
  }
}
void test('a saved mute file imports once, keeps full PRs and is kept as a backup', async () => {
  const f = fixture();
  try {
    const saved = [
      { member: member(2), mutedAt: '2026-10-02T00:00:00.000Z' },
      { member: { ...member(1), description: 'Only this file has it' }, mutedAt: '2026-10-01T00:00:00.000Z' },
    ];
    fs.writeFileSync(path.join(f.directory, mutedFile('me')), JSON.stringify(saved));
    await reopen(f.directory, (storage) => {
      const store = createMutedPrStore(storage);
      assert.deepEqual(
        store.index('me').rows.map((row) => [row.member.url, row.mutedAt]),
        saved.map((entry) => [entry.member.url, entry.mutedAt]),
        'The saved order is kept'
      );
      assert.deepEqual(store.member('me', member(1).url), saved[1].member);
      store.set('me', { muted: false, urls: [member(2).url] });
    });
    assert.equal(fs.existsSync(path.join(f.directory, mutedFile('me'))), false);
    assert.equal(
      fs.readFileSync(path.join(f.directory, mutedFile('me') + '.migrated'), 'utf8'),
      JSON.stringify(saved),
      'The original file is kept unchanged'
    );
    // A file that appears later is not imported again over the saved mutes.
    fs.writeFileSync(path.join(f.directory, mutedFile('me')), JSON.stringify(saved));
    await reopen(f.directory, (storage) => {
      assert.deepEqual(createMutedPrStore(storage).index('me').rows.map((row) => row.member.number), [1]);
    });
  } finally {
    f.cleanup();
  }
});
void test('description survives restart', async () => {
  const f = fixture();
  try {
    const pr = { ...member(1), description: 'Part of the briefing key' };
    await reopen(f.directory, (storage) => createMutedPrStore(storage).set('me', { muted: true, members: [pr] }));
    await reopen(f.directory, (storage) => {
      assert.deepEqual(createMutedPrStore(storage).member('me', pr.url), pr, 'Unmuting restores the full PR');
    });
  } finally {
    f.cleanup();
  }
});
void test('order survives restart', async () => {
  const f = fixture();
  try {
    let time = 1_000_000;
    await reopen(f.directory, (storage) => {
      const store = createMutedPrStore(storage, () => time++);
      store.set('me', { muted: true, members: [member(3), member(1)] });
      store.set('me', { muted: true, members: [member(2)] });
      store.set('me', { muted: false, urls: [member(3).url] });
      store.set('me', { muted: true, members: [member(3)] });
      store.set('me', { muted: true, members: [{ ...member(1), title: 'Muted again' }] });
    });
    await reopen(f.directory, (storage) => {
      const rows = createMutedPrStore(storage).index('me').rows;
      assert.deepEqual(rows.map((row) => row.member.number), [1, 2, 3], 'A re-mute keeps its place');
      assert.equal(rows[0].member.title, 'Muted again');
      assert.equal(rows[0].mutedAt, new Date(1_000_001).toISOString(), 'and its original time');
    });
  } finally {
    f.cleanup();
  }
});
