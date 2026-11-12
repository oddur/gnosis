import assert from 'node:assert/strict';
import { test } from 'node:test';
import { columnTop, createColumnLayout } from '../lib/explanation-column-layout';

void test('a column that fits the viewport keeps the stylesheet offset', () => {
  assert.equal(columnTop(900, 400, 2000), null);
  assert.equal(columnTop(900, 868, 2000), null);
});

void test('a column taller than the viewport is pinned by its bottom', () => {
  // min(16, viewport - column - 16), as the sticky column had before.
  assert.equal(columnTop(900, 869, 2000), 15);
  assert.equal(columnTop(900, 1500, 2000), -616);
});

void test('the tallest column in a row has no sticky travel and never gets a value', () => {
  assert.equal(columnTop(900, 57_000, 57_000), null);
  assert.equal(columnTop(900, 1500, 1500), null);
});

type Callback = (entries: Partial<ResizeObserverEntry>[]) => void;
function harness() {
  let callback: Callback = () => {};
  const observed = new Set<Element>();
  const frames: (() => void)[] = [];
  const layout = createColumnLayout(
    (cb) => {
      callback = cb as unknown as Callback;
      return {
        observe: (el: Element) => void observed.add(el),
        unobserve: (el: Element) => void observed.delete(el),
        disconnect: () => observed.clear(),
      };
    },
    { request: (cb) => frames.push(cb), cancel: () => {} }
  );
  const element = () => {
    const writes: string[] = [];
    const style = {
      top: '',
      removeProperty(name: string) {
        writes.push(`remove ${name}`);
      },
    };
    const proxy = new Proxy(style, {
      set(target, key, value) {
        if (key === 'top') writes.push(`top ${value}`);
        return Reflect.set(target, key, value);
      },
    });
    return { el: { style: proxy } as unknown as HTMLElement, writes };
  };
  const size = (target: Element, block: number) =>
    ({ target, borderBoxSize: [{ blockSize: block }], contentBoxSize: [{ blockSize: block }] }) as never;
  const flush = () => frames.splice(0).forEach((f) => f());
  return {
    layout,
    observed,
    callback: (e: Partial<ResizeObserverEntry>[]) => callback(e),
    element,
    size,
    flush,
    frames,
  };
}

void test('the controller reads sizes only from entries and writes once per frame', () => {
  const h = harness();
  const viewport = h.element();
  const text = h.element();
  const code = h.element();
  h.layout.viewport(viewport.el);
  h.layout.column(1, text.el);
  h.layout.column(1, code.el);
  assert.equal(h.observed.size, 3);
  h.callback([h.size(viewport.el, 900), h.size(text.el, 1500), h.size(code.el, 57_000)]);
  h.callback([h.size(text.el, 1500)]);
  assert.equal(h.frames.length, 1, 'many observer callbacks share one flush');
  h.flush();
  assert.deepEqual(text.writes, ['top -616px']);
  assert.deepEqual(code.writes, [], 'the tallest column gets no write');
  // An unchanged value is not written again.
  h.callback([h.size(text.el, 1500)]);
  h.flush();
  assert.deepEqual(text.writes, ['top -616px']);
  // Once it fits, the inline value is removed.
  h.callback([h.size(text.el, 600)]);
  h.flush();
  assert.deepEqual(text.writes, ['top -616px', 'remove top']);
});

void test('removing a column clears its offset and stops observing it', () => {
  const h = harness();
  const viewport = h.element();
  const text = h.element();
  const code = h.element();
  h.layout.viewport(viewport.el);
  const stopText = h.layout.column(2, text.el);
  h.layout.column(2, code.el);
  h.callback([h.size(viewport.el, 800), h.size(text.el, 2000), h.size(code.el, 3000)]);
  h.flush();
  assert.deepEqual(text.writes, ['top -1216px']);
  stopText();
  assert.equal(h.observed.has(text.el), false);
  assert.deepEqual(text.writes, ['top -1216px', 'remove top']);
  h.layout.disconnect();
  assert.equal(h.observed.size, 0);
});
