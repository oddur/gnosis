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
  // A re-indented line is a new line; a missing final line feed is not.
  assert.deepEqual(writtenLines('  a\nb', 'a\n', 'b\n'), [0]);
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

void test('written label: counts the lines in words and names who wrote them', async () => {
  const { fileWriter, writerOf, writtenLabel } = await import('../lib/conflict-diff');
  assert.equal(writtenLabel(1, 'structural merge'), '1 line written by structural merge (neither side had it)');
  assert.equal(writtenLabel(3, 'Claude'), '3 lines written by Claude (neither side had them)');
  // Gnosis is credited only for its own rules; an unknown writer is never called Gnosis.
  assert.equal(writtenLabel(1), '1 line written by a resolver (neither side had it)');
  assert.equal(writerOf('mergiraf'), 'structural merge');
  assert.equal(writerOf('model', 'Claude'), 'Claude');
  assert.equal(writerOf('model'), 'the model');
  assert.equal(writerOf('union'), 'Gnosis’s rule');
  assert.equal(writerOf('rerere'), 'you in an earlier merge');
  assert.equal(writerOf('manual'), 'a resolver');
  assert.equal(fileWriter({ wholeFile: { source: 'moved', text: '' }, source: 'manual' }), 'Gnosis’s rule');
  assert.equal(fileWriter({ source: 'agent' }), 'the model');
});

// Review round 1 of #493: the user's rule is "when in doubt, mark".
void test('written lines: a line ending is part of the line, so a resolver that changes CRLF to LF wrote that line', async () => {
  const { writtenLines, writtenFileLines } = await import('../lib/conflict-diff');
  assert.deepEqual(writtenLines('a\r\nb\n', 'a\n', 'b\n'), [0]);
  assert.deepEqual(writtenLines('a\n', 'a\r\n', 'b\r\n'), [0]);
  assert.deepEqual([...writtenFileLines('x\r\ny\n', 'x\ny\n', 'x\ny\n')], [1]);
});

void test('written lines: with no time to diff, the cautious rule compares with the side that has most copies, never the sum', async () => {
  const { writtenFileLines } = await import('../lib/conflict-diff');
  // `}` once on each side, twice in the result: the sum of the sides would explain both copies; the cautious rule
  // marks both.
  const spent = { until: 0 };
  assert.deepEqual([...writtenFileLines('a\n}\nb\n}\n', 'a\n}\n', 'b\n}\n', undefined, spent)], [2, 4]);
  // A spent budget's cautious marks are not kept: with time, the line diffs show each `}` is a side's.
  assert.deepEqual([...writtenFileLines('a\n}\nb\n}\n', 'a\n}\n', 'b\n}\n')], []);
});

void test('written lines: a suggestion’s marks stay after you keep a conflict, and the lines you type are never marked', async () => {
  const { draftWritten, resolverBaseline } = await import('../lib/conflict-diff');
  const original =
    'head\n<<<<<<< pr\ncall(a, retries);\n=======\ncall(a, timeout);\n>>>>>>> main\nmid\n<<<<<<< pr\nx\n=======\ny\n>>>>>>> main\ntail\n';
  const file = {
    original,
    ours: 'head\ncall(a, retries);\nmid\nx\ntail\n',
    theirs: 'head\ncall(a, timeout);\nmid\ny\ntail\n',
    proposals: undefined,
    wholeFile: undefined,
    source: 'agent' as const,
    // The suggestion combined conflict 1, rewrote `mid`, and left conflict 2 open.
    resolverText: 'head\ncall(a, retries, timeout);\nmid();\n<<<<<<< pr\nx\n=======\ny\n>>>>>>> main\ntail\n',
  };
  const baseline = resolverBaseline(file, file.resolverText);
  assert.deepEqual([...draftWritten(file, file.resolverText, baseline)], [2, 3]);
  // Keep the PR's side of conflict 2: the suggestion's lines stay marked, the kept side's line is the PR's.
  const kept = 'head\ncall(a, retries, timeout);\nmid();\nx\ntail\n';
  assert.deepEqual([...draftWritten(file, kept, baseline)], [2, 3]);
  // A line you typed, unsaved: never Gnosis's.
  const typed = 'head\ncall(a, retries, timeout);\nmid();\nx\n// mine\ntail\n';
  assert.deepEqual([...draftWritten(file, typed, baseline)], [2, 3]);
  // Without a resolver's text, a hand edit has no marks.
  assert.equal(draftWritten({ ...file }, typed, undefined).size, 0);
});

