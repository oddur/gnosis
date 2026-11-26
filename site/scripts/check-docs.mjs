#!/usr/bin/env node
// Checks that the user docs (site/src/content/docs/*.mdx) agree with the app and with their screenshots.
//
//  a. Every <DocShot name="…"> has its light and dark captures (1600 and 960 pixels wide, each with a .json sidecar)
//     and a capture recipe in the root scripts/docs-screenshots.json (the capture pipeline's file). A placeholder
//     image (its sidecar says `placeholder: true`) or a recipe marked `placeholder: true` is a warning.
//  b. Every <Kbd keys="…"> is a shortcut the app has, and the Keyboard shortcuts page lists every shortcut the app has.
//     The app has no single keymap. The shortcuts come from the ? cheatsheet (components/ShortcutOverlay.tsx, with
//     lib/conflict-shortcuts.ts, DIFF_LAYOUT_KEYS and QUIET_CHANGES_KEY), plus scripts/docs-shortcuts.json for the
//     shortcuts that live only in inline key handlers. Each of those names a source file and a piece of its code.
//  c. Every <Setting name="…" section="…"> names a label in the Settings code, and a Settings tab.
//
// It fails closed: a component it can't read, or app code it can't parse, is an error that says what to change.
// Run it with `npm run check:docs` in site/. The root `npm test` runs it too (tests/site-docs.test.ts), so a change to
// a shortcut or a setting label fails that change's PR, not the next site deploy. Only Node built-ins: the root tests
// import it without the site's dependencies.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const SITE_DIR = join(here, '..');
export const REPO_DIR = join(SITE_DIR, '..');
const SHORTCUTS_PAGE = 'keyboard-shortcuts.mdx';

/** @typedef {{ file: string, line: number }} Where */
/** @typedef {{ errors: string[], warnings: string[], stats: Record<string, number> }} Report */

// ---------------------------------------------------------------- docs

