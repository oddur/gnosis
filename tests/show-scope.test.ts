import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diffGaps, revealSpan, revealedParts, type GapHunk, type GapReveals } from '../lib/diff-gaps';
import { SCOPE_CONTEXT_BUDGET, SCOPE_JOIN_LINES, showScopePlan } from '../lib/show-scope';
import type { DefinitionKind, SyntaxDefinition } from '../lib/syntax-scope';

/** A 200-line file whose line n reads `line n`; each change rewrites one line, with three lines of context. */
function need<T>(value: T | undefined): T {
  assert.ok(value !== undefined);
  return value;
}
const LINES = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`);
function hunk(changed: number[]): GapHunk {
  const first = Math.max(1, changed[0] - 3),
    last = Math.min(LINES.length, changed[changed.length - 1] + 3);
  const rows: GapHunk['rows'] = [];
  for (let n = first; n <= last; n++)
    if (changed.includes(n)) rows.push({ type: '-', text: `old ${n}` }, { type: '+', text: LINES[n - 1] });
    else rows.push({ type: ' ', text: LINES[n - 1] });
  return { oldStart: first, newStart: first, rows, noEofOld: false, noEofNew: false };
}
const def = (kind: DefinitionKind, name: string, start: number, end: number, signatureEnd = start): SyntaxDefinition => ({
  kind,
  name,
  label: name,
  crumb: name,
  start,
  end,
  signatureEnd,
});
function plan(hunks: GapHunk[], after: SyntaxDefinition[], before?: SyntaxDefinition[]) {
  const gaps = need(diffGaps(hunks, LINES.length));
  const parts = revealedParts(hunks, gaps, {}, LINES);
  return { gaps, parts, plan: showScopePlan(parts, gaps, { after, before }) };
}
/** The new lines the diff shows once the plan's spans are revealed. */
function shownAfter(hunks: GapHunk[], after: SyntaxDefinition[]) {
  const { gaps, plan: shown } = plan(hunks, after);
  let reveals: GapReveals = {};
  for (const scope of shown) for (const [start, end] of scope.spans) reveals = revealSpan(reveals, gaps, start, end);
  const parts = revealedParts(hunks, gaps, reveals, LINES);
  return parts.flatMap((part) => (part.kind === 'hunk' ? [[part.hunk.newStart, part.hunk.newStart + part.hunk.rows.filter((r) => r.type !== '-').length - 1]] : []));
}

void test('The budget is one named constant: 10 lines above and 10 below; hunks of one definition join across 20', () => {
  assert.equal(SCOPE_CONTEXT_BUDGET, 10);
  assert.equal(SCOPE_JOIN_LINES, 20);
});

void test('A function whose rest is within the budget above and below shows whole', () => {
  // The change at line 50 shows 47–53; save() is 40–62: 7 lines above, 9 below.
  const save = def('function', 'save', 40, 62);
  const { plan: shown } = plan([hunk([50])], [save]);
  assert.deepEqual(shown.map((s) => [s.key, s.spans]), [['40-62', [[40, 46], [54, 62]]]]);
  assert.deepEqual(shownAfter([hunk([50])], [save]), [[40, 62]]);
});

void test('Exactly 10 lines above and below still fits; 11 on either side does not', () => {
  // The hunk shows 47–53.
  assert.equal(plan([hunk([50])], [def('function', 'edge', 37, 63)]).plan.length, 1, '10 and 10');
  assert.equal(plan([hunk([50])], [def('function', 'above', 36, 63)]).plan.length, 0, '11 above');
  assert.equal(plan([hunk([50])], [def('function', 'below', 37, 64)]).plan.length, 0, '11 below');
  // A long function with its change in the middle keeps plain context and Show whole function.
  assert.deepEqual(shownAfter([hunk([100])], [def('function', 'long', 60, 140)]), [[97, 103]]);
});

void test('Two hunks of one definition join when the lines between them are few, and keep their gap when not', () => {
  // Hunks at 50 and 66 show 47–53 and 63–69: 9 lines between them.
  const short = def('function', 'short', 42, 75);
  assert.deepEqual(plan([hunk([50]), hunk([66])], [short]).plan[0].spans, [[42, 46], [54, 62], [70, 75]]);
  assert.deepEqual(shownAfter([hunk([50]), hunk([66])], [short]), [[42, 75]], 'one continuous view of the function');
  // Hunks at 50 and 80 show 47–53 and 77–83: 23 lines between them, past the join; the ends still show.
  const long = def('function', 'apart', 42, 90);
  assert.deepEqual(plan([hunk([50]), hunk([80])], [long]).plan[0].spans, [[42, 46], [84, 90]]);
  assert.deepEqual(shownAfter([hunk([50]), hunk([80])], [long]), [[42, 53], [77, 90]]);
});

void test('The next definition out shows too while it still fits, and walking out stops at the first that does not', () => {
  // A short method in a short class: the whole class shows, and its method is inside it.
  const method = def('method', 'flush', 45, 56);
  const klass = def('class', 'Store', 40, 60);
  assert.deepEqual(plan([hunk([50])], [klass, method]).plan.map((s) => [s.definition.name, s.spans]), [['Store', [[40, 46], [54, 60]]]]);
  // The class is too long above: the method alone.
  const tall = def('class', 'Tall', 20, 60);
  assert.deepEqual(plan([hunk([50])], [tall, method]).plan.map((s) => s.definition.name), ['flush']);
  // A module around a class that does not fit is never shown, even though the module would be cheap from its end.
  const inner = def('function', 'inner', 30, 70);
  const module = def('module', 'm', 28, 72);
  assert.deepEqual(plan([hunk([50])], [module, inner]).plan, [], 'inner costs 17 above, so nothing outside it is tried');
});

void test('A definition already on screen adds nothing; a hunk outside every definition is left alone', () => {
  assert.deepEqual(plan([hunk([50])], [def('function', 'tiny', 48, 52)]).plan, []);
  assert.deepEqual(plan([hunk([50])], [def('function', 'elsewhere', 100, 110)]).plan, []);
});

void test('A hunk that only deletes uses the old file’s definition, in new line numbers', () => {
  // Line 50 is deleted: old 47–53 shows; new lines move up one after it. The old function is 40–60.
  const rows: GapHunk['rows'] = [
    ...[47, 48, 49].map((n) => ({ type: ' ' as const, text: LINES[n - 1] })),
    { type: '-', text: 'old 50' },
    ...[51, 52, 53].map((n) => ({ type: ' ' as const, text: LINES[n - 2] })),
  ];
  const deleting: GapHunk = { oldStart: 47, newStart: 47, rows, noEofOld: false, noEofNew: false };
  const gaps = need(diffGaps([deleting], LINES.length));
  const parts = revealedParts([deleting], gaps, {}, LINES);
  const shown = showScopePlan(parts, gaps, { after: [def('function', 'other', 150, 160)], before: [def('function', 'prune', 40, 60)] });
  assert.deepEqual(shown.map((s) => [s.definition.name, s.definition.start, s.definition.end, s.spans]), [['prune', 40, 59, [[40, 46], [53, 59]]]]);
});

void test('A definition holding a change the view leaves out is not shown', () => {
  const hunks = [hunk([50])];
  const gaps = need(diffGaps(hunks, LINES.length)).map((gap) => (gap.index === 1 ? { ...gap, opaque: true } : gap));
  const parts = revealedParts(hunks, gaps, {}, LINES);
  assert.deepEqual(showScopePlan(parts, gaps, { after: [def('function', 'save', 40, 62)] }), []);
});
