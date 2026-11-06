import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildIndexedHunks, formatHunkIndexForPrompt } from '../lib/diff-parse';
import { buildPlannerContext } from '../lib/context-builder';
import { buildPlannerEvidence, PLANNER_EVIDENCE_BUDGET } from '../lib/review-planning';
import type { PrMetadata } from '../lib/types';

const diff = `diff --git a/session.ts b/session.ts
--- a/session.ts
+++ b/session.ts
@@ -1,3 +1,3 @@ validateSession
 function validateSession(session) {
-  return !!session;
+  return !!session && session.expires > Date.now();
 }
diff --git a/session.test.ts b/session.test.ts
--- a/session.test.ts
+++ b/session.test.ts
@@ -1 +1 @@
-expect(validateSession(expired)).toBe(true);
+expect(validateSession(expired)).toBe(false);
`;

void test('planner receives real implementation and test evidence with the complete hunk index', () => {
  const hunks = buildIndexedHunks(diff, {}, {});
  const context = buildPlannerContext(
    { title: 'Reject expired sessions', author: 'author', description: '', baseBranch: 'main' } as PrMetadata,
    [],
    formatHunkIndexForPrompt(hunks),
    undefined,
    undefined,
    hunks
  );
  assert.ok(context.includes('session.expires > Date.now()'));
  assert.ok(context.includes('expect(validateSession(expired)).toBe(false)'));
  assert.ok(context.includes('"scopeHint":"validateSession"'));
  assert.equal(context.match(/<hunk_index>/g)?.length, 1);
  assert.ok(context.includes('"omittedHunks":0'));
});

void test('large patches cannot starve other files or exceed the added source budget', () => {
  const base = buildIndexedHunks(diff, {}, {});
  const many = Array.from({ length: 600 }, (_, i) => ({
    ...base[0],
    id: `hunk-${i}`,
    content: '+"\\<&>'.repeat(8000),
  }));
  const evidence = buildPlannerEvidence([...many, { ...base[1], id: 'test-hunk' }]);
  assert.ok(evidence.length <= PLANNER_EVIDENCE_BUDGET);
  assert.ok(evidence.includes('"id":"test-hunk"'), 'Small test file survives a large implementation patch');
  assert.ok(evidence.includes('"complete":false'));
  const coverage = JSON.parse(evidence.split('\n')[2]) as { sampledHunks: number; omittedHunks: number };
  assert.equal(coverage.sampledHunks, evidence.match(/"id":/g)?.length);
  assert.equal(coverage.sampledHunks + coverage.omittedHunks, many.length + 1);
  assert.ok(coverage.omittedHunks > 0);
  assert.ok(evidence.includes('Missing excerpts are NOT unchanged or low-value code'));
});

void test('sampling remains bounded with many files and long metadata', () => {
  const base = buildIndexedHunks(diff, {}, {})[0];
  const hunks = Array.from({ length: 500 }, (_, i) => ({
    ...base,
    id: `hunk-${i}`,
    filePath: `src/${i}.ts`,
    content: '+x'.repeat(4000),
  }));
  const evidence = buildPlannerEvidence(hunks, 10_000);
  assert.ok(evidence.length <= 10_000);
  assert.ok(evidence.includes('"omittedHunks":'));
  const huge = buildPlannerEvidence([{ ...base, filePath: 'x'.repeat(100_000) }], 2000);
  assert.ok(huge.length <= 2000);
  assert.ok(huge.includes('"sampledHunks":0'));
  assert.throws(() => buildPlannerEvidence(hunks, 100));
});

void test('uneven file sizes do not omit hunks when the complete review fits the sample count', () => {
  const base = buildIndexedHunks(diff, {}, {});
  const hunks = Array.from({ length: 44 }, (_, i) => ({ ...base[0], id: `hunk-${i}` }));
  const evidence = buildPlannerEvidence([...hunks, { ...base[1], id: 'test-hunk' }]);
  assert.ok(evidence.includes('"sampledHunks":45'));
  assert.ok(evidence.includes('"omittedHunks":0'));
});
