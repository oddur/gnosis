import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import * as TreeSitter from 'web-tree-sitter';
import { createSyntaxEngine } from '../lib/syntax-scope';
import { blockProposals, blockResolutions, carryFile, withProposals } from '../lib/conflict-carry';
import { inferChoices, parseConflicts } from '../lib/conflict-blocks';
import { assertPerf, perfBudget } from './perf-budget';
import {
  accountLines,
  accountWholeFile,
  blockBuckets,
  bucketSummary,
  proposalKey,
  summarySentence,
  verifyProposals,
  verifyWholeFile,
  type Analyse,
} from '../lib/conflict-verify';
import type { ConflictFile, ConflictProposal } from '../lib/conflict-resolution';

/** Conflict buckets and their checks (phase 1 of the conflict redesign), with the real tree-sitter grammars. */
const assets = path.resolve(__dirname, '../src/assets/tree-sitter');
const engine = createSyntaxEngine(TreeSitter, {
  runtime: async () => new Uint8Array(await fs.readFile(require.resolve('web-tree-sitter/web-tree-sitter.wasm'))),
  grammar: async (language) => new Uint8Array(await fs.readFile(path.join(assets, `${language}.wasm`))),
  tags: (name) => fs.readFile(path.join(assets, `${name}-tags.scm`), 'utf8'),
});
const analyse: Analyse = (language, text) => engine.definitions(language, text);

const base =
  "import { a } from './a';\n\nexport function one() {\n  return 1;\n}\n\nexport function two() {\n  return 2;\n}\n";
const three = 'export function three() {\n  return 3;\n}\n\n';
const four = 'export function four() {\n  return 4;\n}\n\n';
const ours = base
  .replace("from './a';\n", "from './a';\nimport { b } from './b';\n")
  .replace('export function two', `${three}export function two`);
const theirs = base
  .replace("from './a';\n", "from './a';\nimport { c } from './c';\n")
  .replace('export function two', `${four}export function two`);
// What `git merge-tree` writes for these sides, in diff3 style.
const original =
  "import { a } from './a';\n<<<<<<< feature\nimport { b } from './b';\n||||||| ancestor\n=======\nimport { c } from './c';\n>>>>>>> main\n" +
  `\nexport function one() {\n  return 1;\n}\n\n<<<<<<< feature\n${three}||||||| ancestor\n=======\n${four}>>>>>>> main\nexport function two() {\n  return 2;\n}\n`;
const imports = "import { b } from './b';\nimport { c } from './c';\n";
const file = (proposals: (ConflictProposal | null)[], overrides: Partial<ConflictFile> = {}): ConflictFile => ({
  path: 'src/numbers.ts',
  mode: '100644',
  base,
  ours,
  theirs,
  original,
  result: withProposals(original, proposals),
  resolved: false,
  source: 'mergiraf',
  proposals,
  ...overrides,
});
const merged = (text: string): ConflictProposal => ({ source: 'mergiraf', text });

void test('a resolver’s output becomes per-conflict proposals only where the text outside the conflicts is Git’s', () => {
  // Structural merge combined the imports and left the two new functions conflicted, with its own marker layout.
  const output = original
    .replace(/<<<<<<< feature\nimport[\s\S]*?>>>>>>> main\n/, imports)
    .replace(
      /<<<<<<< feature\nexport function three[\s\S]*?>>>>>>> main\n/,
      `<<<<<<< ours\n${three.trim()}\n=======\n${four.trim()}\n>>>>>>> theirs\n\n`
    );
  const proposals = blockProposals(original, output, 'mergiraf');
  assert.deepEqual(proposals, [merged(imports), null]);
  assert.equal(
    withProposals(original, [merged(imports), null]),
    original.replace(/<<<<<<< feature\nimport[\s\S]*?>>>>>>> main\n/, imports)
  );
  assert.equal(
    blockProposals(original, output.replace('return 1;', 'return 10;'), 'mergiraf'),
    undefined,
    'It changed lines Git had merged'
  );
  assert.equal(blockProposals(original, original, 'mergiraf'), undefined, 'Nothing resolved: no proposals');
});

