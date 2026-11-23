import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { JSDOM } from 'jsdom';
import type * as ReactModule from 'react';

// `CloseWhenHidden` (components/PrActionControls.tsx, #542): an action popover closes when React <Activity> hides its
// workspace or the window loses focus, and never because its owner closed it normally.
const dom = new JSDOM('<!doctype html><body></body>', { pretendToBeVisual: true });
const g = globalThis as Record<string, unknown>;
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'MutationObserver'])
  Object.defineProperty(g, key, { value: (dom.window as unknown as Record<string, unknown>)[key], configurable: true });
g.IS_REACT_ACT_ENVIRONMENT = true;

let React: typeof ReactModule;
let createRoot: typeof import('react-dom/client').createRoot;
let CloseWhenHidden: typeof import('../components/PrActionControls').CloseWhenHidden;
before(async () => {
  React = await import('react');
  ({ createRoot } = await import('react-dom/client'));
  ({ CloseWhenHidden } = await import('../components/PrActionControls'));
});
const microtasks = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** A popover's content and its watcher, inside an Activity, as a PR workspace has them. */
function setup() {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const closes: number[] = [];
  const content = { current: null as HTMLDivElement | null };
  const render = async (open: boolean, mode: 'visible' | 'hidden' = 'visible') => {
    React.act(() => {
      root.render(
        <React.Activity mode={mode}>
          <CloseWhenHidden open={open} onClose={() => closes.push(1)} content={content} />
          {open && <div id="popup" ref={(node) => { content.current = node; }} />}
        </React.Activity>
      );
    });
    await microtasks();
  };
  return {
    render,
    closes,
    unmount: () => {
      React.act(() => {
        root.unmount();
      });
    },
  };
}

void test('a normal close never calls onClose', async () => {
  const { render, closes, unmount } = setup();
  await render(true);
  await render(false);
  assert.equal(closes.length, 0, 'The owner closed it: nothing to undo, no cancel after a merge or a step card');
  await render(true);
  await render(false);
  assert.equal(closes.length, 0);
  unmount();
});

void test('a hidden workspace closes its open popover, and hides it at once', async () => {
  const { render, closes, unmount } = setup();
  await render(true);
  const popup = document.getElementById('popup') as HTMLElement;
  await render(true, 'hidden');
  assert.equal(closes.length, 1);
  assert.equal(popup.style.display, 'none', 'Hidden in the same commit, so it never paints without its control');
  unmount();
});

void test('the window losing focus closes an open popover, and only an open one', async () => {
  const { render, closes, unmount } = setup();
  await render(true);
  window.dispatchEvent(new Event('blur'));
  assert.equal(closes.length, 1);
  await render(false);
  window.dispatchEvent(new Event('blur'));
  assert.equal(closes.length, 1, 'A closed popover does not listen');
  unmount();
});
