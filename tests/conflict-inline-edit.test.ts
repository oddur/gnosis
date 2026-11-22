import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyChoices,
  conflictModel,
  conflictSpan,
  editConflict,
  editText,
  onlyInSpan,
  parseConflicts,
  type ConflictBlock,
} from '../lib/conflict-blocks';
import { conflictCompareRows, conflictDiffText, conflictWritten, keptMarks } from '../lib/conflict-diff';
import { blockBuckets } from '../lib/conflict-verify';
import { hasConflictMarkers } from '../lib/conflict-resolution';

/** Two conflicts with text before, between and after them, as Git writes them. */
const original = [
  'export function retryDelay(attempt: number) {\n',
  '<<<<<<< feature/retry\n',
  '  return Math.min(attempt * 200, 5000);\n',
  '||||||| ancestor\n',
  '  return attempt * 200;\n',
  '=======\n',
  '  return Math.max(100, attempt * 200);\n',
  '>>>>>>> main\n',
  '}\n',
  '<<<<<<< feature/retry\n',
  'export const retries = 5;\n',
  '=======\n',
  'export const retries = 3;\n',
  '>>>>>>> main\n',
  '// end\n',
].join('');
const segments = parseConflicts(original);
const typed = '  return Math.min(Math.max(100, attempt * 200), 5000);\n';

void test('inline edit: Save puts the text into the conflict’s span only, and the other conflict keeps its choice', () => {
  const contents = applyChoices(segments, [undefined, 'theirs']);
  const model = conflictModel(original, contents);
  const span = conflictSpan(model, contents, 0);
  assert.ok(span);
  assert.equal(contents.slice(span.start, span.end), segments[1].kind === 'conflict' ? segments[1].block.raw : '');
  const result = editConflict(model, contents, 0, typed);
  assert.ok(result);
  assert.equal(
    result.contents,
    'export function retryDelay(attempt: number) {\n' + typed + '}\nexport const retries = 3;\n// end\n'
  );
  assert.ok(onlyInSpan(contents, result.contents, span), 'Nothing outside the span changed');
  // The edit is yours: it reads as an edit, and the other conflict keeps its Keep and its Undo.
  const after = conflictModel(original, result.contents, undefined, undefined, result.edits);
  assert.equal(after.undoable, true);
  assert.deepEqual(after.choices, ['edit', 'theirs']);
  assert.deepEqual(result.edit, { text: typed, before: undefined, pick: undefined });
  assert.equal(blockBuckets({ original }, result.contents, undefined, undefined, result.edits)[0], 'decided');
});

void test('inline edit: a change outside the span is refused', () => {
  const contents = applyChoices(segments, ['ours', 'theirs']);
  const model = conflictModel(original, contents);
  const span = conflictSpan(model, contents, 1);
  assert.ok(span);
  const inside = contents.slice(0, span.start) + 'export const retries = 4;\n' + contents.slice(span.end);
  assert.equal(onlyInSpan(contents, inside, span), true);
  // One character before the span, one after it, or text that runs past its end: each is refused.
  const before = contents.replace('export function', 'export async function');
  assert.equal(onlyInSpan(contents, before, span), false);
  const after = contents.replace('// end', '// done');
  assert.equal(onlyInSpan(contents, after, span), false);
  assert.equal(onlyInSpan(contents, contents.slice(0, span.start) + 'x\n', span), false, 'The text after the span went');
  assert.equal(onlyInSpan(contents, contents.slice(0, span.start - 1) + contents.slice(span.start), span), false);
  // A span that isn't in the text at all.
  assert.equal(onlyInSpan(contents, contents, { index: 1, start: 10, end: contents.length + 5 }), false);
});

void test('inline edit: a draft edited outside its conflicts can’t be edited conflict by conflict', () => {
  const contents = applyChoices(segments, ['ours', 'theirs']).replace('// end', '// changed by hand');
  const model = conflictModel(original, contents);
  assert.equal(model.undoable, false);
  assert.equal(conflictSpan(model, contents, 0), undefined);
  assert.equal(editConflict(model, contents, 0, typed), undefined);
  // A model that doesn't match the draft (the draft changed meanwhile) is refused too.
  const stale = conflictModel(original, applyChoices(segments, ['ours', 'theirs']));
  assert.equal(conflictSpan(stale, applyChoices(segments, ['theirs', 'theirs']), 0), undefined);
  assert.equal(editConflict(stale, applyChoices(segments, ['theirs', 'theirs']), 0, typed), undefined);
});

void test('inline edit: an edit after which the conflicts can’t be told apart is refused, and nothing changes', () => {
  // The edit ends with the text between the conflicts: the draft then reads as the first conflict's PR side and both
  // sides of the second as well, so the second conflict's choice could no longer be trusted.
  const source = '<<<<<<< a\nx\n=======\ny\n>>>>>>> b\nmid\n<<<<<<< a\nmid\n=======\nq\n>>>>>>> b\n';
  const split = parseConflicts(source);
  const contents = applyChoices(split, [undefined, 'theirs']);
  const model = conflictModel(source, contents);
  assert.equal(editConflict(model, contents, 0, 'x\nmid\n'), undefined);
  // A plain edit of the same conflict is fine.
  assert.ok(editConflict(model, contents, 0, 'z\n'));
});

