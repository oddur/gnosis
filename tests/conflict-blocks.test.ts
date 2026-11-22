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

void test('the Conflicts view diff shows a decided conflict as its result and an open one as its two sides', async () => {
  const { conflictDiffText } = await import('../lib/conflict-diff');
  const original = 'a\n<<<<<<< pr\nours\n=======\ntheirs\n>>>>>>> main\nb\n<<<<<<< pr\nx\n=======\n>>>>>>> main\nc\n';
  const open = conflictDiffText(conflictModel(original, original));
  // Open: the base branch's lines stand in, so the diff against the PR's file shows both sides. Never markers.
  assert.equal(open.after, 'a\ntheirs\nb\nc\n');
  assert.deepEqual(
    open.blocks.map(({ index, start, end, anchor }) => [index, start, end, anchor]),
    [
      [0, 2, 2, 2],
      // No lines on main's side: the card sits under the line before.
      [1, 4, 3, 3],
    ]
  );
  const kept = applyChoices(parseConflicts(original), ['ours', 'ours']);
  const decided = conflictDiffText(conflictModel(original, kept));
  assert.equal(decided.after, 'a\nours\nb\nx\nc\n');
  assert.deepEqual(decided.blocks.map((b) => [b.start, b.end, b.anchor]), [[2, 2, 2], [4, 4, 4]]);
  // A proposal shows its text.
  const proposals = [{ text: 'merged\n' }, null];
  const draft = applyChoices(parseConflicts(original), ['proposal', undefined], proposals);
  const proposed = conflictDiffText(conflictModel(original, draft, proposals), proposals);
  assert.match(proposed.after, /^a\nmerged\nb\n/);
});

void test('a card sits under the lines it decides: under the PR lines removed when its side shows none, at the top too', async () => {
  const { cardAnchors, conflictDiffText } = await import('../lib/conflict-diff');
  const { hunksFromDiff } = await import('../lib/diff-gaps');
  const { parseDiffFromFile } = await import('@pierre/diffs');
  const anchors = (original: string, ours: string) => {
    const shown = conflictDiffText(conflictModel(original, original));
    const hunks = hunksFromDiff(
      parseDiffFromFile({ name: 'a.ts', contents: ours }, { name: 'a.ts', contents: shown.after }, { context: 3 }, true)
    );
    return cardAnchors(shown.blocks, hunks).map(({ index, side, line }) => [index, side, line]);
  };
  // Block 1 removes the PR's `x` (old line 4) and main has no lines: its card sits under `x`, not under `b`.
  const original = 'a\n<<<<<<< pr\nours\n=======\ntheirs\n>>>>>>> main\nb\n<<<<<<< pr\nx\n=======\n>>>>>>> main\nc\n';
  assert.deepEqual(anchors(original, 'a\nours\nb\nx\nc\n'), [
    [0, 'additions', 2],
    [1, 'deletions', 4],
  ]);
  // At the top of the file: under the last PR line removed, never under a later line.
  const top = '<<<<<<< pr\nx\ny\n=======\n>>>>>>> main\nrest\n';
  assert.deepEqual(anchors(top, 'x\ny\nrest\n'), [[0, 'deletions', 2]]);
});

// Compare with (#445 item 9): the same draft against the PR's file, against main's, and as rows per conflict.
const compareOriginal =
  'a\n<<<<<<< pr\nours\n||||||| ancestor\nold\n=======\ntheirs\n>>>>>>> main\nb\n<<<<<<< pr\nx\n||||||| ancestor\n=======\n>>>>>>> main\nc\n';
const compareOurs = 'a\nours\nb\nx\nc\n';
const compareTheirs = 'a\ntheirs\nb\nc\n';
async function compareAnchors(draft: string, against: 'ours' | 'theirs', proposals?: { text: string }[]) {
  const { cardAnchors, conflictDiffText } = await import('../lib/conflict-diff');
  const { hunksFromDiff } = await import('../lib/diff-gaps');
  const { parseDiffFromFile } = await import('@pierre/diffs');
  const shown = conflictDiffText(conflictModel(compareOriginal, draft, proposals), proposals, against);
  const before = against === 'ours' ? compareOurs : compareTheirs;
  const hunks = hunksFromDiff(
    parseDiffFromFile({ name: 'a.ts', contents: before }, { name: 'a.ts', contents: shown.after }, { context: 3 }, true)
  );
  return {
    after: shown.after,
    anchors: cardAnchors(shown.blocks, hunks).map(({ index, side, line }) => [index, side, line]),
  };
}

