import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAppWindows } from '../src/app-windows';

class FakeWindow {
  destroyed = false;
  focused = false;
  private closed: (() => void)[] = [];
  constructor(readonly name: string) {}
  isDestroyed() {
    return this.destroyed;
  }
  isFocused() {
    return this.focused;
  }
  once(_event: 'closed', listener: () => void) {
    this.closed.push(listener);
  }
  close(all: FakeWindow[]) {
    this.destroyed = true;
    all.splice(all.indexOf(this), 1);
    for (const listener of this.closed) listener();
  }
}

void test('the panel is not an app window: not the main window, not counted, not broadcast to', () => {
  const all: FakeWindow[] = [];
  const windows = createAppWindows(() => all);
  const panel = new FakeWindow('panel');
  all.push(panel);
  windows.exclude(panel);
  assert.deepEqual(windows.list(), [], 'With only the panel, activate creates a main window');
  const main = new FakeWindow('main');
  all.push(main);
  assert.deepEqual(windows.list(), [main]);
  assert.equal(windows.list()[0], main, 'The main window is first even though the panel is older');
  assert.equal(windows.isAuxiliary(panel), true);
  assert.equal(windows.isAuxiliary(main), false);
});

void test('a focused panel is not a focused app', () => {
  const panel = new FakeWindow('panel');
  const main = new FakeWindow('main');
  const windows = createAppWindows(() => [panel, main]);
  windows.exclude(panel);
  panel.focused = true;
  assert.equal(windows.focused(), undefined);
  main.focused = true;
  assert.equal(windows.focused(), main);
});

void test('destroyed windows are skipped', () => {
  const main = new FakeWindow('main');
  const windows = createAppWindows(() => [main]);
  main.destroyed = true;
  assert.deepEqual(windows.list(), []);
});

void test('closing the last app window while the panel exists reports it once', () => {
  const all: FakeWindow[] = [];
  const windows = createAppWindows(() => all);
  const panel = new FakeWindow('panel');
  const main = new FakeWindow('main');
  const second = new FakeWindow('second');
  all.push(panel, main, second);
  windows.exclude(panel);
  let last = 0;
  windows.watchClose(main, () => last++);
  windows.watchClose(second, () => last++);
  second.close(all);
  assert.equal(last, 0, 'Another app window is still open');
  main.close(all);
  assert.equal(last, 1);
});

void test('without the panel, Electron reports the last close itself', () => {
  const all: FakeWindow[] = [];
  const windows = createAppWindows(() => all);
  const main = new FakeWindow('main');
  all.push(main);
  let last = 0;
  windows.watchClose(main, () => last++);
  main.close(all);
  assert.equal(last, 0, '`window-all-closed` fires instead, so the handler does not run twice');
});
