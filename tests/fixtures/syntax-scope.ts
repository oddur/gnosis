import { structuredPatch } from 'diff';
import type { PrChangeFile, PrFileContents } from '../../lib/pr-changes';

/**
 * Synthetic files for the tree-sitter scope checks (#393): `tests/syntax-scope.test.ts` and the `--syntax-scope`
 * browser suite, which adds them to the workbench fixture's Changes with `?syntax-scope`.
 *
 * `src/scope.ts` changes a short function (opens whole by default), a 66-line method (Show whole function), a
 * 205-line function (past the cap: Show function signature) and an `it` test. `src/store.rs` changes an `impl`
 * block, a method, a trait, a `#[test]` function and deletes a line from `cleanup()`. `src/notes.rb` has no
 * grammar. `src/large.ts` is a 3,000-line file with one change, for parse timing.
 */
const filler = (prefix: string, from: number, count: number) =>
  Array.from({ length: count }, (_, i) => `${prefix}${from + i} = ${from + i};`);

export const scopeBefore = [
  '// Scope fixture for #393.',
  "import { join } from 'node:path';",
  '',
  'export function resolvePaths(root: string, names: string[]): string[] {',
  '  const result: string[] = [];',
  '  for (const name of names) {',
  '    if (!name) continue;',
  '    result.push(join(root, name));',
  '  }',
  '  result.sort();',
  '  return result;',
  '}',
  '',
  ...filler('export const before', 0, 30),
  '',
  'export class StoreBridge {',
  '  private items = new Map<string, number>();',
  '  flush(): number {',
  '    let total = 0;',
  ...Array.from({ length: 60 }, (_, i) => `    total += ${i};`),
  '    return total;',
  '  }',
  '}',
  '',
  ...filler('export const between', 0, 30),
  '',
  'export function migrate(version: number): number {',
  ...Array.from({ length: 200 }, (_, i) => `  version = version + ${i};`),
  '  return version;',
  '}',
  '',
  ...filler('export const after', 0, 30),
  '',
  "describe('resolvePaths', () => {",
  "  it('joins names', () => {",
  "    expect(resolvePaths('/r', ['a'])).toEqual(['/r/a']);",
  '  });',
  '});',
];
export const scopeAfter = scopeBefore.map((line) =>
  line === '    result.push(join(root, name));'
    ? '    result.push(join(root, name.trim()));'
    : line === '    total += 30;'
      ? '    total += 30 * 2;'
      : line === '  version = version + 120;'
        ? '  version = version + 121;'
        : line === "    expect(resolvePaths('/r', ['a'])).toEqual(['/r/a']);"
          ? "    expect(resolvePaths('/r', [' a '])).toEqual(['/r/a']);"
          : line
);

export const storeBefore = [
  'use std::collections::HashMap;',
  '',
  'pub struct StoreBridge {',
  '    items: HashMap<String, u32>,',
  '}',
  '',
  'impl StoreBridge {',
  '    pub const LIMIT: usize = 64;',
  '',
  '    pub fn new() -> Self {',
  '        StoreBridge { items: HashMap::new() }',
  '    }',
  '',
  '    pub fn save(&mut self, key: &str, value: u32) -> bool {',
  ...Array.from({ length: 40 }, (_, i) => `        let step_${i} = value + ${i};`),
  '        self.items.insert(key.to_string(), value);',
  '        true',
  '    }',
  '}',
  '',
  ...Array.from({ length: 20 }, (_, i) => `const C_${i}: u32 = ${i};`),
  '',
  'pub trait Bridge {',
  '    fn send(&self, payload: &[u8]) -> usize;',
  '}',
  '',
  ...Array.from({ length: 20 }, (_, i) => `const D_${i}: u32 = ${i};`),
  '',
  'pub fn cleanup(store: &mut StoreBridge) {',
  '    store.items.clear();',
  '    println!("cleared");',
  '    store.items.shrink_to_fit();',
  '}',
  '',
  ...Array.from({ length: 20 }, (_, i) => `const E_${i}: u32 = ${i};`),
  '',
  '#[cfg(test)]',
  'mod tests {',
  '    use super::*;',
  '',
  '    #[test]',
  '    fn saves_items() {',
  '        let mut store = StoreBridge::new();',
  '        assert!(store.save("a", 1));',
  '    }',
  '}',
];
export const storeAfter = storeBefore
  .filter((line) => line !== '    println!("cleared");')
  .map((line) =>
    line === '    pub const LIMIT: usize = 64;'
      ? '    pub const LIMIT: usize = 128;'
      : line === '        self.items.insert(key.to_string(), value);'
        ? '        self.items.insert(key.to_owned(), value);'
        : line === '    fn send(&self, payload: &[u8]) -> usize;'
          ? '    fn send(&self, payload: &[u8], urgent: bool) -> usize;'
          : line === '        assert!(store.save("a", 1));'
            ? '        assert!(store.save("a", 2));'
            : line
  );

