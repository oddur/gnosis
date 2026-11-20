import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import * as TreeSitter from 'web-tree-sitter';
import { createSyntaxEngine } from '../lib/syntax-scope';
import { blockProposals, blockResolutions, carryFile, withProposals } from '../lib/conflict-carry';
import { parseConflicts } from '../lib/conflict-blocks';
import { blockBuckets, bucketSummary, summarySentence, verifyProposals, type Analyse } from '../lib/conflict-verify';
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
  assert.deepEqual(verdict, { merged: true, note: 'The file parses. No definition or added line was lost.' });
});

void test('a lost definition, a duplicate, a parse error, markers or mixed line endings keep the proposal in Check', async () => {
  const lost = await verifyProposals(file([merged(imports), merged(three)]), analyse);
  assert.deepEqual(lost, { merged: false, note: 'four is missing from the result.' });
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
  assert.deepEqual(blockBuckets(f, `// edited\n${keptPr}`, ok), ['decided', 'decided']);
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
  assert.deepEqual(summary, { files: 3, conflicts: 6, merged: 3, needs: 3, checking: 0 });
  assert.equal(summarySentence(summary), '3 files conflict. 3 of 6 conflicts are merged and checked. 3 need you.');
  const reviewed = bucketSummary([{ buckets: blockBuckets(c, c.result, check), verdict: check, reviewed: true }]);
  assert.equal(summarySentence(reviewed), '1 file conflicts. Nothing needs you.');
  const checking = bucketSummary([
    { buckets: blockBuckets(b, b.result, undefined), verdict: undefined, reviewed: false },
  ]);
  assert.equal(summarySentence(checking), '1 file conflicts. Checking 2 results…');
  assert.equal(
    summarySentence({ files: 3, conflicts: 9, merged: 7, needs: 2, checking: 0 }),
    '3 files conflict. 7 of 9 conflicts are merged and checked. 2 need you.'
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
  assert.deepEqual(await verifyProposals(f, analyse), { merged: false, note: 'four is missing from the result.' });
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