void test('written lines: the baseline is the resolver’s text, a whole-file proposal the draft still is, or every proposal applied', async () => {
  const { draftWritten, resolverBaseline } = await import('../lib/conflict-diff');
  const original = 'a\n<<<<<<< pr\ncall(a, retries);\n=======\ncall(a, timeout);\n>>>>>>> main\nb\n';
  const proposals = [{ source: 'mergiraf' as const, text: 'call(a, retries, timeout);\n' }];
  const ours = 'a\ncall(a, retries);\nb\n';
  const theirs = 'a\ncall(a, timeout);\nb\n';
  const applied = 'a\ncall(a, retries, timeout);\nb\n';
  assert.equal(resolverBaseline({ original, proposals, source: 'mergiraf' }, applied), applied);
  // Structural merge's per-conflict draft, then an edit by hand elsewhere: its combined line stays marked.
  const edited = 'a\ncall(a, retries, timeout);\nb\n// note\n';
  assert.deepEqual([...draftWritten({ original, ours, theirs, proposals }, edited, resolverBaseline({ original, proposals, source: 'mergiraf' }, edited))], [2]);
  // A whole-file proposal: marked in its preview (the same rule, with the proposal as the baseline) and once used.
  const whole = { source: 'moved' as const, text: 'a\ncall(a, retries, timeout);\nb\n' };
  assert.equal(resolverBaseline({ original, wholeFile: whole, source: 'manual' }, whole.text), whole.text);
  assert.equal(resolverBaseline({ original, wholeFile: whole, source: 'manual' }, original), undefined);
  assert.equal(resolverBaseline({ original, wholeFile: whole, resolverText: 'x\n', source: 'manual' }, original), 'x\n');
});

void test('written lines: a confirmation of 100 large whole-file drafts opens in 300 ms, its marks come as files mount', async () => {
  const { confirmGroups, confirmWritten } = await import('../lib/conflict-confirm');
  const { perfBudget, withinPerf } = await import('./perf-budget');
  // Different enough on each side that a full line diff is slow.
  const lines = (seed: number) => Array.from({ length: 4000 }, (_, i) => `const v${(i * seed) % 4001} = ${i};\n`).join('');
  const files = Array.from({ length: 100 }, (_, n) => {
    const original = `<<<<<<< pr\n${lines(3)}=======\n${lines(7)}>>>>>>> main\n`;
    const result = lines(11 + n);
    return {
      file: {
        path: `src/f${n}.ts`,
        mode: '100644',
        base: '',
        ours: lines(3),
        theirs: lines(7),
        original,
        result,
        resolved: true,
        source: 'agent' as const,
        resolverText: result,
      },
      buckets: [],
    };
  });
  const started = performance.now();
  const groups = confirmGroups(files, []);
  withinPerf('conflict confirmation, 100 large whole-file drafts: open', performance.now() - started, perfBudget(300));
  assert.equal(groups.decided.length, 100);
  assert.ok(groups.decided.every((f) => f.marks && !f.written.length), 'no line diff runs while the confirmation opens');
  // As the files mount, one shared budget bounds their diffs; past it they are marked cautiously, never left unmarked.
  const budget = { until: Date.now() + 300 };
  assert.ok(groups.decided.every((f) => confirmWritten(f, budget).length > 0), 'every file is still marked');
});

