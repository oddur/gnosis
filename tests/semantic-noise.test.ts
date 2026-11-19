import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, test } from 'node:test';
import { structuredPatch } from 'diff';
import * as TreeSitter from 'web-tree-sitter';
import { createSyntaxEngine, type SyntaxLanguage } from '../lib/syntax-scope';
import {
  blockKey,
  changeBlocks,
  comparisonTexts,
  fileNoise,
  hidden,
  hunkNoise,
  noiseLabel,
  noiseStat,
  type NoiseKind,
} from '../lib/semantic-noise';

/**
 * Formatting-only and comment-only changes (#396), with the real tree-sitter runtime and the grammars Gnosis
 * bundles. The corpus's rule: no change of meaning may ever be called formatting or comments. Every case that changes
 * the program expects `code`.
 */
const assets = path.resolve(__dirname, '../src/assets/tree-sitter');
const engine = createSyntaxEngine(TreeSitter, {
  runtime: async () => new Uint8Array(await fs.readFile(require.resolve('web-tree-sitter/web-tree-sitter.wasm'))),
  grammar: async (language) => new Uint8Array(await fs.readFile(path.join(assets, `${language}.wasm`))),
  tags: (name) => fs.readFile(path.join(assets, `${name}-tags.scm`), 'utf8'),
});

interface Hunk {
  oldStart: number;
  newStart: number;
  rows: { type: ' ' | '+' | '-'; text: string }[];
}
/** The hunks of a diff of two texts, with `context` unchanged lines around each change, as GitHub's patches have. */
function hunksOf(before: string, after: string, context = 3): Hunk[] {
  return structuredPatch('a', 'b', before, after, '', '', { context }).hunks.map((hunk) => ({
    oldStart: hunk.oldLines === 0 ? hunk.oldStart + 1 : hunk.oldStart,
    newStart: hunk.newLines === 0 ? hunk.newStart + 1 : hunk.newStart,
    rows: hunk.lines
      .filter((line) => !line.startsWith('\\'))
      .map((line) => ({ type: line[0] as ' ' | '+' | '-', text: line.slice(1) })),
  }));
}
/** Each change block's kind, in order. */
async function kinds(language: SyntaxLanguage, before: string, after: string, context = 3): Promise<NoiseKind[]> {
  const hunks = hunksOf(before, after, context);
  assert.ok(hunks.length, 'The texts must differ');
  const { blocks } = await engine.noise(language, after, hunks);
  return blocks.map((block) => block.kind);
}
const lines = (...rows: string[]) => `${rows.join('\n')}\n`;

/** Every case: language, name, before, after, and the expected kind of each block. */
type Case = [SyntaxLanguage, string, string, string, NoiseKind[]];
const corpus: Case[] = [];
const add = (language: SyntaxLanguage, name: string, before: string, after: string, expected: NoiseKind | NoiseKind[]) =>
  corpus.push([language, name, before, after, Array.isArray(expected) ? expected : [expected]]);

