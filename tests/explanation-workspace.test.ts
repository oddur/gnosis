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
import type { Preferences } from '../lib/types';
const storage = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
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
void test('one pending review spans views while accounts, PRs, and original revisions stay separate', async () => {
  await updateReviewDrafts('alice', 'pr1', (list) => [...list, draft]);
  assert.deepEqual(readReviewDrafts('alice', 'pr1'), [draft]);
  assert.deepEqual(readReviewDrafts('bob', 'pr1'), []);
  assert.deepEqual(readReviewDrafts('alice', 'pr2'), []);
  await updateReviewDrafts('alice', 'pr1', (list) => list.map((d) => ({ ...d, body: 'Edited in Changes.' })));
  assert.equal(readReviewDrafts('alice', 'pr1')[0].headSha, 'head');
  assert.equal(readReviewDrafts('alice', 'pr1')[0].body, 'Edited in Changes.');
  await assert.rejects(() => updateReviewDrafts('', 'pr1', (list) => [...list, draft]), /Connect GitHub/);
});
void test('a failed draft write preserves the last saved review', async () => {
  await updateReviewDrafts('alice', 'full-disk', () => [draft]);
  const save = localStorage.setItem.bind(localStorage);
  localStorage.setItem = () => {
    throw Error('Disk full');
  };
  try {
    await assert.rejects(() => updateReviewDrafts('alice', 'full-disk', () => []), /Disk full/);
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

void test('signed-out local explanations migrate, edit, and retain notes independently of GitHub accounts', async () => {
  const { JSDOM } = await import('jsdom');
  const { createElement, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { useExplanationComments } = await import('../lib/use-explanation-comments');
  const { subjectForReview } = await import('../lib/workbench');
  const dom = new JSDOM('<div id="root"></div>');
  const globals = ['window', 'document', 'IS_REACT_ACT_ENVIRONMENT'] as const;
  const previous = globals.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  }))
    Object.defineProperty(globalThis, key, { value, configurable: true });
  const review: import('../lib/types').ReviewGuide = {
    prUrl: 'local:/project/notes',
    prTitle: 'Local changes',
    prDescription: '',
    author: '',
    summary: '',
    riskLevel: 'low',
    riskRationale: '',
    totalFilesChanged: 1,
    totalLinesChanged: 1,
    slides: [],
    headSha: 'head',
    baseSha: 'base',
  };
  const legacyKey = `gnosis-drafts:${subjectForReview(review)}:${review.headSha}`;
  localStorage.setItem(legacyKey, JSON.stringify([draft]));
  let notes: ReturnType<typeof useExplanationComments> | undefined;
  function Harness({ account }: { account: string }) {
    notes = useExplanationComments(review, account);
    return null;
  }
  const container = dom.window.document.getElementById('root');
  assert.ok(container);
  const getNotes = () => {
    assert.ok(notes);
    return notes;
  };
  const update = (work: () => void | Promise<void>) => act(async () => { await work(); });
  let root = createRoot(container);
  try {
    await update(() => root.render(createElement(Harness, { account: '' })));
    assert.equal(notes?.comments[0]?.body, draft.body, 'legacy local draft remains accessible without authentication');
    assert.equal(localStorage.getItem(legacyKey), null);
    await update(() => getNotes().addComment({ ...draft, body: 'New local note' }));
    assert.equal(getNotes().comments.length, 2);
    const id = getNotes().comments[1].id;
    await update(() => getNotes().editComment(id, 'Edited local note'));
    await update(() => root.render(createElement(Harness, { account: 'alice' })));
    assert.equal(getNotes().comments[1].body, 'Edited local note', 'logging in keeps local notes');
    await update(() => root.unmount());
    root = createRoot(container);
    await update(() => root.render(createElement(Harness, { account: '' })));
    assert.equal(getNotes().comments[1].body, 'Edited local note', 'reopening signed out keeps local notes');
    await update(() => getNotes().removeComment(id));
    assert.equal(getNotes().comments.length, 1);
    const persisted = [...storage.entries()].find(([key]) => key.includes(review.prUrl))?.[1];
    assert.deepEqual(JSON.parse(persisted ?? 'null'), getNotes().comments, 'notes are persisted');
  } finally {
    await update(() => root.unmount());
    globals.forEach((key, i) => {
      const descriptor = previous[i];
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    });
    dom.window.close();
  }
});

void test('review submission waits for draft removal and recovers after a failed save', async () => {
  const { JSDOM } = await import('jsdom');
  const { createElement, act, useState } = await import('react');
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://review.test', pretendToBeVisual: true });
  const globals: Record<string, unknown> = {
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement,
    HTMLButtonElement: dom.window.HTMLButtonElement, Element: dom.window.Element, Node: dom.window.Node,
    MutationObserver: dom.window.MutationObserver, CustomEvent: dom.window.CustomEvent,
    NodeFilter: dom.window.NodeFilter, getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { value, configurable: true });
  window.electronAPI = { loadPreferences: () => Promise.resolve({ reviewSignature: false } as Preferences) } as typeof window.electronAPI;
  const { createRoot } = await import('react-dom/client');
  const { SubmitReviewDialog } = await import('../components/SubmitReviewDialog');
  let completeRemoval: () => void = () => { throw Error('No removal pending'); };
  let failRemoval: () => void = () => { throw Error('No removal pending'); };
  const submitted: string[][] = [];
  function Harness() {
    const [comments, setComments] = useState([draft, { ...draft, id: 'retained', body: 'Keep this comment.' }]);
    return createElement(SubmitReviewDialog, {
      open: true, onOpenChange: () => {}, comments,
      prUrl: 'https://github.com/o/r/pull/99', isOwnPr: false,
      onEditComment: () => {},
      onRemoveComment: async (id: string) => {
        await new Promise<void>((resolve, reject) => {
          completeRemoval = resolve;
          failRemoval = () => reject(new Error('Disk full'));
        });
        setComments(current => current.filter(comment => comment.id !== id));
      },
      onSubmit: () => {
        submitted.push(comments.map(comment => comment.id));
        return Promise.resolve({ reviewUrl: 'https://github.com/o/r/pull/99#review', droppedCommentCount: 0 });
      },
    });
  }
  const container = document.getElementById('root');
  assert.ok(container);
  const root = createRoot(container);
  const update = (work: () => void | Promise<void>) => act(async () => { await work(); });
  const button = (text: string) => {
    const found = [...document.querySelectorAll('button')].find(element => element.textContent.trim() === text);
    assert.ok(found, `Missing button: ${text}`);
    return found;
  };
  try {
    await update(() => { root.render(createElement(Harness)); });
    assert.equal(button('Submit review').disabled, false);
    await update(() => { button('Remove draft').click(); });
    assert.equal(button('Submit review').disabled, true);
    await update(() => { button('Submit review').click(); });
    assert.deepEqual(submitted, []);

    await update(() => { failRemoval(); });
    assert.match(document.body.textContent, /Could not remove this draft/);
    assert.equal(button('Submit review').disabled, false, 'failed removal does not leave submission locked');
    assert.equal(document.querySelectorAll('.review-submit-comment').length, 2);

    await update(() => { button('Remove draft').click(); });
    assert.equal(button('Submit review').disabled, true);
    await update(() => { completeRemoval(); });
    assert.equal(document.querySelectorAll('.review-submit-comment').length, 1);
    assert.equal(button('Submit review').disabled, false);
    await update(() => { button('Submit review').click(); });
    assert.deepEqual(submitted, [['retained']], 'the removed draft must not be posted');
  } finally {
    await act(async () => {
      root.unmount();
      // Radix restores focus in a timer; keep the DOM globals until it finishes.
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    dom.window.close();
  }
});
