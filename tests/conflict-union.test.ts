import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import * as TreeSitter from 'web-tree-sitter';
import { createSyntaxEngine } from '../lib/syntax-scope';
import { withProposals } from '../lib/conflict-carry';
import { keepsLayout, layoutMerge, sameTokens, unionNote, unionOf, withUnions } from '../lib/conflict-union';
import { assertPerf } from './perf-budget';
import type { SyntaxLanguage } from '../lib/syntax-scope';
import {
  blockBuckets,
  NOT_SAME,
  proposalKey,
  SAME_CHANGE,
  SAME_LINES,
  verifyProposals,
  type Analyse,
  type Equivalent,
} from '../lib/conflict-verify';
import type { ConflictFile, ConflictProposal } from '../lib/conflict-resolution';
import { conflictChecker, withoutUnconfirmed } from '../src/conflict-checks';

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
    `Both sides added different definitions here. Proposal: keep both, the PR’s lines first. ${doesnt}`
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

void test('a union of classes, or of class fields, in a language that runs them in order gets the order note (#462)', async () => {
  const cls = (name: string) => `export class ${name} {\n  static made = Date.now();\n}\n\n`;
  const py = (name: string) => `class ${name}:\n    made = time.time()\n\n\n`;
  const unions = await Promise.all([
    check(conflict('src/models.ts', [cls('Alpha'), [cls('Beta'), '', cls('Gamma')], cls('Omega')])),
    check(conflict('src/models.js', [cls('Alpha'), [cls('Beta'), '', cls('Gamma')], cls('Omega')])),
    check(conflict('models.py', [`import time\n\n\n${py('Alpha')}`, [py('Beta'), '', py('Gamma')], py('Omega')])),
    check(
      conflict('src/options.ts', [
        'export class Options {\n  width = 1;\n',
        ['  depth = this.width * 2;\n', '', '  weight = this.width * 3;\n'],
        '}\n',
      ])
    ),
  ]);
  for (const union of unions) {
    assert.deepEqual(union.buckets, ['check']);
    assert.match(union.verdict.note, new RegExp(`^Both sides added different (definitions|fields) here\\..*${order}$`));
  }
  // Java defines its classes before any code runs: their order still doesn't matter.
  const java = await check(
    conflict('src/Shapes.java', [
      'package lab;\n\n',
      ['class Square {}\n', '', 'class Circle {}\n'],
      'class Point {}\n',
    ])
  );
  assert.deepEqual(java.buckets, ['check']);
  assert.match(java.verdict.note, new RegExp(doesnt));
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

// Each side inserted at its own place (before and after mid()), so the line checks can pass on their own.
void test('each failure stays with its conflict: a proposal that keeps every line stays Merged beside one that lost a line', async () => {
  const f = conflict(
    'src/math.ts',
    [
      "import { a } from './a';\n",
      ["import { b } from './b';\n", '', "import { c } from './c';\n"],
      `\n${fn('alpha')}`,
      [fn('beta') + fn('mid'), fn('mid'), fn('mid') + fn('gamma')],
      fn('omega'),
    ],
    [mergiraf("import { b } from './b';\n"), mergiraf(fn('beta') + fn('mid') + fn('gamma'))]
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
    [fn('beta') + fn('mid'), fn('mid'), fn('mid') + fn('gamma')],
    fn('delta'),
    [fn('eps') + fn('mid2'), fn('mid2'), fn('mid2') + fn('zeta')],
  ];
  const f = conflict('src/math.ts', parts, [
    mergiraf(fn('beta') + fn('mid') + fn('gamma')),
    mergiraf(fn('eps') + fn('mid2') + fn('zeta')),
  ]);
  assert.deepEqual((await check(f)).buckets, ['merged', 'merged']);
  // A parse error with no position.
  const blind: Analyse = async (language, text, ranges) => {
    const read = await engine.definitions(language, text, ranges);
    return text === f.result ? { ...read, errors: true, errorLines: undefined } : read;
  };
  const verdict = await verifyProposals(f, blind);
  assert.deepEqual(verdict, { merged: false, note: 'With the proposals in place, the file doesn’t parse.' });
  assert.deepEqual(blockBuckets(f, f.result, verdict), ['check', 'check']);
  // A parse error in one proposal: that one goes to Check, the other stays Merged once the file parses without it.
  const unclosed = mergiraf(`${fn('eps')}${fn('mid2')}export function zeta() {\n  return 1;\n\n`);
  const traced = await check(
    conflict('src/math.ts', parts, [mergiraf(fn('beta') + fn('mid') + fn('gamma')), unclosed])
  );
  assert.deepEqual(traced.buckets, ['merged', 'check']);
  assert.equal(traced.verdict.blocks?.[1]?.note, 'This proposal doesn’t parse.');
  // With a conflict still undecided, a parse error is the whole file's, as before.
  const open = await check(
    conflict(
      'src/math.ts',
      [...parts, fn('omega'), [fn('x'), 'x\n', fn('y')]],
      [mergiraf(fn('beta') + fn('mid') + fn('gamma')), unclosed, null]
    )
  );
  assert.deepEqual(open.buckets, ['check', 'check', 'decide']);
  assert.equal(open.verdict.note, 'With the proposals in place, the file doesn’t parse.');
  // A duplicate whose copies are all in lines no proposal wrote.
  const outside = conflict(
    'src/math.ts',
    [fn('alpha'), fn('alpha'), [fn('beta') + fn('mid'), fn('mid'), fn('mid') + fn('gamma')], fn('omega')],
    [mergiraf(fn('beta') + fn('mid') + fn('gamma'))]
  );
  const once = fn('alpha') + fn('omega');
  const dup = await verifyProposals({ ...outside, base: once, ours: once, theirs: once }, analyse);
  assert.deepEqual(dup, { merged: false, note: 'alpha is defined twice in the result.' });
});

void test('the checks follow the draft: a conflict you decided is checked as your text, and the check runs again', async () => {
  const parts: (string | [string, string, string])[] = [
    fn('alpha'),
    [fn('beta') + fn('mid'), fn('mid'), fn('mid') + fn('gamma')],
    fn('delta'),
    [fn('eps') + fn('mid2'), fn('mid2'), fn('mid2') + fn('zeta')],
  ];
  const f = conflict('src/math.ts', parts, [
    mergiraf(fn('beta') + fn('mid') + fn('gamma')),
    mergiraf(fn('eps') + fn('mid2') + fn('zeta')),
  ]);
  // You keep main's side of the first conflict: the second proposal is checked beside that text, not its proposal.
  const chosen = { ...f, result: f.result.replace(fn('beta') + fn('mid') + fn('gamma'), fn('mid') + fn('gamma')) };
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

/** Both sides made the same change (#445 item 15): the PR's version, Merged only when the syntax trees match. */
/** The review's reproductions (#467): the same tokens, but not the same program. */
const TRAPS: [string, string, [string, string, string], string][] = [
  [
    'lab/value.py',
    'def value():\n',
    ['    x = (1,)\n', '    x = 0\n', '    x = (\n        1\n    )\n'],
    '    return x\n',
  ],
  ['src/count.ts', 'function g() {\n', ['  x = a\n  ++b;\n', '  x = a;\n', '  x = a++\n  b;\n'], '}\n'],
];

void test('the same change in another layout is a candidate; a different token, order or spacing is not', () => {
  assert.equal(
    sameTokens('f(a, { retries: 3 }, "json");\n', "f(\n  a,\n  { retries: 3 },\n  'json',\n);\n", 'typescript'),
    true
  );
  assert.equal(sameTokens('x = ["a", "b"]\n', 'x = [\n    "a",\n    "b",\n]\n', 'python'), true);
  // Traps: one token, a string's content, a number, the order, a space inside a string.
  assert.equal(sameTokens('f(a, true);\n', 'f(\n  a,\n  false\n);\n', 'typescript'), false);
  assert.equal(sameTokens("f('hey');\n", "f('hey!');\n", 'typescript'), false);
  assert.equal(sameTokens('x = [30]\n', 'x = [\n    300,\n]\n', 'python'), false);
  assert.equal(sameTokens('f(a, b);\n', 'f(\n  b,\n  a\n);\n', 'typescript'), false);
  assert.equal(sameTokens('x = ["beta gamma"]\n', 'x = ["beta  gamma"]\n', 'python'), false);
  // Python: a line's indentation outside brackets is meaning, not layout.
  assert.equal(sameTokens('if a:\n    b()\nc()\n', 'if a:\n    b()\n    c()\n', 'python'), false);
  assert.equal(sameTokens('if a:\n    b()\nc()\n', 'if a:\n    b()\n    c()\n', 'typescript'), true);
  // Inside a string or comment, brackets, commas and line breaks are content.
  assert.equal(sameTokens("f('a,)');\n", "f('a)');\n", 'typescript'), false);
  assert.equal(sameTokens('f(`a\n  b`);\n', 'f(`a\nb`);\n', 'typescript'), false);
  assert.equal(sameTokens('f(a); // x, )\n', 'f(a); // x )\n', 'typescript'), false);
  assert.equal(sameTokens('f(a); /* (\n */\n', 'f(a); /* ( */\n', 'typescript'), false);
  assert.equal(sameTokens('x = "a, )"\n', "x = 'a )'\n", 'python'), false);
});

void test('preparation proposes the PR’s version where both sides may have made the same change, with a grammar', () => {
  const original = `a\n${marker("f('x');\n", "f('w');\n", 'f("x");\n')}b\n`;
  assert.deepEqual(withUnions('src/x.ts', original, undefined), [{ source: 'same', text: "f('x');\n" }]);
  // A proposal structural merge made stays; without a grammar nothing can prove the two are the same code.
  const kept = { source: 'mergiraf' as const, text: "f('x');\n" };
  assert.deepEqual(withUnions('src/x.ts', original, [kept]), [kept]);
  assert.equal(withUnions('notes.txt', original, undefined), undefined);
  // Both sides inserted the same lines in different layouts: the same change, not two additions.
  const inserted = `a\n${marker('f(1, 2);\n', '', 'f(\n  1,\n  2,\n);\n')}`;
  assert.deepEqual(withUnions('src/x.ts', inserted, undefined), [{ source: 'same', text: 'f(1, 2);\n' }]);
});

void test('the PR’s version of the same change is Merged only when both sides are the same program', async () => {
  const equivalent: Equivalent = (language, before, after) => engine.equivalent(language, before, after);
  const verify = async (name: string, parts: (string | [string, string, string])[], proposals?: ConflictProposal[]) => {
    const f = conflict(name, parts, proposals);
    const verdict = await verifyProposals(f, analyse, false, equivalent);
    return { verdict, buckets: blockBuckets(f, f.result, verdict), proposals: f.proposals };
  };
  const merged = { merged: true, note: `${SAME_CHANGE} The file parses.` };
  // Quotes, wrapping and a trailing comma, in TypeScript and Python.
  const quotes = await verify('src/greet.ts', [
    'export function hello() {\n',
    ['  return greet("hey", 4);\n', "  return greet('hi', 4);\n", "  return greet('hey', 4);\n"],
    '}\n',
  ]);
  assert.deepEqual(quotes.verdict, merged);
  assert.deepEqual(quotes.buckets, ['merged']);
  const list = await verify('lab/targets.py', [
    'def targets():\n',
    ['    names = [\n        "a",\n        "b",\n    ]\n', '    names = ["a"]\n', '    names = ["a", "b"]\n'],
    '    return names\n',
  ]);
  assert.deepEqual(list.verdict, merged);
  // The review's traps the candidate check lets through: the trees differ, so the checks don't Merge the PR's
  // version, and src/conflict-checks.ts takes it back.
  for (const [name, head, call, tail] of TRAPS) {
    const trap = await verify(name, [head, call, tail]);
    assert.deepEqual(trap.proposals, [{ source: 'same', text: call[0] }], name);
    assert.deepEqual(trap.verdict, { merged: false, note: NOT_SAME }, name);
  }
  // With no tree comparison given at all, nothing confirms it.
  const call = ["  f(\n    'x',\n  );\n", "  f('w');\n", '  f("x");\n'] as [string, string, string];
  const open = conflict('src/x.ts', ['function g() {\n', call, '}\n']);
  assert.deepEqual(open.proposals, [{ source: 'same', text: call[0] }]);
  assert.deepEqual(await verifyProposals(open, analyse), { merged: false, note: NOT_SAME });
  // Structural merge's own proposal of the same change: Merged as the PR's layout, never as main's.
  const pr = await verify('src/x.ts', ['function g() {\n', call, '}\n'], [{ source: 'mergiraf', text: call[0] }]);
  assert.deepEqual(pr.verdict, merged);
  const main = await verify('src/x.ts', ['function g() {\n', call, '}\n'], [{ source: 'mergiraf', text: call[2] }]);
  assert.deepEqual(main.verdict, { merged: false, note: SAME_LINES });
});

void test('a same-change proposal its check didn’t Merge is taken back: Decide, with Git’s markers', async () => {
  const check = conflictChecker(engine);
  /** The file once the service took back what its check didn't Merge. */
  const settle = (f: ConflictFile, verdict: Awaited<ReturnType<typeof check>>) => {
    const back = withoutUnconfirmed(f, verdict);
    return back && { ...f, ...back };
  };
  for (const [name, head, call, tail] of TRAPS) {
    const f = conflict(name, [head, call, tail]);
    const after = settle(f, await check(f));
    assert.ok(after, name);
    assert.equal(after.proposals, undefined, name);
    assert.equal(after.result, f.original, 'The draft holds Git’s markers again');
    assert.equal(after.source, 'manual');
    assert.equal(after.structuralNote, 'Structural merge couldn’t combine this file.');
    assert.deepEqual(blockBuckets(after, after.result, undefined), ['decide'], name);
  }
  // Fail closed: with the language off, or no verdict at all (an error, a timeout), even the same change goes back.
  const quotes = conflict('src/x.ts', ['function g() {\n', ["  f('x');\n", "  f('w');\n", '  f("x");\n'], '}\n']);
  for (const verdict of [await conflictChecker(engine, ['typescript'])(quotes), undefined]) {
    const after = settle(quotes, verdict);
    assert.equal(after?.result, quotes.original);
    assert.deepEqual(blockBuckets(after, after.result, undefined), ['decide']);
  }
  // A confirmed same change stays Merged, and a proposal that isn't 'same' is never taken back.
  const confirmed = await check(quotes);
  assert.equal(settle(quotes, confirmed), undefined);
  assert.deepEqual(blockBuckets(quotes, quotes.result, confirmed), ['merged']);
  const union = conflict('src/math.ts', [fn('alpha'), [fn('beta'), '', fn('gamma')]]);
  assert.equal(settle(union, undefined), undefined);
  // A draft you edited: the trap's conflict gets its markers back, the conflict you decided keeps your text.
  const [, head, call, tail] = TRAPS[1];
  const two = conflict('src/count.ts', [head, call, tail, ['const c = 1;\n', 'const c = 0;\n', 'const c = 2;\n']]);
  assert.deepEqual(
    two.proposals?.map((p) => p?.source ?? null),
    ['same', null]
  );
  const decided = {
    ...two,
    result: two.result.replace(/<<<<<<< feature\nconst c[^]*>>>>>>> main\n/, 'const c = 2;\n'),
  };
  const edited = settle(decided, await check(decided));
  assert.equal(edited?.result, two.original.replace(/<<<<<<< feature\nconst c[^]*>>>>>>> main\n/, 'const c = 2;\n'));
  assert.deepEqual(blockBuckets(edited, edited.result, undefined), ['decide', 'decided']);
  // You changed the trap's conflict yourself: its proposal goes, your text stays.
  const mine = { ...two, result: two.result.replace(call[0], '  x = a + b;\n') };
  assert.equal(settle(mine, await check(mine))?.result, mine.result);
  // A file you marked reviewed is no longer resolved once its markers come back.
  const [name, h, c, t] = TRAPS[0];
  const reviewed = { ...conflict(name, [h, c, t]), resolved: true };
  const back = settle(reviewed, await check(reviewed));
  assert.equal(back?.result, reviewed.original);
  assert.equal(back.resolved, false);
});

void test('one side only reformatted, the other edited: the edit in the reformatted layout, Merged on the trees’ word', async () => {
  const check = conflictChecker(engine);
  const one = '  return combine(value, total, 4);\n';
  const wrapped = '  return combine(\n    value,\n    total,\n    4,\n  );\n';
  const edited = '  return combine(value, total, 5);\n';
  const want = '  return combine(\n    value,\n    total,\n    5,\n  );\n';
  const merge = (base: string, ours: string, theirs: string, language: SyntaxLanguage = 'typescript') =>
    layoutMerge({ base, ours, theirs }, language);
  // Either side may be the one that reformatted; the result is always the edit in its layout, and says whose it is.
  assert.deepEqual(merge(one, wrapped, edited), { text: want, formatted: 'ours' });
  assert.deepEqual(merge(one, edited, wrapped), { text: want, formatted: 'theirs' });
  for (const [ours, theirs] of [
    [wrapped, edited],
    [edited, wrapped],
  ]) {
    const f = conflict('src/x.ts', ['function f(value: number, total: number) {\n', [ours, one, theirs], '}\n']);
    assert.deepEqual(f.proposals, [{ source: 'layout', text: want }]);
    const verdict = await check(f);
    assert.match(verdict?.note ?? '', /only reformatted these lines/);
    assert.deepEqual(blockBuckets(f, f.result, verdict), ['merged']);
  }
  // Spacing, quote marks and an edit that inserts tokens: the new tokens keep the editing side's own spacing.
  assert.equal(merge('f("a", b)\n', "f( 'a', b )\n", 'f("a", b, c)\n')?.text, "f( 'a', b, c )\n");
  // After a deletion, the next token keeps the editing side's spacing: words are never joined.
  assert.equal(merge('return (a) + b;\n', 'return ( a ) +\n  b;\n', 'return a + b;\n')?.text, 'return a +\n  b;\n');
  assert.equal(merge('f(typeof (x));\n', 'f( typeof (x) );\n', 'f(typeof x);\n')?.text, 'f( typeof x);\n');
  // Not this rule: both sides changed code, both only reformatted, or the edit is where the reformat added a comma.
  assert.equal(merge(one, edited, one.replace('4', '6')), undefined);
  assert.equal(merge(one, wrapped, one.replace('(', '( ')), undefined);
  assert.equal(merge('f(a)\n', 'f(\n  a,\n)\n', 'f(a, b)\n'), undefined);
  // Inside a string or comment every character counts: a changed space there is code, not layout.
  assert.equal(merge('f("a b", 1)\n', 'f("a  b", 1)\n', 'f("a b", 2)\n'), undefined);
  // In Python, a line's indentation outside brackets is code.
  assert.equal(
    merge('if a:\n    b()\nc()\n', 'if a:\n    b()\n    c()\n', 'if a:\n    b(1)\nc()\n', 'python'),
    undefined
  );
  // ' and " are the same string only where the language says so: in Go and Rust they are different tokens.
  assert.ok(merge('f("a", 1)\n', "f('a', 1)\n", 'f("a", 2)\n', 'python'));
  assert.equal(merge('f("a", 1)\n', "f('a', 1)\n", 'f("a", 2)\n', 'go'), undefined);
  assert.equal(merge('f("a", 1)\n', "f('a', 1)\n", 'f("a", 2)\n', 'rust'), undefined);
  // A Rust lifetime is not a string: what follows it is still code, so its spacing is layout.
  assert.deepEqual(
    merge(
      "fn f<'a>(x: &'a T, n: u8) {}\n",
      "fn f<'a>(\n    x: &'a T,\n    n: u8,\n) {}\n",
      "fn f<'a>(x: &'a T, n: u16) {}\n",
      'rust'
    ),
    {
      text: "fn f<'a>(\n    x: &'a T,\n    n: u16,\n) {}\n",
      formatted: 'ours',
    }
  );
  // JavaScript's # is a private name, not a comment; Python's // is floor division, not a comment.
  assert.equal(merge('f(this.#a, 1);\n', 'f( this.#a, 1 );\n', 'f(this.#a, 2);\n')?.text, 'f( this.#a, 2 );\n');
  assert.equal(
    merge('f(a // b, 1)\n', 'f(\n    a // b,\n    1,\n)\n', 'f(a // b, 2)\n', 'python')?.text,
    'f(\n    a // b,\n    2,\n)\n'
  );
  // A proposal the trees don't confirm is taken back: the conflict is yours to decide.
  const trap = conflict('src/x.ts', ['function f(value: number, total: number) {\n', [wrapped, one, edited], '}\n']);
  const wrong = { ...trap, proposals: [{ source: 'layout' as const, text: want.replace('5', '6') }] };
  wrong.result = withProposals(wrong.original, wrong.proposals);
  const back = withoutUnconfirmed(wrong, await check(wrong));
  assert.ok(back);
  assert.equal(back.result, wrong.original);
  assert.equal(back.proposals, undefined);
});

void test('the layout rule takes structural merge’s place only when that one lost the layout, and gives it back', async () => {
  const block: [string, string, string] = ['  g(\n    1,\n  );\n', '  g(1);\n', '  g(2);\n'];
  const file = (proposal: ConflictProposal) => conflict('src/x.ts', ['function f() {\n', block, '}\n'], [proposal]);
  const lost = file({ source: 'mergiraf', text: '  g(2);\n' });
  assert.deepEqual(lost.proposals, [{ source: 'layout', text: '  g(\n    2,\n  );\n', instead: '  g(2);\n' }]);
  // Structural merge's proposal that keeps the layout, and a remembered resolution, stay as they are.
  const kept = file({ source: 'mergiraf', text: '  g(\n    2,\n  );\n' });
  assert.deepEqual(kept.proposals, [{ source: 'mergiraf', text: '  g(\n    2,\n  );\n' }]);
  assert.deepEqual(file({ source: 'rerere', text: '  g(3);\n' }).proposals, [{ source: 'rerere', text: '  g(3);\n' }]);
  // When the checks don't Merge the rule's proposal, structural merge's is offered again (Check), the file keeps its
  // source and gets no "couldn't combine" note.
  const back = withoutUnconfirmed(lost, undefined);
  assert.ok(back);
  assert.deepEqual(back.proposals, [{ source: 'mergiraf', text: '  g(2);\n' }]);
  assert.equal(back.result, lost.original);
  assert.equal(back.source, 'mergiraf');
  assert.equal(back.structuralNote, undefined);
  const again = { ...lost, ...back };
  assert.deepEqual(blockBuckets(again, again.result, await conflictChecker(engine)(again)), ['check']);
});

void test('the layout rule stays fast on a 2000-line block, and gives up past its limits', () => {
  const lines = Array.from({ length: 2000 }, (_, i) => `  total = combine(total, value${i}, ${i});\n`);
  const base = lines.join('');
  const wrapped = lines.map((l) => l.replace('combine(', 'combine( ').replace(');', ' );')).join('');
  const edited = base.replace('value1000, 1000', 'value1000, 1001');
  const many = lines.map((l, i) => (i % 2 ? l.replace(/(\d+)\);/, '$1 + 1);') : l)).join('');
  const started = performance.now();
  const near = layoutMerge({ base, ours: wrapped, theirs: edited }, 'typescript');
  const far = layoutMerge({ base, ours: wrapped, theirs: many }, 'typescript');
  const sides = { base, edited, formatted: wrapped };
  assert.ok(near && keepsLayout(sides, near.text));
  assert.equal(far, undefined, 'Too many edits to compare: no proposal');
  assert.equal(keepsLayout({ base, edited: many, formatted: wrapped }, many), false);
  assertPerf('layout rule, 2000-line block', performance.now() - started, 1000);
});
