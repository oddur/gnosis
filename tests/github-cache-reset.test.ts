import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { requestGitHubCacheClear, applyPendingGitHubCacheClear, hasPendingGitHubCacheClear } from '../src/github-cache-reset';
import { createAppDataStore } from '../src/app-data-store';
import { createMutedPrStore } from '../src/muted-pr-store';
import { createStarredPrStore } from '../src/starred-pr-store';
import { createSavedViewStore } from '../src/saved-view-store';
import type { ReviewMember } from '../lib/workbench';

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gnosis-cache-reset-'));
  const write = (name: string, data: unknown) => fs.writeFileSync(path.join(directory, name), JSON.stringify(data));
  const read = (name: string): unknown => JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));
  const exists = (name: string) => fs.existsSync(path.join(directory, name));
  return { directory, write, read, exists, cleanup: () => fs.rmSync(directory, { recursive: true, force: true }) };
}
void test('clear runs before restart initialization and removes late writes while preserving user data and API deadlines', async () => {
  const f = fixture();
  try {
    const saved = {
      account: 'reviewer',
      credentialKey: 'scope',
      briefs: { review: { summary: 'Keep this' } },
      overrides: [{ action: 'split' }],
      day: '2026-10-24',
      used: 4,
      filters: { author: 'me' },
    };
    f.write('workbench.json', {
      ...saved,
      subjects: [{ title: 'Cached PR' }],
      listings: { cached: true },
      discoveryProgress: { members: [] },
      checkedAt: { pr: 1 },
      parentLookups: { branch: {} },
      discoveredAt: 1,
    });
    const retained = [
      'github-budget.json',
      'preferences.json',
      'reviews.json',
      'starred-prs.json',
      'muted-prs.json',
      'saved-views.json',
    ];
    for (const name of retained) f.write(name, { marker: name, reset: 123456 });
    requestGitHubCacheClear(f.directory);
    // The departing process could still finish an HTTP request after the button click.
    f.write('github-cache.json', { lateResponse: 'must not survive restart' });
    f.write('github-cache.json.tmp', { pending: true });
    for (const name of ['github-cache.sqlite', 'github-cache.sqlite-wal', 'github-cache.sqlite-shm'])
      f.write(name, 'disposable');
    let browserClears = 0;
    assert.equal(
      await applyPendingGitHubCacheClear(f.directory, () => {
        browserClears++;
        return Promise.resolve();
      }),
      true
    );
    assert.equal(f.exists('github-cache.json'), false);
    assert.equal(f.exists('github-cache.json.tmp'), false);
    for (const name of ['github-cache.sqlite', 'github-cache.sqlite-wal', 'github-cache.sqlite-shm'])
      assert.equal(f.exists(name), false);
    assert.deepEqual(f.read('workbench.json'), { ...saved, subjects: [] });
    for (const name of retained) assert.deepEqual(f.read(name), { marker: name, reset: 123456 });
    assert.equal(browserClears, 1);
    assert.equal(
      await applyPendingGitHubCacheClear(f.directory, () => {
        throw Error('Must not clear on every launch');
      }),
      false
    );
  } finally {
    f.cleanup();
  }
});
void test('an unsuccessful browser-cache clear remains pending and retries on startup', async () => {
  const f = fixture();
  try {
    requestGitHubCacheClear(f.directory);
    await assert.rejects(
      applyPendingGitHubCacheClear(f.directory, () => Promise.reject(new Error('Disk busy'))),
      /Disk busy/
    );
    assert.equal(f.exists('clear-github-cache.json'), true);
    assert.equal(await applyPendingGitHubCacheClear(f.directory, () => Promise.resolve()), true);
    assert.equal(f.exists('clear-github-cache.json'), false);
  } finally {
    f.cleanup();
  }
});
void test('unreadable workbench data is never discarded together with saved briefings', () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.directory, 'workbench.json'), 'broken json');
    assert.throws(() => requestGitHubCacheClear(f.directory));
    assert.equal(f.exists('clear-github-cache.json'), false);
    assert.equal(fs.readFileSync(path.join(f.directory, 'workbench.json'), 'utf8'), 'broken json');
  } finally {
    f.cleanup();
  }
});

void test('hasPendingGitHubCacheClear', async () => {
  const f = fixture();
  try {
    assert.equal(hasPendingGitHubCacheClear(f.directory), false);
    requestGitHubCacheClear(f.directory);
    assert.equal(hasPendingGitHubCacheClear(f.directory), true, 'Startup then clears before opening the window');
    await applyPendingGitHubCacheClear(f.directory, async () => {});
    assert.equal(hasPendingGitHubCacheClear(f.directory), false);
  } finally {
    f.cleanup();
  }
});

void test('mutes, stars and saved views survive a GitHub cache reset', async () => {
  const f = fixture();
  const member = (number: number) =>
    ({
      number,
      repo: 'o/r',
      headRepo: 'o/r',
      baseRepo: 'o/r',
      url: `https://github.com/o/r/pull/${number}`,
      title: `PR ${number}`,
      description: `Description ${number}`,
      author: 'author',
      role: 'watched',
      baseBranch: 'main',
      headBranch: `feature-${number}`,
      baseSha: 'base',
      headSha: 'head',
      merged: false,
      state: 'open',
      createdAt: '2026-10-22',
      updatedAt: '2026-10-22',
      labels: [],
      isDraft: false,
      requestedReviewers: [],
      requestedTeams: [],
    }) as unknown as ReviewMember;
  let data = createAppDataStore();
  try {
    await data.open(f.directory);
    createMutedPrStore(data).set('me', { muted: true, members: [member(1)] });
    createStarredPrStore(data).set('me', { starred: true, members: [member(2)] });
    const views = createSavedViewStore(data).act('me', { type: 'create', name: 'Mine' });
    await data.close();
    requestGitHubCacheClear(f.directory);
    data = createAppDataStore();
    await data.open(f.directory);
    await applyPendingGitHubCacheClear(f.directory, () => Promise.resolve(), () => data.clearGitHub());
    assert.equal(createMutedPrStore(data).member('me', member(1).url)?.description, 'Description 1');
    assert.deepEqual(createStarredPrStore(data).load('me').map((entry) => entry.member.number), [2]);
    assert.equal(createSavedViewStore(data).load('me').activeId, views.activeId);
  } finally {
    await data.close();
    f.cleanup();
  }
});
