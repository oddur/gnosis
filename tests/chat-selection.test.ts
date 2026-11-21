import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chatSelectionLabel, diffSelectionRange, formatChatSelection, parseChatSelection } from '../lib/chat-selection';
import { chatQuestion } from '../lib/chat-context';
import { selectionStep } from '../lib/chat-trace';

void test('a selection carries its file and lines as its first line, and reads back', () => {
  const text = formatChatSelection({
    code: 'await queue.dispatch(command);\nreturn command.result;',
    path: 'src/queue.ts',
    side: 'after',
    startLine: 52,
    endLine: 40,
  });
  assert.equal(text, 'After lines 40–52 of src/queue.ts:\nawait queue.dispatch(command);\nreturn command.result;');
  assert.deepEqual(parseChatSelection(text), {
    code: 'await queue.dispatch(command);\nreturn command.result;',
    path: 'src/queue.ts',
    side: 'after',
    startLine: 40,
    endLine: 52,
  });
  assert.equal(
    formatChatSelection({ code: 'old()', side: 'before', startLine: 7, endLine: 7 }),
    'Before line 7:\nold()'
  );
  assert.equal(formatChatSelection({ code: 'x' }), 'x', 'No lines, no header');
  // Selections saved before locations: the Changes comment range, and plain topic selections.
  assert.deepEqual(parseChatSelection('After lines 3–4:\na\nb'), {
    code: 'a\nb',
    side: 'after',
    startLine: 3,
    endLine: 4,
  });
  assert.deepEqual(parseChatSelection('plain code'), { code: 'plain code' });
});

void test('the chip names the file and lines', () => {
  assert.equal(chatSelectionLabel(parseChatSelection('After lines 40–52 of src/queue.ts:\nx')), 'queue.ts · L40–52');
  assert.equal(chatSelectionLabel(parseChatSelection('After line 7:\nx'), 'src/worker.ts'), 'worker.ts · L7');
  assert.equal(chatSelectionLabel(parseChatSelection('x')), 'Selected code');
});

void test('a diff selection sits on the new side unless it holds only removed rows', () => {
  assert.deepEqual(
    diffSelectionRange([
      { line: 12, type: 'deletion' },
      { line: 14, type: 'addition' },
      { line: 15, type: 'context' },
    ]),
    { side: 'after', startLine: 14, endLine: 15 }
  );
  assert.deepEqual(
    diffSelectionRange([
      { line: 30, type: 'deletion' },
      { line: 31, type: 'deletion' },
    ]),
    { side: 'before', startLine: 30, endLine: 31 }
  );
  assert.equal(diffSelectionRange([{ line: 0, type: 'context' }]), undefined);
});

void test('the question tells the model where the selected code is', () => {
  const question = chatQuestion('Why?', 'After lines 40–41 of src/queue.ts:\nconst a = `x`;\nb();');
  assert.equal(
    question,
    'Regarding this code in src/queue.ts, new lines 40–41:\n```\nconst a = `x`;\nb();\n```\n\nWhy?'
  );
  assert.equal(chatQuestion('Why?', 'a ``` b'), 'Regarding this code:\n````\na ``` b\n````\n\nWhy?');
  assert.equal(chatQuestion('Why?'), 'Why?');
  const step = selectionStep('Before lines 3–5 of lib/old.ts:\na\nb\nc');
  assert.deepEqual(
    [step?.label, step?.path, step?.startLine, step?.endLine, step?.side, step?.detail],
    ['old.ts', 'lib/old.ts', 3, 5, 'before', '3 lines you selected']
  );
});
