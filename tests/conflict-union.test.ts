import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import * as TreeSitter from 'web-tree-sitter';
import { createSyntaxEngine } from '../lib/syntax-scope';
import { withProposals } from '../lib/conflict-carry';
import { unionNote, unionOf, withUnions } from '../lib/conflict-union';
import { blockBuckets, proposalKey, verifyProposals, type Analyse } from '../lib/conflict-verify';
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

const doesnt = 'Their order shouldn’t matter; check that both belong.';
const order = 'Check the order: it can matter here.';

void test('a union is never Merged: it is a ready proposal in Check, with a note on what each side added', async () => {
  const functions = await check(conflict('src/math.ts', [fn('alpha'), [fn('beta'), '', fn('gamma')], fn('omega')]));
  assert.deepEqual(functions.buckets, ['check']);
  assert.equal(
    functions.verdict.note,
    `Both sides added different definitions here. Gnosis kept both, the PR’s lines first. ${doesnt}`
  );
  // Imports in TypeScript run module code in order.
  const imports = await check(
    conflict('src/math.ts', [
      "import { a } from './a';\n",
      ["import { b } from './b';\n", '', "import { c } from './c';\n"],
      `\n${fn('alpha')}`,
    ])
  );
  assert.deepEqual(imports.buckets, ['check']);
  assert.match(imports.verdict.note, new RegExp(`^Both sides added different imports here\\..*${order}$`));
  const go = await check(
    conflict('main.go', [
      'package main\n\nimport (\n\t"fmt"\n',
      ['\t"os"\n', '', '\t"strings"\n'],
      ')\n\nfunc main() { fmt.Println(os.Args, strings.ToUpper("x")) }\n',
    ])
  );
  assert.deepEqual(go.buckets, ['check']);
  assert.match(go.verdict.note, new RegExp(`imports here.*${doesnt}`));
  const rust = await check(
    conflict('src/lib.rs', [
      'pub struct Options {\n    pub width: u32,\n',
      ['    pub depth: u32,\n', '', '    pub weight: u32,\n'],
      '}\n',
    ])
  );
  assert.deepEqual(rust.buckets, ['check']);
  assert.match(rust.verdict.note, /different fields here/);
});

void test('traps stay in Check: a catch-all arm, names both sides added, attributes, ordered lists, duplicate keys', async () => {
  const traps = [
    conflict('src/status.rs', [
      'pub fn status(s: &str) -> u16 {\n    match s {\n        "ok" => 200,\n',
      ['        "denied" => 403,\n', '', '        _ => 500,\n'],
      '    }\n}\n',
    ]),
    conflict('src/math.ts', [fn('alpha'), [fn('clamp', '0'), '', fn('clamp', '1')], fn('omega')]),
    conflict('src/Log.java', [
      'package lab;\n\npublic class Log {\n    void write(String m) {}\n\n',
      ['    void write(int code) {}\n', '', '    void write(int value) {}\n'],
      '}\n',
    ]),
    // An attribute on the PR's item would land on main's in the other order.
    conflict('src/lib.rs', ['mod a;\n', ['#[cfg(test)]\nmod tests;\n', '', 'mod b;\n'], 'mod c;\n']),
    conflict('src/lib.rs', ['use std::fmt;\n', ['use std::io;\n', '', 'use std::io;\n'], '\nfn main() {}\n']),
    conflict('src/a.ts', [
      'const x = 1;\n',
      ['export default function a() {}\n', '', 'export default function b() {}\n'],
      '',
    ]),
    conflict('app/settings.py', ['MIDDLEWARE = [\n    "security",\n', ['    "auth",\n', '', '    "csrf",\n'], ']\n']),
    conflict('ci.yml', [
      'jobs:\n  build:\n    runs-on: ubuntu-latest\n',
      ['    timeout-minutes: 10\n', '', '    timeout-minutes: 30\n'],
      '    steps:\n      - run: make\n',
    ]),
    conflict('src/run.ts', ['export function run() {\n  start();\n', ['  log();\n', '', '  audit();\n'], '}\n']),
  ];
  for (const f of traps) assert.deepEqual((await check(f)).buckets, ['check'], f.path);
  const [arms, twice, overload, , , , list, keys, statements] = await Promise.all(traps.map((f) => check(f)));
  assert.match(arms.verdict.note, new RegExp(`different cases here.*${order}`));
  assert.equal(twice.verdict.note, 'Both sides added clamp here. Keep one, or check that both belong.');
  // Overloads differ by parameter types: names alone don't make them different.
  assert.equal(overload.verdict.note, 'Both sides added write(int) here. Keep one, or check that both belong.');
  assert.match(list.verdict.note, new RegExp(`different items here.*${order}`));
  assert.equal(keys.verdict.note, 'Both sides added timeout-minutes here. Keep one, or check that both belong.');
  // Statements in a function body are no definitions: order and meaning are for you.
  assert.match(statements.verdict.note, /^Both sides added lines here\./);
  // Units the parser couldn't read whole get the plainest note.
  assert.match(unionNote('typescript', undefined, undefined), /^Both sides added lines here\./);
});

const mergiraf = (text: string): ConflictProposal => ({ source: 'mergiraf', text });

