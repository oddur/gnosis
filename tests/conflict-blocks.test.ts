import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyChoices,
  conflictCount,
  conflictLabels,
  conflictModel,
  inferChoices,
  parseConflicts,
  shortBranch,
} from '../lib/conflict-blocks';

const sha = (c: string) => c.repeat(40);
const file = [
  'export function retryDelay(attempt: number) {\n',
  '<<<<<<< feature/retry\n',
  '  return Math.min(attempt * 200, 5000);\n',
  '||||||| ancestor\n',
  '  return attempt * 200;\n',
  '=======\n',
  '  return Math.max(100, attempt * 200);\n',
  '>>>>>>> main\n',
  '}\n',
  `<<<<<<< ${sha('a')}\n`,
  'const a = 1;\n',
  '=======\n',
  'const a = 2;\n',
  `>>>>>>> ${sha('c')}\n`,
].join('');

void test('parses diff3 and two-way blocks without using marker labels', () => {
  const segments = parseConflicts(file);
  assert.deepEqual(
    segments.map((s) => s.kind),
    ['text', 'conflict', 'text', 'conflict']
  );
  const [, first, , second] = segments;
  assert.ok(first.kind === 'conflict' && second.kind === 'conflict');
  assert.equal(first.block.ours, '  return Math.min(attempt * 200, 5000);\n');
  assert.equal(first.block.base, '  return attempt * 200;\n');
  assert.equal(first.block.theirs, '  return Math.max(100, attempt * 200);\n');
  assert.equal(first.block.line, 2);
  assert.equal(second.block.base, undefined);
  assert.equal(second.block.line, 10);
  assert.equal(conflictCount(file), 2);
  // Text outside blocks round-trips exactly.
  assert.equal(applyChoices(segments, []), file);
  // An unfinished block is plain text, so the file still counts as conflicted elsewhere.
  assert.equal(conflictCount('<<<<<<< a\nx\n=======\n'), 0);
  // CRLF files keep their line endings.
  const crlf = '<<<<<<< a\r\nx\r\n=======\r\ny\r\n>>>>>>> b\r\n';
  assert.equal(applyChoices(parseConflicts(crlf), ['theirs']), 'y\r\n');
});

void test('choices apply per block and are recovered from a saved draft for Undo', () => {
  const segments = parseConflicts(file);
  const keptPr = applyChoices(segments, ['ours']);
  assert.match(keptPr, /Math\.min/);
  assert.doesNotMatch(keptPr, /Math\.max/);
  assert.equal(conflictCount(keptPr), 1);
  const both = applyChoices(segments, ['both', 'theirs']);
  assert.ok(both.indexOf('Math.min') < both.indexOf('Math.max'), 'Keep both puts the PR change first');
  assert.equal(conflictCount(both), 0);
  assert.deepEqual(inferChoices(segments, both), ['both', 'theirs']);
  assert.deepEqual(inferChoices(segments, keptPr), ['ours', undefined]);
  assert.deepEqual(inferChoices(segments, file), [undefined, undefined]);
  // Undo of one block keeps the other block's choice.
  assert.equal(
    applyChoices(segments, [undefined, 'theirs']),
    applyChoices(segments, []).replace(segments[3].kind === 'conflict' ? segments[3].block.raw : '', 'const a = 2;\n')
  );

  const model = conflictModel(file, both);
  assert.equal(model.undoable, true);
  assert.deepEqual(model.choices, ['both', 'theirs']);
  // A hand-edited draft works on its own remaining markers, without Undo for earlier blocks.
  const edited = keptPr.replace('export function', '// note\nexport function');
  const own = conflictModel(file, edited);
  assert.equal(own.undoable, false);
  assert.equal(own.source, edited);
  assert.equal(own.segments.filter((s) => s.kind === 'conflict').length, 1);
});

void test('labels name the PR and the base branch, never commit IDs', () => {
  const merge = conflictLabels('merge', { head: 'feature/retry', base: 'main' });
  assert.equal(merge.ours, 'This PR · feature/retry');
  assert.equal(merge.theirs, 'main');
  assert.equal(merge.base, 'Before both changes');
  assert.deepEqual(merge.keep, { ours: 'Keep PR change', theirs: 'Keep main’s change', both: 'Keep both' });
  assert.equal(merge.kept.ours, 'Kept PR change');
  const long = conflictLabels('merge', { head: 'x', base: 'release/2026-11-long-maintenance-branch' });
  assert.ok(long.keep.theirs.length <= 'Keep ’s change'.length + 24);
  assert.equal(long.theirs, 'release/2026-11-long-maintenance-branch');
  const restack = conflictLabels('restack', { head: 'feature/retry-121', base: 'feature/retry' });
  assert.equal(restack.ours, 'Updated parent · feature/retry');
  assert.equal(restack.theirs, 'This PR · feature/retry-121');
  assert.equal(shortBranch('abcdefghij', 5), 'ab…ij');
  for (const value of [merge, restack]) assert.doesNotMatch(JSON.stringify(value), /[0-9a-f]{12}/);
});