void test('a result that parses and keeps every definition is Merged', async () => {
  const verdict = await verifyProposals(file([merged(imports), merged(three + four)]), analyse);
  assert.deepEqual(verdict, { merged: true, note: 'The file parses. Every line of both sides is accounted for.' });
});

void test('a lost definition, a duplicate, a parse error, markers or mixed line endings keep the proposal in Check', async () => {
  const lost = await verifyProposals(file([merged(imports), merged(three)]), analyse);
  assert.deepEqual(lost, { merged: false, note: 'export function four() { from main is missing from the result.' });
  const twice = await verifyProposals(file([merged(imports), merged(three + three + four)]), analyse);
  assert.deepEqual(twice, { merged: false, note: 'three is defined twice in the result.' });
  const broken = await verifyProposals(
    file([merged(imports), merged(`${three}${four.replace('}\n', '\n')}`)]),
    analyse
  );
  assert.deepEqual(broken, { merged: false, note: 'The result doesn’t parse.' });
  const markers = await verifyProposals(file([merged('<<<<<<< x\n'), null]), analyse);
  assert.equal(markers.merged, false);
  const endings = await verifyProposals(file([merged("import { b } from './b';\r\n"), merged(three + four)]), analyse);
  assert.deepEqual(endings, { merged: false, note: 'The result mixes line endings.' });
});

void test('a definition that only main’s side of an undecided conflict holds is not expected yet', async () => {
  const verdict = await verifyProposals(file([merged(imports), null]), analyse);
  assert.equal(verdict.merged, true, verdict.note);
});

void test('a side that deleted a definition is respected, and a failed parse never counts as checked', async () => {
  // main removed two(); the PR kept it. Keeping it or dropping it is the conflict, so neither is a lost definition.
  const withoutTwo = theirs.replace(/export function two[\s\S]*$/, '');
  const verdict = await verifyProposals(file([merged(imports), merged(three + four)], { theirs: withoutTwo }), analyse);
  assert.equal(verdict.merged, true, verdict.note);
  const failing = await verifyProposals(file([merged(imports), null]), () => Promise.reject(Error('off in Settings')));
  assert.equal(failing.merged, false);
});

void test('files with no grammar: your earlier resolution stays Merged, structural merge goes to Check', async () => {
  const text = (proposals: (ConflictProposal | null)[]) =>
    file(proposals, {
      path: 'notes.txt',
      base: 'a\n',
      ours: 'b\n',
      theirs: 'c\n',
      original: '<<<<<<< x\nb\n=======\nc\n>>>>>>> y\n',
    });
  assert.equal((await verifyProposals(text([{ source: 'rerere', text: 'bc\n' }]), analyse)).merged, true);
  assert.equal((await verifyProposals(text([merged('bc\n')]), analyse)).merged, false);
});

void test('buckets follow the draft: proposal, undone, kept by you, edited by hand', () => {
  const f = file([merged(imports), null]);
  const ok = { merged: true, note: '' };
  assert.deepEqual(blockBuckets(f, f.result, ok), ['merged', 'decide']);
  assert.deepEqual(blockBuckets(f, f.result, { merged: false, note: 'x' }), ['check', 'decide']);
  assert.deepEqual(blockBuckets(f, f.result, undefined), ['check', 'decide'], 'Checking: not Merged yet');
  assert.deepEqual(blockBuckets(f, original, ok), ['decide', 'decide'], 'Undo restores both sides');
  const keptPr = f.result.replace(/<<<<<<< feature\nexport function three[\s\S]*?>>>>>>> main\n/, three);
  assert.deepEqual(blockBuckets(f, keptPr, ok), ['merged', 'decided']);
  // Review probe: an edit elsewhere never turns an unreviewed proposal into a decision.
  assert.deepEqual(blockBuckets(f, `// edited\n${keptPr}`, ok), ['check', 'decided']);
  assert.deepEqual(blockBuckets({ ...f, unsupported: 'binary' }, '', ok), ['decide']);
});

