import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import * as TreeSitter from 'web-tree-sitter';
import { createSyntaxEngine } from '../lib/syntax-scope';
import { withProposals } from '../lib/conflict-carry';
import { readUnion, unionOf, withUnions } from '../lib/conflict-union';
import { blockBuckets, verifyProposals, type Analyse } from '../lib/conflict-verify';
import type { ConflictFile, ConflictProposal } from '../lib/conflict-resolution';

/** Both sides added different definitions at the same place (#445 item 16), and per-conflict check results (item 18). */
const assets = path.resolve(__dirname, '../src/assets/tree-sitter');
const engine = createSyntaxEngine(TreeSitter, {
  runtime: async () => new Uint8Array(await fs.readFile(require.resolve('web-tree-sitter/web-tree-sitter.wasm'))),
  grammar: async (language) => new Uint8Array(await fs.readFile(path.join(assets, `${language}.wasm`))),
  tags: (name) => fs.readFile(path.join(assets, `${name}-tags.scm`), 'utf8'),
});
const analyse: Analyse = (language, text, ranges) => engine.definitions(language, text, ranges);

const marker = (ours: string, base: string, theirs: string) =>
  `<<<<<<< feature\n${ours}||||||| ancestor\n${base}=======\n${theirs}>>>>>>> main\n`;
/**
 * A file whose texts are `parts` joined, where each conflict part is [ours, base, theirs]. Its proposals are what
 * preparation gives when structural merge left every conflict open, or `proposals` where given.
 */
function conflict(
  name: string,
  parts: (string | [string, string, string])[],
  proposals?: (ConflictProposal | null)[]
): ConflictFile {
  const side = (i: number) => parts.map((p) => (typeof p === 'string' ? p : p[i])).join('');
  const original = parts.map((p) => (typeof p === 'string' ? p : marker(...p))).join('');
  const filled = withUnions(name, original, proposals) ?? [];
  return {
    path: name,
    mode: '100644',
    base: side(1),
    ours: side(0),
    theirs: side(2),
    original,
    result: withProposals(original, filled),
    resolved: false,
    source: 'mergiraf',
    proposals: filled,
  };
}
const check = async (f: ConflictFile) => {
  const verdict = await verifyProposals(f, analyse);
  return { verdict, buckets: blockBuckets(f, f.result, verdict) };
};

void test('a union is both sides’ inserted lines, the PR’s first, only where neither side changed an ancestor line', () => {
  assert.deepEqual(unionOf({ base: '', ours: 'a\n', theirs: 'b\n' }), {
    text: 'a\nb\n',
    before: 0,
    ours: 1,
    theirs: 1,
  });
  // Git's block can hold ancestor lines both sides kept around the insertions.
  assert.deepEqual(unionOf({ base: 'x\ny\n', ours: 'x\na\ny\n', theirs: 'x\nb\nc\ny\n' }), {
    text: 'x\na\nb\nc\ny\n',
    before: 1,
    ours: 1,
    theirs: 2,
  });
  // A changed ancestor line (a trailing comma added), insertions at different places, a missing line ending, or the
  // same insertion: no union.
  assert.equal(unionOf({ base: '  "b"\n', ours: '  "b",\n  "c"\n', theirs: '  "b",\n  "d"\n' }), undefined);
  assert.equal(unionOf({ base: 'x\ny\n', ours: 'a\nx\ny\n', theirs: 'x\ny\nb\n' }), undefined);
  assert.equal(unionOf({ base: '', ours: 'a', theirs: 'b\n' }), undefined);
  assert.equal(unionOf({ base: '', ours: '\n', theirs: 'b\n' }), undefined);
  assert.equal(unionOf({ base: undefined, ours: 'a\n', theirs: 'b\n' }), undefined);
});

void test('preparation adds unions only where structural merge left a conflict open, in files with a grammar', () => {
  const original = `a\n${marker('b\n', '', 'c\n')}d\n${marker('e\n', '', 'f\n')}`;
  const kept = { source: 'mergiraf' as const, text: 'mine\n' };
  assert.deepEqual(withUnions('src/x.ts', original, [kept, null]), [kept, { source: 'union', text: 'e\nf\n' }]);
  assert.deepEqual(withUnions('src/x.ts', original, undefined), [
    { source: 'union', text: 'b\nc\n' },
    { source: 'union', text: 'e\nf\n' },
  ]);
  // Without a grammar nothing can tell definitions from lines whose order matters.
  assert.equal(withUnions('notes.txt', original, undefined), undefined);
  assert.deepEqual(withUnions('CHANGELOG.md', original, [kept, null]), [kept, null]);
});

