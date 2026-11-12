import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diffLayoutShortcutMap, nextDiffLayout, unifiedLineIndex, type DiffLayout } from '../lib/diff-layout';
import { createShortcutListener, isShortcutSuppressed } from '../lib/use-keyboard-shortcuts';

interface FakeTarget {
  tagName: string;
  isContentEditable?: boolean;
  closest?: (selector: string) => unknown;
}
const div: FakeTarget = { tagName: 'DIV', closest: () => null };

function key(key: string, init: { meta?: boolean; ctrl?: boolean; repeat?: boolean; path?: FakeTarget[] } = {}) {
  const event = {
    key,
    metaKey: !!init.meta,
    ctrlKey: !!init.ctrl,
    altKey: false,
    repeat: !!init.repeat,
    isComposing: false,
    defaultPrevented: false,
    composedPath: () => init.path ?? [div],
    preventDefault() {
      event.defaultPrevented = true;
    },
  };
  return event;
}

function setup(layout: DiffLayout | undefined, modal = false) {
  const chosen: DiffLayout[] = [];
  const view = layout ? { layout, choose: (next: DiffLayout) => chosen.push(next) } : undefined;
  const map = diffLayoutShortcutMap(
    () => view,
    () => modal
  );
  const listener = createShortcutListener(() => map);
  const press = (event: ReturnType<typeof key>) => {
    listener(event as unknown as KeyboardEvent);
    return event.defaultPrevented;
  };
  return { chosen, press };
}

void test('d toggles the layout, and u and s choose one', () => {
  assert.equal(nextDiffLayout('d', 'unified'), 'split');
  assert.equal(nextDiffLayout('d', 'split'), 'unified');
  assert.equal(nextDiffLayout('u', 'split'), 'unified');
  assert.equal(nextDiffLayout('s', 'unified'), 'split');
  assert.equal(nextDiffLayout('x', 'unified'), undefined);

  const unified = setup('unified');
  assert.equal(unified.press(key('d')), true, 'A handled key does not also type or scroll');
  assert.equal(unified.press(key('s')), true);
  assert.equal(unified.press(key('u')), true);
  assert.deepEqual(unified.chosen, ['split', 'split', 'unified']);
  const split = setup('split');
  split.press(key('d'));
  assert.deepEqual(split.chosen, ['unified']);
});

void test('layout keys leave modified, repeated and other keys alone', () => {
  const { chosen, press } = setup('unified');
  assert.equal(press(key('d', { meta: true })), false, '⌘D stays free for the system and menus');
  assert.equal(press(key('d', { ctrl: true })), false);
  assert.equal(press(key('D')), false);
  assert.equal(press(key('d', { repeat: true })), false, 'Holding the key does not switch back and forth');
  assert.equal(press(key('x')), false);
  assert.deepEqual(chosen, []);
});

void test('layout keys keep their default action without a diff on screen or while a modal is open', () => {
  const none = setup(undefined);
  assert.equal(none.press(key('d')), false);
  const modal = setup('unified', true);
  assert.equal(modal.press(key('d')), false);
  assert.equal(modal.press(key('s')), false);
  assert.deepEqual(modal.chosen, []);
});

void test('layout keys never fire while typing or inside a dialog', () => {
  const textarea: FakeTarget = { tagName: 'TEXTAREA' };
  const input: FakeTarget = { tagName: 'INPUT' };
  const editor: FakeTarget = { tagName: 'DIV', isContentEditable: true, closest: () => null };
  const inDialog: FakeTarget = {
    tagName: 'BUTTON',
    closest: (selector: string) => (selector.includes('[role="dialog"]') ? {} : null),
  };
  // A comment editor inside a diff's shadow root is retargeted at its host; the composed path still has it.
  const host: FakeTarget = { tagName: 'DIFFS-CONTAINER', closest: () => null };
  const { chosen, press } = setup('unified');
  for (const path of [[textarea], [input], [editor], [inDialog], [textarea, host]]) {
    assert.equal(isShortcutSuppressed(key('d', { path }) as unknown as KeyboardEvent), true);
    assert.equal(press(key('d', { path })), false);
    assert.equal(press(key('u', { path })), false);
  }
  assert.deepEqual(chosen, []);
  assert.equal(isShortcutSuppressed(key('d') as unknown as KeyboardEvent), false);
  const composing = { ...key('d'), isComposing: true };
  assert.equal(isShortcutSuppressed(composing as unknown as KeyboardEvent), true);
});

void test("Pierre's line index identifies the same line in both layouts", () => {
  assert.equal(unifiedLineIndex('12,7'), 12);
  assert.equal(unifiedLineIndex('0,0'), 0);
  assert.equal(unifiedLineIndex('4'), 4);
  assert.equal(unifiedLineIndex(''), undefined);
  assert.equal(unifiedLineIndex(null), undefined);
  assert.equal(unifiedLineIndex('x,1'), undefined);
});
