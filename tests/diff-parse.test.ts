import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseUnifiedDiff } from '../lib/diff-parse';

const diff = [
  'diff --git a/new.ts b/new.ts',
  'new file mode 100644',
  'index 0000000..1111111',
  '--- /dev/null',
  '+++ b/new.ts',
  '@@ -0,0 +1,2 @@',
  '+export const a = 1;',
  '+export const b = 2;',
  'diff --git a/kept.ts b/kept.ts',
  'index 2222222..3333333 100644',
  '--- a/kept.ts',
  '+++ b/kept.ts',
  '@@ -1,2 +1,2 @@',
  ' const x = 1;',
  '-const y = 2;',
  '+const y = 3;',
  'diff --git a/gone.ts b/gone.ts',
  'deleted file mode 100644',
  'index 4444444..0000000',
  '--- a/gone.ts',
  '+++ /dev/null',
  '@@ -1 +0,0 @@',
  '-export const z = 0;',
  'diff --git a/after.ts b/after.ts',
  'index 5555555..6666666 100644',
  '--- a/after.ts',
  '+++ b/after.ts',
  '@@ -1 +1 @@',
  '-old',
  '+new',
  '',
].join('\n');

void test('each file in a diff gets its own status: one after an added or deleted file is modified', () => {
  const status = Object.fromEntries(parseUnifiedDiff(diff).map((hunk) => [hunk.filePath, hunk.fileStatus]));
  assert.deepEqual(status, { 'new.ts': 'added', 'kept.ts': 'modified', 'gone.ts': 'deleted', 'after.ts': 'modified' });
});