const fn = (name: string, body = '1') => `export function ${name}() {\n  return ${body};\n}\n\n`;

void test('two new functions in TypeScript are Merged; imports, which run module code in order, stay in Check', async () => {
  const functions = await check(conflict('src/math.ts', [fn('alpha'), [fn('beta'), '', fn('gamma')], fn('omega')]));
  assert.deepEqual(functions.buckets, ['merged']);
  assert.equal(
    functions.verdict.note,
    'Both sides added different definitions here. Gnosis kept both, the PR’s lines first. Their order doesn’t matter. The file parses.'
  );
  const imports = await check(
    conflict('src/math.ts', [
      "import { a } from './a';\n",
      ["import { b } from './b';\n", '', "import { c } from './c';\n"],
      `\n${fn('alpha')}`,
    ])
  );
  assert.deepEqual(imports.buckets, ['check']);
  assert.match(
    imports.verdict.note,
    /^Both sides added different imports here\..*Check the order: it can matter here\.$/
  );
});

void test('Go, Rust, Java and C# imports, and Go and Rust struct fields, are Merged in any order', async () => {
  const go = await check(
    conflict('main.go', [
      'package main\n\nimport (\n\t"fmt"\n',
      ['\t"os"\n', '', '\t"strings"\n'],
      ')\n\nfunc main() { fmt.Println(os.Args, strings.ToUpper("x")) }\n',
    ])
  );
  assert.deepEqual(go.buckets, ['merged'], go.verdict.note);
  const rust = await check(
    conflict('src/lib.rs', [
      'pub struct Options {\n    pub width: u32,\n',
      ['    pub depth: u32,\n', '', '    pub weight: u32,\n'],
      '}\n',
    ])
  );
  assert.deepEqual(rust.buckets, ['merged'], rust.verdict.note);
  const java = await check(
    conflict('src/Main.java', [
      'package lab;\n\nimport java.util.List;\n',
      ['import java.util.Map;\n', '', 'import java.util.Set;\n'],
      '\nclass Main {}\n',
    ])
  );
  assert.deepEqual(java.buckets, ['merged'], java.verdict.note);
});

void test('traps: a catch-all arm, a name both sides added, a same-signature overload and an ordered list stay in Check', async () => {
  const arms = await check(
    conflict('src/status.rs', [
      'pub fn status(s: &str) -> u16 {\n    match s {\n        "ok" => 200,\n',
      ['        "denied" => 403,\n', '', '        _ => 500,\n'],
      '    }\n}\n',
    ])
  );
  assert.deepEqual(arms.buckets, ['check']);
  assert.match(arms.verdict.note, /different cases here.*Check the order/);
  const twice = await check(
    conflict('src/math.ts', [fn('alpha'), [fn('clamp', '0'), '', fn('clamp', '1')], fn('omega')])
  );
  assert.deepEqual(twice.buckets, ['check']);
  assert.equal(twice.verdict.note, 'Both sides added clamp here. Keep one, or check that both belong.');
  const cls = (members: [string, string, string]) =>
    conflict('src/Log.java', ['package lab;\n\npublic class Log {\n    void write(String m) {}\n\n', members, '}\n']);
  // Overloads differ by parameter types: names alone don't make them different.
  const same = await check(cls(['    void write(int code) {}\n', '', '    void write(int value) {}\n']));
  assert.deepEqual(same.buckets, ['check']);
  assert.equal(same.verdict.note, 'Both sides added write(int) here. Keep one, or check that both belong.');
  const differ = await check(cls(['    void write(long n) {}\n', '', '    void write(double d) {}\n']));
  assert.deepEqual(differ.buckets, ['merged'], differ.verdict.note);
  const list = await check(
    conflict('app/settings.py', ['MIDDLEWARE = [\n    "security",\n', ['    "auth",\n', '', '    "csrf",\n'], ']\n'])
  );
  assert.deepEqual(list.buckets, ['check']);
  assert.match(list.verdict.note, /different items here.*Check the order/);
  const keys = await check(
    conflict('ci.yml', [
      'jobs:\n  build:\n    runs-on: ubuntu-latest\n',
      ['    timeout-minutes: 10\n', '', '    timeout-minutes: 30\n'],
      '    steps:\n      - run: make\n',
    ])
  );
  assert.deepEqual(keys.buckets, ['check']);
  assert.equal(keys.verdict.note, 'Both sides added timeout-minutes here. Keep one, or check that both belong.');
  // Statements in a function body are no definitions: order and meaning are for you.
  const statements = await check(
    conflict('src/run.ts', ['export function run() {\n  start();\n', ['  log();\n', '', '  audit();\n'], '}\n'])
  );
  assert.deepEqual(statements.buckets, ['check']);
  assert.match(statements.verdict.note, /^Both sides added lines here\./);
  // A definition the other side added elsewhere in the file, outside the conflict.
  const units = (name: string) => ({ parent: 'program', units: [{ type: 'function_declaration', name }] });
  assert.deepEqual(readUnion('typescript', units('beta'), units('gamma'), new Map([['beta', 2]])), {
    merge: false,
    note: 'beta is defined twice in the result. Check which to keep.',
  });
  assert.equal(readUnion('typescript', units('beta'), units('gamma'), new Map([['beta', 1]])).merge, true);
  // Units the parser couldn't read whole stay in Check.
  assert.equal(readUnion('typescript', undefined, units('gamma')).merge, false);
});

