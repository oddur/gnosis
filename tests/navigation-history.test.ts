import { EventEmitter } from 'node:events';
import type { BrowserWindow } from 'electron';
import { attachWindowHistoryNavigation } from '../src/window-history-navigation';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createNavigationHistory, historyKeyDirection } from '../lib/navigation-history';

void test('history replaces the current visit, retains forward entries on restore, and branches on new navigation', () => {
  const h = createNavigationHistory<{ id: string; scroll: number }>((v) => v.id);
  h.record({ id: 'queue', scroll: 10 });
  h.record({ id: 'queue', scroll: 250 });
  h.record({ id: 'pr', scroll: 0 });
  h.record({ id: 'changes', scroll: 0 });
  assert.equal(h.move(-1)?.id, 'pr');
  h.record({ id: 'pr', scroll: 50 });
  assert.equal(h.move(1)?.id, 'changes');
  h.move(-1);
  assert.deepEqual(h.move(-1), { id: 'queue', scroll: 250 });
  assert.equal(h.move(-1), undefined);
  h.record({ id: 'another-pr', scroll: 0 });
  assert.equal(h.move(1), undefined);
  assert.equal(h.move(-1)?.id, 'queue');
});

void test('history is bounded and can be cleared on account changes', () => {
  const h = createNavigationHistory<string>((v) => v, 3);
  for (const id of ['a', 'b', 'c', 'd']) h.record(id);
  assert.equal(h.move(-1), 'c');
  assert.equal(h.move(-1), 'b');
  assert.equal(h.move(-1), undefined);
  h.clear();
  assert.equal(h.current(), undefined);
  assert.equal(h.move(1), undefined);
});

void test('browser shortcuts support driver mappings without stealing macOS word movement', () => {
  const key = (key: string, modifiers = {}) => ({
    key,
    code: '',
    metaKey: false,
    altKey: false,
    ctrlKey: false,
    shiftKey: false,
    ...modifiers,
  });
  assert.equal(historyKeyDirection(key('[', { metaKey: true }), 'darwin'), -1);
  assert.equal(historyKeyDirection(key(']', { metaKey: true }), 'darwin'), 1);
  assert.equal(historyKeyDirection(key('ArrowLeft', { altKey: true }), 'darwin'), undefined);
  assert.equal(historyKeyDirection(key('ArrowLeft', { altKey: true }), 'win32'), -1);
  assert.equal(historyKeyDirection(key('ArrowRight', { altKey: true }), 'linux'), 1);
  assert.equal(historyKeyDirection(key('BrowserBack'), 'darwin'), -1);
  assert.equal(historyKeyDirection(key('BrowserForward'), 'darwin'), 1);
  assert.equal(historyKeyDirection(key('[', { metaKey: true, shiftKey: true }), 'darwin'), undefined);
});

void test('failed or superseded navigation restores the displayed visit without deleting Forward', () => {
  const h = createNavigationHistory<string>((v) => v);
  for (const id of ['queue', 'review-a', 'review-b']) h.record(id);
  h.move(-1);
  h.move(-1);
  h.restore('review-b');
  assert.equal(h.current(), 'review-b');
  assert.equal(h.move(-1), 'review-a');
  assert.equal(h.move(1), 'review-b');
});

void test('native app commands and Logitech macOS swipe gestures use the same history directions', () => {
  const window = new EventEmitter();
  const moves: number[] = [];
  let prevented = 0;
  const event = {
    preventDefault() {
      prevented++;
    },
  };
  attachWindowHistoryNavigation(window as unknown as BrowserWindow, (direction) => moves.push(direction));
  window.emit('app-command', event, 'browser-backward');
  window.emit('app-command', event, 'browser-forward');
  window.emit('swipe', event, 'left');
  window.emit('swipe', event, 'right');
  window.emit('swipe', event, 'up');
  window.emit('swipe', event, 'down');
  window.emit('app-command', event, 'media-nexttrack');
  assert.deepEqual(moves, [-1, 1, -1, 1]);
  assert.equal(prevented, 4);
});
