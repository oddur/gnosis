import type { PrChangeFile, PrFileContents } from '../../lib/pr-changes';
import { patchOf } from './syntax-scope';

/**
 * `?tree-symbols`: the Changes tree's symbol rows (Settings › Review, Beta; tests/tree-symbols-browser.ts). The PR
 * changes `src/symbols/store.ts`: a new import at the top, `flush` inside an unchanged class `Store`, `gone` removed and
 * `added` added. In the tree the file expands to Imports, then Store › flush, gone and added. It also changes
 * `src/symbols/tasks.ts`, right after it in the tree: `start` and `stop` change, for `n` to walk on into the next file.
 */
export const TREE_SYMBOLS_FILE = 'src/symbols/store.ts';
export const TREE_SYMBOLS_NEXT_FILE = 'src/symbols/tasks.ts';
/** An added file with one function taller than the screen: V pages through it before it ticks it. */
export const TREE_SYMBOLS_LONG_FILE = 'src/zlong/report.ts';

const filler = Array.from({ length: 30 }, (_, i) => `export const pad${i} = ${i};`);
const before = [
  "import { a } from 'a';",
  '',
  'export class Store {',
  '  items = 1;',
  '  flush() {',
  '    return 1;',
  '  }',
  '  keep() {',
  '    return 2;',
  '  }',
  '}',
  '',
  ...filler,
  '',
  'export function gone() {',
  '  return 0;',
  '}',
];
const after = [
  "import { a } from 'a';",
  "import { b } from 'b';",
  '',
  'export class Store {',
  '  items = 1;',
  '  flush() {',
  '    return 2;',
  '  }',
  '  keep() {',
  '    return 2;',
  '  }',
  '}',
  '',
  ...filler,
  '',
  'export function added() {',
  '  if (Math.random()) return 3;',
  '  return 4;',
  '}',
];

const tasksBefore = ['export function start() {', '  return 1;', '}', '', ...filler.map((line) => line.replace('pad', 'wait')), '', 'export function stop() {', '  return 1;', '}'];
const tasksAfter = tasksBefore.map((line) => (line === '  return 1;' ? '  return 2;' : line));

const text = (lines: string[]) => `${lines.join('\n')}\n`;
const longAfter = ['export function report(rows: number[]): number {', '  let total = 0;', ...Array.from({ length: 80 }, (_, i) => `  total += rows[${i}] ?? ${i};`), '  return total;', '}'];
const changed = (path: string, changeId: string, old: string[], next: string[], status: PrChangeFile['status'] = 'modified'): PrChangeFile => {
  const patch = patchOf(old, next);
  const lines = patch.split('\n');
  return {
    path,
    status,
    additions: lines.filter((line) => line.startsWith('+')).length,
    deletions: lines.filter((line) => line.startsWith('-')).length,
    changeId,
    patch,
  };
};
export const treeSymbolsFiles: PrChangeFile[] = [
  changed(TREE_SYMBOLS_FILE, 'tree-symbols-v1', before, after),
  changed(TREE_SYMBOLS_NEXT_FILE, 'tree-symbols-tasks-v1', tasksBefore, tasksAfter),
  changed(TREE_SYMBOLS_LONG_FILE, 'tree-symbols-long-v1', [], longAfter, 'added'),
];
export function treeSymbolsContents(path: string): PrFileContents | undefined {
  const sides =
    path === TREE_SYMBOLS_FILE ? [before, after] : path === TREE_SYMBOLS_NEXT_FILE ? [tasksBefore, tasksAfter] : path === TREE_SYMBOLS_LONG_FILE ? [[], longAfter] : undefined;
  return sides && { before: { kind: 'text', content: text(sides[0]) }, after: { kind: 'text', content: text(sides[1]) } };
}