export const notesBefore = [
  '# Notes',
  ...Array.from({ length: 20 }, (_, i) => `NOTE_${i} = ${i}`),
  'def summarize(notes)',
  '  notes.map(&:strip)',
  'end',
  ...Array.from({ length: 20 }, (_, i) => `OTHER_${i} = ${i}`),
];
export const notesAfter = notesBefore.map((line) =>
  line === '  notes.map(&:strip)' ? '  notes.map(&:strip).compact' : line
);

/** 1,000 three-line functions; the change is in `generated500`. */
export const largeBefore = Array.from({ length: 1000 }, (_, k) => [
  `export function generated${k}(input: number): number {`,
  `  return input * ${k} + ${k % 7};`,
  '}',
]).flat();
export const largeAfter = largeBefore.map((line) =>
  line === '  return input * 500 + 3;' ? '  return input * 500 + 4;' : line
);

const text = (lines: string[]) => `${lines.join('\n')}\n`;
/** Lines a hunk header names as its enclosing line, as GitHub's language-aware headers do. */
const HEADER_LINE = /^\s*(?:(?:pub|export|public|private|protected|static|async)\s+)*(?:fn|function|class|impl|mod|struct|trait|interface|void|def)\b/;
/** The text GitHub puts after a hunk header: the nearest definition line above the hunk, or nothing. */
export function headerContext(before: string[], oldStart: number): string {
  for (let index = oldStart - 2; index >= 0; index--) if (HEADER_LINE.test(before[index])) return ` ${before[index]}`;
  return '';
}
/**
 * A GitHub-style patch: hunks with three lines of context, without file headers. With `headers`, each hunk header
 * ends with the enclosing line above the hunk, as GitHub's do (`@@ -8,7 +8,7 @@ pub fn handler_3(&self) -> u32 {`).
 */
export function patchOf(before: string[], after: string[], { headers = false } = {}): string {
  const patch = structuredPatch('a', 'b', text(before), text(after), '', '', { context: 3 });
  return patch.hunks
    .map((hunk) =>
      [
        `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@${headers ? headerContext(before, hunk.oldStart) : ''}`,
        ...hunk.lines,
      ].join('\n')
    )
    .join('\n');
}

// Imports at the top change outside every definition: the file alone is their location.
const importsBefore = [
  "import { join } from 'node:path';",
  "import { readFile } from 'node:fs/promises';",
  '',
  ...Array.from({ length: 12 }, (_, i) => `const filler${i} = ${i};`),
  '',
  'export function total(values: number[]): number {',
  '  let sum = 0;',
  '  for (const value of values) sum += value;',
  '  return sum;',
  '}',
];
const importsAfter = [
  "import { join, resolve } from 'node:path';",
  "import { readFile } from 'node:fs/promises';",
  '',
  ...Array.from({ length: 12 }, (_, i) => `const filler${i} = ${i};`),
  '',
  'export function total(values: number[]): number {',
  '  let sum = 0;',
  '  for (const value of values) sum += value * 1;',
  '  return sum;',
  '}',
];
/** A Unity script: a change inside `namespace › class › Update()`, for the C# grammar (#393). */
const navmesh = (step: string) => [
  'using UnityEngine;',
  '',
  'namespace Klang.Seed.World',
  '{',
  '    public class Navmesh : MonoBehaviour',
  '    {',
  '        [SerializeField] private float speed = 2f;',
  '',
  ...Array.from({ length: 10 }, (_, i) => `        private int field${i} = ${i};`),
  '',
  '        private void Update()',
  '        {',
  '            var delta = Time.deltaTime;',
  `            transform.Translate(0, ${step}, 0);`,
  '            Debug.Log(delta);',
  '        }',
  '    }',
  '}',
];
const navmeshBefore = navmesh('speed');
const navmeshAfter = navmesh('speed * delta');
// Pinned hunk headers (#395): two long changed hunks in a parsed file and in a file with no grammar. Each hunk's
// header pins under the file header while it is on screen. The first hunk of each starts at line 1, with no bar above
// it. `sticky.ts`'s second hunk is long enough to be sliced (#353).
const stickyBefore = [
  '// Sticky header fixture for #395.',
  'export function first(input: number): number {',
  '  let value = input;',
  ...Array.from({ length: 80 }, (_, i) => `  value += ${i};`),
  '  return value;',
  '}',
  ...Array.from({ length: 20 }, (_, i) => `export const between${i} = ${i};`),
  'export function second(input: number): number {',
  '  let value = input;',
  ...Array.from({ length: 200 }, (_, i) => `  value -= ${i};`),
  '  return value;',
  '}',
];
const stickyAfter = stickyBefore.map((line) => line.replace(/^  value ([+-])= (\d+);$/, '  value $1= $2 * 2;'));
const stickyNotesBefore = [
  '# Sticky notes for #395',
  ...Array.from({ length: 80 }, (_, i) => `FIRST_${i} = ${i}`),
  ...Array.from({ length: 20 }, (_, i) => `BETWEEN_${i} = ${i}`),
  ...Array.from({ length: 80 }, (_, i) => `SECOND_${i} = ${i}`),
];
const stickyNotesAfter = stickyNotesBefore.map((line) => line.replace(/^(FIRST|SECOND)_(\d+) = (\d+)$/, '$1_$2 = $3 * 2'));
const SOURCES: Record<string, [string[], string[]]> = {
  'src/scope.ts': [scopeBefore, scopeAfter],
  'src/imports.ts': [importsBefore, importsAfter],
  'src/Navmesh.cs': [navmeshBefore, navmeshAfter],
  'src/store.rs': [storeBefore, storeAfter],
  'src/notes.rb': [notesBefore, notesAfter],
  'src/large.ts': [largeBefore, largeAfter],
  'src/sticky.ts': [stickyBefore, stickyAfter],
  'src/sticky.rb': [stickyNotesBefore, stickyNotesAfter],
};
const changeFiles = (sources: Record<string, [string[], string[]]>, prefix: string, headers = false): PrChangeFile[] =>
  Object.entries(sources).map(([path, [before, after]], i) => {
    const patch = patchOf(before, after, { headers });
    const additions = patch.split('\n').filter((line) => line.startsWith('+')).length;
    const deletions = patch.split('\n').filter((line) => line.startsWith('-')).length;
    return { path, status: 'modified' as const, additions, deletions, changeId: `${prefix}-${i}`, patch };
  });
