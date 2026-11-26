import type { PrChangeFile, PrFileContents } from '../../lib/pr-changes';
import { patchOf } from './syntax-scope';

/**
 * `?tree-symbols`: the Changes tree's symbol rows (Settings › Review, Beta; tests/tree-symbols-browser.ts). The PR
 * changes `src/symbols/store.ts`: a new import at the top, `flush` inside an unchanged class `Store`, `gone` removed and
 * `added` added. In the tree the file expands to Imports, then Store › flush, gone and added.
 */
export const TREE_SYMBOLS_FILE = 'src/symbols/store.ts';

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

const text = (lines: string[]) => `${lines.join('\n')}\n`;
const patch = patchOf(before, after);
const lines = patch.split('\n');
export const treeSymbolsFiles: PrChangeFile[] = [
  {
    path: TREE_SYMBOLS_FILE,
    status: 'modified',
    additions: lines.filter((line) => line.startsWith('+')).length,
    deletions: lines.filter((line) => line.startsWith('-')).length,
    changeId: 'tree-symbols-v1',
    patch,
  },
];
export function treeSymbolsContents(path: string): PrFileContents | undefined {
  return path === TREE_SYMBOLS_FILE ? { before: { kind: 'text', content: text(before) }, after: { kind: 'text', content: text(after) } } : undefined;
}
