import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, test } from 'node:test';
import { structuredPatch } from 'diff';
import * as TreeSitter from 'web-tree-sitter';
import { createSyntaxEngine, type SyntaxLanguage } from '../lib/syntax-scope';
import { DEFAULT_DIFF_APPEARANCE, noiseFilterOf, toggledQuietChanges } from '../lib/review-diff';
import { quietHeader } from '../lib/quiet-changes-header';
import {
  blockKey,
  changeBlocks,
  comparisonTexts,
  fileNoise,
  hidden,
  hunkNoise,
  noiseLabel,
  noiseStat,
  numberText,
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
add('typescript', 'reindent', tsBase, tsBase.replace(/^ {2}/gm, '    '), 'whitespace');
add('typescript', 'spacing', tsBase, tsBase.replace('let sum = 0;', 'let  sum=0 ;'), 'whitespace');
add('typescript', 'blank line', tsBase, tsBase.replace('  return sum;', '\n  return sum;'), 'whitespace');
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
add('typescript', 'comment and reindent', lines('if (a) {', '  // old', '  b();', '}'), lines('if (a) {', '    // new', '    b();', '}'), 'whitespace-comments');
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
add('tsx', 'JSX attributes rewrapped', lines('const a = <p a="1" b={2}>x</p>;'), lines('const a = <p', '  a="1"', '  b={2}>x</p>;'), 'whitespace');
add('tsx', 'JSX reindented', lines('const a = (', '  <div>', '    <p>Hello</p>', '    text here', '  </div>', ');'), lines('const a = (', '    <div>', '        <p>Hello</p>', '        text here', '    </div>', ');'), 'formatting');
add('tsx', 'JSX space after a tag', lines('const a = <div><b>x</b> y</div>;'), lines('const a = <div><b>x</b>y</div>;'), 'code');
add('typescript', 'same tokens, other statements', lines('a', '++b;'), lines('a++', 'b;'), 'code');
add('go', 'cgo preamble', lines('package a', '', '// #include <a.h>', 'import "C"'), lines('package a', '', '// #include <b.h>', 'import "C"'), 'code');
add('javascript', 'regex', lines('const a = /a b/;'), lines('const a = /a  b/;'), 'code');

// ── Rust ────────────────────────────────────────────────────────────────────
const rsBase = lines('pub fn total(values: &[i32]) -> i32 {', '    let mut sum = 0;', '    for v in values { sum += v; }', '    sum', '}');
add('rust', 'reindent and rewrap', rsBase, rsBase.replace('    for v in values { sum += v; }', '    for v in values {\n        sum += v;\n    }'), 'whitespace');
add('rust', 'trailing comma in arguments', lines('fn f() { g(a, b); }'), lines('fn f() {', '    g(', '        a,', '        b,', '    );', '}'), 'formatting');
add('rust', 'tuple comma', lines('fn f() { let a = (b,); }'), lines('fn f() { let a = (b); }'), 'code');
add('rust', 'doc comment', lines('/// Totals.', 'pub fn f() {}'), lines('/// Totals the values.', '/// Returns 0 when empty.', 'pub fn f() {}'), 'comments');
add('rust', 'block comment', lines('fn f() { /* a */ g(); }'), lines('fn f() { /* b */ g(); }'), 'comments');
add('rust', 'string content', lines('fn f() { g("a"); }'), lines('fn f() { g("b"); }'), 'code');
add('rust', 'char quotes are not strings', lines("fn f() { g('a'); }"), lines('fn f() { g("a"); }'), 'code');
add('rust', 'renamed identifier', rsBase, rsBase.replace(/\bsum\b/g, 'acc'), 'code');
add('rust', 'operator', rsBase, rsBase.replace('sum += v', 'sum -= v'), 'code');
add('rust', 'macro spacing', lines('fn f() { println!("{}", a); }'), lines('fn f() { println!( "{}" , a ); }'), 'whitespace');
add('rust', 'parse error', lines('fn f() {}'), lines('fn f() {'), 'code');

// ── C# ──────────────────────────────────────────────────────────────────────
const csBase = lines('namespace App {', '    public class Store {', '        public int Total(int[] values) {', '            var sum = 0;', '            foreach (var v in values) sum += v;', '            return sum;', '        }', '    }', '}');
add('csharp', 'reindent', csBase, csBase.replace(/^( +)/gm, '$1$1'), ['whitespace', 'whitespace']);
add('csharp', 'braces on their own line', csBase, csBase.replace('    public class Store {', '    public class Store\n    {'), 'whitespace');
add('csharp', 'doc comment', lines('/// <summary>Old.</summary>', 'class A {}'), lines('/// <summary>New.</summary>', 'class A {}'), 'comments');
add('csharp', 'comment removed', csBase.replace('            var sum = 0;', '            // Start at zero.\n            var sum = 0;'), csBase, 'comments');
add('csharp', 'verbatim string', lines('class A { string s = @"a b"; }'), lines('class A { string s = @"a  b"; }'), 'code');
add('csharp', 'interpolated string', lines('class A { string s = $"a{b}"; }'), lines('class A { string s = $"a{ b }"; }'), 'code');
add('csharp', 'renamed identifier', csBase, csBase.replace(/\bsum\b/g, 'acc'), 'code');
add('csharp', 'reordered statements', lines('class A { void F() { a(); b(); } }'), lines('class A { void F() { b(); a(); } }'), 'code');
add('csharp', 'trailing comma in an enum', lines('enum E { A, B }'), lines('enum E', '{', '    A,', '    B,', '}'), 'formatting');

// ── Go ──────────────────────────────────────────────────────────────────────
const goBase = lines('package store', '', 'func Total(values []int) int {', '\tsum := 0', '\tfor _, v := range values {', '\t\tsum += v', '\t}', '\treturn sum', '}');
add('go', 'alignment', lines('package a', '', 'var (', '\ta = 1', '\tbb = 2', ')'), lines('package a', '', 'var (', '\ta  = 1', '\tbb = 2', ')'), 'whitespace');
add('go', 'wrapped call with trailing comma', lines('package a', '', 'func f() {', '\tg(a, b)', '}'), lines('package a', '', 'func f() {', '\tg(', '\t\ta,', '\t\tb,', '\t)', '}'), 'formatting');
add('go', 'doc comment', goBase, goBase.replace('func Total', '// Total adds the values.\nfunc Total'), 'comments');
add('go', 'build constraint', lines('//go:build linux', '', 'package a'), lines('//go:build darwin', '', 'package a'), 'code');
add('go', 'raw string', lines('package a', '', 'var s = `a b`'), lines('package a', '', 'var s = `a  b`'), 'code');
add('go', 'renamed identifier', goBase, goBase.replace(/\bsum\b/g, 'acc'), 'code');
add('go', 'operator', goBase, goBase.replace('sum += v', 'sum -= v'), 'code');
add('go', 'return then a line break', lines('package a', '', 'func f() int {', '\treturn 1', '}'), lines('package a', '', 'func f() int {', '\treturn', '\t1', '}'), 'code');

// ── Python ──────────────────────────────────────────────────────────────────
const pyBase = lines('def total(values):', '    total = 0', '    for v in values:', '        total += v', '    return total');
add('python', 'consistent reindent', pyBase, pyBase.replace(/^( +)/gm, (spaces) => ' '.repeat(spaces.length / 2)), 'whitespace');
add('python', 'wrap inside brackets', lines('x = f(a, b)'), lines('x = f(', '    a,', '    b,', ')'), 'formatting');
add('python', 'spacing', lines('x = f(a,b)'), lines('x = f(a, b)'), 'whitespace');
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
add('java', 'reindent', javaBase, javaBase.replace(/^( +)/gm, '$1$1'), 'whitespace');
add('java', 'javadoc', javaBase, javaBase.replace('  int total', '  /** Adds the values. */\n  int total'), 'comments');
add('java', 'block comment edited', lines('class A { /* a */ }'), lines('class A { /* b */ }'), 'comments');
add('java', 'text block', lines('class A { String s = """', '  a', '  """; }'), lines('class A { String s = """', '    a', '  """; }'), 'code');
add('java', 'renamed identifier', javaBase, javaBase.replace(/\bsum\b/g, 'acc'), 'code');
add('java', 'operator', javaBase, javaBase.replace('sum += v', 'sum -= v'), 'code');
add('java', 'array initializer trailing comma', lines('class A { int[] a = {1, 2}; }'), lines('class A { int[] a = {', '  1,', '  2,', '}; }'), 'formatting');

// ── JSON ────────────────────────────────────────────────────────────────────
add('json', 'reformat', lines('{"a": 1, "b": [1, 2]}'), lines('{', '  "a": 1,', '  "b": [', '    1,', '    2', '  ]', '}'), 'whitespace');
add('json', 'value', lines('{"a": 1}'), lines('{"a": 2}'), 'code');
add('json', 'string whitespace', lines('{"a": "x y"}'), lines('{"a": "x  y"}'), 'code');
add('json', 'reordered keys', lines('{', '  "a": 1,', '  "b": 2', '}'), lines('{', '  "b": 2,', '  "a": 1', '}'), 'code');
add('json', 'trailing comma is a parse error', lines('{"a": 1}'), lines('{"a": 1,}'), 'code');

// ── YAML ────────────────────────────────────────────────────────────────────
add('yaml', 'spacing after a colon', lines('a: 1', 'b: 2'), lines('a:   1', 'b: 2'), 'whitespace');
add('yaml', 'comment', lines('# Old', 'a: 1'), lines('# New', 'a: 1'), 'comments');
add('yaml', 'quote style', lines("a: 'x'"), lines('a: "x"'), 'formatting');
add('yaml', 'plain to quoted is a type change', lines('a: 1'), lines('a: "1"'), 'code');
add('yaml', 'indentation changes nesting', lines('a:', '  b: 1', '  c: 2'), lines('a:', '  b: 1', 'c: 2'), 'code');
add('yaml', 'indentation changes a list item', lines('a:', '  - b: 1', '    c: 2'), lines('a:', '  - b: 1', '  - c: 2'), 'code');
add('yaml', 'block scalar indentation', lines('a: |', '  x', '  y'), lines('a: |', '    x', '    y'), 'code');
add('yaml', 'value', lines('a: 1'), lines('a: 2'), 'code');

// ── Formatting: equivalent tokens, and the traps beside each equivalence ────
// Semicolons and ASI: a `;` is formatting only where the statements stay the same.
add('typescript', 'semicolon dropped', lines('let a = 1;', 'f(a);'), lines('let a = 1', 'f(a)'), 'formatting');
add('typescript', 'ASI: a line starting with ( joins the previous one', lines('a = b;', '(c || d).e();'), lines('a = b', '(c || d).e();'), 'code');
add('typescript', 'ASI: a line starting with [ joins the previous one', lines('a = b;', '[1, 2].forEach(f);'), lines('a = b', '[1, 2].forEach(f);'), 'code');
add('typescript', 'ASI: a template after an expression is a tagged template', lines('const s = x;', '`t`;'), lines('const s = x', '`t`;'), 'code');
add('typescript', 'ASI: ++ on the next line belongs to it', lines('a;', '++b;'), lines('a', '++b'), 'formatting');
add('typescript', 'ASI: return then a line break returns nothing either way', lines('function f() {', '  return;', '  x;', '}'), lines('function f() {', '  return', '  x', '}'), 'formatting');
add('typescript', 'semicolons in a for header stay', lines('for (a; b; ) c();'), lines('for (a; ; b) c();'), 'code');
// Parentheses: dropped only where they group nothing.
add('typescript', 'parentheses around a returned expression', lines('function f() { return a && b; }'), lines('function f() {', '  return (', '    a && b', '  );', '}'), 'formatting');
add('typescript', 'parentheses around an assigned expression', lines('x = a + b;'), lines('x = (a + b);'), 'formatting');
add('typescript', 'parentheses around an argument', lines('f(a);'), lines('f((a));'), 'formatting');
add('tsx', 'parentheses around JSX in an operand', lines('const a = b && <p>x</p>;'), lines('const a = b && (', '  <p>x</p>', ');'), 'formatting');
add('typescript', 'parentheses that change precedence', lines('x = a * (b + c);'), lines('x = a * b + c;'), 'code');
add('typescript', 'parentheses that end an optional chain', lines('x = (a?.b).c;'), lines('x = a?.b.c;'), 'code');
add('typescript', 'parentheses around a sequence', lines('function f() { return (a, b); }'), lines('function f() { return a, b; }'), 'code');
add('typescript', 'an arrow returning an object needs its parentheses', lines('const f = () => ({});'), lines('const f = () => {};'), 'code');
add('typescript', 'one arrow parameter, with or without parentheses', lines('f((name) => name.length);'), lines('f(name => name.length);'), 'formatting');
add('typescript', 'a typed arrow parameter keeps its parentheses', lines('f((name: string) => name);'), lines('f(name => name);'), 'code');
add('typescript', 'a rest arrow parameter keeps its parentheses', lines('f((...name) => name);'), lines('f(name => name);'), 'code');
add('typescript', 'a union type’s leading bar', lines('type A = B | C;'), lines('type A =', '  | B', '  | C;'), 'formatting');
// Braces around one statement.
add('typescript', 'braces around one statement', lines('if (a) b();', 'else c();'), lines('if (a) {', '  b();', '} else {', '  c();', '}'), 'formatting');
add('typescript', 'braces that move an else', lines('if (a) { if (b) c(); } else d();'), lines('if (a) if (b) c(); else d();'), 'code');
add('java', 'braces around one statement', lines('class A { void f() { if (a) b(); } }'), lines('class A { void f() { if (a) { b(); } } }'), 'formatting');
add('csharp', 'braces around one statement', lines('class A { void F() { foreach (var x in xs) G(x); } }'), lines('class A { void F() { foreach (var x in xs) { G(x); } } }'), 'formatting');
// Numbers.
add('typescript', 'digit separators', lines('const n = 1000000;'), lines('const n = 1_000_000;'), 'formatting');
add('typescript', 'hex case', lines('const n = 0xFF;'), lines('const n = 0xff;'), 'formatting');
add('typescript', 'trailing zeros', lines('const n = 1.50;'), lines('const n = 1.5;'), 'formatting');
add('typescript', 'a legacy octal is not a decimal', lines('const n = 017;'), lines('const n = 17;'), 'code');
add('typescript', 'a BigInt is not a number', lines('const n = 10n;'), lines('const n = 10;'), 'code');
add('rust', 'digit separators with a suffix', lines('fn f() { let n = 1000u32; }'), lines('fn f() { let n = 1_000u32; }'), 'formatting');
add('python', 'digit separators', lines('n = 1000'), lines('n = 1_000'), 'formatting');
add('json', 'JSON numbers stay as written', lines('{"a": 1.50}'), lines('{"a": 1.5}'), 'code');
// Rust bodies.
add('rust', 'a closure body in braces', lines('fn f() { let g = |x| x + 1; }'), lines('fn f() {', '    let g = |x| {', '        x + 1', '    };', '}'), 'formatting');
add('rust', 'a match arm body in braces', lines('fn f() { match x { A => g(), B => h(), } }'), lines('fn f() {', '    match x {', '        A => {', '            g()', '        }', '        B => h(),', '    }', '}'), 'formatting');
add('rust', 'a match arm statement is not its value', lines('fn f() { match x { A => g(), B => h() } }'), lines('fn f() { match x { A => { g(); } B => h() } }'), 'code');
// YAML flow collections.
add('yaml', 'a trailing comma in a flow sequence', lines('a: [1, 2]'), lines('a:', '  [', '    1,', '    2,', '  ]'), 'formatting');
// Import order is never formatting: modules can run code when imported.
add('typescript', 'imports reordered', lines("import a from 'a';", "import b from 'b';"), lines("import b from 'b';", "import a from 'a';"), 'code');
add('python', 'imports reordered', lines('import a', 'import b'), lines('import b', 'import a'), 'code');
add('go', 'imports reordered', lines('package a', '', 'import (', '\t"b"', '\t"a"', ')'), lines('package a', '', 'import (', '\t"a"', '\t"b"', ')'), 'code');
add('python', 'parentheses around a returned value', lines('def f():', '    return a and b'), lines('def f():', '    return (', '        a and b', '    )'), 'formatting');

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
    assert.deepEqual(await kinds('typescript', before, after), ['whitespace', 'code']);
  });
  void test('blocks in one GitHub hunk are classified apart', async () => {
    const before = lines('a();', 'b();', 'c();', 'd();', 'e();');
    const after = lines('a( );', 'b();', 'c();', 'd(1);', 'e();');
    const hunks = hunksOf(before, after);
    assert.equal(hunks.length, 1);
    assert.deepEqual(await kinds('typescript', before, after), ['whitespace', 'code']);
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
    assert.deepEqual(await kinds('python', before, after), ['code', 'whitespace']);
  });
  void test('YAML: a key that leaves its mapping is code, and a respaced value further down is formatting', async () => {
    const filler = Array.from({ length: 12 }, (_, i) => `k${i}: ${i}`);
    const before = lines('server:', '  port: 80', '  host: x', ...filler, 'retries:   3');
    const after = lines('server:', '  port: 80', 'host: x', ...filler, 'retries: 3');
    assert.deepEqual(await kinds('yaml', before, after), ['code', 'whitespace']);
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
    assert.deepEqual(blocks.map((b) => b.kind), ['whitespace']);
  });
  void test('line endings alone are formatting', async () => {
    const hunks = [{ oldStart: 1, newStart: 1, rows: [{ type: '-' as const, text: 'a();\r' }, { type: '+' as const, text: 'a();' }] }];
    const { blocks } = await engine.noise('typescript', 'a();\n', hunks);
    assert.deepEqual(blocks.map((b) => b.kind), ['whitespace']);
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
    assert.deepEqual(blocks.map((b) => b.kind), ['whitespace']);
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
  void test('each kind hides by its own toggle; formatting hides whitespace too; mixed kinds need both toggles', () => {
    const f = (whitespace: boolean, formatting: boolean, comments: boolean) => ({ whitespace, formatting, comments });
    assert.equal(hidden('whitespace', f(true, false, false)), true);
    assert.equal(hidden('whitespace', f(false, true, false)), true, 'Formatting includes whitespace');
    assert.equal(hidden('formatting', f(true, false, false)), false, 'Whitespace does not include formatting');
    assert.equal(hidden('formatting', f(false, true, false)), true);
    assert.equal(hidden('comments', f(true, true, false)), false);
    assert.equal(hidden('comments', f(false, false, true)), true);
    assert.equal(hidden('whitespace-comments', f(true, false, false)), false);
    assert.equal(hidden('whitespace-comments', f(true, false, true)), true);
    assert.equal(hidden('formatting-comments', f(true, false, true)), false);
    assert.equal(hidden('formatting-comments', f(false, true, true)), true);
    assert.equal(hidden('code', f(true, true, true)), false);
    assert.equal(hidden(undefined, f(true, true, true)), false);
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
    const filter = { whitespace: false, formatting: true, comments: false };
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
    assert.equal(noiseLabel(['whitespace']), 'Whitespace only');
    assert.equal(noiseLabel(['formatting']), 'Formatting only');
    assert.equal(noiseLabel(['whitespace', 'formatting']), 'Formatting only', 'Formatting includes whitespace');
    assert.equal(noiseLabel(['comments', 'comments']), 'Comments only');
    assert.equal(noiseLabel(['formatting', 'comments']), 'Formatting and comments');
    assert.equal(noiseLabel(['whitespace-comments']), 'Whitespace and comments');
    assert.equal(noiseLabel(['formatting-comments', 'whitespace']), 'Formatting and comments');
    const all = { whitespace: true, formatting: true, comments: true };
    const blocks = [
      { oldStart: 1, oldCount: 2, newStart: 1, newCount: 3, kind: 'formatting' as const },
      { oldStart: 5, oldCount: 1, newStart: 6, newCount: 1, kind: 'whitespace' as const },
      { oldStart: 9, oldCount: 1, newStart: 10, newCount: 1, kind: 'code' as const },
    ];
    const noise = fileNoise(blocks, all);
    assert.equal(noise.all, false);
    assert.equal(noise.shown, 2);
    assert.equal(noiseStat(noise), '5 formatting · 2 whitespace');
    assert.equal(fileNoise(blocks.slice(0, 2), all).all, true);
    assert.equal(fileNoise(blocks.slice(0, 2), all).reformatted, false, 'Two small hunks are not a formatter run');
    const many = Array.from({ length: 4 }, (_, i) => ({ oldStart: i * 10 + 1, oldCount: 1, newStart: i * 10 + 1, newCount: 1, kind: 'whitespace' as const }));
    assert.equal(fileNoise(many, all).reformatted, true);
    assert.equal(fileNoise([...many, { ...many[0], oldStart: 90, newStart: 90, kind: 'comments' as const }], all).reformatted, false, 'Comments are not a formatter run');
    assert.equal(fileNoise([], all).all, false);
  });
});

