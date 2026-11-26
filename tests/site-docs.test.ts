import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkDocs, formatReport, normalizeShortcut } from '../site/scripts/check-docs.mjs';

// The user docs (site/src/content/docs) name screenshots, shortcuts and settings. A change to a shortcut or a setting
// label must update the docs in the same PR; this runs the site's check so that PR fails, not the next site deploy.
void test('the docs match the app: screenshots, shortcuts and settings', () => {
  const report = checkDocs();
  assert.deepEqual(report.errors, [], formatReport(report));
  assert.ok(report.stats.pages >= 10 && report.stats.shortcuts > 30, formatReport(report));
});

void test('shortcuts compare across ways of writing them', () => {
  assert.equal(normalizeShortcut('⌘ ⇧ M'), normalizeShortcut('Cmd+Shift+M'));
  assert.equal(normalizeShortcut('⌘⇧T'), normalizeShortcut('cmd shift T'));
  assert.equal(normalizeShortcut('Cmd/Ctrl K'), normalizeShortcut('⌘ K'));
  assert.equal(normalizeShortcut('1 – 9'), normalizeShortcut('1-9'));
  assert.equal(normalizeShortcut('Esc'), normalizeShortcut('Escape'));
  assert.notEqual(normalizeShortcut('G'), normalizeShortcut('g'));
  assert.notEqual(normalizeShortcut('Ctrl K'), normalizeShortcut('⌘ K'));
  assert.equal(normalizeShortcut('+'), '+');
});
