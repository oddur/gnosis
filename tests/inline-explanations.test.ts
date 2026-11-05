import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  normalizeInlineExplanations,
  resolveGeneratedInlineExplanations,
  numberExplanationDiffs,
} from '../lib/inline-explanations';
import type { DiffHunk, InlineExplanation } from '../lib/types';

const filePath = 'PR-example~repo-12/src/queue.ts';
const hunk: DiffHunk = {
  filePath,
  hunkHeader: '@@ -1,30 +1,30 @@',
  language: 'typescript',
  renderedHtml: '',
  content: Array.from({ length: 30 }, (_, i) =>
    i === 3 ? '-return dispatch();\n+return await dispatch();' : ` step${i + 1}();`
  ).join('\n'),
};
const note: InlineExplanation = {
  filePath,
  line: 4,
  side: 'RIGHT',
  code: 'return await dispatch();',
  text: 'Awaiting dispatch keeps the queue slot occupied until the operation completes.',
};

void test('explanations require exact file, side, line, and source text, including stack identity', () => {
  const notes = normalizeInlineExplanations(
    [
      null,
      {},
      { ...note, line: '4' },
      { ...note, line: -1 },
      { ...note, line: 4.5 },
      { ...note, filePath: 'src/queue.ts' },
      { ...note, filePath: filePath.replace('-12/', '-13/') },
      { ...note, line: 99 },
      { ...note, side: 'LEFT' },
      { ...note, code: 'different source' },
      { ...note, code: '' },
      { ...note, text: '' },
      { ...note, text: 'x'.repeat(321) },
      { ...note, text: 'a '.repeat(46) },
      note,
    ],
    [hunk]
  );
  assert.deepEqual(notes, [note]);
  assert.deepEqual(normalizeInlineExplanations(undefined, [hunk]), []);
  assert.deepEqual(normalizeInlineExplanations({ notes: [note] }, [hunk]), []);
  const removed = { ...note, side: 'LEFT' as const, code: 'return dispatch();' };
  assert.deepEqual(normalizeInlineExplanations([removed], [hunk]), [removed]);
});

void test('distinct explanations survive close anchors and large counts; exact duplicate text is removed', () => {
  const at = (line: number, path = filePath) => ({
    ...note,
    filePath: path,
    line,
    code: `step${line}();`,
    text: `Specific consequence at ${path}:${line}.`,
  });
  const second = filePath.replace('-12/', '-13/');
  const third = filePath.replace('-12/', '-14/');
  const sameLine = { ...note, text: 'The finally block releases the slot on rejection as well as success.' };
  const notes = normalizeInlineExplanations(
    [
      note,
      { ...note },
      { ...at(20), text: note.text.toUpperCase() },
      sameLine,
      at(5),
      at(12),
      at(24),
      at(1, second),
      at(1, third),
    ],
    [hunk, { ...hunk, filePath: second }, { ...hunk, filePath: third }]
  );
  assert.deepEqual(notes, [note, sameLine, at(5), at(12), at(24), at(1, second), at(1, third)]);
});

void test('saved notes are dropped when their source changes; file status prevents wrong-side anchors', () => {
  assert.deepEqual(
    normalizeInlineExplanations(
      [note],
      [{ ...hunk, content: hunk.content.replace('+return await dispatch();', '+return retry();') }]
    ),
    []
  );
  const added = { ...hunk, hunkHeader: '@@ -1,1 +1,1 @@', content: '+return await dispatch();' };
  const moved = { ...note, line: 1 };
  assert.deepEqual(normalizeInlineExplanations([moved], [added], [{ filename: filePath, status: 'added' }]), [moved]);
  assert.deepEqual(
    normalizeInlineExplanations([{ ...moved, side: 'LEFT' }], [added], [{ filename: filePath, status: 'added' }]),
    []
  );
});