void describe('quiet changes settings and words', () => {
  void test('saved preferences from before formatting had its own toggle keep hiding what they hid', () => {
    assert.deepEqual(noiseFilterOf(undefined), { whitespace: true, formatting: true, comments: false }, 'Defaults');
    assert.deepEqual(noiseFilterOf({ hideWhitespace: false }), { whitespace: false, formatting: false, comments: false }, 'Whitespace off meant formatting off');
    assert.deepEqual(noiseFilterOf({ hideWhitespace: true, hideComments: true }), { whitespace: true, formatting: true, comments: true });
    assert.deepEqual(noiseFilterOf({ hideWhitespace: true, hideFormatting: false }), { whitespace: true, formatting: false, comments: false });
  });
  void test('w hides or shows every quiet change, and brings back the reader’s own choice', () => {
    const base = { ...DEFAULT_DIFF_APPEARANCE };
    assert.deepEqual(toggledQuietChanges(base), { hideWhitespace: false, hideFormatting: false, hideComments: false });
    const off = { ...base, hideWhitespace: false, hideFormatting: false, hideComments: false };
    assert.deepEqual(toggledQuietChanges(off), { hideWhitespace: true, hideFormatting: true, hideComments: false }, 'Defaults');
    assert.deepEqual(toggledQuietChanges(off, { hideWhitespace: true, hideFormatting: false, hideComments: true }), { hideWhitespace: true, hideFormatting: false, hideComments: true });
  });
  void test('number spelling reduces to the value only where the language makes it the same', () => {
    assert.equal(numberText('typescript', '1_000'), numberText('typescript', '1000'));
    assert.equal(numberText('typescript', '0xFF'), numberText('typescript', '255'));
    assert.equal(numberText('typescript', '1.50'), numberText('typescript', '1.5'));
    assert.notEqual(numberText('typescript', '017'), numberText('typescript', '17'));
    assert.notEqual(numberText('typescript', '10n'), numberText('typescript', '10'));
    assert.equal(numberText('rust', '1_000U32'), '1000u32');
    assert.notEqual(numberText('rust', '1.50'), numberText('rust', '1.5'), 'Only JavaScript reduces to the value');
  });
  void test('a file header names a whole quiet file, or gives the code’s own counts first', () => {
    const all = { whitespace: true, formatting: true, comments: true };
    const run = Array.from({ length: 4 }, (_, i) => ({ oldStart: i * 10 + 1, oldCount: 1, newStart: i * 10 + 1, newCount: 1, kind: 'formatting' as const }));
    assert.equal(quietHeader(fileNoise(run, all), 4, 4).text, 'Reformatted');
    const one = [{ oldStart: 1, oldCount: 1, newStart: 1, newCount: 1, kind: 'whitespace' as const }];
    assert.equal(quietHeader(fileNoise(one, all), 1, 1).text, 'Whitespace only');
    const mixed = [...one, { oldStart: 9, oldCount: 2, newStart: 9, newCount: 3, kind: 'code' as const }];
    const header = quietHeader(fileNoise(mixed, all), 4, 3);
    assert.deepEqual(header.code, { added: 3, deleted: 2 });
    assert.equal(header.text, '2 whitespace');
  });
});
