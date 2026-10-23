import test from 'node:test';
import assert from 'node:assert/strict';
import type { Root, Element } from 'hast';
import { scopeMarkdownHeadings } from '../lib/markdown-headings';
import { memberReadiness } from '../components/PrReadiness';
import type { ReviewMember } from '../lib/workbench';
import type { PrStatus } from '../lib/types';

void test('author headings are scoped beneath single-PR and stack sections without skipped levels', () => {
  for (const startLevel of [3, 4]) {
    const nodes: Element[] = ['h2', 'h4', 'h1', 'h6'].map((tagName) => ({
      type: 'element',
      tagName,
      properties: {},
      children: [],
    }));
    const tree: Root = { type: 'root', children: nodes };
    scopeMarkdownHeadings({ startLevel })(tree);
    assert.deepEqual(
      nodes.map((node) => node.tagName),
      [`h${startLevel}`, `h${startLevel + 1}`, `h${startLevel}`, `h${startLevel + 1}`]
    );
  }
});

void test('stack readiness never presents neutral, absent, or failed status as passed', () => {
  const member = { state: 'open', merged: false, isDraft: false } as ReviewMember;
  const status = {
    mergeable: true,
    ciChecks: [{}],
    ciConclusion: 'neutral',
    reviewSummary: { approved: 0, changesRequested: 0 },
  } as PrStatus;
  assert.equal(memberReadiness(member), 'Checks not loaded');
  assert.equal(memberReadiness(member, status), 'Checks need inspection');
  assert.equal(memberReadiness(member, { ...status, ciConclusion: 'failure' }), 'Checks failing');
  assert.equal(memberReadiness(member, { ...status, ciConclusion: 'success' }), 'Checks passed');
  assert.equal(memberReadiness(member, status, 'Rate limited'), 'Status unavailable');
  assert.equal(
    memberReadiness(member, { ...status, reviewSummary: { approved: 2, changesRequested: 1, commented: 0 } }),
    'Changes requested'
  );
});
