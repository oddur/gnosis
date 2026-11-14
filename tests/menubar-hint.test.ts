import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MENUBAR_HINT_KEY, menubarHintVisible, normalizeMenubarHint, recordMenubarHint } from '../lib/menubar-hint';
import { buildMenubarState, type MenubarInput } from '../lib/menubar-state';
import type { QueueItem, ReviewMember } from '../lib/workbench';
import { LOGIN, T0, member } from './notification-fixtures';

const item = (m: ReviewMember): QueueItem => ({
  subject: { id: m.url, kind: 'pr', title: m.title, members: [m], edges: [], warnings: [] },
  attention: 'other',
});
const input = (extra: Partial<MenubarInput> = {}): MenubarInput => ({
  login: LOGIN,
  signedIn: true,
  online: true,
  queue: { items: [item(member(1, { requestedReviewers: [LOGIN], title: 'Review 1' }))], sync: { status: 'idle', checkedAt: T0 - 60_000 } },
  signals: () => undefined,
  now: T0,
  ...extra,
});

void test('the tip shows on first open, until it is dismissed or a row is opened', () => {
  const first = normalizeMenubarHint(undefined);
  assert.deepEqual(first, {});
  assert.equal(menubarHintVisible(first), true, 'nothing saved: the first open shows the tip');

  const dismissed = recordMenubarHint(first, 'dismissed', T0);
  assert.deepEqual(dismissed, { done: 'dismissed', at: T0 });
  assert.equal(menubarHintVisible(dismissed), false);

  const opened = recordMenubarHint(first, 'opened', T0);
  assert.equal(menubarHintVisible(opened), false, 'opening a row ends it too');
  // Whichever comes first stays: a later open changes nothing.
  assert.equal(recordMenubarHint(dismissed, 'opened', T0 + 1), dismissed);
});

void test('saved tip state is read strictly', () => {
  assert.deepEqual(normalizeMenubarHint({ done: 'opened', at: 5 }), { done: 'opened', at: 5 });
  assert.deepEqual(normalizeMenubarHint({ done: 'dismissed', at: 'soon' }), { done: 'dismissed' });
  for (const raw of [null, 'dismissed', 1, [], { done: 'later' }, { done: true }]) assert.deepEqual(normalizeMenubarHint(raw), {});
});

void test('the panel state carries the tip only with rows to move through', () => {
  assert.equal(buildMenubarState(input({ hint: true })).state.hint, true);
  assert.equal(buildMenubarState(input()).state.hint, false, 'off unless main says so');
  assert.equal(buildMenubarState(input({ hint: true, queue: { items: [], sync: { status: 'idle', checkedAt: T0 } } })).state.hint, false, 'all clear');
  assert.equal(buildMenubarState(input({ hint: true, queue: undefined })).state.hint, false, 'loading');
  assert.equal(buildMenubarState(input({ hint: true, signedIn: false })).state.hint, false, 'signed out');
});

void test('the tip answer survives a restart and a GitHub cache reset', async () => {
  const { createAppDataStore } = await import('../src/app-data-store');
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gnosis-menubar-hint-'));
  let store = createAppDataStore();
  try {
    await store.open(dir);
    assert.equal(menubarHintVisible(normalizeMenubarHint(store.read(MENUBAR_HINT_KEY))), true);
    store.write(MENUBAR_HINT_KEY, recordMenubarHint({}, 'dismissed', T0));
    await store.close();
    store = createAppDataStore();
    await store.open(dir);
    await store.clearGitHub();
    const saved = normalizeMenubarHint(store.read(MENUBAR_HINT_KEY));
    assert.deepEqual(saved, { done: 'dismissed', at: T0 });
    assert.equal(menubarHintVisible(saved), false);
  } finally {
    await store.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
