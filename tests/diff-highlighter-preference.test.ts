import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveDiffHighlighter } from '../lib/diff-highlighter-preference';

void test('existing installs and invalid preferences keep Shiki', () => {
  for (const value of [undefined, null, '', 'removed-engine', 123, {}]) {
    assert.equal(resolveDiffHighlighter(value), 'shiki-js');
  }
});
void test('explicit settings override the trial environment in either direction', () => {
  assert.equal(resolveDiffHighlighter(undefined, 'highlights'), 'highlights');
  assert.equal(resolveDiffHighlighter('shiki-js', 'highlights'), 'shiki-js');
  assert.equal(resolveDiffHighlighter('highlights', 'shiki-js'), 'highlights');
});