void test('compare with PR: an open conflict shows main’s lines against the PR’s, each card under its lines', async () => {
  const open = await compareAnchors(compareOriginal, 'ours');
  // The default is PR: the same text as before item 9.
  const { conflictDiffText } = await import('../lib/conflict-diff');
  assert.equal(conflictDiffText(conflictModel(compareOriginal, compareOriginal)).after, open.after);
  assert.equal(open.after, 'a\ntheirs\nb\nc\n');
  assert.deepEqual(open.anchors, [
    [0, 'additions', 2],
    // main has no lines: under the PR's `x` it removes.
    [1, 'deletions', 4],
  ]);
});

void test('compare with main: an open conflict shows the PR’s lines against main’s, never no change', async () => {
  const open = await compareAnchors(compareOriginal, 'theirs');
  // Against main, main's lines would read as no change: the PR's stand in, so both sides still show.
  assert.equal(open.after, 'a\nours\nb\nx\nc\n');
  assert.notEqual(open.after, compareTheirs);
  assert.deepEqual(open.anchors, [
    [0, 'additions', 2],
    [1, 'additions', 4],
  ]);
  // Every conflict has a card place, in every mode.
  assert.equal(open.anchors.length, 2);
});

void test('compare with main: a card sits under main’s lines its conflict removes, at the top of a file too', async () => {
  const { cardAnchors, conflictDiffText } = await import('../lib/conflict-diff');
  const { hunksFromDiff } = await import('../lib/diff-gaps');
  const { parseDiffFromFile } = await import('@pierre/diffs');
  // The PR deleted x and y; main kept them. Open, against main, the conflict shows no lines and removes main's two.
  const top = '<<<<<<< pr\n=======\nx\ny\n>>>>>>> main\nrest\n';
  const shown = conflictDiffText(conflictModel(top, top), undefined, 'theirs');
  assert.equal(shown.after, 'rest\n');
  const hunks = hunksFromDiff(
    parseDiffFromFile(
      { name: 'a.ts', contents: 'x\ny\nrest\n' },
      { name: 'a.ts', contents: shown.after },
      { context: 3 },
      true
    )
  );
  assert.deepEqual(
    cardAnchors(shown.blocks, hunks).map(({ index, side, line }) => [index, side, line]),
    [[0, 'deletions', 2]]
  );
});

void test('compare with main: a decided conflict shows its result, under its lines even when it equals main', async () => {
  // Kept main's side in both: the result is main's file, so the diff has no change. The cards still sit under the
  // conflicts' lines (the first) or under the line before (the second, which keeps no lines), never nowhere.
  const keptMain = applyChoices(parseConflicts(compareOriginal), ['theirs', 'theirs']);
  const main = await compareAnchors(keptMain, 'theirs');
  assert.equal(main.after, compareTheirs);
  assert.deepEqual(main.anchors, [
    [0, 'additions', 2],
    [1, 'additions', 3],
  ]);
  // Kept the PR's side: what the PR still changes after the merge.
  const keptPr = applyChoices(parseConflicts(compareOriginal), ['ours', 'ours']);
  const pr = await compareAnchors(keptPr, 'theirs');
  assert.equal(pr.after, compareOurs);
  assert.deepEqual(pr.anchors, [
    [0, 'additions', 2],
    [1, 'additions', 4],
  ]);
  // A proposal shows its text against main too.
  const proposals = [{ text: 'merged\n' }, { text: 'x\n' }];
  const draft = applyChoices(parseConflicts(compareOriginal), ['proposal', 'proposal'], proposals);
  const proposed = await compareAnchors(draft, 'theirs', proposals);
  assert.equal(proposed.after, 'a\nmerged\nb\nx\nc\n');
  assert.deepEqual(proposed.anchors, [
    [0, 'additions', 2],
    [1, 'additions', 4],
  ]);
});

void test('compare with both: each conflict’s two sides and ancestor, and a result only once something is chosen', async () => {
  const { conflictCompareRows } = await import('../lib/conflict-diff');
  const open = conflictCompareRows(conflictModel(compareOriginal, compareOriginal));
  assert.deepEqual(open, [
    { index: 0, base: 'old\n', ours: 'ours\n', theirs: 'theirs\n' },
    { index: 1, base: '', ours: 'x\n', theirs: '' },
  ]);
  // Nothing chosen: no result row, so no version can pass for the result.
  assert.ok(open.every((row) => !('result' in row)));
  const proposals = [{ text: 'merged\n' }, null];
  const draft = applyChoices(parseConflicts(compareOriginal), ['proposal', 'both'], proposals);
  const rows = conflictCompareRows(conflictModel(compareOriginal, draft, proposals), proposals);
  assert.deepEqual(
    rows.map((row) => row.result),
    ['merged\n', 'x\n']
  );
  const { isCompareWith } = await import('../lib/conflict-diff');
  assert.ok(['pr', 'main', 'both'].every(isCompareWith));
  assert.equal(isCompareWith('theirs'), false);
  assert.equal(isCompareWith(null), false);
});

