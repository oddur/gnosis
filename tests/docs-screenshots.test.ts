import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  fixtureUrl,
  imagePaths,
  parseKey,
  parseStep,
  provenance,
  selectRecipes,
  validateRecipes,
} from '../scripts/docs-screenshot-recipes.mjs';
import { sceneNames } from '../scripts/docs-screenshot-steps';

const file: unknown = JSON.parse(readFileSync('scripts/docs-screenshots.json', 'utf8'));

void test('the docs screenshot recipes are valid, and every scene they name exists', () => {
  const recipes = validateRecipes(file, { scenes: sceneNames });
  assert.ok(recipes.length >= 30, `${recipes.length} recipes`);
  for (const recipe of recipes) {
    if (recipe.placeholder) continue;
    const page = (recipe.fixture ?? '').split('?')[0];
    assert.ok(existsSync(`tests/fixtures/${page}`), `recipe "${recipe.name}": tests/fixtures/${page} does not exist`);
    if (recipe.suite) assert.ok(existsSync(recipe.suite), `recipe "${recipe.name}": ${recipe.suite} does not exist`);
  }
  const used = new Set(recipes.map((recipe) => recipe.scene).filter(Boolean));
  assert.deepEqual(sceneNames.filter((name) => !used.has(name)), [], 'every step function is used by a recipe');
});

void test('the recipes cover each documented area', () => {
  const names = new Set(validateRecipes(file).map((recipe) => recipe.name));
  for (const name of [
    'queue',
    'overview',
    'workspace-tabs',
    'pr-summary',
    'pr-changes-split',
    'pr-checks',
    'pr-commits',
    'comment-composer',
    'review-threads',
    'pr-header-actions',
    'merge-confirm',
    'explanation-reader',
    'explanation-options',
    'explanation-focused',
    'explanation-diagram',
    'chat-panel',
    'conflicts',
    'stack-overview',
    'breadcrumbs',
    'moved-symbols',
    'quiet-changes',
    'notification',
    'menubar-panel',
    'shortcut-overlay',
    'browser-extension',
  ])
    assert.ok(names.has(name), `no recipe "${name}"`);
  for (const section of ['queue', 'repositories', 'review', 'appearance', 'notifications', 'integrations', 'updates', 'diagnostics'])
    assert.ok(names.has(`settings-${section}`), `no recipe for the ${section} settings`);
});

void test('parseStep reads each kind of step', () => {
  assert.deepEqual(parseStep('click .queue-filter-toggle'), {
    type: 'click',
    target: { kind: 'selector', selector: '.queue-filter-toggle' },
    raw: 'click .queue-filter-toggle',
  });
  assert.deepEqual(parseStep('click text:Open PR overview'), {
    type: 'click',
    target: { kind: 'text', text: 'Open PR overview' },
    raw: 'click text:Open PR overview',
  });
  assert.deepEqual(parseStep('dblclick text:Introduce').type, 'dblclick');
  assert.deepEqual(parseStep('pointerdown .workspace-menu-trigger').type, 'pointerdown');
  assert.deepEqual(parseStep('wait .x [data-a="b c"]'), { type: 'wait', condition: { kind: 'selector', selector: '.x [data-a="b c"]' }, raw: 'wait .x [data-a="b c"]' });
  assert.deepEqual(parseStep('wait text:No overrides'), { type: 'wait', condition: { kind: 'text', text: 'No overrides' }, raw: 'wait text:No overrides' });
  assert.deepEqual(parseStep('wait gone:.spinner'), { type: 'wait', condition: { kind: 'gone', selector: '.spinner' }, raw: 'wait gone:.spinner' });
  assert.deepEqual(parseStep('wait settled:queue-list'), { type: 'wait', condition: { kind: 'settled', key: 'queue-list' }, raw: 'wait settled:queue-list' });
  assert.deepEqual(parseStep("wait js:document.querySelectorAll('.a').length===7"), {
    type: 'wait',
    condition: { kind: 'js', expression: "document.querySelectorAll('.a').length===7" },
    raw: "wait js:document.querySelectorAll('.a').length===7",
  });
  assert.deepEqual(parseStep('key Mod+Shift+M'), { type: 'key', key: 'M', modifiers: ['Mod', 'Shift'], raw: 'key Mod+Shift+M' });
  assert.deepEqual(parseStep('scroll .stack-merge-plan'), { type: 'scroll', selector: '.stack-merge-plan', raw: 'scroll .stack-merge-plan' });
  assert.deepEqual(parseStep('type Hello  world'), { type: 'type', text: 'Hello  world', raw: 'type Hello  world' });
  assert.deepEqual(parseStep('js window.x=1'), { type: 'js', expression: 'window.x=1', raw: 'js window.x=1' });
  // A selector may contain a colon; only the known prefixes are conditions.
  assert.deepEqual(parseStep('wait .a:not(.b)'), { type: 'wait', condition: { kind: 'selector', selector: '.a:not(.b)' }, raw: 'wait .a:not(.b)' });
});

void test('parseStep rejects what it cannot run, saying why', () => {
  assert.throws(() => parseStep('sleep 500'), /not a step/);
  assert.throws(() => parseStep('click'), /needs an argument/);
  assert.throws(() => parseStep('click text:  '), /no text/);
  assert.throws(() => parseStep('wait settled:'), /nothing after "settled:"/);
  assert.throws(() => parseStep('key Hyper+K'), /not a modifier/);
  assert.throws(() => parseStep(42 as unknown as string), /must be a string/);
});

