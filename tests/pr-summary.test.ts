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

void test('stack readiness does not infer merge eligibility from checks or approval counts', () => {
  const member = {
    url: 'https://github.com/example/repo/pull/1',
    headSha: 'head',
    baseBranch: 'main',
    state: 'open',
    merged: false,
    isDraft: false,
  } as ReviewMember;
  const status = {
    mergeable: true,
    ciChecks: [{}],
    ciConclusion: 'success',
    reviewSummary: { approved: 2, changesRequested: 0 },
  } as PrStatus;
  assert.equal(memberReadiness(member), 'Readiness unknown');
  assert.equal(memberReadiness(member, status), 'Readiness unknown');
  assert.equal(memberReadiness(member, status, 'Rate limited'), 'Readiness unknown');
  assert.equal(memberReadiness({ ...member, merged: true }, status), 'Merged');
});
