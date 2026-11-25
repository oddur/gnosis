// Recipes for the documentation screenshots (scripts/docs-screenshots.json), shared by the capture host
// (scripts/capture-docs-screenshots.mjs), the Electron side (scripts/docs-screenshot-capture.ts) and the unit tests
// (tests/docs-screenshots.test.ts). Plain JavaScript, so the Node host can import it without a TypeScript loader.
//
// A recipe names one scene of the real app, rendered from a browser-test fixture with synthetic data. Each recipe is
// captured in the light and the dark theme, at 1600×960 CSS pixels and device scale factor 2, and written as
// site/public/docs/screenshots/<name>-<theme>.webp (1600w) and <name>-<theme>-small.webp (960w), each with a
// <file>.json provenance sidecar.
//
// Recipe fields:
//   name         kebab-case; the file stem.
//   page         the docs page that shows it (informational).
//   title        alt text for the image.
//   fixture      a fixture page and its query, relative to tests/fixtures/ ("workbench.html?pr-summary").
//   suite        the browser suite the scene comes from (informational; provenance).
//   viewport     { width, height } in CSS pixels; defaults to 1600×960.
//   steps        simple steps, run in order (see parseStep).
//   scene        the name of a step function in scripts/docs-screenshot-steps.ts, run after `steps`.
//   ready        the condition the scene has rendered, checked last: a `wait` step without the "wait " prefix.
//   note         what the scene shows and how it is reached, for people.
//   placeholder  true: no capture; the docs keep a placeholder image.

import { URL } from 'node:url';

export const DEFAULT_VIEWPORT = Object.freeze({ width: 1600, height: 960 });
export const DEVICE_SCALE_FACTOR = 2;
export const OUTPUT_WIDTHS = Object.freeze({ full: 1600, small: 960 });
export const WEBP_QUALITY = 86;
export const THEMES = Object.freeze(/** @type {const} */ (['light', 'dark']));
export const SCREENSHOT_DIR = 'site/public/docs/screenshots';
export const PROVENANCE_SOURCE = 'synthetic fixture data, actual Gnosis UI';

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FIXTURE = /^[a-z0-9-]+\.html(?:\?.*)?$/;
const MODIFIERS = new Map([
  ['mod', 'Mod'],
  ['cmd', 'Meta'],
  ['command', 'Meta'],
  ['meta', 'Meta'],
  ['ctrl', 'Control'],
  ['control', 'Control'],
  ['shift', 'Shift'],
  ['alt', 'Alt'],
  ['option', 'Alt'],
]);
const RECIPE_KEYS = new Set(['name', 'page', 'title', 'fixture', 'suite', 'viewport', 'steps', 'scene', 'ready', 'note', 'placeholder']);

/**
 * @typedef {{ kind: 'selector', selector: string } | { kind: 'text', text: string }} Target
 * @typedef {{ kind: 'selector', selector: string } | { kind: 'text', text: string } | { kind: 'gone', selector: string }
 *   | { kind: 'settled', key: string } | { kind: 'js', expression: string }} Condition
 * @typedef {{ type: 'click' | 'dblclick' | 'pointerdown', target: Target, raw: string } | { type: 'wait', condition: Condition, raw: string }
 *   | { type: 'js', expression: string, raw: string }
 *   | { type: 'key', key: string, modifiers: string[], raw: string } | { type: 'scroll', selector: string, raw: string }
 *   | { type: 'type', text: string, raw: string }} Step
 * @typedef {{ width: number, height: number }} Viewport
 * @typedef {{ name: string, page?: string, title?: string, fixture?: string, suite?: string, viewport?: Viewport,
 *   steps?: string[], scene?: string, ready?: string, note?: string, placeholder?: boolean }} Recipe
 */

/**
 * A condition: `text:<visible text>`, `gone:<selector>`, `settled:<key>` (lib/test-settled.ts), `js:<expression>`,
 * or a CSS selector that must match a visible element.
 * @param {string} source
 * @returns {Condition}
 */
export function parseCondition(source) {
  const value = source.trim();
  if (!value) throw new Error('a condition is empty');
  const prefixed = /^(text|gone|settled|js):([\s\S]*)$/.exec(value);
  if (!prefixed) return { kind: 'selector', selector: value };
  const rest = prefixed[2].trim();
  if (!rest) throw new Error(`"${value}" has nothing after "${prefixed[1]}:"`);
  switch (prefixed[1]) {
    case 'text':
      return { kind: 'text', text: rest };
    case 'gone':
      return { kind: 'gone', selector: rest };
    case 'settled':
      return { kind: 'settled', key: rest };
    default:
      return { kind: 'js', expression: rest };
  }
}

/**
 * A key combination such as `Mod+Shift+M`, `?`, `Escape` or `Mod++`. `Mod` is Cmd on macOS and Ctrl elsewhere.
 * @param {string} source
 * @returns {{ key: string, modifiers: string[] }}
 */
