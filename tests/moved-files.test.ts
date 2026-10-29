import test from 'node:test';
import assert from 'node:assert/strict';
import { isUnchangedMove } from '../lib/pr-changes';
void test('pure moves require matching contents, including images and LFS objects', () => {
  const file = {
    path: 'new.ts',
    previousPath: 'old.ts',
    status: 'renamed' as const,
    additions: 0,
    deletions: 0,
    changeId: 'move',
  };
  const text = { kind: 'text' as const, content: 'unchanged\n' };
  assert.equal(isUnchangedMove(file), false);
  assert.equal(isUnchangedMove(file, { before: text, after: text }), true);
  assert.equal(isUnchangedMove(file, { before: text, after: { ...text, content: 'changed' } }), false);
  assert.equal(isUnchangedMove({ ...file, additions: 1 }, { before: text, after: text }), false);
  assert.equal(isUnchangedMove({ ...file, status: 'added' }, { before: text, after: text }), false);
  const image = { kind: 'image' as const, dataUrl: 'data:image/png;base64,AAAA' };
  assert.equal(isUnchangedMove(file, { before: image, after: image }), true);
  assert.equal(
    isUnchangedMove(file, { before: image, after: { ...image, dataUrl: 'data:image/png;base64,BBBB' } }),
    false
  );
  const lfs = { kind: 'lfs' as const, pointer: { oid: 'a'.repeat(64), size: 42 } };
  assert.equal(isUnchangedMove(file, { before: lfs, after: lfs }), true);
  assert.equal(
    isUnchangedMove(file, { before: lfs, after: { ...lfs, pointer: { ...lfs.pointer, oid: 'b'.repeat(64) } } }),
    false
  );
});