void test('compare with both: rows show every line of a 20-line conflict, even between changes far apart', async () => {
  const { compareRowContext } = await import('../lib/conflict-diff');
  const { hunksFromDiff } = await import('../lib/diff-gaps');
  const { parseDiffFromFile } = await import('@pierre/diffs');
  const base = Array.from({ length: 20 }, (_, i) => `line ${i + 1}\n`);
  const ours = ['changed 1\n', ...base.slice(1, 19), 'changed 20\n'];
  const before = base.join(''),
    after = ours.join('');
  const context = compareRowContext(before, after);
  assert.equal(context, 20);
  const hunks = hunksFromDiff(
    parseDiffFromFile({ name: 'a.ts', contents: before }, { name: 'a.ts', contents: after }, { context }, true)
  );
  // One hunk with every line of both versions: lines 5 to 16 are not hidden between the two changes.
  assert.equal(hunks.length, 1);
  const rows = hunks[0].rows;
  assert.deepEqual(
    rows.filter((r) => r.type !== '+').map((r) => r.text.replace(/\n$/, '')),
    base.map((l) => l.replace(/\n$/, ''))
  );
  assert.deepEqual(
    rows.filter((r) => r.type !== '-').map((r) => r.text.replace(/\n$/, '')),
    ours.map((l) => l.replace(/\n$/, ''))
  );
  // With the view's usual three lines of context, the middle would be cut out.
  const usual = hunksFromDiff(
    parseDiffFromFile({ name: 'a.ts', contents: before }, { name: 'a.ts', contents: after }, { context: 3 }, true)
  );
  assert.equal(usual.length, 2);
  assert.equal(compareRowContext('', ''), 1);
  assert.equal(compareRowContext('a\nb', 'a\n'), 2);
});

void test('compare with both: a row equal to the ancestor still shows every line, as unchanged context', async () => {
  const { compareRowContext, compareRowPins } = await import('../lib/conflict-diff');
  const { afterLines, hunksFromDiff, withPins } = await import('../lib/diff-gaps');
  const { parseDiffFromFile } = await import('@pierre/diffs');
  const text = 'const a = 1;\nconst b = 2;\nconst c = 3;\n';
  const hunks = hunksFromDiff(
    parseDiffFromFile(
      { name: 'a.ts', contents: text },
      { name: 'a.ts', contents: text },
      { context: compareRowContext(text, text) },
      true
    )
  );
  assert.equal(hunks.length, 0, 'the same text has no hunks');
  const shown = withPins(hunks, compareRowPins(hunks, text), afterLines(text));
  assert.equal(shown.length, 1);
  assert.deepEqual(
    shown[0].rows.map((r) => [r.type, r.text.replace(/\n$/, '')]),
    [
      [' ', 'const a = 1;'],
      [' ', 'const b = 2;'],
      [' ', 'const c = 3;'],
    ]
  );
  // A diff that didn't parse has no hunks either: the same pins show its lines.
  assert.deepEqual(compareRowPins([], 'x\ny'), [[1, 2]]);
  // A row with hunks, or no lines, needs no pins.
  assert.deepEqual(compareRowPins([], ''), []);
  assert.deepEqual(compareRowPins([{ oldStart: 1, newStart: 1, rows: [], noEofOld: false, noEofNew: false }], 'x\n'), []);
});