export function parseKey(source) {
  const value = source.trim();
  if (!value) throw new Error('a key step names no key');
  if (value === '+') return { key: '+', modifiers: [] };
  // A trailing "++" is the plus key after modifiers.
  const plus = value.endsWith('++');
  const parts = (plus ? value.slice(0, -2) : value).split('+');
  const key = plus ? '+' : parts.pop();
  if (!key) throw new Error(`"${value}" names no key`);
  const modifiers = [];
  for (const part of parts) {
    const modifier = MODIFIERS.get(part.trim().toLowerCase());
    if (!modifier) throw new Error(`"${part}" in "${value}" is not a modifier (Mod, Cmd, Ctrl, Shift, Alt)`);
    if (!modifiers.includes(modifier)) modifiers.push(modifier);
  }
  return { key, modifiers };
}

/**
 * One simple step:
 *   click <selector> | click text:<text>     click a visible element (by CSS, or by its text or aria-label), with the
 *                                            mousedown first that many app controls listen for, as the suites do
 *   dblclick <target>                        double-click (a queue row opens its PR or stack this way)
 *   pointerdown <target>                     only a pointerdown (the app menu and some menus open on it)
 *   wait <condition>                          wait until the condition holds (see parseCondition)
 *   key <combination>                         press keys (see parseKey)
 *   scroll <selector>                         scroll the first visible match into the middle of its scroller
 *   type <text>                               type into the focused element
 *   js <expression>                           run an expression in the page and await it: fixture mocks, shadow-DOM
 *                                            clicks, filling a field. Prefer a named scene for anything long.
 * @param {string} source
 * @returns {Step}
 */
export function parseStep(source) {
  if (typeof source !== 'string') throw new Error(`a step must be a string, not ${JSON.stringify(source)}`);
  const raw = source.trim();
  const match = /^(click|dblclick|pointerdown|wait|key|scroll|type|js)(?:\s+([\s\S]*))?$/.exec(raw);
  if (!match) throw new Error(`"${raw}" is not a step: start it with click, dblclick, pointerdown, wait, key, scroll, type or js`);
  const argument = (match[2] ?? '').trim();
  if (!argument) throw new Error(`"${raw}" needs an argument`);
  switch (match[1]) {
    case 'click':
    case 'dblclick':
    case 'pointerdown': {
      const text = /^text:([\s\S]*)$/.exec(argument);
      if (text && !text[1].trim()) throw new Error(`"${raw}" has no text after "text:"`);
      return { type: match[1], target: text ? { kind: 'text', text: text[1].trim() } : { kind: 'selector', selector: argument }, raw };
    }
    case 'wait':
      return { type: 'wait', condition: parseCondition(argument), raw };
    case 'key':
      return { type: 'key', ...parseKey(argument), raw };
    case 'scroll':
      return { type: 'scroll', selector: argument, raw };
    case 'js':
      return { type: 'js', expression: argument, raw };
    default:
      return { type: 'type', text: (match[2] ?? '').replace(/^\s/, ''), raw };
  }
}

/**
 * The recipes in a parsed scripts/docs-screenshots.json: `{ recipes: [...] }`, or a bare array.
 * Throws one error that lists every problem, each naming its recipe.
 * @param {unknown} data
 * @param {{ scenes?: Iterable<string> }} [options] the step functions scripts/docs-screenshot-steps.ts defines
 * @returns {Recipe[]}
 */