export const syntaxScopeFiles: PrChangeFile[] = changeFiles(SOURCES, 'syntax');

/**
 * `?syntax-lazy`: files whose contents the queue never prepares, for loading on view and prefetch (#393). Each Rust
 * handler is 60 lines inside `mod api › impl ClientN`, so its hunk shows a truncated breadcrumb and "Show whole
 * function" (too long to open by default). `cleanup.rs` only deletes a line, so both of its sides load. `panel.ts`
 * changes a method of a class.
 */
export function lazyHandler(i: number): [string[], string[]] {
  const before = [
    `// Lazy fixture ${i} for #393.`,
    'use std::fmt;',
    '',
    'mod api {',
    `    pub struct Client${i};`,
    '',
    `    impl Client${i} {`,
    `        pub fn handler_${i}(&self) -> u32 {`,
    '            let mut total = 0;',
    ...Array.from({ length: 60 }, (_, k) => `            total += ${k};`),
    '            total',
    '        }',
    '    }',
    '}',
  ];
  return [before, before.map((line) => (line === '            total += 30;' ? '            total += 30 * 2;' : line))];
}
const cleanupBefore = [
  'pub fn cleanup(items: &mut Vec<u32>) -> usize {',
  ...Array.from({ length: 30 }, (_, k) => `    items.push(${k});`),
  '    items.clear();',
  '    println!("cleared");',
  ...Array.from({ length: 30 }, (_, k) => `    items.push(${k + 30});`),
  '    items.len()',
  '}',
];
const panelBefore = [
  "import { render } from './dom';",
  '',
  'export class Panel {',
  '  open(): number {',
  '    let size = 0;',
  ...Array.from({ length: 60 }, (_, k) => `    size += ${k};`),
  '    return size;',
  '  }',
  '}',
];
export const LAZY_HANDLERS = 163;
const LAZY: Record<string, [string[], string[]]> = {
  'src/lazy/cleanup.rs': [cleanupBefore, cleanupBefore.filter((line) => line !== '    println!("cleared");')],
  ...Object.fromEntries(
    Array.from({ length: LAZY_HANDLERS }, (_, i) => [`src/lazy/h${String(i).padStart(3, '0')}.rs`, lazyHandler(i)])
  ),
  'src/lazy/panel.ts': [panelBefore, panelBefore.map((line) => (line === '    size += 30;' ? '    size += 30 * 2;' : line))],
};
// The lazy files' hunk headers carry GitHub's enclosing line, for the provisional breadcrumb shown before contents load.
export const syntaxLazyFiles: PrChangeFile[] = changeFiles(LAZY, 'lazy', true);

export function syntaxScopeContents(path: string): PrFileContents | undefined {
  const source = Object.hasOwn(SOURCES, path) ? SOURCES[path] : Object.hasOwn(LAZY, path) ? LAZY[path] : undefined;
  if (!source) return undefined;
  return { before: { kind: 'text', content: text(source[0]) }, after: { kind: 'text', content: text(source[1]) } };
}
