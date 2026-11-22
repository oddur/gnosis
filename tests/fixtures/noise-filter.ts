import type { PrChangeFile, PrFileContents } from '../../lib/pr-changes';
import { patchOf } from './syntax-scope';

/**
 * `?noise-filter`: quiet changes (#396, tests/noise-filter-browser.ts). Each file is a case the filter must get right:
 * - `src/noise/format.ts`: every change is whitespace (reindented, rewrapped, respaced): the file is one bar.
 * - `src/noise/prettier.ts`: a formatter run (quotes, semicolons, trailing commas, parentheses): "Reformatted".
 * - `src/noise/comments.ts`: every change is a comment (a JSDoc edit, a comment added, one removed).
 * - `src/noise/mixed.ts`: a formatting-only hunk (quote style), a code hunk, a hunk with a reformatted line one line above a code
 *   change (it stays, its formatting line dimmed), and a comment-only hunk.
 * - `src/noise/indent.py`: a re-indented line that leaves a loop (code, never hidden), and a respaced signature.
 * - `config/noise.yaml`: a key re-indented out of its mapping (code, never hidden), and a respaced value.
 * - `src/noise/imports.ts`: a name added from a module the file already imports (quiet once Imports is on), an import
 *   of a package the file never imported (a new dependency, never hidden), and a code change.
 */
const filler = (prefix: string, count: number, comment = '//') =>
  Array.from({ length: count }, (_, i) => (i % 5 === 4 ? `${comment} ${prefix} section ${i}.` : `const ${prefix}${i} = ${i};`));

const formatBefore = [
  '// Totals for the noise fixture.',
  'export function total(values: number[]): number {',
  '  let sum = 0;',
  '  for (const value of values) sum += value;',
  '  return sum;',
  '}',
  ...filler('f', 20),
  'export function mean(values:number[]):number{ return total(values)/values.length; }',
  ...filler('g', 12),
];
const formatAfter = [
  '// Totals for the noise fixture.',
  'export function total(values: number[]): number {',
  '    let sum = 0;',
  '    for (const value of values) sum += value;',
  '    return sum;',
  '}',
  ...filler('f', 20),
  'export function mean(values: number[]): number {',
  '  return total(values) / values.length;',
  '}',
  ...filler('g', 12),
];

const commentsBefore = [
  '/**',
  ' * Retries a request.',
  ' */',
  'export function retry(times: number): number {',
  '  return times;',
  '}',
  ...filler('c', 20),
  'export const limit = 5; // five',
  'export const delay = 100;',
  ...filler('d', 8),
];
const commentsAfter = [
  '/**',
  ' * Retries a request until it succeeds or runs out of tries.',
  ' * @param times How many tries are left.',
  ' */',
  'export function retry(times: number): number {',
  '  return times;',
  '}',
  ...filler('c', 20),
  'export const limit = 5;',
  '// Milliseconds between tries.',
  'export const delay = 100;',
  ...filler('d', 8),
];

// A function whose respaced signature is quiet and whose last line changes code: its breadcrumb jumps into the bar.
const COMPUTE_BODY = Array.from({ length: 40 }, (_, i) => `  const step${i} = a * ${i} + b;`);
const mixedBefore = [
  "import { join } from 'node:path';",
  'export const base = join("a","b");',
  ...filler('m', 20),
  'export function scale(value: number): number {',
  '  return value * 2;',
  '}',
  ...filler('n', 20),
  'export function clamp(value: number): number {',
  '  const low = Math.max(value,0);',
  '  const mid = 50;',
  '  const high = 100;',
  '  return Math.min(low, high);',
  '}',
  ...filler('p', 20),
  '// Rounds down.',
  'export const floor = Math.floor;',
  ...filler('q', 20),
  'export function compute(a:number,b:number):number {',
  ...COMPUTE_BODY,
  '  return a + b;',
  '}',
];
const mixedAfter = [
  "import { join } from 'node:path';",
  "export const base = join('a', 'b');",
  ...filler('m', 20),
  'export function scale(value: number): number {',
  '  return value * 3;',
  '}',
  ...filler('n', 20),
  'export function clamp(value: number): number {',
  '  const low = Math.max(value, 0);',
  '  const mid = 50;',
  '  const high = 99;',
  '  return Math.min(low, high);',
  '}',
  ...filler('p', 20),
  '// Rounds towards negative infinity.',
  'export const floor = Math.floor;',
  ...filler('q', 20),
  'export function compute(a: number, b: number): number {',
  ...COMPUTE_BODY,
  '  return a - b;',
  '}',
];

