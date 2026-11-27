import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { classify } from '../scripts/ci-changes.mjs';

/** Which parts of Checks a change runs (scripts/ci-changes.mjs, .github/workflows/checks.yml). */

void test('documentation alone runs nothing', () => {
  assert.deepEqual(
    classify(['docs/releasing.md', 'README.md', 'AGENTS.md', 'LICENSE', '.github/ISSUE_TEMPLATE/bug.yml']),
    {
      app: false,
      site: false,
      extension: false,
    }
  );
});

void test('the website runs only its own build', () => {
  assert.deepEqual(
    classify(['site/src/content/docs/reviewing-a-pr.mdx', 'site/public/docs/screenshots/x-dark.webp', 'README.md']),
    {
      app: false,
      site: true,
      extension: false,
    }
  );
});

void test('the extension runs its build and the app checks, which hold its unit tests', () => {
  assert.deepEqual(classify(['extensions/browser/src/content.ts']), { app: true, site: false, extension: true });
});

void test('app code, tests and scripts run the app checks', () => {
  for (const path of [
    'components/PrChangesView.tsx',
    'lib/x.ts',
    'src/main.ts',
    'tests/x-browser.ts',
    'scripts/docs-screenshots.json',
    'forge.config.ts',
    'index.html',
  ]) {
    assert.deepEqual(classify([path]), { app: true, site: false, extension: false }, path);
  }
});

void test('Markdown in a code or test folder is not documentation', () => {
  assert.equal(classify(['tests/fixtures/conflicts/md-add-changelog-entries/base/CHANGELOG.md']).app, true);
  assert.equal(classify(['resources/notes.md']).app, true);
  assert.equal(classify(['extensions/browser/README.md']).extension, true);
});

void test('dependencies, the TypeScript config and the Checks workflow run everything', () => {
  for (const path of [
    'package.json',
    'package-lock.json',
    'tsconfig.json',
    '.github/workflows/checks.yml',
    'scripts/ci-changes.mjs',
  ]) {
    assert.deepEqual(classify([path, 'README.md']), { app: true, site: true, extension: true }, path);
  }
});

void test('an unknown path runs the app checks: only known paths skip them', () => {
  assert.equal(classify(['.github/workflows/release.yml']).app, true);
  assert.equal(classify(['somewhere/new.txt']).app, true);
});

void test('the command line prints one output per part, and everything when it gets no paths', () => {
  const run = (input: string) =>
    execFileSync(process.execPath, ['scripts/ci-changes.mjs'], { input, encoding: 'utf8' });
  assert.equal(run('site/a.mdx\nREADME.md\n'), 'app=false\nsite=true\nextension=false\n');
  assert.equal(run(''), 'app=true\nsite=true\nextension=true\n');
});
