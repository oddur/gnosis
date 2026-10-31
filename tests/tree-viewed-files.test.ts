import { test } from 'node:test';
import assert from 'node:assert/strict';
import { treeViewedFiles } from '../lib/tree-viewed-files';
const entries = [
  '01 · repo #1/src/a.ts',
  '01 · repo #1/src/nested/b.ts',
  '01 · repo #1/src-other/c.ts',
  '02 · repo #2/src/a.ts',
].map((key) => ({ key }));
void test('a folder includes descendants, but not adjacent prefixes or other PRs', () => {
  assert.deepEqual(treeViewedFiles(entries, { kind: 'directory', path: '01 · repo #1/src/' }), entries.slice(0, 2));
  assert.deepEqual(treeViewedFiles(entries, { kind: 'directory', path: '01 · repo #1/src' }), entries.slice(0, 2));
});
void test('search narrows the already filtered inventory, without expanding collapsed folders', () => {
  assert.deepEqual(
    treeViewedFiles(entries, { kind: 'directory', path: '01 · repo #1/src/' }, new Set([entries[1].key])),
    [entries[1]]
  );
  assert.deepEqual(treeViewedFiles(entries, { kind: 'directory', path: '01 · repo #1/src/' }, new Set()), []);
  assert.deepEqual(treeViewedFiles(entries.slice(1), { kind: 'directory', path: '01 · repo #1/src/' }), [entries[1]]);
});
void test('file actions affect exactly one file', () => {
  assert.deepEqual(treeViewedFiles(entries, { kind: 'file', path: entries[0].key }), [entries[0]]);
});
