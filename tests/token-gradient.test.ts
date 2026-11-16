import assert from 'node:assert/strict';
import { test } from 'node:test';
import { flattenLine, type Hast } from '../lib/token-gradient';

// A line of code becomes one text node colored by a gradient, so the accessibility tree has one text node a line
// instead of one a token (#366). tests/diff-gaps-browser.ts checks the rendered lines and the accessibility work.
const token = (value: string, style?: string, extra: Record<string, unknown> = {}): Hast => ({
  type: 'element',
  tagName: 'span',
  properties: { ...(style ? { style } : {}), ...extra },
  children: [{ type: 'text', value }],
});
const line = (...children: Hast[]): Hast => ({ type: 'element', tagName: 'div', properties: { 'data-line': 1 }, children });

test('a line of colored tokens becomes one text node with the colors as columns', () => {
  const node = line(token('export', 'color:#F97583'), token(' function', 'color:#F97583'), token(' f', 'color:#B392F0'), token('();'));
  flattenLine(node);
  assert.deepEqual(node.children, [
    {
      type: 'element',
      tagName: 'span',
      properties: {
        'data-tokens': '',
        style: 'background-image:linear-gradient(90deg,#F97583 0ch 15ch,#B392F0 15ch 17ch,var(--diffs-fg) 17ch 20ch)',
      },
      children: [{ type: 'text', value: 'export function f();' }],
    },
  ]);
});

test('a line of exactly 200 columns is still flattened', () => {
  const node = line(token('x'.repeat(150), 'color:#111111'), token('y'.repeat(50), 'color:#222222'));
  flattenLine(node);
  assert.equal(node.children?.length, 1);
});

test('a final newline takes no column', () => {
  const node = line(token('a', 'color:#111111'), token('b\n', 'color:#222222'));
  flattenLine(node);
  assert.equal(node.children?.[0].children?.[0].value, 'ab\n');
  assert.match(String(node.children?.[0].properties?.style), /#222222 1ch 2ch\)$/);
});

test('lines whose columns or styles a gradient cannot follow keep their tokens', () => {
  const cases: [string, Hast][] = [
    ['a tab', line(token('\tx', 'color:#111111'), token('y', 'color:#222222'))],
    ['a wide character', line(token('名', 'color:#111111'), token('y', 'color:#222222'))],
    ['italic', line(token('x', 'color:#111111;font-style:italic'), token('y', 'color:#222222'))],
    ['an inline change mark', line(token('x', 'color:#111111', { 'data-diff-span': '' }), token('y', 'color:#222222'))],
    ['one color', line(token('x', 'color:#111111'), token('y', 'color:#111111'))],
    ['more than 200 columns', line(token('x'.repeat(150), 'color:#111111'), token('y'.repeat(51), 'color:#222222'))],
  ];
  for (const [name, node] of cases) {
    const before = structuredClone(node.children);
    flattenLine(node);
    assert.deepEqual(node.children, before, name);
  }
});

test('lines that are not code lines are left alone', () => {
  const node: Hast = { type: 'element', tagName: 'div', properties: {}, children: [token('x', 'color:#111111'), token('y', 'color:#222222')] };
  const before = structuredClone(node.children);
  flattenLine(node);
  assert.deepEqual(node.children, before);
});