void test('written lines: a diff that timed out on its own is cached; only a spent shared budget is retried', async () => {
  const { writtenFileLines } = await import('../lib/conflict-diff');
  const lines = (seed: number) => Array.from({ length: 6000 }, (_, i) => `let w${(i * seed) % 6007} = ${i};\n`).join('');
  const [ours, theirs, result] = [lines(5), lines(13), lines(29)];
  writtenFileLines(result, ours, theirs);
  const again = performance.now();
  const cached = writtenFileLines(result, ours, theirs);
  assert.ok(performance.now() - again < 50, 'the second call reads the cache, timed out or not');
  assert.ok(cached.size > 0);
});

void test('pins are clipped to the gaps: a pin that crosses a hunk shows its lines on both sides of it', async () => {
  const { withPins } = await import('../lib/diff-gaps');
  const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}\n`);
  const hunk = { oldStart: 8, newStart: 8, rows: [{ type: '-' as const, text: 'old\n' }, { type: '+' as const, text: 'line 8\n' }], noEofOld: false, noEofNew: false };
  // Lines 5 to 12 pinned; the hunk shows line 8: 5–7 are pinned before it and 9–12 after it, none dropped.
  const shown = withPins([hunk], [[5, 12]], lines);
  assert.deepEqual(
    shown.map((h) => [h.newStart, h.rows.filter((r) => r.type !== '-').length]),
    [
      [5, 3],
      [8, 1],
      [9, 4],
    ]
  );
  // A pin inside the hunk adds nothing; one past the file's end is cut at its last line.
  assert.equal(withPins([hunk], [[8, 8]], lines).length, 1);
  assert.deepEqual(withPins([], [[19, 40]], lines).map((h) => [h.newStart, h.rows.length]), [[19, 2]]);
});

void test('a resolver’s text stays across a base move while the carried draft holds its lines', async () => {
  const { withResult } = await import('../lib/conflict-carry');
  const { draftWritten, resolverBaseline, holdsResolverLines } = await import('../lib/conflict-diff');
  const old = {
    path: 'a.ts',
    mode: '100644',
    base: 'a\n',
    ours: 'b\n',
    theirs: 'c\n',
    original: '<<<<<<< pr\nb\n=======\nc\n>>>>>>> main\n',
    result: 'b + c\n',
    resolved: false,
    source: 'agent' as const,
    resolverText: 'b + c\n',
  };
  // main moved: a fresh merge with a new line of main's, and the suggestion's draft carried over it.
  const next = { ...old, theirs: 'c\nd\n', original: '<<<<<<< pr\nb\n=======\nc\nd\n>>>>>>> main\n', result: '', resolverText: undefined, source: 'manual' as const };
  const carried = withResult(old, next, 'b + c\nd\n', false);
  assert.equal(carried.resolverText, 'b + c\n');
  assert.deepEqual([...draftWritten(carried, carried.result, resolverBaseline(carried, carried.result))], [1]);
  // A carried draft that no longer holds any of its lines drops it.
  assert.equal(withResult(old, next, 'b\nd\n', false).resolverText, undefined);
  assert.equal(holdsResolverLines('b\n', 'b\n', 'c\n', 'b\n'), false, 'a resolver text of side lines only holds none');
  // An older draft with no resolver text, a resolver's: cautious, every line neither side had.
  const older = { ...carried, resolverText: undefined, source: 'agent' as const };
  assert.deepEqual([...draftWritten(older, older.result, resolverBaseline(older, older.result))], [1]);
});

void test('slice fingerprint: rows with the same count and different text differ, and a row break is part of it', async () => {
  const { hunkFingerprint } = await import('../lib/diff-gaps');
  const rows = (...texts: string[]) => texts.map((text) => ({ type: '+', text }));
  assert.equal(hunkFingerprint(rows('a\n', 'b\n')), hunkFingerprint(rows('a\n', 'b\n')));
  assert.notEqual(hunkFingerprint(rows('call(a, timeout);\n')), hunkFingerprint(rows('call(a, retries);\n')));
  assert.notEqual(hunkFingerprint(rows('ab', 'c')), hunkFingerprint(rows('a', 'bc')));
  assert.notEqual(hunkFingerprint([{ type: '+', text: 'x' }]), hunkFingerprint([{ type: '-', text: 'x' }]));
});
