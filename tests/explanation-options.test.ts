import test from 'node:test';
import assert from 'node:assert/strict';
import {
  explanationFile,
  explanationExclusion,
  explanationInstructions,
  normalizeExplanationOptions,
  normalizeExplanationPreferences,
  normalizeLocalExplanationPreferences,
  EXPLANATION_STYLES,
} from '../lib/explanation-options';
import { normalizeRepositorySettings } from '../lib/repository-settings';
import { filterDiff } from '../lib/file-filter';
const file = (path: string, sourcePath = path) =>
  explanationFile({ filename: sourcePath, additions: 3, deletions: 1, status: 'modified' }, path, 'PR');
void test('default scope excludes generated files but includes tests; rules remain independent', () => {
  const options = normalizeExplanationOptions(null);
  assert.equal(options.style, 'concise');
  assert.ok(explanationExclusion(file('generated/schema.ts'), options));
  assert.equal(explanationExclusion(file('src/code.test.ts'), options), undefined);
  assert.ok(explanationExclusion(file('src/code.test.ts'), { ...options, excludeTests: true }));
  assert.equal(
    explanationExclusion(file('generated/schema.ts'), { ...options, excludeGenerated: false, excludeTests: true }),
    undefined
  );
});
void test('extensions are normalized and apply to source paths, including extensionless files', () => {
  const options = normalizeExplanationOptions({ hiddenExtensions: ['.TS', '.ts', '', 'ts', '../x', 1] });
  assert.deepEqual(options.hiddenExtensions, ['.ts', '']);
  assert.ok(explanationExclusion(file('src/file.TS', 'PR-120/src/file.TS'), options));
  assert.ok(explanationExclusion(file('Makefile'), options));
  assert.equal(explanationExclusion(file('README.md'), options), undefined);
});
void test('explicit choices win, remain PR-specific, and new files follow rules', () => {
  const options = normalizeExplanationOptions({
    excludeTests: true,
    hiddenExtensions: ['.ts'],
    fileOverrides: { 'PR-1/generated/a.ts': true, 'README.md': false },
  });
  assert.equal(explanationExclusion(file('generated/a.ts', 'PR-1/generated/a.ts'), options), undefined);
  assert.ok(explanationExclusion(file('generated/a.ts', 'PR-2/generated/a.ts'), options));
  assert.equal(explanationExclusion(file('README.md'), options), 'Excluded by you');
  assert.ok(explanationExclusion(file('new.test.ts'), options));
  assert.equal(explanationExclusion(file('constructor'), options), undefined);
  assert.equal(explanationExclusion(file('__proto__'), options), undefined);
});
void test('classification overrides from raw changes apply to explanation classification', () => {
  const f = explanationFile(
    { filename: 'generated/a.ts', additions: 0, deletions: 0, status: 'modified' },
    'generated/a.ts',
    'PR',
    undefined,
    { generated: false, test: true }
  );
  assert.equal(explanationExclusion(f, normalizeExplanationOptions(null)), undefined);
  assert.ok(explanationExclusion(f, normalizeExplanationOptions({ excludeTests: true })));
});
void test('remembered defaults discard file choices; malformed preferences are normalized', () => {
  const options = normalizeExplanationOptions({
    style: 'educational',
    fileOverrides: { a: true, b: false, c: 'yes' },
    hiddenExtensions: ['.md'],
    customInstructions: 'Focus',
  });
  assert.deepEqual(options.fileOverrides, { a: true, b: false });
  const prefs = normalizeExplanationPreferences(options);
  assert.equal('fileOverrides' in prefs, false);
  assert.deepEqual(
    normalizeRepositorySettings({ 'ORG/Repo': { explanation: options } })['org/repo'].explanation,
    prefs
  );
  assert.deepEqual(
    normalizeExplanationPreferences({ style: 'bad', excludeGenerated: 0, excludeTests: 'true' }),
    normalizeExplanationPreferences(null)
  );
  assert.deepEqual(
    normalizeLocalExplanationPreferences({ 'local:/tmp/project': options, invalid: options, 'local:/bad': null }),
    { 'local:/tmp/project': prefs }
  );
});
void test('each style guides depth while retaining clear prose and global instructions', () => {
  const prompts = EXPLANATION_STYLES.map(({ value }) =>
    explanationInstructions(
      normalizeExplanationOptions({ style: value, customInstructions: 'Use domain examples' }),
      'Always explain ownership'
    )
  );
  assert.equal(new Set(prompts).size, 4);
  for (const prompt of prompts) {
    assert.match(prompt, /clear, concise prose/);
    assert.match(prompt, /Always explain ownership/);
  }
  assert.match(prompts[3], /Use domain examples/);
  assert.doesNotMatch(prompts[0], /Use domain examples/);
});
void test('excluded paths are omitted from primary diff including namespaced stack paths', () => {
  const files = [file('a.ts', 'PR-1/a.ts'), file('generated/b.ts', 'PR-2/generated/b.ts')];
  const excluded = new Set(
    files.filter((f) => explanationExclusion(f, normalizeExplanationOptions(null))).map((f) => f.path)
  );
  const diff = files
    .map((f) => `diff --git a/${f.path} b/${f.path}\n--- a/${f.path}\n+++ b/${f.path}\n@@ -1 +1 @@\n-old\n+new\n`)
    .join('');
  const filtered = filterDiff(diff, excluded);
  assert.match(filtered, /PR-1\/a.ts/);
  assert.doesNotMatch(filtered, /generated\/b.ts/);
});