const pyFiller = (count: number) => Array.from({ length: count }, (_, i) => (i % 5 === 4 ? `# Section ${i}.` : `VALUE_${i} = ${i}`));
const pythonBefore = [
  'def run(items):',
  '    total = 0',
  '    for item in items:',
  '        total += item',
  '    log(total)',
  '    return total',
  '',
  ...pyFiller(20),
  '',
  'def other(a,b):',
  '    return a+b',
];
const pythonAfter = [
  'def run(items):',
  '    total = 0',
  '    for item in items:',
  '        total += item',
  '        log(total)',
  '    return total',
  '',
  ...pyFiller(20),
  '',
  'def other(a, b):',
  '    return a + b',
];

const yamlFiller = Array.from({ length: 20 }, (_, i) => `key_${i}: ${i}`);
const yamlBefore = ['server:', '  port: 80', '  tls:', '    cert: a', '  host: example', ...yamlFiller, 'retries:   3', 'timeout: 10'];
const yamlAfter = ['server:', '  port: 80', '  tls:', '    cert: a', 'host: example', ...yamlFiller, 'retries: 3', 'timeout: 10'];

// A formatter run: quotes, semicolons, trailing commas and parentheses, in four hunks.
const prettierBefore = [
  "import { join } from 'node:path'",
  ...filler('r', 12),
  "export const names = ['alpha', 'beta']",
  ...filler('s', 12),
  'export const sum = (a) => (a + 1)',
  ...filler('t', 12),
  "export const label = 'done'",
  ...filler('u', 4),
];
const prettierAfter = [
  'import { join } from "node:path";',
  ...filler('r', 12),
  'export const names = [',
  '  "alpha",',
  '  "beta",',
  '];',
  ...filler('s', 12),
  'export const sum = a => a + 1;',
  ...filler('t', 12),
  'export const label = "done";',
  ...filler('u', 4),
];

const importsBefore = [
  "import { parseSize } from './units';",
  ...filler('i', 12),
  "export const size = parseSize('1kb');",
  ...filler('j', 12),
  'export function limit(count: number): number {',
  '  return count * 2;',
  '}',
  ...filler('k', 4),
];
const importsAfter = [
  "import { parseSize } from './units';",
  "import { formatBytes } from './units';",
  ...filler('i', 12),
  "import { z } from 'zod';",
  "export const size = parseSize('1kb');",
  ...filler('j', 12),
  'export function limit(count: number): number {',
  '  return count * 3;',
  '}',
  ...filler('k', 4),
];

export const NOISE_FILES = {
  prettier: 'src/noise/prettier.ts',
  format: 'src/noise/format.ts',
  comments: 'src/noise/comments.ts',
  mixed: 'src/noise/mixed.ts',
  python: 'src/noise/indent.py',
  yaml: 'config/noise.yaml',
  imports: 'src/noise/imports.ts',
} as const;
const SOURCES: [string, string[], string[]][] = [
  [NOISE_FILES.format, formatBefore, formatAfter],
  [NOISE_FILES.prettier, prettierBefore, prettierAfter],
  [NOISE_FILES.comments, commentsBefore, commentsAfter],
  [NOISE_FILES.mixed, mixedBefore, mixedAfter],
  [NOISE_FILES.python, pythonBefore, pythonAfter],
  [NOISE_FILES.yaml, yamlBefore, yamlAfter],
  [NOISE_FILES.imports, importsBefore, importsAfter],
];
const text = (lines: string[]) => `${lines.join('\n')}\n`;
export const noiseFilterFiles: PrChangeFile[] = SOURCES.map(([path, before, after], i) => {
  const patch = patchOf(before, after, { headers: true });
  const lines = patch.split('\n');
  return {
    path,
    status: 'modified' as const,
    additions: lines.filter((line) => line.startsWith('+')).length,
    deletions: lines.filter((line) => line.startsWith('-')).length,
    changeId: `noise-${i}`,
    patch,
  };
});
const BY_PATH = new Map(SOURCES.map(([path, before, after]) => [path, { before, after }]));
export function noiseFilterContents(path: string): PrFileContents | undefined {
  const file = BY_PATH.get(path);
  return file && { before: { kind: 'text', content: text(file.before) }, after: { kind: 'text', content: text(file.after) } };
}
