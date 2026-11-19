import type { PrChangeFile, PrFileContents } from '../../lib/pr-changes';
import { patchOf } from './syntax-scope';

/**
 * `?noise-filter`: quiet changes (#396, tests/noise-filter-browser.ts). Each file is a case the filter must get right:
 * - `src/noise/format.ts`: every change is formatting (reindented, rewrapped, respaced): the file is one bar.
 * - `src/noise/comments.ts`: every change is a comment (a JSDoc edit, a comment added, one removed).
 * - `src/noise/mixed.ts`: a formatting-only hunk, a code hunk, a hunk with a reformatted line one line above a code
 *   change (it stays, its formatting line dimmed), and a comment-only hunk.
 * - `src/noise/indent.py`: a re-indented line that leaves a loop (code, never hidden), and a respaced signature.
 * - `config/noise.yaml`: a key re-indented out of its mapping (code, never hidden), and a respaced value.
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
  ...filler('q', 6),
];
const mixedAfter = [
  "import { join } from 'node:path';",
  'export const base = join("a", "b");',
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
  ...filler('q', 6),
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

export const NOISE_FILES = {
  format: 'src/noise/format.ts',
  comments: 'src/noise/comments.ts',
  mixed: 'src/noise/mixed.ts',
  python: 'src/noise/indent.py',
  yaml: 'config/noise.yaml',
} as const;
const SOURCES: [string, string[], string[]][] = [
  [NOISE_FILES.format, formatBefore, formatAfter],
  [NOISE_FILES.comments, commentsBefore, commentsAfter],
  [NOISE_FILES.mixed, mixedBefore, mixedAfter],
  [NOISE_FILES.python, pythonBefore, pythonAfter],
  [NOISE_FILES.yaml, yamlBefore, yamlAfter],
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
