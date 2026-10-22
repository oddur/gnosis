import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeInlineExplanations } from '../lib/inline-explanations';
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

void test('noise limits reject duplicate, nearby, excess-per-file, and excess-per-topic notes', () => {
  const at = (line: number, path = filePath) => ({
    ...note,
    filePath: path,
    line,
    code: `step${line}();`,
    text: `Specific consequence at ${path}:${line}.`,
  });
  const second = filePath.replace('-12/', '-13/');
  const third = filePath.replace('-12/', '-14/');
  const notes = normalizeInlineExplanations(
    [
      note,
      { ...note },
      { ...at(20), text: note.text.toUpperCase() },
      at(5),
      at(12),
      at(24),
      at(1, second),
      at(1, third),
    ],
    [hunk, { ...hunk, filePath: second }, { ...hunk, filePath: third }]
  );
  assert.deepEqual(notes, [note, at(12), at(1, second)]);
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