void test('inline edit: Undo returns to the choice the first edit replaced, and your pick with it', () => {
  const proposals = [{ text: typed, source: 'mergiraf' as const }, null];
  const contents = applyChoices(segments, ['proposal', 'ours'], proposals);
  const picks = [undefined, 'ours' as const];
  const model = conflictModel(original, contents, proposals, picks);
  const first = editConflict(model, contents, 0, '  return 1;\n', proposals, picks);
  assert.ok(first);
  assert.deepEqual(first.edit, { text: '  return 1;\n', before: 'proposal', pick: undefined });
  const second = editConflict(
    conflictModel(original, first.contents, proposals, picks, first.edits),
    first.contents,
    0,
    '  return 2;\n',
    proposals,
    picks
  );
  assert.ok(second);
  assert.deepEqual(second.edit, { text: '  return 2;\n', before: 'proposal', pick: undefined }, 'A second edit keeps the first one’s Undo');
  // Editing a Keep: the pick it replaced comes back with Undo.
  const kept = editConflict(model, contents, 1, 'export const retries = 6;\n', proposals, picks);
  assert.ok(kept);
  assert.deepEqual(kept.edit, { text: 'export const retries = 6;\n', before: 'ours', pick: 'ours' });
  // Undo is the edit's `before`: the draft is the proposal again, and nothing else moved.
  const undone = applyChoices(segments, [second.edit.before, 'ours'], proposals);
  assert.equal(undone, contents);
});

void test('inline edit: conflict markers typed in an edit keep the conflict in Decide', () => {
  const contents = applyChoices(segments, [undefined, 'theirs']);
  const model = conflictModel(original, contents);
  const marked = editConflict(model, contents, 0, '<<<<<<< mine\n  return 1;\n=======\n  return 2;\n>>>>>>> theirs\n');
  assert.ok(marked);
  assert.equal(hasConflictMarkers(marked.contents), true, 'The file still has a marker: Mark reviewed stays off');
  assert.deepEqual(blockBuckets({ original }, marked.contents, undefined, undefined, marked.edits), ['decide', 'decided']);
  const after = conflictModel(original, marked.contents, undefined, undefined, marked.edits);
  assert.equal(conflictCompareRows(after)[0].result, undefined, 'Compare with both shows no result for it');
  // A lone marker line counts too.
  const lone = editConflict(model, contents, 0, '  return 1;\n=======\n');
  assert.ok(lone);
  assert.equal(blockBuckets({ original }, lone.contents, undefined, undefined, lone.edits)[0], 'decide');
  // Git's own conflict text typed back is the open conflict again, not an edit.
  const raw = segments[1].kind === 'conflict' ? segments[1].block.raw : '';
  const back = editConflict(model, contents, 0, raw);
  assert.ok(back);
  assert.deepEqual(conflictModel(original, back.contents, undefined, undefined, back.edits).choices, [undefined, 'theirs']);
});

void test('inline edit: your text keeps the file’s line endings and a final line break', () => {
  const block: ConflictBlock = { ours: 'a\r\n', theirs: 'b\r\n', raw: '', line: 1 };
  assert.equal(editText(block, 'a\r\n', 'x\ny'), 'x\r\ny\r\n');
  assert.equal(editText({ ...block, ours: 'a\n', theirs: 'b\n' }, 'a\n', 'x'), 'x\n');
  // Deleting every line removes the conflict's lines and nothing else.
  assert.equal(editText({ ...block, ours: 'a\n', theirs: 'b\n' }, 'a\n', ''), '');
  const contents = applyChoices(segments, ['ours', 'theirs']);
  const result = editConflict(conflictModel(original, contents), contents, 1, '');
  assert.ok(result);
  assert.equal(result.contents, contents.replace('export const retries = 3;\n', ''));
  // A last line without its line break never joins the line after the conflict.
  const joined = editConflict(conflictModel(original, contents), contents, 1, 'export const retries = 9;');
  assert.ok(joined);
  assert.match(joined.contents, /retries = 9;\n\/\/ end\n$/);
});

void test('inline edit: the diff shows your text; only the resolver’s lines you left as they were stay marked', () => {
  const proposal = '  const low = Math.max(100, attempt * 200);\n  return Math.min(low, 5000);\n';
  const proposals = [{ text: proposal, source: 'mergiraf' as const }, null];
  const contents = applyChoices(segments, ['proposal', 'theirs'], proposals);
  const model = conflictModel(original, contents, proposals);
  assert.deepEqual(conflictWritten(model, proposals).get(0), [0, 1], 'Both proposal lines are the resolver’s');
  // You change the second line and type a third: the first stays the resolver's, the others are yours.
  const text = '  const low = Math.max(100, attempt * 200);\n  return Math.min(low, 6000);\n  // checked\n';
  const result = editConflict(model, contents, 0, text, proposals);
  assert.ok(result);
  const written = keptMarks(proposal, [0, 1], result.edit.text);
  assert.deepEqual(written, [0]);
  const edits = [{ ...result.edit, written }];
  const after = conflictModel(original, result.contents, proposals, undefined, edits);
  assert.deepEqual(conflictWritten(after, proposals).get(0), [0]);
  const shown = conflictDiffText(after, proposals);
  assert.ok(shown.after.includes(text));
  assert.equal(shown.blocks[0].end - shown.blocks[0].start + 1, 3);
  // A line you typed that reads like the resolver's is still yours: nothing kept from it, nothing marked.
  assert.deepEqual(keptMarks('', [], proposal), []);
  assert.deepEqual(keptMarks('a\nb\n', [0, 1], 'b\na\n').length, 1, 'Only a line the diff keeps in place keeps its mark');
});