void test('the summary counts conflicts, not files, and a reviewed file’s Check conflicts no longer need you', () => {
  const ok = { merged: true, note: '' };
  const check = { merged: false, note: 'x' };
  const a = file([merged(imports), null]);
  const b = file([merged(imports), merged(three + four)], { path: 'src/b.ts' });
  const c = file([merged(imports), merged(three + four)], { path: 'src/c.ts' });
  const summary = bucketSummary([
    { buckets: blockBuckets(a, a.result, ok), verdict: ok, reviewed: false },
    { buckets: blockBuckets(b, b.result, ok), verdict: ok, reviewed: false },
    { buckets: blockBuckets(c, c.result, check), verdict: check, reviewed: false },
  ]);
  assert.deepEqual(summary, {
    files: 3,
    conflicts: 6,
    merged: 3,
    needs: 3,
    checking: 0,
    decide: 1,
    wholeConflicts: 0,
    wholeFiles: 0,
  });
  assert.equal(summarySentence(summary), '3 files conflict. 3 of 6 conflicts are merged and checked. 3 need you.');
  const reviewed = bucketSummary([{ buckets: blockBuckets(c, c.result, check), verdict: check, reviewed: true }]);
  assert.equal(summarySentence(reviewed), '1 file conflicts. Nothing needs you.');
  const checking = bucketSummary([
    { buckets: blockBuckets(b, b.result, undefined), verdict: undefined, reviewed: false },
  ]);
  assert.equal(summarySentence(checking), '1 file conflicts. Checking 2 results…');
  assert.equal(
    summarySentence({
      files: 3,
      conflicts: 9,
      merged: 7,
      needs: 2,
      checking: 0,
      decide: 2,
      wholeConflicts: 0,
      wholeFiles: 0,
    }),
    '3 files conflict. 7 of 9 conflicts are merged and checked. 2 need you.'
  );
  // Whole-file proposals are named as proposals to check.
  const passed = { merged: false, passed: true, note: '' };
  const whole = { buckets: ['check'] as const, verdict: passed, reviewed: false, whole: true };
  assert.equal(summarySentence(bucketSummary([whole])), '1 file conflicts. 1 proposal to check.');
  assert.equal(
    summarySentence(bucketSummary([whole, { buckets: ['decide'], verdict: undefined, reviewed: false }])),
    '2 files conflict. 2 need you: 1 proposal to check, 1 to decide.'
  );
  // One proposal that covers two conflicts says so, and the totals stay per conflict.
  const covering = { ...whole, buckets: ['check', 'check'] as const };
  assert.equal(summarySentence(bucketSummary([covering])), '1 file conflicts. 1 proposal to check for 2 conflicts.');
  assert.equal(
    summarySentence(bucketSummary([covering, { buckets: ['decide'], verdict: undefined, reviewed: false }])),
    '2 files conflict. 3 need you: 1 proposal to check for 2 conflicts, 1 to decide.'
  );
});

void test('review probe: a lone newline between conflicts never cuts a resolution short', () => {
  // Structural merge wrote `b1\nc1\n` and more; the earliest "\n" after the first conflict used to make its proposal
  // "b1" and lose c1. Where the split is not unique, neither conflict gets a proposal: both go to Decide.
  const twoBlocks =
    'a\n<<<<<<< feature\nb\n=======\nB\n>>>>>>> main\n\n<<<<<<< feature\nc\n=======\nC\n>>>>>>> main\nz\n';
  const output = 'a\nb1\nc1\n\nm\nz\n';
  assert.deepEqual(blockResolutions(parseConflicts(twoBlocks), output), [undefined, undefined]);
  assert.equal(blockProposals(twoBlocks, output, 'mergiraf'), undefined);
  // Unique anchors on both sides still give each conflict its own text.
  const anchored = twoBlocks.replace('>>>>>>> main\n\n<<<<<<<', '>>>>>>> main\nmiddle\n<<<<<<<');
  assert.deepEqual(blockResolutions(parseConflicts(anchored), 'a\nb1\nc1\nmiddle\nC\nz\n'), ['b1\nc1\n', 'C\n']);
});

