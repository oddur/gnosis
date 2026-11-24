import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { JSDOM } from 'jsdom';
import type * as ReactModule from 'react';
import type { HeaderReview } from '../lib/pr-header-review';

// `useChangesHeaderReview` (lib/pr-header-review.ts, #352): Changes hands its drafts to the PR header while it shows.
// Leaving Changes and coming back must not render the PR page again when nothing the header shows changed.
const dom = new JSDOM('<!doctype html><body></body>', { pretendToBeVisual: true });
const g = globalThis as Record<string, unknown>;
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'MutationObserver'])
  Object.defineProperty(g, key, { value: (dom.window as unknown as Record<string, unknown>)[key], configurable: true });
g.IS_REACT_ACT_ENVIRONMENT = true;

let React: typeof ReactModule;
let createRoot: typeof import('react-dom/client').createRoot;
let lib: typeof import('../lib/pr-header-review');
before(async () => {
  React = await import('react');
  ({ createRoot } = await import('react-dom/client'));
  lib = await import('../lib/pr-header-review');
});

type Drafts = { count: number; blocked?: string };

/** A PR page with Changes kept in an Activity, as PrSummary has it, and what its header shows on each render. */
function setup() {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const pages: (HeaderReview | undefined)[] = [];
  const calls: string[] = [];
  function Changes({ drafts }: { drafts: Drafts }) {
    const toHeader = React.useContext(lib.PrHeaderReviewContext);
    React.useEffect(() => {
      toHeader?.({
        draftCount: drafts.count,
        draftsDisabled: false,
        reviewBlocked: drafts.blocked,
        toggleDrafts: () => calls.push(`toggle ${drafts.count}`),
        openReview: () => calls.push(`open ${drafts.count}`),
      });
      return () => toHeader?.(undefined);
    }, [toHeader, drafts.count, drafts.blocked]);
    return null;
  }
  const ChangesView = React.memo(Changes);
  function Page({ tab, drafts, mounted }: { tab: string; drafts: Drafts; mounted: boolean }) {
    const [review, receive] = lib.useChangesHeaderReview(tab === 'changes');
    pages.push(tab === 'changes' ? review : undefined);
    return (
      <lib.PrHeaderReviewContext.Provider value={receive}>
        <React.Activity mode={tab === 'changes' ? 'visible' : 'hidden'}>{mounted && <ChangesView drafts={drafts} />}</React.Activity>
      </lib.PrHeaderReviewContext.Provider>
    );
  }
  const render = (tab: string, drafts: Drafts, mounted = true) => {
    React.act(() => {
      root.render(<Page tab={tab} drafts={drafts} mounted={mounted} />);
    });
  };
  return { render, pages, calls, unmount: () => React.act(() => root.unmount()) };
}

void test('leaving Changes and coming back renders the page once for each switch', () => {
  const { render, pages, unmount } = setup();
  const drafts = { count: 2 };
  render('changes', drafts);
  assert.equal(pages.at(-1)?.draftCount, 2, 'the header shows Changes’ drafts');
  const shown = pages.length;
  render('checks', drafts);
  assert.equal(pages.length, shown + 1, 'hiding Changes takes its drafts back without another render');
  render('changes', drafts);
  assert.equal(pages.length, shown + 2, 'showing it again hands the same drafts over without another render');
  assert.equal(pages.at(-1)?.draftCount, 2, 'and the header shows them at once');
  unmount();
});

void test('the header follows changed drafts, and its buttons act on the latest hand-off', () => {
  const { render, pages, calls, unmount } = setup();
  render('changes', { count: 1 });
  render('changes', { count: 3, blocked: 'Sign in to review' });
  assert.equal(pages.at(-1)?.draftCount, 3);
  assert.equal(pages.at(-1)?.reviewBlocked, 'Sign in to review');
  pages.at(-1)?.toggleDrafts();
  pages.at(-1)?.openReview();
  assert.deepEqual(calls, ['toggle 3', 'open 3']);
  unmount();
});

void test('Changes gone while shown leaves the header without its drafts', () => {
  const { render, pages, unmount } = setup();
  render('changes', { count: 1 });
  render('changes', { count: 1 }, false);
  assert.equal(pages.at(-1), undefined, 'the header falls back to the summary’s drafts');
  unmount();
});