// Lines a resolver wrote (#445 item 10): result lines neither side had, marked in the Conflicts view.
void test('written lines: a combined or inserted line neither side had is marked, a side’s line never', async () => {
  const { writtenLines } = await import('../lib/conflict-diff');
  // Each side's added line, kept as it was: nothing marked.
  assert.deepEqual(
    writtenLines('call(a, {\n  retries,\n  timeout,\n});\n', 'call(a, {\n  retries,\n});\n', 'call(a, {\n  timeout,\n});\n'),
    []
  );
  // Mergiraf combined both edits into one line: only that line.
  assert.deepEqual(writtenLines('call(a, retries, timeout);\n', 'call(a, retries);\n', 'call(a, timeout);\n'), [0]);
  // An inserted line between the two sides' lines.
  assert.deepEqual(writtenLines('a\nseparator\nb\n', 'a\n', 'b\n'), [1]);
  // A re-indented line is a new line; a missing final line feed or a CR is not.
  assert.deepEqual(writtenLines('  a\nb', 'a\n', 'b\r\n'), [0]);
  // Both sides' lines, in any order and dropped or not, are theirs.
  assert.deepEqual(writtenLines('b\na\n', 'a\n', 'b\n'), []);
  assert.deepEqual(writtenLines('', 'a\n', 'b\n'), []);
});

void test('written lines: a repeated line is a side’s only as often as the sides have it, else every copy is marked', async () => {
  const { writtenLines } = await import('../lib/conflict-diff');
  // A union of two blocks that each end in `}`: two copies, both sides', none marked.
  assert.deepEqual(writtenLines('a\n}\nb\n}\n', 'a\n}\n', 'b\n}\n'), []);
  // One `}` more than both sides together: which copy is new can't be told, so every copy is marked.
  assert.deepEqual(writtenLines('a\n}\nb\n}\n}\n', 'a\n}\n', 'b\n}\n'), [1, 3, 4]);
  // A line only one side has once, written twice.
  assert.deepEqual(writtenLines('x\nx\n', 'x\n', 'y\n'), [0, 1]);
  // An ancestor line both sides removed is not a side's line.
  assert.deepEqual(writtenLines('old\n', 'new\n', 'other\n'), [0]);
});

void test('written lines: a whole-file proposal marks the lines neither whole side keeps, a moved line too', async () => {
  const { writtenFileLines } = await import('../lib/conflict-diff');
  const ours = 'import a\n\nfunction f() {\n  return 1;\n}\n\nfunction g() {}\n';
  const theirs = 'import a\nimport b\n\nfunction f() {\n  return 2;\n}\n';
  // main's import, the PR's g, and one line of f neither had.
  const result = 'import a\nimport b\n\nfunction f() {\n  return 1 + 2;\n}\n\nfunction g() {}\n';
  assert.deepEqual([...writtenFileLines(result, ours, theirs)], [5]);
  // A side's line moved to where neither side had it is marked: no diff keeps it in place.
  const moved = 'function g() {}\nimport a\nimport b\n\nfunction f() {\n  return 1;\n}\n';
  assert.ok(writtenFileLines(moved, ours, theirs).has(1));
  // A result that is one side has no marks.
  assert.equal(writtenFileLines(theirs, ours, theirs).size, 0);
});

void test('written lines: only proposal-filled conflicts mark lines, by their place in the shown file', async () => {
  const { conflictDiffText, conflictWritten, shownWritten } = await import('../lib/conflict-diff');
  const original =
    'head\n<<<<<<< pr\ncall(a, retries);\n=======\ncall(a, timeout);\n>>>>>>> main\nmid\n<<<<<<< pr\nx\n=======\ny\n>>>>>>> main\ntail\n';
  const segments = parseConflicts(original);
  const proposals = [{ text: 'call(a, retries, timeout);\n' }, { text: 'x\n' }];
  // Mergiraf combined conflict 1; conflict 2's proposal is a same-change one: the PR's lines, nothing marked.
  const draft = applyChoices(segments, ['proposal', 'proposal'], proposals);
  const model = conflictModel(original, draft, proposals);
  const written = conflictWritten(model, proposals);
  assert.deepEqual([...written], [[0, [0]]]);
  for (const against of ['ours', 'theirs'] as const) {
    const shown = conflictDiffText(model, proposals, against);
    assert.deepEqual([...shownWritten(shown.blocks, written)], [2], `against ${against}`);
  }
  // Keep removes the marks: a plain Keep, Keep both, or an open conflict writes nothing.
  for (const choice of ['ours', 'theirs', 'both', undefined] as const) {
    const kept = applyChoices(segments, [choice, 'proposal'], proposals);
    assert.equal(conflictWritten(conflictModel(original, kept, proposals), proposals).size, 0, String(choice));
  }
});

void test('written label: counts the lines in words', async () => {
  const { writtenLabel } = await import('../lib/conflict-diff');
  assert.equal(writtenLabel(1), '1 line written by Gnosis (neither side had it)');
  assert.equal(writtenLabel(3), '3 lines written by Gnosis (neither side had them)');
});
