import test from 'node:test';
import assert from 'node:assert/strict';
import { assertReviewId, isReviewId, safeExternalUrl } from '../src/safe-input';

void test('review ids must be UUIDs', () => {
  assert.equal(isReviewId('3f2b8c1e-9a4d-4e7b-8c21-5d6f7a8b9c0d'), true);
  for (const bad of ['../preferences', '..%2Fpreferences', '', 'abc', '3f2b8c1e-9a4d-4e7b-8c21-5d6f7a8b9c0d/../x', 42, null, undefined]) {
    assert.equal(isReviewId(bad), false, String(bad));
    assert.throws(() => assertReviewId(bad), /Invalid saved review/);
  }
});

void test('only web and mail links may leave the app', () => {
  assert.equal(safeExternalUrl('https://github.com/o/r/pull/1'), 'https://github.com/o/r/pull/1');
  assert.equal(safeExternalUrl('http://example.com'), 'http://example.com');
  assert.equal(safeExternalUrl('mailto:someone@example.com'), 'mailto:someone@example.com');
  for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'vscode://file/x', 'smb://host/share', 'gnosis://pr/o/r/1', 'GNOSIS://pr/o/r/1', 'gnosis-dev://pr/o/r/1', 'not a url', '', 7]) {
    assert.equal(safeExternalUrl(bad), null, String(bad));
  }
});