// ── TypeScript ──────────────────────────────────────────────────────────────
const tsBase = lines(
  "import { readFile } from 'node:fs/promises';",
  '',
  'export function total(values: number[]): number {',
  '  let sum = 0;',
  '  for (const value of values) sum += value;',
  '  return sum;',
  '}'
);
add('typescript', 'reindent', tsBase, tsBase.replace(/^ {2}/gm, '    '), 'formatting');
add('typescript', 'spacing', tsBase, tsBase.replace('let sum = 0;', 'let  sum=0 ;'), 'formatting');
add('typescript', 'blank line', tsBase, tsBase.replace('  return sum;', '\n  return sum;'), 'formatting');
add(
  'typescript',
  'wrap a signature',
  tsBase,
  tsBase.replace('export function total(values: number[]): number {', 'export function total(\n  values: number[],\n): number {'),
  'formatting'
);
add('typescript', 'trailing comma in an object', lines('const a = { x: 1, y: 2 };'), lines('const a = {', '  x: 1,', '  y: 2,', '};'), 'formatting');
add('typescript', 'quote style', tsBase, tsBase.replace("'node:fs/promises'", '"node:fs/promises"'), 'formatting');
add('typescript', 'line comment added', tsBase, tsBase.replace('  return sum;', '  // The total.\n  return sum;'), 'comments');
add('typescript', 'line comment edited', lines('// Adds.', 'const a = 1;'), lines('// Adds them up.', 'const a = 1;'), 'comments');
add('typescript', 'trailing comment removed', lines('const a = 1; // one', 'const b = 2;'), lines('const a = 1;', 'const b = 2;'), 'comments');
add(
  'typescript',
  'JSDoc edited',
  lines('/**', ' * Adds.', ' */', 'export const add = (a: number) => a;'),
  lines('/**', ' * Adds a number.', ' * @param a The number.', ' */', 'export const add = (a: number) => a;'),
  'comments'
);
add('typescript', 'comment and reindent', lines('if (a) {', '  // old', '  b();', '}'), lines('if (a) {', '    // new', '    b();', '}'), 'both');
add('typescript', 'string content', lines("const a = 'x';"), lines("const a = 'y';"), 'code');
add('typescript', 'string whitespace', lines("const a = 'x y';"), lines("const a = 'x  y';"), 'code');
add('typescript', 'template whitespace', lines('const a = `x ${b} y`;'), lines('const a = `x ${b}  y`;'), 'code');
add('typescript', 'quotes with an escape', lines("const a = 'it\\'s';"), lines('const a = "it\'s";'), 'code');
add('typescript', 'renamed identifier', tsBase, tsBase.replace(/\bsum\b/g, 'total'), 'code');
add('typescript', 'reordered statements', lines('a();', 'b();'), lines('b();', 'a();'), 'code');
add('typescript', 'operator', tsBase, tsBase.replace('sum += value', 'sum -= value'), 'code');
add('typescript', 'return then a line break', lines('function f() {', '  return x;', '}'), lines('function f() {', '  return', '  x;', '}'), 'code');
add(
  'typescript',
  'code change hidden in a reformat',
  tsBase,
  tsBase.replace(/^ {2}/gm, '    ').replace('let sum = 0;', 'let sum = 1;'),
  'code'
);
add('typescript', 'uncommented code', lines('a();', '// b();', 'c();'), lines('a();', 'b();', 'c();'), 'code');
add('typescript', 'commented-out code', lines('a();', 'b();', 'c();'), lines('a();', '// b();', 'c();'), 'code');
add(
  'typescript',
  'block comment opened around code',
  lines('a();', 'b();', 'c();', 'd();', 'e();', 'f();', 'g();', 'h();', 'i();', 'j();'),
  lines('a();', '/*', 'b();', 'c();', 'd();', 'e();', 'f();', 'g();', 'h();', '*/', 'i();', 'j();'),
  ['code', 'code']
);
add('typescript', 'directive comment', lines('const a: number = b;'), lines('// @ts-ignore', 'const a: number = b;'), 'code');
add('typescript', 'parse error', lines('const a = 1;'), lines('const a = (1;'), 'code');
add('typescript', 'trailing comma after a hole', lines('const a = [1, , ];'), lines('const a = [1, ];'), 'code');
add('tsx', 'JSX text', lines('const a = <p>Hello world</p>;'), lines('const a = <p>Hello  world</p>;'), 'code');
add('tsx', 'JSX attributes rewrapped', lines('const a = <p a="1" b={2}>x</p>;'), lines('const a = <p', '  a="1"', '  b={2}>x</p>;'), 'formatting');
add('tsx', 'JSX reindented', lines('const a = (', '  <div>', '    <p>Hello</p>', '    text here', '  </div>', ');'), lines('const a = (', '    <div>', '        <p>Hello</p>', '        text here', '    </div>', ');'), 'formatting');
add('tsx', 'JSX space after a tag', lines('const a = <div><b>x</b> y</div>;'), lines('const a = <div><b>x</b>y</div>;'), 'code');
add('typescript', 'same tokens, other statements', lines('a', '++b;'), lines('a++', 'b;'), 'code');
add('go', 'cgo preamble', lines('package a', '', '// #include <a.h>', 'import "C"'), lines('package a', '', '// #include <b.h>', 'import "C"'), 'code');
add('javascript', 'regex', lines('const a = /a b/;'), lines('const a = /a  b/;'), 'code');

