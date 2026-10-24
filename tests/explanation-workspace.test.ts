import test from 'node:test';
import assert from 'node:assert/strict';
import { readReviewDrafts, updateReviewDrafts, type ChangesReviewDraft } from '../lib/changes-review-drafts';
import {
  readDiscussion,
  refreshDiscussion,
  replaceDiscussionThread,
  peekDiscussion,
  setDiscussionAccount,
  subscribeDiscussions,
} from '../lib/review-discussion-cache';
import type { GitHubReviewThreads, GitHubReviewThread } from '../lib/review-threads';
const storage = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  },
  configurable: true,
});
const draft: ChangesReviewDraft = {
  id: 'draft',
  filePath: 'worker.ts',
  line: 3,
  side: 'RIGHT',
  body: 'Check cancellation.',
  headSha: 'head',
  baseSha: 'base',
  baseBranch: 'main',
  hunkHeader: '',
  codeSnippet: '',
  slideIndex: 1,
};
void test('one pending review spans views while accounts, PRs, and original revisions stay separate', () => {
  updateReviewDrafts('alice', 'pr1', (list) => [...list, draft]);
  assert.deepEqual(readReviewDrafts('alice', 'pr1'), [draft]);
  assert.deepEqual(readReviewDrafts('bob', 'pr1'), []);
  assert.deepEqual(readReviewDrafts('alice', 'pr2'), []);
  updateReviewDrafts('alice', 'pr1', (list) => list.map((d) => ({ ...d, body: 'Edited in Changes.' })));
  assert.equal(readReviewDrafts('alice', 'pr1')[0].headSha, 'head');
  assert.equal(readReviewDrafts('alice', 'pr1')[0].body, 'Edited in Changes.');
  assert.throws(() => updateReviewDrafts('', 'pr1', (list) => [...list, draft]), /Connect GitHub/);
});
void test('a failed draft write preserves the last saved review', () => {
  updateReviewDrafts('alice', 'full-disk', () => [draft]);
  const save = localStorage.setItem.bind(localStorage);
  localStorage.setItem = () => {
    throw Error('Disk full');
  };
  try {
    assert.throws(() => updateReviewDrafts('alice', 'full-disk', () => []), /Disk full/);
  } finally {
    localStorage.setItem = save;
  }
  assert.deepEqual(readReviewDrafts('alice', 'full-disk'), [draft]);
});
void test('shared GitHub discussions coalesce reads and preserve a write over an older in-flight response', async () => {
  setDiscussionAccount('alice');
  const thread: GitHubReviewThread = {
    id: 'thread',
    path: 'worker.ts',
    line: 3,
    startLine: null,
    diffSide: 'RIGHT',
    isResolved: false,
    isOutdated: false,
    viewerCanResolve: true,
    viewerCanUnresolve: false,
    comments: [{ id: 'comment', body: 'Before', author: null, createdAt: '', url: '' }],
  };
  const data: GitHubReviewThreads = { headSha: 'head', baseSha: 'base', threads: [thread] };
  let reads = 0,
    resolve: (value: GitHubReviewThreads) => void = () => {};
  Object.defineProperty(globalThis, 'window', {
    value: {
      electronAPI: {
        getReviewThreads: () => {
          reads++;
          return new Promise<GitHubReviewThreads>((done) => {
            resolve = done;
          });
        },
      },
    },
    configurable: true,
  });
  const first = readDiscussion('pr1'),
    second = readDiscussion('pr1');
  assert.equal(first, second);
  resolve(data);
  await first;
  const updates: GitHubReviewThreads[] = [];
  const unsubscribe = subscribeDiscussions((_url, next) => updates.push(next));
  const stale = refreshDiscussion('pr1');
  replaceDiscussionThread('pr1', { ...thread, isResolved: true });
  resolve(data);
  await stale;
  assert.equal(peekDiscussion('pr1')?.threads[0].isResolved, true);
  await readDiscussion('pr1');
  assert.equal(reads, 2);
  assert.equal(updates.at(-1)?.threads[0].isResolved, true);
  const oldAccount = refreshDiscussion('pr1');
  setDiscussionAccount('bob');
  resolve(data);
  await assert.rejects(oldAccount, /account changed/);
  assert.equal(peekDiscussion('pr1'), undefined);
  unsubscribe();
});