void test('review probe: a lost line that is no definition keeps the proposal in Check', async () => {
  // The imports conflict kept only the PR's import: every definition survives, main's import does not.
  const verdict = await verifyProposals(file([merged("import { b } from './b';\n"), merged(three + four)]), analyse);
  assert.deepEqual(verdict, { merged: false, note: "import { c } from './c'; from main is missing from the result." });
  const config = await verifyProposals(
    {
      path: 'config.json',
      base: '{\n  "a": 1\n}\n',
      ours: '{\n  "a": 1,\n  "b1": 2\n}\n',
      theirs: '{\n  "a": 1,\n  "c1": 3\n}\n',
      original:
        '{\n<<<<<<< feature\n  "a": 1,\n  "b1": 2\n||||||| ancestor\n  "a": 1\n=======\n  "a": 1,\n  "c1": 3\n>>>>>>> main\n}\n',
      proposals: [merged('  "a": 1,\n  "b1": 2\n')],
    },
    analyse
  );
  assert.equal(config.merged, false, config.note);
});

void test('review probe: a lost definition is excused only by its exact name, in the same undecided conflict', async () => {
  // main's side of the open imports conflict names `fourteen` and `four` as imports, not definitions: four() was lost
  // by the proposal for the other conflict, and nothing excuses it.
  const imported = "import { fourteen, four } from './c';\n";
  const f = file([null, merged(three)], {
    theirs: theirs.replace("import { c } from './c';\n", imported),
    original: original.replace("import { c } from './c';\n", imported),
  });
  assert.deepEqual(await verifyProposals(f, analyse), {
    merged: false,
    note: 'export function four() { from main is missing from the result.',
  });
});

void test('review probe: carrying a draft forward uses the fresh proposal for a conflict it cannot carry', () => {
  const proposals = [merged(imports), merged(three + four)];
  const next = file(proposals);
  // The earlier draft resolved only an older version of the second conflict.
  const old = file([null, null], { original: original.replace('return 3;', 'return 30;') });
  old.result = old.original.replace(/<<<<<<< feature\nexport[\s\S]*?>>>>>>> main\n/, three.replace('3', '30'));
  const carried = carryFile(old, next, true);
  assert.equal(carried.file.result, withProposals(original, proposals));
  assert.equal(carried.file.resolved, false);
  assert.deepEqual(carried.file.proposals, proposals);
});

void test('review probe: a check result belongs to the proposals it checked', () => {
  // The workspace keys each result by this fingerprint, so a pass for earlier proposals never marks new ones Merged.
  const before = file([merged(imports), merged(three + four)]);
  const after = file([merged(imports), merged(three)]);
  assert.notEqual(proposalKey(before), proposalKey(after));
  assert.equal(proposalKey(before), proposalKey(file([merged(imports), merged(three + four)])));
});

void test('second review probe: a draft that splits two ways is never carried, so a choice cannot swap', () => {
  // `}\n}\n` is "PR side, then the text, then the PR side" and also "main side, then the text, then main side".
  const twoWays = '<<<<<<< feature\n}\n=======\n>>>>>>> main\n}\n<<<<<<< feature\n=======\n}\n>>>>>>> main\n';
  assert.equal(inferChoices(parseConflicts(twoWays), '}\n}\n'), undefined);
  assert.deepEqual(blockResolutions(parseConflicts(twoWays), '}\n}\n'), [undefined, undefined]);
});

void test('second review probe: a fresh proposal next to a hand-edited block is never decided', () => {
  const proposals = [null, merged(three + four)];
  const f = file(proposals);
  const edited = withProposals(original, proposals).replace(
    /<<<<<<< feature\nimport[\s\S]*?>>>>>>> main\n/,
    "import { b, c } from './bc';\n"
  );
  assert.deepEqual(blockBuckets(f, edited, undefined), ['decided', 'check']);
  assert.deepEqual(blockBuckets(f, edited, { merged: true, note: '' }), ['decided', 'merged']);
});

void test('second review probe: a proposal that drops a line both sides kept is not Merged', () => {
  const kept = {
    base: 'start();\nvalidate(input);\nfinish();\n',
    ours: 'start();\nvalidate(input);\nlog(1);\nfinish();\n',
    theirs: 'begin();\nvalidate(input);\nfinish();\n',
  };
  assert.equal(
    accountLines(kept, 'begin();\nlog(1);\nfinish();\n', false),
    'validate(input); from both sides is missing from the result.'
  );
  assert.equal(accountLines(kept, 'begin();\nvalidate(input);\nlog(1);\nfinish();\n', false), undefined);
  assert.equal(
    accountLines(kept, 'begin();\nvalidate(input);\nlog(1);\nfinish();\nextra();\n', false),
    'extra(); is in neither side.'
  );
  assert.equal(
    accountLines(kept, 'start();\nbegin();\nvalidate(input);\nlog(1);\nfinish();\n', false),
    'start(); was removed on one side but is still in the result.'
  );
  // Both sides rewrote the same line: a choice, never Merged. In Python, indentation counts.
  assert.match(
    accountLines({ base: 'a = 1\n', ours: 'a = 2\n', theirs: 'a = 3\n' }, 'a = 2\n', true) ?? '',
    /Both sides changed/
  );
  assert.match(
    accountLines(
      { base: 'if x:\n    y()\n', ours: 'if x:\n    y()\nz()\n', theirs: 'if x:\n    y()\n' },
      'if x:\n    y()\n    z()\n',
      true
    ) ?? '',
    /z\(\)/
  );
});