// ── Rust ────────────────────────────────────────────────────────────────────
const rsBase = lines('pub fn total(values: &[i32]) -> i32 {', '    let mut sum = 0;', '    for v in values { sum += v; }', '    sum', '}');
add('rust', 'reindent and rewrap', rsBase, rsBase.replace('    for v in values { sum += v; }', '    for v in values {\n        sum += v;\n    }'), 'formatting');
add('rust', 'trailing comma in arguments', lines('fn f() { g(a, b); }'), lines('fn f() {', '    g(', '        a,', '        b,', '    );', '}'), 'formatting');
add('rust', 'tuple comma', lines('fn f() { let a = (b,); }'), lines('fn f() { let a = (b); }'), 'code');
add('rust', 'doc comment', lines('/// Totals.', 'pub fn f() {}'), lines('/// Totals the values.', '/// Returns 0 when empty.', 'pub fn f() {}'), 'comments');
add('rust', 'block comment', lines('fn f() { /* a */ g(); }'), lines('fn f() { /* b */ g(); }'), 'comments');
add('rust', 'string content', lines('fn f() { g("a"); }'), lines('fn f() { g("b"); }'), 'code');
add('rust', 'char quotes are not strings', lines("fn f() { g('a'); }"), lines('fn f() { g("a"); }'), 'code');
add('rust', 'renamed identifier', rsBase, rsBase.replace(/\bsum\b/g, 'acc'), 'code');
add('rust', 'operator', rsBase, rsBase.replace('sum += v', 'sum -= v'), 'code');
add('rust', 'macro spacing', lines('fn f() { println!("{}", a); }'), lines('fn f() { println!( "{}" , a ); }'), 'formatting');
add('rust', 'parse error', lines('fn f() {}'), lines('fn f() {'), 'code');

// ── C# ──────────────────────────────────────────────────────────────────────
const csBase = lines('namespace App {', '    public class Store {', '        public int Total(int[] values) {', '            var sum = 0;', '            foreach (var v in values) sum += v;', '            return sum;', '        }', '    }', '}');
add('csharp', 'reindent', csBase, csBase.replace(/^( +)/gm, '$1$1'), ['formatting', 'formatting']);
add('csharp', 'braces on their own line', csBase, csBase.replace('    public class Store {', '    public class Store\n    {'), 'formatting');
add('csharp', 'doc comment', lines('/// <summary>Old.</summary>', 'class A {}'), lines('/// <summary>New.</summary>', 'class A {}'), 'comments');
add('csharp', 'comment removed', csBase.replace('            var sum = 0;', '            // Start at zero.\n            var sum = 0;'), csBase, 'comments');
add('csharp', 'verbatim string', lines('class A { string s = @"a b"; }'), lines('class A { string s = @"a  b"; }'), 'code');
add('csharp', 'interpolated string', lines('class A { string s = $"a{b}"; }'), lines('class A { string s = $"a{ b }"; }'), 'code');
add('csharp', 'renamed identifier', csBase, csBase.replace(/\bsum\b/g, 'acc'), 'code');
add('csharp', 'reordered statements', lines('class A { void F() { a(); b(); } }'), lines('class A { void F() { b(); a(); } }'), 'code');
add('csharp', 'trailing comma in an enum', lines('enum E { A, B }'), lines('enum E', '{', '    A,', '    B,', '}'), 'formatting');

