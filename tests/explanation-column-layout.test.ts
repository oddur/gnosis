import assert from 'node:assert/strict';
import { test } from 'node:test';
import { columnSticks, columnTop, createColumnLayout } from '../lib/explanation-column-layout';

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

void test('only a column shorter than its row sticks, so scroll anchoring has the tallest to anchor in', () => {
  assert.equal(columnSticks(400, 2000), true);
  assert.equal(columnSticks(2000, 2000), false);
  assert.equal(columnSticks(0, 0), false);
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
    const attributes = new Set<string>();
    const el = {
      style: proxy,
      toggleAttribute(name: string, force: boolean) {
        writes.push(`${force ? 'set' : 'unset'} ${name}`);
        if (force) attributes.add(name);
        else attributes.delete(name);
        return force;
      },
      removeAttribute(name: string) {
        attributes.delete(name);
      },
    };
    return { el: el as unknown as HTMLElement, writes, attributes };
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
  assert.deepEqual(text.writes, ['set data-sticky', 'top -616px']);
  assert.deepEqual(code.writes, [], 'the tallest column gets no write and stays in normal flow');
  // An unchanged value is not written again.
  h.callback([h.size(text.el, 1500)]);
  h.flush();
  assert.deepEqual(text.writes, ['set data-sticky', 'top -616px']);
  // Once it fits, the inline value is removed; it still sticks.
  h.callback([h.size(text.el, 600)]);
  h.flush();
  assert.deepEqual(text.writes, ['set data-sticky', 'top -616px', 'remove top']);
  // When the narrative becomes the tallest, it stops sticking and the code column sticks instead.
  h.callback([h.size(text.el, 60_000)]);
  h.flush();
  assert.deepEqual(text.writes.slice(3), ['unset data-sticky']);
  assert.deepEqual(code.writes, ['set data-sticky', 'top -56116px']);
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
  assert.deepEqual(text.writes, ['set data-sticky', 'top -1216px']);
  stopText();
  assert.equal(h.observed.has(text.el), false);
  assert.deepEqual(text.writes, ['set data-sticky', 'top -1216px', 'remove top']);
  assert.equal(text.attributes.has('data-sticky'), false);
  h.layout.disconnect();
  assert.equal(h.observed.size, 0);
});