void test('each failure stays with its conflict: a proposal that keeps every line stays Merged beside one that lost a line', async () => {
  const f = conflict(
    'src/math.ts',
    [
      "import { a } from './a';\n",
      ["import { b } from './b';\n", '', "import { c } from './c';\n"],
      `\n${fn('alpha')}`,
      [fn('beta'), '', fn('gamma')],
      fn('omega'),
    ],
    [mergiraf("import { b } from './b';\n"), mergiraf(fn('beta') + fn('gamma'))]
  );
  const { verdict, buckets } = await check(f);
  assert.deepEqual(buckets, ['check', 'merged']);
  const [imports, functions] = verdict.blocks ?? [];
  assert.equal(imports?.note, "import { c } from './c'; from main is missing from the result.");
  assert.equal(functions?.note, 'The file parses. Every line of both sides is accounted for.');
});

void test('a failure the checks can’t trace to a conflict keeps every proposal in the file in Check', async () => {
  const parts: (string | [string, string, string])[] = [
    fn('alpha'),
    [fn('beta'), '', fn('gamma')],
    fn('delta'),
    [fn('eps'), '', fn('zeta')],
  ];
  const f = conflict('src/math.ts', parts, [mergiraf(fn('beta') + fn('gamma')), mergiraf(fn('eps') + fn('zeta'))]);
  assert.deepEqual((await check(f)).buckets, ['merged', 'merged']);
  // A parse error with no position.
  const blind: Analyse = async (language, text, ranges) => {
    const read = await engine.definitions(language, text, ranges);
    return text === f.result ? { ...read, errors: true, errorLines: undefined } : read;
  };
  const verdict = await verifyProposals(f, blind);
  assert.deepEqual(verdict, { merged: false, note: 'The result doesn’t parse.' });
  assert.deepEqual(blockBuckets(f, f.result, verdict), ['check', 'check']);
  // A parse error in one proposal: that one goes to Check, the other stays Merged once the file parses without it.
  const unclosed = mergiraf(`${fn('eps')}export function zeta() {\n  return 1;\n\n`);
  const traced = await check(conflict('src/math.ts', parts, [mergiraf(fn('beta') + fn('gamma')), unclosed]));
  assert.deepEqual(traced.buckets, ['merged', 'check']);
  assert.equal(traced.verdict.blocks?.[1]?.note, 'This result doesn’t parse.');
  // With a conflict still undecided, a parse error is the whole file's, as before.
  const open = await check(
    conflict(
      'src/math.ts',
      [...parts, fn('omega'), [fn('x'), 'x\n', fn('y')]],
      [mergiraf(fn('beta') + fn('gamma')), unclosed, null]
    )
  );
  assert.deepEqual(open.buckets, ['check', 'check', 'decide']);
  assert.equal(open.verdict.note, 'The result doesn’t parse.');
  // A duplicate whose copies are all in lines no proposal wrote.
  const outside = conflict(
    'src/math.ts',
    [fn('alpha'), fn('alpha'), [fn('beta'), '', fn('gamma')], fn('omega')],
    [mergiraf(fn('beta') + fn('gamma'))]
  );
  const once = fn('alpha') + fn('omega');
  const dup = await verifyProposals({ ...outside, base: once, ours: once, theirs: once }, analyse);
  assert.deepEqual(dup, { merged: false, note: 'alpha is defined twice in the result.' });
});

void test('the checks follow the draft: a conflict you decided is checked as your text, and the check runs again', async () => {
  const parts: (string | [string, string, string])[] = [
    fn('alpha'),
    [fn('beta'), '', fn('gamma')],
    fn('delta'),
    [fn('eps'), '', fn('zeta')],
  ];
  const f = conflict('src/math.ts', parts, [mergiraf(fn('beta') + fn('gamma')), mergiraf(fn('eps') + fn('zeta'))]);
  // You keep main's side of the first conflict: the second proposal is checked beside that text, not its proposal.
  const chosen = { ...f, result: f.result.replace(fn('beta') + fn('gamma'), fn('gamma')) };
  assert.notEqual(proposalKey(chosen), proposalKey(f), 'A new draft is checked again');
  const read: string[] = [];
  const spy: Analyse = (language, text, ranges) => {
    read.push(text);
    return analyse(language, text, ranges);
  };
  const verdict = await verifyProposals(chosen, spy);
  assert.ok(read.includes(chosen.result), 'The checks parse the draft as you left it');
  assert.ok(!read.includes(f.result));
  assert.deepEqual(blockBuckets(chosen, chosen.result, verdict), ['decided', 'merged']);
});

void test('a proposal your saved draft decided stays in Check if you pick it again before saving', async () => {
  const f = conflict('src/math.ts', [fn('alpha'), [fn('beta'), '', fn('gamma')]], [mergiraf(fn('beta') + fn('gamma'))]);
  const saved = { ...f, result: f.result.replace(fn('beta') + fn('gamma'), fn('gamma')) };
  const verdict = await verifyProposals(saved, analyse);
  assert.equal(verdict.merged, false, 'No proposal was checked, so the file is not Merged');
  // Undo puts the proposal back on screen; the verdict still belongs to the saved draft.
  assert.deepEqual(blockBuckets(saved, withProposals(f.original, f.proposals ?? []), verdict), ['check']);
});