// ── Go ──────────────────────────────────────────────────────────────────────
const goBase = lines('package store', '', 'func Total(values []int) int {', '\tsum := 0', '\tfor _, v := range values {', '\t\tsum += v', '\t}', '\treturn sum', '}');
add('go', 'alignment', lines('package a', '', 'var (', '\ta = 1', '\tbb = 2', ')'), lines('package a', '', 'var (', '\ta  = 1', '\tbb = 2', ')'), 'formatting');
add('go', 'wrapped call with trailing comma', lines('package a', '', 'func f() {', '\tg(a, b)', '}'), lines('package a', '', 'func f() {', '\tg(', '\t\ta,', '\t\tb,', '\t)', '}'), 'formatting');
add('go', 'doc comment', goBase, goBase.replace('func Total', '// Total adds the values.\nfunc Total'), 'comments');
add('go', 'build constraint', lines('//go:build linux', '', 'package a'), lines('//go:build darwin', '', 'package a'), 'code');
add('go', 'raw string', lines('package a', '', 'var s = `a b`'), lines('package a', '', 'var s = `a  b`'), 'code');
add('go', 'renamed identifier', goBase, goBase.replace(/\bsum\b/g, 'acc'), 'code');
add('go', 'operator', goBase, goBase.replace('sum += v', 'sum -= v'), 'code');
add('go', 'return then a line break', lines('package a', '', 'func f() int {', '\treturn 1', '}'), lines('package a', '', 'func f() int {', '\treturn', '\t1', '}'), 'code');

// ── Python ──────────────────────────────────────────────────────────────────
const pyBase = lines('def total(values):', '    total = 0', '    for v in values:', '        total += v', '    return total');
add('python', 'consistent reindent', pyBase, pyBase.replace(/^( +)/gm, (spaces) => ' '.repeat(spaces.length / 2)), 'formatting');
add('python', 'wrap inside brackets', lines('x = f(a, b)'), lines('x = f(', '    a,', '    b,', ')'), 'formatting');
add('python', 'spacing', lines('x = f(a,b)'), lines('x = f(a, b)'), 'formatting');
add('python', 'quote style', lines("x = 'a'"), lines('x = "a"'), 'formatting');
add('python', 'comment edited', lines('# Old.', 'x = 1'), lines('# New.', 'x = 1'), 'comments');
add('python', 'docstring edited', lines('def f():', '    """Old."""', '    return 1'), lines('def f():', '    """New, longer."""', '    return 1'), 'comments');
add(
  'python',
  'reindent moves a line out of the loop',
  pyBase,
  pyBase.replace('        total += v\n    return total', '        total += v\n        return total'),
  'code'
);
add('python', 'reindent moves a line into the if', lines('if a:', '    b()', 'c()'), lines('if a:', '    b()', '    c()'), 'code');
add('python', 'tuple trailing comma', lines('x = (a,)'), lines('x = (a)'), 'code');
add('python', 'subscript trailing comma', lines('x = a[1,]'), lines('x = a[1]'), 'code');
add('python', 'f-string', lines('x = f"{a} b"'), lines('x = f"{a}  b"'), 'code');
add('python', 'string content', lines('x = "a"'), lines('x = "b"'), 'code');
add('python', 'statements joined', lines('a = 1', 'b = 2'), lines('a = 1; b = 2'), 'code');
add('python', 'type comment', lines('x = []  # type: list[int]'), lines('x = []  # type: list[str]'), 'code');
add('python', 'parse error', lines('x = 1'), lines('x = (1'), 'code');

// ── Java ────────────────────────────────────────────────────────────────────
const javaBase = lines('class Store {', '  int total(int[] values) {', '    int sum = 0;', '    for (int v : values) sum += v;', '    return sum;', '  }', '}');
add('java', 'reindent', javaBase, javaBase.replace(/^( +)/gm, '$1$1'), 'formatting');
add('java', 'javadoc', javaBase, javaBase.replace('  int total', '  /** Adds the values. */\n  int total'), 'comments');
add('java', 'block comment edited', lines('class A { /* a */ }'), lines('class A { /* b */ }'), 'comments');
add('java', 'text block', lines('class A { String s = """', '  a', '  """; }'), lines('class A { String s = """', '    a', '  """; }'), 'code');
add('java', 'renamed identifier', javaBase, javaBase.replace(/\bsum\b/g, 'acc'), 'code');
add('java', 'operator', javaBase, javaBase.replace('sum += v', 'sum -= v'), 'code');
add('java', 'array initializer trailing comma', lines('class A { int[] a = {1, 2}; }'), lines('class A { int[] a = {', '  1,', '  2,', '}; }'), 'formatting');