void test('second review probe: splitting a long output with a lone newline between conflicts stays fast', () => {
  const block = (i: number) => `<<<<<<< feature\na${i}\n=======\nb${i}\n>>>>>>> main\n`;
  const blocks = Array.from({ length: 2500 }, (_, i) => block(i)).join('\n');
  const output = Array.from({ length: 2500 }, (_, i) => `a${i}b${i}\n`).join('\n');
  const started = performance.now();
  assert.equal(blockProposals(blocks, output, 'mergiraf'), undefined);
  assertPerf('conflict split of a 10,000-line output', performance.now() - started, perfBudget(500));
});

void test('a whole-file proposal is checked as a whole, accepts a move, and is never Merged', async () => {
  const fn = (name: string, total = 'value + 1') =>
    `function ${name}(value) {\n  const total = ${total};\n  return total * 2;\n}\n`;
  const sides = {
    path: 'src/order.js',
    base: [fn('alpha'), fn('beta')].join('\n'),
    ours: [fn('beta'), fn('alpha')].join('\n'),
    theirs: [fn('alpha', 'value + 10'), fn('beta')].join('\n'),
  };
  const right = await verifyWholeFile(sides, merged([fn('beta'), fn('alpha', 'value + 10')].join('\n')), analyse);
  assert.equal(right.merged, false);
  assert.deepEqual(right, {
    merged: false,
    passed: true,
    note: 'Mergiraf moved lines outside the conflict. The result parses and keeps every change from both sides. Read it, then use it.',
  });
  // The move without main's edit drops the line main added.
  assert.equal(
    accountWholeFile(sides, sides.ours, false),
    'const total = value + 10; from main is missing from the result.'
  );
  assert.equal(
    accountWholeFile(sides, [fn('beta'), fn('alpha', 'value + 10'), 'let x;\n'].join('\n'), false),
    'let x; is in neither side.'
  );
  // Every line is there, but main's edit landed in beta, which took alpha's place.
  assert.deepEqual(await verifyWholeFile(sides, merged([fn('beta', 'value + 10'), fn('alpha')].join('\n')), analyse), {
    merged: false,
    note: 'alpha in the result doesn’t match main’s change to it. Read it before you use it, or resolve conflict by conflict.',
  });
  // Moved and also kept in place: alpha is there twice.
  const doubled = await verifyWholeFile(sides, merged([fn('alpha', 'value + 10'), sides.ours].join('\n')), analyse);
  assert.match(doubled.note, /^alpha is defined twice in the result\./);
  assert.equal(doubled.passed, undefined);
  // One Check item while the draft is the original conflict; your own choices count as usual.
  const whole = file([], { proposals: undefined, wholeFile: merged('x\n') });
  assert.deepEqual(blockBuckets(whole, original, { merged: false, passed: true, note: '' }), ['check', 'check']);
  assert.deepEqual(blockBuckets(whole, original, undefined), ['check', 'check'], 'Check while its checks run');
  // One that failed its checks leaves the conflicts to decide.
  assert.deepEqual(blockBuckets(whole, original, { merged: false, note: 'x' }), ['decide', 'decide']);
  assert.notEqual(proposalKey(whole), proposalKey(file([], { proposals: undefined })));
  const chosen = parseConflicts(original)
    .map((s) => (s.kind === 'text' ? s.text : s.block.ours))
    .join('');
  assert.deepEqual(blockBuckets(whole, chosen, undefined), ['decided', 'decided']);
});