export function validateRecipes(data, options = {}) {
  const list = Array.isArray(data) ? data : data && typeof data === 'object' ? /** @type {{ recipes?: unknown }} */ (data).recipes : undefined;
  if (!Array.isArray(list)) throw new Error('docs-screenshots.json must be an array of recipes or { "recipes": [...] }');
  const scenes = options.scenes ? new Set(options.scenes) : undefined;
  const problems = [];
  const names = new Set();
  list.forEach((entry, index) => {
    const label = entry && typeof entry === 'object' && typeof entry.name === 'string' ? `"${entry.name}"` : `#${index + 1}`;
    const fail = (message) => problems.push(`recipe ${label}: ${message}`);
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return fail('is not an object');
    for (const key of Object.keys(entry)) if (!RECIPE_KEYS.has(key)) fail(`unknown field "${key}"`);
    if (typeof entry.name !== 'string' || !NAME.test(entry.name)) fail('needs a kebab-case "name"');
    else if (names.has(entry.name)) fail('the name is used twice');
    else names.add(entry.name);
    for (const key of ['page', 'title', 'suite', 'note', 'scene', 'ready'])
      if (entry[key] !== undefined && (typeof entry[key] !== 'string' || !entry[key].trim())) fail(`"${key}" must be a non-empty string`);
    if (entry.placeholder !== undefined && typeof entry.placeholder !== 'boolean') fail('"placeholder" must be true or false');
    if (entry.viewport !== undefined) {
      const { width, height } = entry.viewport ?? {};
      if (!Number.isInteger(width) || !Number.isInteger(height) || width < 320 || height < 240 || width > 3840 || height > 2160)
        fail('"viewport" must be { width, height } in whole CSS pixels, from 320×240 to 3840×2160');
    }
    if (entry.fixture !== undefined && (typeof entry.fixture !== 'string' || !FIXTURE.test(entry.fixture)))
      fail('"fixture" must be a page in tests/fixtures with its query, such as "workbench.html?pr-summary"');
    else if (typeof entry.fixture === 'string' && /[?&]theme=/.test(entry.fixture)) fail('"fixture" must not set theme: every recipe is captured in both themes');
    if (entry.steps !== undefined) {
      if (!Array.isArray(entry.steps)) fail('"steps" must be an array of step strings');
      else
        entry.steps.forEach((step, stepIndex) => {
          try {
            parseStep(step);
          } catch (error) {
            fail(`step ${stepIndex + 1}: ${error.message}`);
          }
        });
    }
    if (typeof entry.ready === 'string')
      try {
        parseCondition(entry.ready);
      } catch (error) {
        fail(`"ready": ${error.message}`);
      }
    if (scenes && typeof entry.scene === 'string' && !scenes.has(entry.scene))
      fail(`"scene" names "${entry.scene}", which scripts/docs-screenshot-steps.ts does not define`);
    if (entry.placeholder !== true) {
      if (typeof entry.fixture !== 'string') fail('needs a "fixture" (or "placeholder": true)');
      if (typeof entry.ready !== 'string') fail('needs a "ready" condition: the scene is captured only once it holds');
    }
  });
  if (problems.length) throw new Error(`scripts/docs-screenshots.json has ${problems.length} problem(s):\n  ${problems.join('\n  ')}`);
  return /** @type {Recipe[]} */ (list);
}

/**
 * The recipes to capture: all of them for an empty selection, else the named ones. Unknown names are an error.
 * @param {Recipe[]} recipes
 * @param {string | string[] | undefined} selection names separated by commas or whitespace
 * @returns {Recipe[]}
 */
export function selectRecipes(recipes, selection) {
  const names = (Array.isArray(selection) ? selection : String(selection ?? '').split(/[\s,]+/)).map((name) => name.trim()).filter(Boolean);
  if (!names.length) return recipes;
  const known = new Map(recipes.map((recipe) => [recipe.name, recipe]));
  const unknown = names.filter((name) => !known.has(name));
  if (unknown.length) throw new Error(`No recipe named ${unknown.map((name) => `"${name}"`).join(', ')} in scripts/docs-screenshots.json`);
  return [...new Set(names)].map((name) => /** @type {Recipe} */ (known.get(name)));
}

/**
 * The fixture URL for a recipe in one theme: the fixture's own query plus `theme=<theme>`.
 * @param {string} base the fixtures folder on the dev server, such as http://127.0.0.1:5173/tests/fixtures/
 * @param {string} fixture
 * @param {'light' | 'dark'} theme
 */
export function fixtureUrl(base, fixture, theme) {
  const url = new URL(fixture, base.endsWith('/') ? base : `${base}/`);
  url.searchParams.set('theme', theme);
  // Flags such as `?pr-summary` have no value; keep them bare, as the suites write them.
  return url.toString().replace(/=(?=&|$)/g, '');
}

/**
 * The image files for one recipe in one theme, relative to the repository.
 * @param {string} name
 * @param {'light' | 'dark'} theme
 */
export function imagePaths(name, theme) {
  return { full: `${SCREENSHOT_DIR}/${name}-${theme}.webp`, small: `${SCREENSHOT_DIR}/${name}-${theme}-small.webp` };
}

/**
 * The provenance sidecar for one image. `prompt` and `createdAt` match site/public/screenshots/*.webp.json.
 * @param {{ recipe: Recipe, theme: 'light' | 'dark', commit: string, width: number, createdAt: string }} input
 */
export function provenance({ recipe, theme, commit, width, createdAt }) {
  const viewport = recipe.viewport ?? DEFAULT_VIEWPORT;
  const fixture = `tests/fixtures/${recipe.fixture}`;
  return {
    prompt:
      `Origin: actual Gnosis application captured from commit ${commit.slice(0, 7)} by scripts/capture-docs-screenshots.mjs, ` +
      `recipe "${recipe.name}" in the ${theme} theme, from ${fixture}${recipe.suite ? ` (as ${recipe.suite} drives it)` : ''} ` +
      `at ${viewport.width}×${viewport.height} CSS pixels and device scale factor ${DEVICE_SCALE_FACTOR}. ` +
      `Synthetic fixture data, actual Gnosis UI. Resized to ${width}px wide with sharp, WebP quality ${WEBP_QUALITY}. No generated imagery.`,
    createdAt,
    commit,
    recipe: recipe.name,
    theme,
    fixture,
    viewport,
    deviceScaleFactor: DEVICE_SCALE_FACTOR,
    width,
    source: PROVENANCE_SOURCE,
  };
}