// ── JSON ────────────────────────────────────────────────────────────────────
add('json', 'reformat', lines('{"a": 1, "b": [1, 2]}'), lines('{', '  "a": 1,', '  "b": [', '    1,', '    2', '  ]', '}'), 'formatting');
add('json', 'value', lines('{"a": 1}'), lines('{"a": 2}'), 'code');
add('json', 'string whitespace', lines('{"a": "x y"}'), lines('{"a": "x  y"}'), 'code');
add('json', 'reordered keys', lines('{', '  "a": 1,', '  "b": 2', '}'), lines('{', '  "b": 2,', '  "a": 1', '}'), 'code');
add('json', 'trailing comma is a parse error', lines('{"a": 1}'), lines('{"a": 1,}'), 'code');

// ── YAML ────────────────────────────────────────────────────────────────────
add('yaml', 'spacing after a colon', lines('a: 1', 'b: 2'), lines('a:   1', 'b: 2'), 'formatting');
add('yaml', 'comment', lines('# Old', 'a: 1'), lines('# New', 'a: 1'), 'comments');
add('yaml', 'quote style', lines("a: 'x'"), lines('a: "x"'), 'formatting');
add('yaml', 'plain to quoted is a type change', lines('a: 1'), lines('a: "1"'), 'code');
add('yaml', 'indentation changes nesting', lines('a:', '  b: 1', '  c: 2'), lines('a:', '  b: 1', 'c: 2'), 'code');
add('yaml', 'indentation changes a list item', lines('a:', '  - b: 1', '    c: 2'), lines('a:', '  - b: 1', '  - c: 2'), 'code');
add('yaml', 'block scalar indentation', lines('a: |', '  x', '  y'), lines('a: |', '    x', '    y'), 'code');
add('yaml', 'value', lines('a: 1'), lines('a: 2'), 'code');

void describe('semantic noise corpus', () => {
  for (const [language, name, before, after, expected] of corpus)
    void test(`${language}: ${name}`, async () => {
      const got = await kinds(language, before, after);
      // A change of meaning may span more than one block; each of them is code.
      if (expected.length === 1 && expected[0] === 'code') assert.ok(got.length && got.every((kind) => kind === 'code'), got.join());
      else assert.deepEqual(got, expected);
    });
  void test('no change of meaning is ever filtered', async () => {
    // A tally across the corpus, for the report: every `code` case stays code.
    let wrong = 0;
    for (const [language, , before, after, expected] of corpus) {
      const got = await kinds(language, before, after);
      got.forEach((kind, i) => {
        if ((expected[i] ?? expected[0]) === 'code' && kind !== 'code') wrong++;
      });
    }
    assert.equal(wrong, 0);
  });
});