/** The docs' MDX files, with code blocks and inline code blanked so examples don't count. Keeps line numbers. */
function readDocs(siteDir) {
  const dir = join(siteDir, 'src/content/docs');
  return readdirSync(dir)
    .filter((name) => name.endsWith('.mdx'))
    .sort()
    .map((name) => {
      const raw = readFileSync(join(dir, name), 'utf8').replace(/\r\n/g, '\n');
      const blank = (match) => match.replace(/[^\n]/g, ' ');
      const text = raw.replace(/^```[\s\S]*?^```/gm, blank).replace(/`[^`\n]*`/g, blank);
      return { name, raw, text };
    });
}

const lineAt = (text, index) => text.slice(0, index).split('\n').length;

/**
 * Every <Tag …> in the docs, with its literal string attributes. An attribute written as an expression ({…}) is
 * recorded in `dynamic`, because the check can't read it.
 */
function findTags(docs, tag) {
  const found = [];
  const pattern = new RegExp(`<${tag}\\b((?:[^>"'{]|"[^"]*"|'[^']*'|\\{[^}]*\\})*)>`, 'g');
  for (const doc of docs) {
    for (const match of doc.text.matchAll(pattern)) {
      const attributes = {};
      const dynamic = [];
      for (const attr of match[1].matchAll(/([A-Za-z][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|\{([^}]*)\})/g)) {
        if (attr[4] !== undefined) dynamic.push(attr[1]);
        else attributes[attr[1]] = attr[2] ?? attr[3];
      }
      found.push({ file: doc.name, line: lineAt(doc.text, match.index), attributes, dynamic });
    }
  }
  return found;
}

function readFrontmatter(doc) {
  const match = /^---\n([\s\S]*?)\n---/.exec(doc.raw);
  const data = {};
  for (const line of match?.[1].split('\n') ?? []) {
    const field = /^(\w+):\s*(.*)$/.exec(line);
    if (field) data[field[1]] = field[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return data;
}

const at = (where) => `${where.file}:${where.line}`;

// ---------------------------------------------------------------- a. screenshots

const SHOT_VARIANTS = ['light', 'light-small', 'dark', 'dark-small'];

function checkScreenshots(siteDir, repoDir, docs, report) {
  // The capture pipeline (scripts/capture-docs-screenshots.mjs) owns this file: { "recipes": [{ name, page, title,
  // suite or fixture, viewport?, steps?, scene?, ready?, note?, placeholder? }] }. This check only needs the names.
  const recipeFile = 'scripts/docs-screenshots.json';
  const recipePath = join(repoDir, recipeFile);
  /** @type {Map<string, { placeholder?: boolean }> | undefined} */
  let byName;
  if (existsSync(recipePath)) {
    byName = new Map();
    try {
      const recipes = JSON.parse(readFileSync(recipePath, 'utf8')).recipes;
      if (!Array.isArray(recipes)) throw new Error('it has no "recipes" array');
      for (const [index, recipe] of recipes.entries()) {
        if (typeof recipe?.name !== 'string' || !recipe.name)
          report.errors.push(`${recipeFile}: recipe ${index + 1} has no "name".`);
        else if (byName.has(recipe.name)) report.errors.push(`${recipeFile}: "${recipe.name}" is used twice.`);
        else byName.set(recipe.name, recipe);
      }
    } catch (error) {
      report.errors.push(`${recipeFile} can't be read: ${error.message}`);
    }
  }

  const shots = findTags(docs, 'DocShot');
  const used = new Set();
  const dir = join(siteDir, 'public/docs/screenshots');
  for (const shot of shots) {
    const { name, alt, caption } = shot.attributes;
    if (shot.dynamic.length)
      report.errors.push(`${at(shot)}: write DocShot's ${shot.dynamic.join(', ')} as plain strings, not {…}.`);
    if (!name) {
      report.errors.push(`${at(shot)}: DocShot needs name="…".`);
      continue;
    }
    if (!alt?.trim() || !caption?.trim())
      report.errors.push(`${at(shot)}: DocShot "${name}" needs alt and caption text.`);
    used.add(name);
    const missing = SHOT_VARIANTS.flatMap((variant) => [
      `${name}-${variant}.webp`,
      `${name}-${variant}.webp.json`,
    ]).filter((file) => !existsSync(join(dir, file)));
    if (missing.length)
      report.errors.push(
        `${at(shot)}: DocShot "${name}" is missing site/public/docs/screenshots/${missing.join(', ')}.`
      );
    // A placeholder image says so in its sidecar until the pipeline captures the real one.
    const placeholders = SHOT_VARIANTS.filter((variant) => {
      const sidecar = join(dir, `${name}-${variant}.webp.json`);
      if (!existsSync(sidecar)) return false;
      try {
        return JSON.parse(readFileSync(sidecar, 'utf8')).placeholder === true;
      } catch (error) {
        report.errors.push(`site/public/docs/screenshots/${name}-${variant}.webp.json is not JSON: ${error.message}`);
        return false;
      }
    });
    const recipe = byName?.get(name);
    if (placeholders.length || recipe?.placeholder)
      report.warnings.push(
        `${at(shot)}: DocShot "${name}" shows a placeholder image. The capture pipeline replaces it.`
      );
    if (recipe) continue;
    if (byName) report.errors.push(`${at(shot)}: DocShot "${name}" has no capture recipe in ${recipeFile}.`);
    // Before the capture pipeline lands there is no recipe file. A placeholder may wait for it; a real image may not.
    else if (placeholders.length < SHOT_VARIANTS.length)
      report.errors.push(`${at(shot)}: DocShot "${name}" needs a capture recipe, but ${recipeFile} does not exist.`);
  }
  if (!byName) report.warnings.push(`${recipeFile} does not exist yet, so no screenshot has a capture recipe.`);
  else {
    const unused = [...byName.keys()].filter((name) => !used.has(name));
    if (unused.length)
      report.warnings.push(`${unused.length} capture recipes are on no page yet: ${unused.join(', ')}.`);
  }
  report.stats.screenshots = used.size;
}

// ---------------------------------------------------------------- b. shortcuts

const ALIASES = {
  '⌘': 'cmd',
  cmd: 'cmd',
  command: 'cmd',
  'cmd/ctrl': 'cmd',
  mod: 'cmd',
  '⇧': 'shift',
  shift: 'shift',
  '⌥': 'alt',
  alt: 'alt',
  option: 'alt',
  opt: 'alt',
  '⌃': 'ctrl',
  ctrl: 'ctrl',
  control: 'ctrl',
  '↵': 'enter',
  '⏎': 'enter',
  enter: 'enter',
  return: 'enter',
  esc: 'esc',
  escape: 'esc',
  '←': 'left',
  left: 'left',
  arrowleft: 'left',
  '→': 'right',
  right: 'right',
  arrowright: 'right',
  '↑': 'up',
  up: 'up',
  arrowup: 'up',
  '↓': 'down',
  down: 'down',
  arrowdown: 'down',
  tab: 'tab',
  space: 'space',
};
const MODIFIER_GLYPHS = '⌘⇧⌥⌃';

/**
 * One shortcut in a comparable form: "⌘ ⇧ M", "Cmd+Shift+M" and "⌘⇧M" all become "cmd shift M". Named keys and
 * modifiers ignore case; single characters keep it, because G is not g. "1 – 9" and "1-9" become "1–9".
 */
export function normalizeShortcut(keys) {
  const tokens = [];
  const text = keys.trim().replace(/(\d)\s*[–—-]\s*(\d)/g, '$1–$2');
  for (const word of text.split(/\s+/)) {
    const parts = word !== '+' && word.length > 1 && word.toLowerCase() !== 'cmd/ctrl' ? word.split(/\+(?=.)/) : [word];
    for (let part of parts) {
      while (part.length > 1 && MODIFIER_GLYPHS.includes(part[0])) {
        tokens.push(part[0]);
        part = part.slice(1);
      }
      if (part) tokens.push(part);
    }
  }
  return tokens
    .map((token) => ALIASES[token.toLowerCase()] ?? (token.length === 1 ? token : token.toLowerCase()))
    .join(' ');
}

/** A cheatsheet `keys` string lists alternatives two spaces apart: 'j  k' is j or k; '⌘ ⇧ M' is one shortcut. */
const alternatives = (keys) => keys.trim().split(/\s{2,}/);

function readSource(repoDir, file, report) {
  const path = join(repoDir, file);
  if (!existsSync(path)) {
    report.errors.push(
      `${file} no longer exists. Update site/scripts/check-docs.mjs to read the shortcuts from their new place.`
    );
    return '';
  }
  return readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
}

/**
 * The shortcuts in the ? cheatsheet. Each `{ keys: …` in these files is one of:
 *   'x'                                                  a literal;
 *   window.electronAPI.platform === 'darwin' ? 'a' : 'b' (or `mac ? 'a' : 'b'`)  the macOS key is 'a';
 *   DIFF_LAYOUT_KEYS.name, QUIET_CHANGES_KEY             constants read from lib/.
 * Anything else is an error, so a new form of entry can't be skipped silently.
 */
function cheatsheetShortcuts(repoDir, report) {
  const layout = readSource(repoDir, 'lib/diff-layout.ts', report);
  const layoutKeys = Object.fromEntries(
    [...(/DIFF_LAYOUT_KEYS\s*=\s*\{([^}]*)\}/.exec(layout)?.[1] ?? '').matchAll(/(\w+):\s*'([^']*)'/g)].map((m) => [
      m[1],
      m[2],
    ])
  );
  const quiet = /QUIET_CHANGES_KEY\s*=\s*'([^']*)'/.exec(readSource(repoDir, 'lib/quiet-changes.ts', report))?.[1];
  if (!Object.keys(layoutKeys).length)
    report.errors.push('lib/diff-layout.ts: DIFF_LAYOUT_KEYS = { … } was not found.');
  if (!quiet) report.errors.push("lib/quiet-changes.ts: QUIET_CHANGES_KEY = '…' was not found.");

  const shortcuts = [];
  for (const file of ['components/ShortcutOverlay.tsx', 'lib/conflict-shortcuts.ts']) {
    const source = readSource(repoDir, file, report);
    let entries = 0;
    for (const match of source.matchAll(/\{\s*keys:\s*/g)) {
      const rest = source.slice(match.index + match[0].length);
      const where = { file, line: lineAt(source, match.index) };
      if (/^string\s*[;,]/.test(rest)) continue; // A type: `{ keys: string; … }`.
      entries++;
      let keys;
      let form;
      if ((form = /^'([^']*)'\s*,/.exec(rest))) keys = form[1];
      else if (
        (form = /^(?:window\.electronAPI\.platform\s*===\s*'darwin'|mac)\s*\?\s*'([^']*)'\s*:\s*'[^']*'\s*,/.exec(rest))
      )
        keys = form[1];
      else if ((form = /^DIFF_LAYOUT_KEYS\.(\w+)\s*,/.exec(rest))) keys = layoutKeys[form[1]];
      else if (/^QUIET_CHANGES_KEY\s*,/.test(rest)) keys = quiet;
      if (keys === undefined) {
        report.errors.push(
          `${at(where)}: check-docs can't read this shortcut: \`keys: ${rest.split('\n')[0].slice(0, 80)}\`. ` +
            'Teach cheatsheetShortcuts in site/scripts/check-docs.mjs this form.'
        );
        continue;
      }
      const label = /label:\s*(['`])(.*?)\1/.exec(rest)?.[2] ?? '';
      for (const one of alternatives(keys)) shortcuts.push({ keys: one, label, ...where });
    }
    if (!entries)
      report.errors.push(`${file}: no shortcuts found. Update cheatsheetShortcuts in site/scripts/check-docs.mjs.`);
  }
  return shortcuts;
}

/** Shortcuts that live only in inline key handlers. Each must still match a piece of its source file. */
function handlerShortcuts(siteDir, repoDir, report) {
  const path = join(siteDir, 'scripts/docs-shortcuts.json');
  let list;
  try {
    list = JSON.parse(readFileSync(path, 'utf8')).shortcuts;
    if (!Array.isArray(list)) throw new Error('it has no "shortcuts" array');
  } catch (error) {
    report.errors.push(`site/scripts/docs-shortcuts.json can't be read: ${error.message}`);
    return [];
  }
  const shortcuts = [];
  const sources = new Map();
  for (const [index, entry] of list.entries()) {
    const label = `site/scripts/docs-shortcuts.json, shortcut ${index + 1} (${entry?.keys ?? 'no keys'})`;
    if (typeof entry?.keys !== 'string' || typeof entry?.source !== 'string' || typeof entry?.evidence !== 'string') {
      report.errors.push(`${label}: each entry needs "keys", "label", "source" and "evidence" strings.`);
      continue;
    }
    if (!sources.has(entry.source)) sources.set(entry.source, readSource(repoDir, entry.source, report));
    const source = sources.get(entry.source);
    if (source && !source.includes(entry.evidence)) {
      report.errors.push(
        `${label}: ${entry.source} no longer contains \`${entry.evidence}\`. ` +
          'Check that the shortcut still exists, then update the entry (or remove it and its docs).'
      );
      continue;
    }
    shortcuts.push({
      keys: entry.keys,
      label: entry.label ?? '',
      file: 'site/scripts/docs-shortcuts.json',
      line: index + 1,
    });
  }
  return shortcuts;
}

function checkShortcuts(siteDir, repoDir, docs, report) {
  const known = [...cheatsheetShortcuts(repoDir, report), ...handlerShortcuts(siteDir, repoDir, report)];
  const knownKeys = new Set(known.map((shortcut) => normalizeShortcut(shortcut.keys)));

  const written = findTags(docs, 'Kbd');
  const onShortcutsPage = new Set();
  for (const kbd of written) {
    const { keys } = kbd.attributes;
    if (kbd.dynamic.includes('keys') || keys === undefined) {
      report.errors.push(`${at(kbd)}: write Kbd as <Kbd keys="…" /> with a plain string.`);
      continue;
    }
    const normal = normalizeShortcut(keys);
    if (kbd.file === SHORTCUTS_PAGE) onShortcutsPage.add(normal);
    if (!knownKeys.has(normal))
      report.errors.push(
        `${at(kbd)}: <Kbd keys="${keys}" /> is not a shortcut in the app. Write the macOS keys (⌘, not Ctrl). ` +
          'If the app has it, add it to site/scripts/docs-shortcuts.json with its source.'
      );
  }
  if (!docs.some((doc) => doc.name === SHORTCUTS_PAGE))
    report.errors.push(`src/content/docs/${SHORTCUTS_PAGE} is missing.`);
  const undocumented = new Map();
  for (const shortcut of known) {
    const normal = normalizeShortcut(shortcut.keys);
    if (!onShortcutsPage.has(normal) && !undocumented.has(normal)) undocumented.set(normal, shortcut);
  }
  for (const shortcut of undocumented.values())
    report.errors.push(
      `${SHORTCUTS_PAGE}: ${shortcut.keys} (${shortcut.label || 'no label'}; ${at(shortcut)}) is not documented. ` +
        `Add <Kbd keys="${shortcut.keys}" /> to the Keyboard shortcuts page.`
    );
  report.stats.shortcuts = knownKeys.size;
  report.stats.kbd = written.length;
}

// ---------------------------------------------------------------- c. settings

const ENTITIES = {
  amp: '&',
  apos: "'",
  quot: '"',
  rsquo: '’',
  lsquo: '‘',
  hellip: '…',
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  rsaquo: '›',
};
const decode = (text) => text.replace(/&(\w+);/g, (whole, name) => ENTITIES[name] ?? whole);
/** Compare labels without caring about curly quotes or spacing. */
const comparable = (text) => decode(text).replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();

/**
 * The labels in the Settings window: SettingsDialog.tsx and the components/*Setting*.tsx panels. A label is a
 * `label="…"` prop (SettingRow, SearchableSelect, Row), or the text of a <label>, <legend>, heading or button. The tabs
 * are the <Tabs.Trigger> texts in SettingsDialog.tsx.
 */
function settingsLabels(repoDir, report) {
  const dir = join(repoDir, 'components');
  const files = existsSync(dir) ? readdirSync(dir).filter((name) => /Setting.*\.tsx$/.test(name)) : [];
  if (!files.includes('SettingsDialog.tsx'))
    report.errors.push(
      'components/SettingsDialog.tsx no longer exists. Update settingsLabels in site/scripts/check-docs.mjs.'
    );
  const labels = new Set();
  const sections = new Set();
  for (const name of files) {
    const source = readFileSync(join(dir, name), 'utf8');
    for (const match of source.matchAll(/(?<![\w-])label="([^"]+)"/g)) labels.add(comparable(match[1]));
    for (const match of source.matchAll(/<(label|legend|h2|h3|h4|Button|button)\b[^>]*>([^<{]+)<\/\1>/g))
      labels.add(comparable(match[2]));
    if (name === 'SettingsDialog.tsx')
      for (const match of source.matchAll(/<Tabs\.Trigger\b[^>]*>([^<{]+)<\/Tabs\.Trigger>/g))
        sections.add(comparable(match[1]));
  }
  if (!labels.size) report.errors.push('No setting labels were found in components/*Setting*.tsx.');
  if (!sections.size)
    report.errors.push('No Settings tabs (<Tabs.Trigger>) were found in components/SettingsDialog.tsx.');
  return { labels, sections };
}

function checkSettings(repoDir, docs, report) {
  const { labels, sections } = settingsLabels(repoDir, report);
  const written = findTags(docs, 'Setting');
  for (const setting of written) {
    const { name, section } = setting.attributes;
    if (setting.dynamic.length || !name) {
      report.errors.push(`${at(setting)}: write Setting as <Setting name="…" section="…" /> with plain strings.`);
      continue;
    }
    if (labels.size && !labels.has(comparable(name))) {
      const words = comparable(name).toLowerCase().split(' ');
      const near = [...labels].filter((label) =>
        words.some((word) => word.length > 3 && label.toLowerCase().includes(word))
      );
      report.errors.push(
        `${at(setting)}: "${name}" is not a label in the Settings code.` +
          (near.length
            ? ` Labels with similar words: ${near
                .slice(0, 5)
                .map((label) => `"${label}"`)
                .join(', ')}.`
            : '')
      );
    }
    if (section !== undefined && sections.size && !sections.has(comparable(section)))
      report.errors.push(
        `${at(setting)}: section "${section}" is not a Settings tab. The tabs are ${[...sections].map((s) => `"${s}"`).join(', ')}.`
      );
  }
  report.stats.settings = written.length;
}

// ---------------------------------------------------------------- pages

function checkPages(docs, report) {
  const orders = new Map();
  for (const doc of docs) {
    const data = readFrontmatter(doc);
    for (const field of ['title', 'description', 'order'])
      if (!data[field]) report.errors.push(`${doc.name}: the frontmatter needs "${field}".`);
    if (data.order) {
      if (orders.has(data.order))
        report.errors.push(`${doc.name}: order ${data.order} is also used by ${orders.get(data.order)}.`);
      orders.set(data.order, doc.name);
    }
  }
  report.stats.pages = docs.length;
}

// ---------------------------------------------------------------- run

/** @returns {Report} */
export function checkDocs({ siteDir = SITE_DIR, repoDir = REPO_DIR } = {}) {
  const report = { errors: [], warnings: [], stats: {} };
  const docs = readDocs(siteDir);
  if (!docs.length) report.errors.push('site/src/content/docs has no .mdx pages.');
  checkPages(docs, report);
  checkScreenshots(siteDir, repoDir, docs, report);
  checkShortcuts(siteDir, repoDir, docs, report);
  checkSettings(repoDir, docs, report);
  return report;
}

export function formatReport(report) {
  const lines = [];
  for (const warning of report.warnings) lines.push(`warning: ${warning}`);
  for (const error of report.errors) lines.push(`error: ${error}`);
  const { pages = 0, screenshots = 0, shortcuts = 0, kbd = 0, settings = 0 } = report.stats;
  lines.push(
    `check-docs: ${pages} pages, ${screenshots} screenshots, ${kbd} <Kbd> against ${shortcuts} app shortcuts, ` +
      `${settings} <Setting>. ${report.errors.length} errors, ${report.warnings.length} warnings.`
  );
  return lines.join('\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const report = checkDocs();
  const output = formatReport(report);
  if (report.errors.length) {
    console.error(output);
    console.error(`\nThe docs disagree with the app (see ${relative(process.cwd(), fileURLToPath(import.meta.url))}).`);
    process.exit(1);
  }
  console.log(output);
}
