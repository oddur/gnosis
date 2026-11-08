import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import type { BrowserWindow } from 'electron';
import {
  initialWorkspaceTabs,
  newWorkspaceTab,
  reduceWorkspaceTabs as reduce,
  workspaceShortcut,
  saveWorkspaceTabs,
  restoreWorkspaceTabs,
  sameTabChrome,
} from '../lib/workspace-tabs';
import { DEFAULT_QUEUE_FILTERS } from '../lib/queue-filters';
import type { AppLocation } from '../lib/navigation-history';
import { attachWorkspaceShortcuts } from '../src/window-workspace-navigation';
import { isReviewStateKey } from '../lib/review-state';
const home: AppLocation = {
  page: 'home',
  home: {
    account: 'maya',
    filters: DEFAULT_QUEUE_FILTERS,
    savedView: false,
    savedQuery: '',
    viewId: null,
    muted: false,
    item: null,
    tab: 'summary',
    selected: null,
    scroll: 250,
  },
};
void test('background opens do not change focus; close returns to last used tab and can reopen', () => {
  let s = initialWorkspaceTabs(newWorkspaceTab('a'));
  s = reduce(s, { type: 'open', tab: newWorkspaceTab('b'), background: true });
  assert.equal(s.active, 'a');
  s = reduce(s, { type: 'open', tab: newWorkspaceTab('c') });
  s = reduce(s, { type: 'activate', id: 'b' });
  s = reduce(s, { type: 'record', id: 'b', location: home });
  s = reduce(s, { type: 'close', id: 'b', replacement: newWorkspaceTab('d') });
  assert.equal(s.active, 'c');
  s = reduce(s, { type: 'reopen' });
  assert.equal(s.active, 'b');
  assert.deepEqual(s.tabs.at(-1)?.initial, { kind: 'location', location: home });
  assert.equal(reduce(s, { type: 'activate', id: 'missing' }), s);
});
void test('last tab becomes a fresh queue, with closed tab still available', () => {
  let s = initialWorkspaceTabs(newWorkspaceTab('a'));
  s = reduce(s, { type: 'close', id: 'a', replacement: newWorkspaceTab('b') });
  assert.equal(s.active, 'b');
  assert.equal(s.tabs.length, 1);
  assert.equal(s.closed[0].id, 'a');
});
void test('location updates are immutable and repeat reports do not render-loop', () => {
  const s = initialWorkspaceTabs(newWorkspaceTab('a'));
  const next = reduce(s, { type: 'record', id: 'a', location: home });
  assert.equal(s.tabs[0].location, undefined);
  assert.equal(next.tabs[0].location, home);
  assert.equal(reduce(next, { type: 'record', id: 'a', location: { ...home, home: { ...home.home } } }), next);
  const moved = reduce(next, { type: 'record', id: 'a', location: { ...home, home: { ...home.home, scroll: 600 } } });
  assert.equal(moved.tabs[0].location?.page, 'home');
});
void test('restored tabs are scoped to an account and malformed entries are rejected', () => {
  let s = initialWorkspaceTabs(newWorkspaceTab('a'));
  s = reduce(s, { type: 'record', id: 'a', location: home });
  const data = saveWorkspaceTabs(s);
  assert.equal(restoreWorkspaceTabs(data, 'maya')?.active, 'a');
  assert.equal(restoreWorkspaceTabs(data, 'other'), undefined);
  assert.equal(restoreWorkspaceTabs({ version: 1, tabs: [null, { id: 'bad id' }] }, 'maya'), undefined);
  assert.equal(restoreWorkspaceTabs({ ...data, tabs: [...data.tabs, ...data.tabs] }, 'maya')?.tabs.length, 1);
  assert.equal(isReviewStateKey('gnosis-workspace-tabs:v1:maya'), true);
});
void test('persisted tabs omit code, descriptions and draft payloads', () => {
  const target = newWorkspaceTab('a', {
    kind: 'home',
    subject: {
      subject: {
        id: 'stack',
        kind: 'stack',
        title: 'Title',
        members: [{ url: 'https://github.com/a/b/pull/1', number: 1, repo: 'a/b', description: 'PRIVATE BODY' }],
        edges: [],
        warnings: [],
      },
      attention: 'other',
    } as never,
  });
  const serialized = JSON.stringify(saveWorkspaceTabs(initialWorkspaceTabs(target)));
  assert.ok(!serialized.includes('PRIVATE BODY'));
  assert.ok(serialized.includes('https://github.com/a/b/pull/1'));
});
void test('tab shortcuts leave editing, IME, native quit and modified combinations alone', () => {
  const k = (key: string, extras = {}) => ({
    key,
    metaKey: true,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    isComposing: false,
    repeat: false,
    ...extras,
  });
  assert.equal(workspaceShortcut(k('T', { shiftKey: true })), 'reopen');
  assert.equal(workspaceShortcut(k('w')), 'close');
  assert.equal(workspaceShortcut(k('q')), undefined);
  assert.equal(workspaceShortcut(k('Tab', { metaKey: false, ctrlKey: true })), 'next');
  assert.equal(workspaceShortcut(k('w', { isComposing: true })), undefined);
  assert.equal(workspaceShortcut(k('t', { altKey: true })), undefined);
});
void test('native tab accelerators suppress Close Window and forward exactly once', () => {
  const contents = new EventEmitter() as EventEmitter & { send: (channel: string, action: unknown) => void };
  const actions: unknown[] = [];
  contents.send = (channel, action) => actions.push([channel, action]);
  attachWorkspaceShortcuts({ webContents: contents } as unknown as BrowserWindow);
  let prevented = 0;
  const event = { preventDefault: () => prevented++ };
  const input = {
    type: 'keyDown',
    key: 'w',
    meta: true,
    control: false,
    alt: false,
    shift: false,
    isComposing: false,
    isAutoRepeat: false,
  };
  contents.emit('before-input-event', event, input);
  contents.emit('before-input-event', event, { ...input, type: 'keyUp' });
  assert.equal(prevented, 1);
  assert.deepEqual(actions, [['workspace-shortcut', 'close']]);
});