void describe('semantic noise across a file', () => {
  void test('each block is classified alone: formatting next to a code change stays formatting', async () => {
    const before = lines(...Array.from({ length: 30 }, (_, i) => `const v${i} = ${i};`));
    const after = before.replace('const v2 = 2;', 'const  v2 = 2;').replace('const v20 = 20;', 'const v20 = 21;');
    assert.deepEqual(await kinds('typescript', before, after), ['formatting', 'code']);
  });
  void test('blocks in one GitHub hunk are classified apart', async () => {
    const before = lines('a();', 'b();', 'c();', 'd();', 'e();');
    const after = lines('a( );', 'b();', 'c();', 'd(1);', 'e();');
    const hunks = hunksOf(before, after);
    assert.equal(hunks.length, 1);
    assert.deepEqual(await kinds('typescript', before, after), ['formatting', 'code']);
  });
  void test('a change that regroups the code around it makes the blocks that reach it code', async () => {
    // Adding `.c()` regroups the whole chain, whose first lines are unchanged.
    const before = lines('const x = a', '  .b();', 'f( 1 );');
    const after = lines('const x = a', '  .b()', '  .c();', 'f(1);');
    const result = await kinds('typescript', before, after, 0);
    assert.equal(result[0], 'code');
  });
  void test('Python: a line the loop takes in is code, and a respaced signature further down is formatting', async () => {
    const filler = Array.from({ length: 12 }, (_, i) => `V${i} = ${i}`);
    const before = lines('def run(items):', '    for item in items:', '        total(item)', '    log(item)', '', ...filler, '', 'def other(a,b):', '    return a+b');
    const after = lines('def run(items):', '    for item in items:', '        total(item)', '        log(item)', '', ...filler, '', 'def other(a, b):', '    return a + b');
    assert.deepEqual(await kinds('python', before, after), ['code', 'formatting']);
  });
  void test('YAML: a key that leaves its mapping is code, and a respaced value further down is formatting', async () => {
    const filler = Array.from({ length: 12 }, (_, i) => `k${i}: ${i}`);
    const before = lines('server:', '  port: 80', '  host: x', ...filler, 'retries:   3');
    const after = lines('server:', '  port: 80', 'host: x', ...filler, 'retries: 3');
    assert.deepEqual(await kinds('yaml', before, after), ['code', 'formatting']);
  });
  void test('a difference in unchanged lines that no block reaches makes every block code', async () => {
    // A string opened in the first block and closed in the second: the lines between change from code to text.
    const before = lines('a( );', ...Array.from({ length: 10 }, (_, i) => `f${i}();`), 'b();');
    const after = lines('a( ); const s = `', ...Array.from({ length: 10 }, (_, i) => `f${i}();`), 'b(); `;');
    const result = await kinds('typescript', before, after);
    assert.ok(result.every((kind) => kind === 'code'), result.join());
  });
  void test('the whole patch, as a file of many hunks with CRLF line endings, matches its hunks', async () => {
    const before = 'a();\r\nb();\r\n';
    const after = 'a( );\r\nb();\r\n';
    const hunks = hunksOf(before, after);
    const { blocks } = await engine.noise('typescript', after, hunks);
    assert.deepEqual(blocks.map((b) => b.kind), ['formatting']);
  });
  void test('line endings alone are formatting', async () => {
    const hunks = [{ oldStart: 1, newStart: 1, rows: [{ type: '-' as const, text: 'a();\r' }, { type: '+' as const, text: 'a();' }] }];
    const { blocks } = await engine.noise('typescript', 'a();\n', hunks);
    assert.deepEqual(blocks.map((b) => b.kind), ['formatting']);
  });
  void test('hunks that do not match the text are code', async () => {
    const hunks = [{ oldStart: 1, newStart: 1, rows: [{ type: '-' as const, text: 'a();' }, { type: '+' as const, text: 'b( );' }] }];
    const { blocks } = await engine.noise('typescript', 'c();\n', hunks);
    assert.deepEqual(blocks.map((b) => [b.kind, b.reason]), [['code', 'mismatch']]);
  });
  void test('an Explanation topic’s subset of hunks is compared with everything else as it is now', async () => {
    const before = lines(...Array.from({ length: 20 }, (_, i) => `f${i}();`));
    const after = before.replace('f1();', 'f1( );').replace('f15();', 'g15();');
    const all = hunksOf(before, after);
    assert.equal(all.length, 2);
    // Only the first hunk: the old text keeps the second change.
    const { blocks } = await engine.noise('typescript', after, [all[0]]);
    assert.deepEqual(blocks.map((b) => b.kind), ['formatting']);
    const second = await engine.noise('typescript', after, [all[1]]);
    assert.deepEqual(second.blocks.map((b) => b.kind), ['code']);
  });
});