void test('each failure stays with its conflict: a union is Merged beside a structural merge that lost a line', async () => {
  const f = conflict(
    'src/math.ts',
    [
      "import { a } from './a';\n",
      ["import { b } from './b';\n", '', "import { c } from './c';\n"],
      `\n${fn('alpha')}`,
      [fn('beta'), '', fn('gamma')],
      fn('omega'),
    ],
    [{ source: 'mergiraf', text: "import { b } from './b';\n" }, null]
  );
  const { verdict, buckets } = await check(f);
  assert.deepEqual(buckets, ['check', 'merged']);
  const [imports, functions] = verdict.blocks ?? [];
  assert.equal(imports?.note, "import { c } from './c'; from main is missing from the result.");
  assert.match(String(functions?.note), /^Both sides added different definitions here\./);
});

void test('a failure the checks can’t trace to a conflict keeps every proposal in the file in Check', async () => {
  const f = conflict('src/math.ts', [
    fn('alpha'),
    [fn('beta'), '', fn('gamma')],
    fn('delta'),
    [fn('eps'), '', fn('zeta')],
  ]);
  assert.deepEqual((await check(f)).buckets, ['merged', 'merged']);
  // A parse error with no position.
  const blind: Analyse = async (language, text, ranges) => {
    const read = await engine.definitions(language, text, ranges);
    return text === f.result ? { ...read, errors: true, errorLines: undefined } : read;
  };
  const verdict = await verifyProposals(f, blind);
  assert.deepEqual(verdict, { merged: false, note: 'The result doesn’t parse.' });
  assert.deepEqual(blockBuckets(f, f.result, verdict), ['check', 'check']);
  // A parse error in one union: that one goes to Check, the other stays Merged once the file parses without it.
  const broken = conflict('src/math.ts', [
    fn('alpha'),
    [fn('beta'), '', fn('gamma')],
    fn('delta'),
    [fn('eps'), '', fn('zeta')],
  ]);
  broken.proposals = [
    broken.proposals?.[0] ?? null,
    { source: 'mergiraf', text: `${fn('eps')}export function zeta() {\n  return 1;\n\n` },
  ];
  broken.result = withProposals(broken.original, broken.proposals);
  const traced = await check(broken);
  assert.deepEqual(traced.buckets, ['merged', 'check']);
  assert.equal(traced.verdict.blocks?.[1]?.note, 'This result doesn’t parse.');
  // A duplicate whose copies are all in lines no proposal wrote.
  const outside = conflict('src/math.ts', [fn('alpha'), fn('alpha'), [fn('beta'), '', fn('gamma')], fn('omega')]);
  const once = fn('alpha') + fn('omega');
  const dup = await verifyProposals({ ...outside, base: once, ours: once, theirs: once }, analyse);
  assert.deepEqual(dup, { merged: false, note: 'alpha is defined twice in the result.' });
});
