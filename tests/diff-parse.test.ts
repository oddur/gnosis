import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildIndexedHunks, expandFullDiff, expandHunkContext, parseUnifiedDiff } from '../lib/diff-parse';

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

// ── Expanded context ─────────────────────────────────────────────

const numbered = (count: number, label = 'line') => Array.from({ length: count }, (_, i) => `${label} ${i + 1}`);

/**
 * One hunk: base lines [from, to) (0-based) become `replacement` in head,
 * with 3 lines of git context. `shift` is head minus base before the change.
 */
function hunkText(base: string[], from: number, to: number, replacement: string[], shift: number) {
  const before = base.slice(Math.max(0, from - 3), from);
  const after = base.slice(to, to + 3);
  const baseCount = before.length + (to - from) + after.length;
  const headCount = before.length + replacement.length + after.length;
  return [
    `@@ -${from - before.length + 1},${baseCount} +${from + shift - before.length + 1},${headCount} @@`,
    ...before.map((l) => ' ' + l),
    ...base.slice(from, to).map((l) => '-' + l),
    ...replacement.map((l) => '+' + l),
    ...after.map((l) => ' ' + l),
  ];
}

const fileDiff = (path: string, hunks: string[][]) =>
  [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, ...hunks.flat(), ''].join('\n');

/** Every row agrees with the base and head text at its numbers, and the header counts match the rows. */
function assertExpandedTruth(header: string, content: string, base: string[], head: string[]) {
  const m = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@/.exec(header);
  assert.ok(m, header);
  let oldLine = Number(m[1]);
  let newLine = Number(m[3]);
  let oldCount = 0;
  let newCount = 0;
  for (const row of content.split('\n')) {
    const text = row.slice(1);
    if (row[0] === ' ' || row[0] === '-') {
      assert.equal(base[oldLine - 1], text, `old ${oldLine} in ${header}`);
      oldLine++;
      oldCount++;
    }
    if (row[0] === ' ' || row[0] === '+') {
      assert.equal(head[newLine - 1], text, `new ${newLine} in ${header}`);
      newLine++;
      newCount++;
    }
  }
  assert.equal(oldCount, Number(m[2]), `old count in ${header}`);
  assert.equal(newCount, Number(m[4]), `new count in ${header}`);
}

/** Expand per hunk (Explanation) and as a whole diff (the prompt), and check both. */
function expandBoth(diff: string, path: string, base: string[], head: string[]) {
  const before = { [path]: base.join('\n') + '\n' };
  const after = { [path]: head.join('\n') + '\n' };
  const hunks = buildIndexedHunks(diff, before, after);
  for (const hunk of hunks) assertExpandedTruth(hunk.expandedHunkHeader, hunk.expandedContent, base, head);
  const full = expandFullDiff(diff, before, after);
  for (const hunk of hunks) assert.ok(full.includes(`${hunk.expandedHunkHeader}\n${hunk.expandedContent}`));
  return hunks;
}

void test('context above a hunk is numbered on both sides when a removal sits a few lines above it', () => {
  const base = numbered(300);
  const big = numbered(240, 'changed');
  // Remove lines 3-5, then change lines 20-259: 8 unchanged lines lie between the hunks.
  const head = [...base.slice(0, 2), ...base.slice(5, 19), ...big, ...base.slice(259)];
  const diff = fileDiff('f.ts', [hunkText(base, 2, 5, [], 0), hunkText(base, 19, 259, big, -3)]);
  const hunks = expandBoth(diff, 'f.ts', base, head);
  assert.equal(hunks.length, 2);
  // Context stops at the removal hunk: old 9-16 is new 6-13. Then 12 lines follow.
  assert.equal(hunks[1].expandedHunkHeader, '@@ -9,266 +6,266 @@');
  assert.equal(hunks[1].expandedContent.split('\n')[0], ' line 9');
  // The removal hunk is at the top of the file; its context below stops at the big hunk.
  assert.equal(hunks[0].expandedHunkHeader, '@@ -1,16 +1,13 @@');

  // Without the neighbours, the context is still true on both sides.
  const alone = expandHunkContext(parseUnifiedDiff(diff)[1], { 'f.ts': base.join('\n') }, { 'f.ts': head.join('\n') });
  assertExpandedTruth(alone.expandedHunkHeader, alone.expandedContent, base, head);
});

void test('context below a hunk stops at a neighbouring hunk a few lines further down', () => {
  const base = numbered(300);
  const big = numbered(240, 'changed');
  // Change lines 21-260, then remove lines 269-271: 8 unchanged lines lie between the hunks.
  const head = [...base.slice(0, 20), ...big, ...base.slice(260, 268), ...base.slice(271)];
  const diff = fileDiff('f.ts', [hunkText(base, 20, 260, big, 0), hunkText(base, 268, 271, [], 0)]);
  const hunks = expandBoth(diff, 'f.ts', base, head);
  assert.equal(hunks[0].expandedHunkHeader, '@@ -6,260 +6,260 @@');
  assert.equal(hunks[1].expandedHunkHeader, '@@ -264,23 +264,20 @@');
});

void test('a hunk at the end of a file gets no context past the last line', () => {
  const base = numbered(40);
  const head = [...base.slice(0, 38), 'line 39 changed', 'line 40 changed'];
  const diff = fileDiff('end.ts', [hunkText(base, 38, 40, head.slice(38), 0)]);
  const [hunk] = expandBoth(diff, 'end.ts', base, head);
  assert.equal(hunk.expandedHunkHeader, '@@ -24,17 +24,17 @@');
  assert.ok(hunk.expandedContent.endsWith('+line 40 changed'));
});

void test('added and deleted files keep their hunk as it is', () => {
  const lines = numbered(5);
  const diff = [
    'diff --git a/new.ts b/new.ts',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/new.ts',
    '@@ -0,0 +1,5 @@',
    ...lines.map((l) => '+' + l),
    'diff --git a/gone.ts b/gone.ts',
    'deleted file mode 100644',
    '--- a/gone.ts',
    '+++ /dev/null',
    '@@ -1,5 +0,0 @@',
    ...lines.map((l) => '-' + l),
    '',
  ].join('\n');
  const text = lines.join('\n') + '\n';
  const before = { 'gone.ts': text, 'new.ts': '' };
  const after = { 'new.ts': text, 'gone.ts': '' };
  assert.deepEqual(
    buildIndexedHunks(diff, before, after).map((h) => [
      h.filePath,
      h.expandedHunkHeader,
      h.expandedContent === h.content,
    ]),
    [
      ['new.ts', '@@ -0,0 +1,5 @@', true],
      ['gone.ts', '@@ -1,5 +0,0 @@', true],
    ]
  );
  assert.equal(expandFullDiff(diff, before, after), diff.replace(/\n$/, ''));
});
