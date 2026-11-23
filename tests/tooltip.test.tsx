import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { JSDOM } from 'jsdom';
import type * as ReactModule from 'react';

// The shared tooltip in a DOM, as the reported bug needs: React <Activity> hiding an open tooltip, controlled tooltips,
// focus the app moves, and what a screen reader reads from a closed tooltip.
const dom = new JSDOM('<!doctype html><body></body>', { pretendToBeVisual: true });
const g = globalThis as Record<string, unknown>;
for (const key of [
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'Element',
  'Node',
  'KeyboardEvent',
  'FocusEvent',
  'MouseEvent',
  'Event',
  'getComputedStyle',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'MutationObserver',
  'DOMRect',
  'CustomEvent',
  'HTMLButtonElement',
  'SVGElement',
  'Text',
])
  Object.defineProperty(g, key, { value: (dom.window as unknown as Record<string, unknown>)[key], configurable: true });
class NoResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
g.ResizeObserver = NoResizeObserver;
g.IS_REACT_ACT_ENVIRONMENT = true;

let React: typeof ReactModule;
let act: typeof ReactModule.act;
let flushSync: typeof import('react-dom').flushSync;
let createRoot: typeof import('react-dom/client').createRoot;
let ui: typeof import('../components/ui/tooltip');
let focusWithTooltip: typeof import('../components/ui/keyboard-focus').focusWithTooltip;

before(async () => {
  React = await import('react');
  act = React.act;
  ({ flushSync } = await import('react-dom'));
  ({ createRoot } = await import('react-dom/client'));
  ui = await import('../components/ui/tooltip');
  ({ focusWithTooltip } = await import('../components/ui/keyboard-focus'));
});

const shown = () =>
  [...document.querySelectorAll<HTMLElement>('[data-slot=tooltip-content]')].filter((n) => n.style.display !== 'none')
    .length;
const tab = () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }));
const byId = (id: string) => document.getElementById(id) as HTMLElement;
/** Commits one update outside act, as the app does, so a check sees only that commit and not the deferred ones. */
const hideNow = (update: () => void) => {
  g.IS_REACT_ACT_ENVIRONMENT = false;
  try {
    flushSync(update);
  } finally {
    g.IS_REACT_ACT_ENVIRONMENT = true;
  }
};
/** Runs a step inside act and lets its effects, microtasks included, settle. */
const run = (step: () => unknown) =>
  act(() => {
    step();
    return Promise.resolve();
  });

async function mount(element: ReactModule.ReactNode) {
  document.body.innerHTML = '';
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await run(() => root.render(element));
  return root;
}

function Tip({ id, open, log, describedBy }: { id: string; open?: boolean; log: string[]; describedBy?: string }) {
  const { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } = ui;
  return (
    <TooltipProvider>
      <Tooltip open={open} onOpenChange={(next) => log.push(String(next))}>
        <TooltipTrigger id={id} {...(describedBy ? { 'aria-describedby': describedBy } : {})}>
          trigger
        </TooltipTrigger>
        <TooltipContent>tip text</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

void test('focus the app moves opens no tooltip; keyboard focus does, in StrictMode too', async () => {
  const log: string[] = [];
  const root = await mount(
    <React.StrictMode>
      <Tip id="t" log={log} />
    </React.StrictMode>
  );
  await run(() => byId('t').focus());
  assert.equal(shown(), 0, 'programmatic focus');
  await run(() => byId('t').blur());
  await run(() => {
    tab();
    byId('t').focus();
  });
  assert.equal(shown(), 1, 'keyboard focus');
  await run(() => window.dispatchEvent(new Event('blur')));
  assert.equal(shown(), 0, 'window blur closes it');
  await run(() => root.unmount());
});

void test('a closed tooltip keeps its text for screen readers, unless the trigger has its own description', async () => {
  const root = await mount(
    <>
      <Tip id="a" log={[]} />
      <Tip id="b" log={[]} describedBy="own" />
    </>
  );
  const description = byId('a').getAttribute('aria-describedby');
  assert.ok(description, 'the closed trigger points to a description');
  assert.equal(byId(description).textContent, 'tip text');
  assert.equal(byId(description).hidden, true, 'the description is hidden, read only through the trigger');
  assert.equal(byId('b').getAttribute('aria-describedby'), 'own');
  await run(() => {
    tab();
    byId('a').focus();
  });
  const open = byId('a').getAttribute('aria-describedby') ?? '';
  assert.notEqual(open, description, 'the open tooltip describes the trigger');
  assert.ok(byId(open).textContent.includes('tip text'));
  await run(() => root.unmount());
});

void test('Activity hiding an open tooltip hides it in the same commit and closes it once', async () => {
  const log: string[] = [];
  let setMode!: (mode: 'visible' | 'hidden') => void;
  function Scope() {
    const [mode, set] = React.useState<'visible' | 'hidden'>('visible');
    setMode = set;
    return (
      <React.Activity mode={mode}>
        <Tip id="c" log={log} />
      </React.Activity>
    );
  }
  const root = await mount(<Scope />);
  await run(() => {
    tab();
    byId('c').focus();
  });
  assert.equal(shown(), 1);
  hideNow(() => setMode('hidden'));
  assert.equal(shown(), 0, 'nothing paints after the hiding commit');
  await run(() => {});
  assert.deepEqual(log, ['true', 'false'], 'closed once');
  await run(() => setMode('visible'));
  assert.equal(shown(), 0, 'still closed when shown again');
  await run(() => {
    byId('c').blur();
    tab();
    byId('c').focus();
  });
  assert.equal(shown(), 1, 'opens again afterwards');
  await run(() => root.unmount());
});

void test('a controlled tooltip: a parent close or unmount is not a hidden scope, and an ignored close keeps it watched', async () => {
  const log: string[] = [];
  let setOpen!: (open: boolean) => void;
  let setMode!: (mode: 'visible' | 'hidden') => void;
  function Parent() {
    const [open, set] = React.useState(false);
    const [mode, change] = React.useState<'visible' | 'hidden'>('visible');
    setOpen = set;
    setMode = change;
    return (
      <React.Activity mode={mode}>
        <Tip id="d" open={open} log={log} />
      </React.Activity>
    );
  }
  const root = await mount(<Parent />);
  await run(() => setOpen(true));
  assert.equal(shown(), 1);
  await run(() => setOpen(false));
  assert.equal(shown(), 0);
  assert.deepEqual(log, [], 'a parent close calls nothing back');
  await run(() => setOpen(true));
  // The parent ignores the close that window blur asks for; hiding the scope must still hide the tooltip.
  await run(() => window.dispatchEvent(new Event('blur')));
  assert.deepEqual(log, ['false']);
  hideNow(() => setMode('hidden'));
  assert.equal(shown(), 0, 'hidden with its scope');
  await run(() => setMode('visible'));
  await run(() => root.unmount());
  assert.deepEqual(log, ['false', 'false'], 'unmounting calls nothing back');
});

void test('focusWithTooltip shows the tooltip, also on a focused trigger, and leaves no keyboard state behind', async () => {
  const root = await mount(<Tip id="e" log={[]} />);
  await run(() => focusWithTooltip(null));
  await run(() => byId('e').focus());
  assert.equal(shown(), 0, 'a missing element leaves focus programmatic');
  await run(() => focusWithTooltip(byId('e')));
  assert.equal(shown(), 1, 'an already-focused trigger opens its tooltip');
  await run(() => {
    byId('e').blur();
    byId('e').focus();
  });
  assert.equal(shown(), 0, 'later programmatic focus still opens none');
  await run(() => root.unmount());
});
