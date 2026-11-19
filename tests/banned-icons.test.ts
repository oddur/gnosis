import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { BANNED_ICON_PATTERN, bannedIconName } from '../lib/banned-icons.mjs';

/** The Sparkles ban (lib/banned-icons.mjs): no source file imports or names a sparkles icon. */
const root = path.resolve(__dirname, '..');
const DIRS = ['components', 'lib', 'src', 'extensions'];
const SKIP = new Set(['lib/banned-icons.mjs', 'src/assets']);

function* sources(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (SKIP.has(rel) || entry.name === 'node_modules') continue;
    if (entry.isDirectory()) yield* sources(rel);
    else if (/\.(tsx?|mjs|js|css|json|html)$/.test(entry.name)) yield rel;
  }
}

void test('no source uses a Sparkles icon; AI actions use Bot', () => {
  const offenders: string[] = [];
  for (const dir of DIRS) {
    if (!fs.existsSync(path.join(root, dir))) continue;
    for (const file of sources(dir)) {
      const text = fs.readFileSync(path.join(root, file), 'utf8');
      text.split('\n').forEach((line, i) => {
        if (BANNED_ICON_PATTERN.test(line)) offenders.push(`${file}:${i + 1}: ${line.trim().slice(0, 100)}`);
      });
    }
  }
  assert.deepEqual(offenders, [], `Sparkles icons are banned (lib/banned-icons.mjs):\n${offenders.join('\n')}`);
});

void test('the ban covers every sparkles variant', () => {
  for (const name of ['sparkles', 'sparkle', 'wand-sparkles', 'Sparkles', 'WandSparkles', 'SparklesIcon']) assert.ok(bannedIconName(name), name);
  for (const name of ['bot', 'Bot', 'lightbulb']) assert.ok(!bannedIconName(name), name);
});
