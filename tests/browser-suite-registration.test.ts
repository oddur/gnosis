import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// Every browser suite that scripts/test-workbench.mjs knows about must be run by CI, through
// test:explainer, test:workbench or test:diagrams. A suite left out silently never runs.
test('every workbench browser suite is registered in an npm script CI runs', () => {
  const runner = readFileSync('scripts/test-workbench.mjs', 'utf8');
  const mapped = new Set([...runner.matchAll(/process\.argv\.includes\('(--[a-z0-9-]+)'\) \? 'tests\//g)].map(match => match[1]));
  const scripts = (JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> }).scripts;
  const run = ['test:explainer', 'test:workbench', 'test:diagrams'].map(name => scripts[name] ?? '').join(' && ');
  const registered = new Set([...run.matchAll(/test-workbench\.mjs (--[a-z0-9-]+)/g)].map(match => match[1]));
  const missing = [...mapped].filter(flag => !registered.has(flag));
  assert.deepEqual(missing, [], `Add these suites to test:workbench: ${missing.join(', ')}`);
});