void test('close others is atomic, bounded and keeps the requested inactive tab', () => {
  let state = initialWorkspaceTabs(newWorkspaceTab('a'));
  for (let i = 0; i < 30; i++)
    state = reduce(state, { type: 'open', tab: newWorkspaceTab(`other-${i}`), background: true });
  state = reduce(state, { type: 'close-others', id: 'other-7' });
  assert.equal(state.active, 'other-7');
  assert.equal(state.tabs.length, 1);
  assert.equal(state.closed.length, 20);
  assert.equal(reduce(state, { type: 'reopen' }).tabs.length, 2);
});
void test('scroll metadata does not invalidate tab chrome; title, status and order do', () => {
  const state = reduce(initialWorkspaceTabs(newWorkspaceTab('a')), { type: 'record', id: 'a', location: home });
  const scrolled = reduce(state, {
    type: 'record',
    id: 'a',
    location: { page: 'home', home: { ...home.home, scroll: 900 } },
  });
  assert.equal(sameTabChrome(state, scrolled), true);
  assert.equal(sameTabChrome(state, reduce(state, { type: 'status', id: 'a', status: 'error' })), false);
});
void test('invalid saved entries do not discard valid neighbouring tabs', () => {
  const valid = saveWorkspaceTabs(initialWorkspaceTabs(newWorkspaceTab('good'))).tabs[0];
  const state = restoreWorkspaceTabs(
    {
      version: 1,
      tabs: [{ ...valid, id: 'bad', home: 'broken' }, valid, { ...valid, id: 'bad2', destination: [] }],
      active: 'bad',
    },
    'maya'
  );
  assert.deepEqual(
    state?.tabs.map((tab) => tab.id),
    ['good']
  );
  assert.equal(state.active, 'good');
});
void test('recovery replaces only the failed tab without creating another queue', () => {
  const state = initialWorkspaceTabs(newWorkspaceTab('failed'));
  const next = reduce(state, { type: 'replace', id: 'failed', tab: newWorkspaceTab('queue') });
  assert.equal(next.tabs.length, 1);
  assert.equal(next.active, 'queue');
});