void test('parseKey reads modifiers and the plus key', () => {
  assert.deepEqual(parseKey('?'), { key: '?', modifiers: [] });
  assert.deepEqual(parseKey('Mod+,'), { key: ',', modifiers: ['Mod'] });
  assert.deepEqual(parseKey('cmd+shift+k'), { key: 'k', modifiers: ['Meta', 'Shift'] });
  assert.deepEqual(parseKey('Ctrl+Alt+Escape'), { key: 'Escape', modifiers: ['Control', 'Alt'] });
  assert.deepEqual(parseKey('Mod++'), { key: '+', modifiers: ['Mod'] });
  assert.deepEqual(parseKey('+'), { key: '+', modifiers: [] });
});

void test('validateRecipes names each recipe with a problem', () => {
  const error = (data: unknown) => {
    try {
      validateRecipes(data, { scenes: ['known'] });
    } catch (caught) {
      return (caught as Error).message;
    }
    return '';
  };
  assert.match(error({ nope: [] }), /must be an array/);
  const message = error([
    { name: 'ok', fixture: 'workbench.html?pr-summary', ready: '.x', steps: ['click .a'], scene: 'known' },
    { name: 'Bad Name', fixture: 'workbench.html', ready: '.x' },
    { name: 'no-ready', fixture: 'workbench.html' },
    { name: 'bad-step', fixture: 'workbench.html', ready: '.x', steps: ['sleep 100'] },
    { name: 'themed', fixture: 'workbench.html?theme=dark', ready: '.x' },
    { name: 'unknown-scene', fixture: 'workbench.html', ready: '.x', scene: 'nope' },
    { name: 'big', fixture: 'workbench.html', ready: '.x', viewport: { width: 9000, height: 960 } },
    { name: 'extra', fixture: 'workbench.html', ready: '.x', colour: 'red' },
    { name: 'ok', fixture: 'workbench.html', ready: '.x' },
    { name: 'far', fixture: '../secret.html', ready: '.x' },
    { name: 'placeholder', placeholder: true },
  ]);
  assert.doesNotMatch(message, /recipe "placeholder"/);
  for (const expected of [
    /recipe "Bad Name": needs a kebab-case "name"/,
    /recipe "no-ready": needs a "ready" condition/,
    /recipe "bad-step": step 1: "sleep 100" is not a step/,
    /recipe "themed": "fixture" must not set theme/,
    /recipe "unknown-scene": "scene" names "nope"/,
    /recipe "big": "viewport" must be/,
    /recipe "extra": unknown field "colour"/,
    /recipe "ok": the name is used twice/,
    /recipe "far": "fixture" must be a page in tests\/fixtures/,
  ])
    assert.match(message, expected);
});

void test('selectRecipes picks named recipes, or all of them', () => {
  const recipes = [{ name: 'a' }, { name: 'b' }, { name: 'c' }];
  assert.equal(selectRecipes(recipes, '').length, 3);
  assert.equal(selectRecipes(recipes, undefined).length, 3);
  assert.deepEqual(selectRecipes(recipes, 'c, a a').map((recipe) => recipe.name), ['c', 'a']);
  assert.deepEqual(selectRecipes(recipes, ['b']).map((recipe) => recipe.name), ['b']);
  assert.throws(() => selectRecipes(recipes, 'a z'), /No recipe named "z"/);
});

void test('the fixture URL carries the theme and keeps bare flags bare', () => {
  assert.equal(
    fixtureUrl('http://127.0.0.1:5000/tests/fixtures/', 'workbench.html?pr-summary&checks', 'dark'),
    'http://127.0.0.1:5000/tests/fixtures/workbench.html?pr-summary&checks&theme=dark'
  );
  assert.equal(
    fixtureUrl('http://127.0.0.1:5000/tests/fixtures', 'menubar.html?state=sample', 'light'),
    'http://127.0.0.1:5000/tests/fixtures/menubar.html?state=sample&theme=light'
  );
});

void test('images and their provenance', () => {
  assert.deepEqual(imagePaths('queue', 'dark'), {
    full: 'site/public/docs/screenshots/queue-dark.webp',
    small: 'site/public/docs/screenshots/queue-dark-small.webp',
  });
  const sidecar = provenance({
    recipe: { name: 'queue', fixture: 'workbench.html', suite: 'tests/workbench-browser.ts' },
    theme: 'dark',
    commit: '0123456789abcdef0123456789abcdef01234567',
    width: 960,
    createdAt: '2026-11-25T00:00:00.000Z',
  });
  assert.equal(sidecar.source, 'synthetic fixture data, actual Gnosis UI');
  assert.equal(sidecar.commit, '0123456789abcdef0123456789abcdef01234567');
  assert.equal(sidecar.recipe, 'queue');
  assert.equal(sidecar.theme, 'dark');
  assert.deepEqual(sidecar.viewport, { width: 1600, height: 960 });
  assert.equal(sidecar.deviceScaleFactor, 2);
  assert.match(sidecar.prompt, /commit 0123456 .*recipe "queue" in the dark theme.*Resized to 960px wide with sharp, WebP quality 86/);
});
