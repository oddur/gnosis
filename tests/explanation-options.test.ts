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
  explanationModel,
  explanationModelLabel,
  modelChoice,
  withoutModelChoice,
} from '../lib/explanation-options';
import { normalizeRepositorySettings, rememberExplanationDefault } from '../lib/repository-settings';
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

// Provider, model and reasoning effort per explanation (#573).
void test('options keep a known provider, model and effort and drop anything else', () => {
  const kept = normalizeExplanationOptions({ provider: 'codex', model: 'gpt-6.1-terra', effort: 'low' });
  assert.equal(kept.provider, 'codex');
  assert.equal(kept.model, 'gpt-6.1-terra');
  assert.equal(kept.effort, 'low');
  // Without a provider, the model's own provider.
  assert.equal(normalizeExplanationOptions({ model: 'claude-sonnet-5-5' }).provider, 'claude');
  for (const value of [
    { model: 'claude-unknown-9' },
    { provider: 'gemini', model: 'claude-sonnet-5-5' },
    { provider: 'claude', model: 'gpt-6.2-sol' },
  ]) {
    const dropped = normalizeExplanationOptions(value);
    assert.equal('provider' in dropped, false, JSON.stringify(value));
    assert.equal('model' in dropped, false, JSON.stringify(value));
  }
  assert.equal('effort' in normalizeExplanationOptions({ effort: 'turbo' }), false);
  assert.equal('model' in normalizeExplanationPreferences(null), false, 'Unset follows Settings');
});
void test('the explanation model falls back to the review model and effort is normalized for the model', () => {
  const review = { provider: 'claude' as const, model: 'claude-opus-5-5' as const, effort: 'medium' as const };
  assert.deepEqual(explanationModel({}, review), { provider: 'claude', model: 'claude-opus-5-5', effort: 'medium' });
  assert.deepEqual(explanationModel({ model: 'claude-haiku-5-5', effort: 'low' }, review), {
    provider: 'claude',
    model: 'claude-haiku-5-5',
    effort: 'low',
  });
  // Another provider's model is used with its provider.
  assert.deepEqual(explanationModel({ provider: 'codex', model: 'gpt-6.1-terra', effort: 'ultra' }, review), {
    provider: 'codex',
    model: 'gpt-6.1-terra',
    effort: 'ultra',
  });
  // Unknown model, unknown provider, or a model the provider doesn't offer: Settings' provider and model.
  const fallback = { provider: 'claude', model: 'claude-opus-5-5' };
  const pick = (value: object) => {
    const { provider, model } = explanationModel(value as never, review);
    return { provider, model };
  };
  assert.deepEqual(pick({ model: 'claude-unknown-9' }), fallback);
  assert.deepEqual(pick({ provider: 'gemini', model: 'gpt-6.2-sol' }), fallback);
  assert.deepEqual(pick({ provider: 'claude', model: 'gpt-6.2-sol' }), fallback);
  assert.deepEqual(pick({ provider: 'codex' }), fallback);
  // Claude has no Ultra; Codex models other than Luna do.
  assert.equal(explanationModel({ model: 'claude-sonnet-5-5', effort: 'ultra' }, review).effort, 'max');
  assert.equal(explanationModel({ model: 'gpt-6-luna', effort: 'ultra' }, review).effort, 'max');
  assert.equal(explanationModelLabel({ model: 'claude-sonnet-5-5' }), 'Sonnet 5.5');
  assert.equal(explanationModelLabel({}), undefined);
});
void test('remember saves the model and effort as the repository default', () => {
  const options = normalizeExplanationOptions({ style: 'in-depth', provider: 'codex', model: 'gpt-6.1-terra', effort: 'low', fileOverrides: { 'a.ts': false } });
  const prefs = { repositorySettings: { 'org/repo': { prInactivityDays: 7 } } };
  const saved = rememberExplanationDefault(prefs, 'org/repo', options, true);
  assert.deepEqual(saved.repositorySettings?.['org/repo'], {
    prInactivityDays: 7,
    explanation: normalizeExplanationPreferences({ style: 'in-depth', provider: 'codex', model: 'gpt-6.1-terra', effort: 'low' }),
  });
  assert.equal(normalizeRepositorySettings(saved.repositorySettings)['org/repo'].explanation?.effort, 'low', 'It survives a reload');
  const local = rememberExplanationDefault({}, 'local:/tmp/project', options, true);
  assert.equal(local.localExplanationPreferences?.['local:/tmp/project'].provider, 'codex');
});
void test('a retired model becomes its successor with the same provider and effort', () => {
  const saved = { provider: 'codex', model: 'gpt-6.1-sol', effort: 'ultra' };
  assert.deepEqual(modelChoice(saved), { provider: 'codex', model: 'gpt-6.2-sol', effort: 'ultra' });
  assert.deepEqual(normalizeExplanationOptions(saved).provider, 'codex');
  // Regenerate stays on Codex, never Settings' Claude model.
  const review = { provider: 'claude' as const, model: 'claude-opus-5-5' as const, effort: 'max' as const };
  assert.deepEqual(explanationModel(normalizeExplanationOptions(saved), review), {
    provider: 'codex',
    model: 'gpt-6.2-sol',
    effort: 'ultra',
  });
  assert.equal(modelChoice({ model: 'claude-opus-4-7' }).model, 'claude-opus-5-5', 'Without a provider, the model’s own');
  assert.equal(explanationModelLabel({ provider: 'codex', model: 'gpt-6.1-sol' }), 'GPT-6.2 Sol');
});
void test('a dropped choice drops provider, model and effort together, then follows the repository, then Settings', () => {
  assert.deepEqual(modelChoice({ provider: 'claude', model: 'gpt-6.2-sol', effort: 'ultra' }), {});
  assert.deepEqual(modelChoice({ provider: 'codex', effort: 'ultra' }), {});
  const options = normalizeExplanationOptions({ provider: 'claude', model: 'gpt-6.2-sol', effort: 'ultra' });
  assert.equal('provider' in options || 'model' in options || 'effort' in options, false);
  const review = { provider: 'claude' as const, model: 'claude-opus-5-5' as const, effort: 'high' as const };
  const repository = { provider: 'codex' as const, model: 'gpt-6.1-terra' as const, effort: 'low' as const };
  assert.deepEqual(explanationModel(options, review, repository), repository);
  assert.deepEqual(explanationModel(options, review), { provider: 'claude', model: 'claude-opus-5-5', effort: 'high' });
  // The explanation's own choice wins over the repository's.
  assert.equal(explanationModel({ provider: 'claude', model: 'claude-haiku-5-5' }, review, repository).model, 'claude-haiku-5-5');
  assert.deepEqual(withoutModelChoice({ style: 'concise', ...repository }), { style: 'concise' });
});
void test('remember saves the model only when the reader chose it in the dialog', () => {
  const options = normalizeExplanationOptions({ style: 'educational', provider: 'claude', model: 'claude-opus-5-5', effort: 'high' });
  // No override yet: it stays unset.
  const unset = rememberExplanationDefault({}, 'org/repo', options, false).repositorySettings?.['org/repo'].explanation;
  assert.equal(unset?.style, 'educational');
  assert.deepEqual(modelChoice(unset), {}, 'No provider, model or effort is pinned');
  // An existing override is kept, not replaced by the resolved model.
  const prefs = {
    repositorySettings: {
      'org/repo': { explanation: normalizeExplanationPreferences({ provider: 'codex', model: 'gpt-6.1-terra', effort: 'low' }) },
    },
  };
  const kept = rememberExplanationDefault(prefs, 'org/repo', options, false).repositorySettings?.['org/repo'].explanation;
  assert.deepEqual([kept?.style, kept?.provider, kept?.model, kept?.effort], ['educational', 'codex', 'gpt-6.1-terra', 'low']);
  const chosen = rememberExplanationDefault(prefs, 'org/repo', options, true).repositorySettings?.['org/repo'].explanation;
  assert.equal(chosen?.model, 'claude-opus-5-5');
});
