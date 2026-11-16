import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

// Tailwind's group-has-*, peer-has-* and in-has-* variants compile to rules such as
// `:is(:where(.group\/name):has(…) *)`. With one of those in the page, Chromium restyles the whole document after
// every DOM insertion. Each slice of a large diff that mounted restyled about 6,600 elements, and with an
// accessibility client running Chromium then rebuilt the accessibility nodes of the diff in view (#366). A plain
// `has-*` variant, where the element itself is the subject, is fine. tests/diff-gaps-browser.ts measures the effect.
// Tailwind reads comments too, so they are checked as well.
const variant = /\b(?:group|peer|in)-has-/;

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.(tsx?|css)$/.test(entry.name) ? [path] : [];
  });
}

void test('no Tailwind variant puts :has() before a descendant combinator', () => {
  const found = ['components', 'lib', 'src'].flatMap(sources).flatMap((path) =>
    readFileSync(path, 'utf8')
      .split('\n')
      .flatMap((line, index) => (variant.test(line) ? [`${path}:${index + 1}: ${line.trim()}`] : []))
  );
  assert.deepEqual(found, [], 'Use a data attribute on the group instead of a group-has-* variant');
});
