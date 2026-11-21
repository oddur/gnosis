import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { clearHere, markHere } from '../lib/diff-here';

// lib/diff-here.ts runs in the page: give it the DOM globals it uses when it marks.
const dom = new JSDOM('<!doctype html><html><body></body></html>');
const globals = globalThis as unknown as Record<string, unknown>;
globals.ShadowRoot = dom.window.ShadowRoot;
globals.MutationObserver = dom.window.MutationObserver;
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
function diff() {
  const host = dom.window.document.createElement('diffs-container');
  dom.window.document.body.append(host);
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<div data-diff>${columns([1, 2, 3, 4])}</div>`;
  return root;
}
/** The one element `selector` finds in `root`. */
function one(root: ParentNode, selector: string): Element {
  const element = root.querySelector(selector);
  assert.ok(element, `Missing ${selector}`);
  return element;
}
const marked = (root: ShadowRoot) =>
  [...root.querySelectorAll('[data-here]')].map((e) => `${e.closest('[data-deletions]') ? 'old' : 'new'} ${e.hasAttribute('data-line') ? 'row' : 'gutter'} ${e.textContent}`);
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

void test('the band moves to the rows that replace the marked ones when the diff renders again', async () => {
  const root = diff();
  const row = one(root, '[data-additions] [data-line="3"]');
  markHere([row]);
  assert.deepEqual(marked(root), ['new gutter 3', 'new row line 3']);
  // Any render of the component around the diff writes its rows anew.
  one(root, '[data-diff]').innerHTML = columns([1, 2, 3, 4]);
  await tick();
  assert.equal(row.isConnected, false);
  assert.deepEqual(marked(root), ['new gutter 3', 'new row line 3'], 'The band shows on the new rows');
  clearHere();
  assert.deepEqual(marked(root), [], 'Clearing ends it on the new rows');
  one(root, '[data-diff]').innerHTML = columns([1, 2, 3, 4]);
  await tick();
  assert.deepEqual(marked(root), [], 'A render after the band ended does not bring it back');
});

void test('a render that no longer shows the marked line drops the band there', async () => {
  const root = diff();
  markHere([one(root, '[data-deletions] [data-line="2"]')]);
  one(root, '[data-diff]').innerHTML = columns([10, 11, 12, 13]);
  await tick();
  assert.deepEqual(marked(root), [], 'No other line takes the band');
  clearHere();
});
