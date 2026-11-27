import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { HERE_CSS, clearHere, markHere, markSection, reapplyHere } from '../lib/diff-here';

// lib/diff-here.ts runs in the page: give it the DOM globals it uses when it marks.
const dom = new JSDOM('<!doctype html><html><body></body></html>');
const globals = globalThis as unknown as Record<string, unknown>;
globals.ShadowRoot = dom.window.ShadowRoot;
globals.CSS ??= { escape: (value: string) => value.replace(/["\\]/g, '\\$&') };

/** A rendered split diff, as Pierre writes it: rows and gutter cells in each column, inside a shadow root. */
const columns = (lines: number[]) =>
  ['deletions', 'additions']
    .map(
      (side) =>
        `<div data-${side}><div data-gutter>${lines.map((n, i) => `<div data-column-number="${n}" data-line-index="${i},${i}">${n}</div>`).join('')}</div>` +
        `<div data-code>${lines.map((n, i) => `<div data-line="${n}" data-line-index="${i},${i}" data-line-type="context">line ${n}</div>`).join('')}</div></div>`
    )
    .join('');
function diff(html = columns([1, 2, 3, 4])) {
  const host = dom.window.document.createElement('diffs-container');
  dom.window.document.body.append(host);
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<div data-diff>${html}</div>`;
  return root;
}
/** The diff renders again, as Pierre does on any render of the component around it, and ChangesDiff's onPostRender runs. */
function render(root: ShadowRoot, html: string) {
  one(root, '[data-diff]').innerHTML = html;
  reapplyHere(root.host);
}
/** The one element `selector` finds in `root`. */
function one(root: ParentNode, selector: string): Element {
  const element = root.querySelector(selector);
  assert.ok(element, `Missing ${selector}`);
  return element;
}
const marked = (root: ShadowRoot) =>
  [...root.querySelectorAll('[data-here]:not([data-content-buffer], [data-gutter-buffer])')].map((e) => `${e.closest('[data-deletions]') ? 'old' : 'new'} ${e.hasAttribute('data-line') ? 'row' : 'gutter'} ${e.textContent}`);

void test('the band moves to the rows that replace the marked ones when the diff renders again', () => {
  const root = diff();
  const row = one(root, '[data-additions] [data-line="3"]');
  markHere([row]);
  assert.deepEqual(marked(root), ['new gutter 3', 'new row line 3']);
  render(root, columns([1, 2, 3, 4]));
  assert.equal(row.isConnected, false);
  assert.deepEqual(marked(root), ['new gutter 3', 'new row line 3'], 'The band shows on the new rows, in the same column');
  clearHere();
  assert.deepEqual(marked(root), [], 'Clearing ends it on the new rows');
  render(root, columns([1, 2, 3, 4]));
  assert.deepEqual(marked(root), [], 'A render after the band ended does not bring it back');
});

void test('a render that no longer shows the marked line drops the band there', () => {
  const root = diff();
  markHere([one(root, '[data-deletions] [data-line="2"]')]);
  // Other lines at the same line indexes, as when lines above are revealed.
  render(root, columns([10, 11, 12, 13]));
  assert.deepEqual(marked(root), [], 'No other line takes the band');
  clearHere();
});

void test('a re-applied band starts as far into its animation as the band has run, and elements that kept it are left alone', (t) => {
  let now = 1000;
  t.mock.method(performance, 'now', () => now);
  const root = diff();
  markHere([one(root, '[data-additions] [data-line="3"]')]);
  const delay = (selector: string) => (one(root, selector) as HTMLElement).style.getPropertyValue('--gnosis-here-delay');
  assert.equal(delay('[data-additions] [data-line="3"]'), '', 'The first rows start at the start');
  now += 700;
  // The code column renders anew; the gutter keeps its cells.
  one(root, '[data-additions] [data-code]').innerHTML = '<div data-line="3" data-line-index="2,2" data-line-type="context">line 3</div>';
  reapplyHere(root.host);
  assert.equal(delay('[data-additions] [data-line="3"]'), '-700ms', 'The new row starts 700 ms in, so it ends with the rest');
  assert.equal(delay('[data-additions] [data-column-number="3"]'), '', 'The gutter cell, never replaced, keeps its animation');
  assert.match(HERE_CSS, /animation-delay: var\(--gnosis-here-delay, 0ms\)/, 'The band reads the delay');
  clearHere();
  assert.equal(one(root, '[data-additions] [data-line="3"]').getAttribute('style'), null, 'Clearing removes the delay');
});

/**
 * A split diff where the new side adds line 3: the old column has an empty-row buffer across from it, in its code and
 * in its gutter. Line indexes are `unified,split`.
 */
const oneSided = () => {
  const old = [
    [1, 1, '0,0'],
    [2, 2, '1,1'],
    [3, 4, '3,3'],
  ] as const;
  const added = [
    [1, '0,0', 'context'],
    [2, '1,1', 'context'],
    [3, '2,2', 'change-addition'],
    [4, '3,3', 'context'],
  ] as const;
  const buffered = (items: string[]) => [...items.slice(0, 2), '%BUFFER%', ...items.slice(2)].join('');
  return (
    `<div data-deletions><div data-gutter>${buffered(old.map(([n, , i]) => `<div data-column-number="${n}" data-line-index="${i}">${n}</div>`)).replace('%BUFFER%', '<div data-gutter-buffer="buffer" data-buffer-size="1"></div>')}</div>` +
    `<div data-code>${buffered(old.map(([n, alt, i]) => `<div data-line="${n}" data-alt-line="${alt}" data-line-index="${i}" data-line-type="context">line ${n}</div>`)).replace('%BUFFER%', '<div data-content-buffer data-buffer-size="1"></div>')}</div></div>` +
    `<div data-additions><div data-gutter>${added.map(([n, i]) => `<div data-column-number="${n}" data-line-index="${i}">${n}</div>`).join('')}</div>` +
    `<div data-code>${added.map(([n, i, type]) => `<div data-line="${n}" data-line-index="${i}" data-line-type="${type}">line ${n}</div>`).join('')}</div></div>`
  );
};
/** The same lines as `columns`, unified: one code column, with its gutter inside it. */
const unifiedRows =
  `<div data-code><div data-gutter>${[1, 2, 3, 4].map((n, i) => `<div data-column-number="${n}" data-line-index="${i},${i}">${n}</div>`).join('')}</div>` +
  `<div data-content>${[1, 2, 3, 4].map((n, i) => `<div data-line="${n}" data-line-index="${i},${i}" data-line-type="context">line ${n}</div>`).join('')}</div></div>`;
const buffersMarked = (root: ShadowRoot) => [...root.querySelectorAll('[data-content-buffer][data-here], [data-gutter-buffer][data-here]')].length;

void test("a section's empty-row buffers keep the band when the diff renders again", () => {
  const root = diff(oneSided());
  markSection([root.host], { side: 'after', start: 3, end: 3, signatureEnd: 3 });
  assert.deepEqual(marked(root), ['new gutter 3', 'new row line 3']);
  assert.equal(buffersMarked(root), 2, 'The buffers across from the added line are marked');
  render(root, oneSided());
  assert.deepEqual(marked(root), ['new gutter 3', 'new row line 3']);
  assert.equal(buffersMarked(root), 2, 'The new buffers take the band too: no hole beside the added line');
  clearHere();
  assert.equal(buffersMarked(root), 0);
});

void test('a band on a unified row takes its line in both columns when the diff turns split', () => {
  const root = diff(unifiedRows);
  markHere([one(root, '[data-line="2"]')]);
  assert.deepEqual(marked(root), ['new gutter 2', 'new row line 2']);
  render(root, columns([1, 2, 3, 4]));
  assert.deepEqual(
    marked(root),
    ['old gutter 2', 'old row line 2', 'new gutter 2', 'new row line 2'],
    'The row spanned the view: in split it spans both columns, not the old one alone'
  );
  clearHere();
});

void test('a band in one column of a split diff keeps to that column, and goes to the row when the diff turns unified', () => {
  const root = diff();
  markHere([one(root, '[data-additions] [data-line="2"]')]);
  render(root, columns([1, 2, 3, 4]));
  assert.deepEqual(marked(root), ['new gutter 2', 'new row line 2'], 'Not the old column');
  render(root, unifiedRows);
  assert.deepEqual(marked(root), ['new gutter 2', 'new row line 2']);
  clearHere();
});