void test('newly generated notes repair unique exact quotes without relocating saved notes', () => {
  const wrong = { ...note, line: 99 };
  assert.deepEqual(resolveGeneratedInlineExplanations([wrong], [hunk]), [note]);
  assert.deepEqual(normalizeInlineExplanations([wrong], [hunk]), []);
  assert.deepEqual(resolveGeneratedInlineExplanations([{ ...wrong, side: 'LEFT' }], [hunk]), []);
  assert.deepEqual(resolveGeneratedInlineExplanations([{ ...wrong, filePath: 'src/queue.ts' }], [hunk]), []);
  assert.deepEqual(resolveGeneratedInlineExplanations([{ ...wrong, code: 'return dispatchLater();' }], [hunk]), []);
});

void test('repair does not guess between duplicate statements or punctuation-only anchors', () => {
  const duplicate = { ...hunk, hunkHeader: '@@ -100,1 +100,1 @@', content: '+return await dispatch();' };
  assert.deepEqual(resolveGeneratedInlineExplanations([{ ...note, line: 50 }], [hunk, duplicate]), []);
  assert.deepEqual(
    resolveGeneratedInlineExplanations([note], [hunk, duplicate]),
    [note],
    'An exact coordinate still disambiguates'
  );
  const punctuation = { ...hunk, content: '+});' };
  assert.deepEqual(resolveGeneratedInlineExplanations([{ ...note, line: 99, code: '});' }], [punctuation]), []);
});

void test('explicit changes take precedence over stale overlapping context regardless of hunk order', () => {
  const stale = { ...hunk, hunkHeader: '@@ -4,1 +4,1 @@', content: ' return dispatch();' };
  for (const hunks of [
    [hunk, stale],
    [stale, hunk],
  ]) {
    assert.deepEqual(normalizeInlineExplanations([note], hunks), [note]);
    assert.deepEqual(normalizeInlineExplanations([{ ...note, code: 'return dispatch();' }], hunks), []);
    const removed = { ...note, side: 'LEFT' as const, code: 'return dispatch();' };
    assert.deepEqual(normalizeInlineExplanations([removed], hunks), [removed]);
  }
});

void test('conflicting explicit source cannot validate or repair an anchor', () => {
  const conflict = { ...hunk, content: hunk.content.replace('+return await dispatch();', '+return retry();') };
  for (const hunks of [
    [hunk, conflict],
    [conflict, hunk],
  ]) {
    assert.deepEqual(normalizeInlineExplanations([note], hunks), []);
    assert.deepEqual(resolveGeneratedInlineExplanations([{ ...note, line: 99 }], hunks), []);
  }
  assert.deepEqual(
    resolveGeneratedInlineExplanations([{ ...note, line: 99 }], [hunk, hunk]),
    [note],
    'Repeated copies of the same coordinate are not ambiguity'
  );
});

void test('prompt coordinates match source sides across additions, removals, files and no-newline markers', () => {
  const input =
    '<diff_hunks>\n--- a.ts (modified) [hunk-0]\n@@ -9,2 +12,2 @@\n-old();\n+new();\n shared();\n--- b.ts (added) [hunk-1]\n@@ -0,0 +1,1 @@\n+created();\n\\ No newline at end of file\n</diff_hunks>';
  const result = numberExplanationDiffs(input);
  assert.ok(result.includes('[L:9 R:-] -old();'));
  assert.ok(result.includes('[L:- R:12] +new();'));
  assert.ok(result.includes('[L:10 R:13]  shared();'));
  assert.ok(result.includes('[L:- R:1] +created();'));
  assert.ok(result.includes('--- b.ts (added) [hunk-1]'));
  const full = numberExplanationDiffs(
    '<full_diff>\ndiff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1,1 +1,0 @@\n--- a SQL comment\n</full_diff>'
  );
  assert.ok(full.includes('[L:1 R:-] --- a SQL comment'), 'A removed SQL comment is not a file boundary');
  assert.equal(numberExplanationDiffs('plain source without a diff header'), 'plain source without a diff header');
});
