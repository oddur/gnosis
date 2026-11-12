import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { createResizeActivity, RESIZE_SETTLE_MS } from '../lib/resize-activity';

function setup() {
  mock.timers.enable({ apis: ['setTimeout'] });
  const target = new EventTarget();
  const observers: { callback: ResizeObserverCallback; observed: Set<Element> }[] = [];
  const activity = createResizeActivity({
    target,
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (handle) => {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    },
    createObserver: (callback) => {
      const record = { callback, observed: new Set<Element>() };
      observers.push(record);
      return {
        observe: (element: Element) => void record.observed.add(element),
        unobserve: (element: Element) => void record.observed.delete(element),
        disconnect: () => record.observed.clear(),
      } as unknown as ResizeObserver;
    },
  });
  const resize = () => target.dispatchEvent(new Event('resize'));
  const entry = (target: Element, width: number) =>
    ({ target, contentRect: { width } }) as unknown as ResizeObserverEntry;
  const fire = (...entries: ResizeObserverEntry[]) =>
    observers[observers.length - 1].callback(entries, {} as ResizeObserver);
  return { activity, resize, entry, fire, observers };
}

void test('settled callbacks run once, 120 ms after the last window resize', (t) => {
  const { activity, resize } = setup();
  t.after(() => mock.timers.reset());
  let settled = 0;
  activity.onResizeSettled(() => settled++);
  assert.equal(activity.isResizing(), false);
  resize();
  assert.equal(activity.isResizing(), true);
  mock.timers.tick(RESIZE_SETTLE_MS - 1);
  resize();
  mock.timers.tick(RESIZE_SETTLE_MS - 1);
  assert.equal(settled, 0, 'each resize restarts the wait');
  mock.timers.tick(1);
  assert.equal(settled, 1);
  assert.equal(activity.isResizing(), false);
});

void test('a settled observer passes entries through at once when the window is not resizing', (t) => {
  const { activity, entry, fire } = setup();
  t.after(() => mock.timers.reset());
  const seen: number[][] = [];
  activity.settledObserver((entries) => seen.push(entries.map((e) => e.contentRect.width)));
  const pane = {} as Element;
  fire(entry(pane, 300));
  assert.deepEqual(seen, [[300]], 'opening a pane stays instant');
});

void test('during a window resize only the latest entry per element arrives, after it settles', (t) => {
  const { activity, resize, entry, fire } = setup();
  t.after(() => mock.timers.reset());
  const seen: number[][] = [];
  const observer = activity.settledObserver((entries) => seen.push(entries.map((e) => e.contentRect.width)));
  const a = {} as Element;
  const b = {} as Element;
  observer.observe(a);
  observer.observe(b);
  for (const width of [900, 860, 820]) {
    resize();
    fire(entry(a, width), entry(b, width / 2));
    mock.timers.tick(16);
  }
  assert.deepEqual(seen, []);
  mock.timers.tick(RESIZE_SETTLE_MS);
  assert.deepEqual(seen, [[820, 410]]);
  // Nothing is delivered twice, and a disconnected observer drops what it held.
  resize();
  fire(entry(a, 700));
  observer.disconnect();
  mock.timers.tick(RESIZE_SETTLE_MS);
  assert.deepEqual(seen, [[820, 410]]);
});