void describe('semantic noise helpers', () => {
  void test('change blocks keep the hunk’s line numbers', () => {
    const blocks = changeBlocks([
      {
        oldStart: 10,
        newStart: 12,
        rows: [
          { type: ' ', text: 'a' },
          { type: '-', text: 'b' },
          { type: '+', text: 'B' },
          { type: '+', text: 'C' },
          { type: ' ', text: 'd' },
          { type: '+', text: 'e' },
        ],
      },
    ]);
    assert.deepEqual(blocks, [
      { oldStart: 11, oldCount: 1, newStart: 13, newCount: 2 },
      { oldStart: 13, oldCount: 0, newStart: 16, newCount: 1 },
    ]);
  });
  void test('the old text is the new one with the hunks undone', () => {
    const texts = comparisonTexts('a\nB\nc\n', [{ oldStart: 2, newStart: 2, rows: [{ type: '-', text: 'b' }, { type: '+', text: 'B' }] }]);
    assert.deepEqual(texts, { before: 'a\nb\nc\n', after: 'a\nB\nc\n', blocks: [{ oldRow: 1, oldCount: 1, newRow: 1, newCount: 1 }] });
  });
  void test('the filter hides each kind by its own toggle, and both kinds only with both', () => {
    assert.equal(hidden('formatting', { whitespace: true, comments: false }), true);
    assert.equal(hidden('comments', { whitespace: true, comments: false }), false);
    assert.equal(hidden('both', { whitespace: true, comments: false }), false);
    assert.equal(hidden('both', { whitespace: true, comments: true }), true);
    assert.equal(hidden('code', { whitespace: true, comments: true }), false);
    assert.equal(hidden(undefined, { whitespace: true, comments: true }), false);
  });
  void test('a hunk is hidden only when every block in it is', () => {
    const hunk = {
      oldStart: 1,
      newStart: 1,
      rows: [
        { type: '-' as const, text: 'a' },
        { type: '+' as const, text: 'a ' },
        { type: ' ' as const, text: 'b' },
        { type: '-' as const, text: 'c' },
        { type: '+' as const, text: 'd' },
      ],
    };
    const both = new Map<string, NoiseKind>([
      [blockKey({ oldStart: 1, newStart: 1 }), 'formatting'],
      [blockKey({ oldStart: 3, newStart: 3 }), 'code'],
    ]);
    const filter = { whitespace: true, comments: false };
    const mixed = hunkNoise(hunk, both, filter);
    assert.equal(mixed.hidden, false);
    assert.deepEqual(mixed.lines, [
      { side: 'before', line: 1 },
      { side: 'after', line: 1 },
    ]);
    both.set(blockKey({ oldStart: 3, newStart: 3 }), 'formatting');
    assert.equal(hunkNoise(hunk, both, filter).hidden, true);
    assert.equal(hunkNoise(hunk, new Map(), filter).hidden, false);
  });
  void test('labels and stats say what is hidden', () => {
    assert.equal(noiseLabel(['formatting']), 'Formatting only');
    assert.equal(noiseLabel(['comments', 'comments']), 'Comments only');
    assert.equal(noiseLabel(['formatting', 'comments']), 'Formatting and comments');
    assert.equal(noiseLabel(['both']), 'Formatting and comments');
    const blocks = [
      { oldStart: 1, oldCount: 2, newStart: 1, newCount: 3, kind: 'formatting' as const },
      { oldStart: 9, oldCount: 1, newStart: 10, newCount: 1, kind: 'code' as const },
    ];
    const noise = fileNoise(blocks, { whitespace: true, comments: true });
    assert.equal(noise.all, false);
    assert.equal(noiseStat(noise), '5 formatting');
    assert.equal(fileNoise(blocks.slice(0, 1), { whitespace: true, comments: true }).all, true);
    assert.equal(fileNoise([], { whitespace: true, comments: true }).all, false);
  });
});
