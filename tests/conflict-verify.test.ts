import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import * as TreeSitter from 'web-tree-sitter';
import { createSyntaxEngine } from '../lib/syntax-scope';
import { blockProposals, blockResolutions, carryFile, withProposals } from '../lib/conflict-carry';
import { conflictModel, inferChoices, parseConflicts } from '../lib/conflict-blocks';
import { assertPerf, perfBudget } from './perf-budget';
import {
  accountLines,
  accountWholeFile,
  blockBuckets,
  unchosenConflicts,
  UNSPLIT_HINT,
  waitingHint,
  withoutUnchosen,
  bucketSummary,
  fileStatus,
  fileStatusLine,
  fileStatusParts,
  keepsLayout,
  allMerged,
  waitsForReview,
  proposalKey,
  proposalReady,
  typeCheckKey,
  SAME_LINES,
  summarySentence,
  verifyProposals,
  verifyWholeFile,
  type Analyse,
  type Equivalent,
} from '../lib/conflict-verify';
import {
  conflictFileStage,
  hasConflictMarkers,
  type ConflictFile,
  type ConflictProposal,
} from '../lib/conflict-resolution';

/** Conflict buckets and their checks (phase 1 of the conflict redesign), with the real tree-sitter grammars. */
const assets = path.resolve(__dirname, '../src/assets/tree-sitter');
const engine = createSyntaxEngine(TreeSitter, {
  runtime: async () => new Uint8Array(await fs.readFile(require.resolve('web-tree-sitter/web-tree-sitter.wasm'))),
  grammar: async (language) => new Uint8Array(await fs.readFile(path.join(assets, `${language}.wasm`))),
  tags: (name) => fs.readFile(path.join(assets, `${name}-tags.scm`), 'utf8'),
});
const analyse: Analyse = (language, text, ranges) => engine.definitions(language, text, ranges);

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
  result: withProposals(overrides.original ?? original, proposals),
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
  // main didn't add a function: the PR's three() goes where it wrote it, and nothing else was inserted there.
  const alone = original.replace(`=======\n${four}>>>>>>> main`, '=======\n>>>>>>> main');
  const verdict = await verifyProposals(
    file([merged(imports), merged(three)], { theirs: theirs.replace(four, ''), original: alone }),
    analyse
  );
  assert.deepEqual(verdict.blocks?.[1], {
    merged: true,
    note: 'The file parses. Every line of both sides is accounted for.',
  });
  // Both sides inserted at one place (the imports, the functions): no order is the ancestor's, so they are Check.
  const both = await verifyProposals(file([merged(imports), merged(three + four)]), analyse);
  assert.deepEqual(both, { merged: false, note: SAME_LINES });
});

/** Both sides added imports at one place: Check, whatever the line counts say. */
const passed = { merged: false, note: SAME_LINES };
void test('a lost definition, a duplicate, a parse error, markers or mixed line endings keep the proposal in Check', async () => {
  // Each failure belongs to the conflict that caused it: the imports conflict stays Merged, with its own reason.
  const lost = await verifyProposals(file([merged(imports), merged(three)]), analyse);
  const missing = { merged: false, note: 'export function four() { from main is missing from the result.' };
  assert.deepEqual(lost.blocks, [passed, missing]);
  const twice = await verifyProposals(file([merged(imports), merged(three + three + four)]), analyse);
  const duplicate = { merged: false, note: 'three is defined twice in the result.' };
  assert.deepEqual(twice.blocks, [passed, duplicate]);
  const broken = await verifyProposals(
    file([merged(imports), merged(`${three}${four.replace('}\n', '\n')}`)]),
    analyse
  );
  const unparsed = { merged: false, note: 'This proposal doesn’t parse.' };
  assert.deepEqual(broken.blocks, [passed, unparsed]);
  assert.deepEqual(
    blockBuckets(
      file([merged(imports), merged(three)]),
      withProposals(original, [merged(imports), merged(three)]),
      lost
    ),
    ['check', 'check']
  );
  const markers = await verifyProposals(file([merged('<<<<<<< x\n'), null]), analyse);
  assert.equal(markers.merged, false);
  const endings = await verifyProposals(file([merged("import { b } from './b';\r\n"), merged(three + four)]), analyse);
  assert.deepEqual(endings, { merged: false, note: 'With the proposals in place, the file mixes line endings.' });
});

void test('a definition that only main’s side of an undecided conflict holds is not expected yet', async () => {
  // Not missing: the imports are Check only because both sides inserted them at one place.
  const verdict = await verifyProposals(file([merged(imports), null]), analyse);
  assert.equal(verdict.note, SAME_LINES);
});

void test('a side that deleted a definition is respected, and a failed parse never counts as checked', async () => {
  // main removed two(); the PR kept it. Keeping it or dropping it is the conflict, so neither is a lost definition.
  const withoutTwo = theirs.replace(/export function two[\s\S]*$/, '');
  const verdict = await verifyProposals(file([merged(imports), merged(three + four)], { theirs: withoutTwo }), analyse);
  assert.equal(verdict.note, SAME_LINES, 'Check only because both sides inserted at one place');
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
  // Undo restores both sides; the proposal stays on the card, one of the choices: Check, never accepted by default.
  assert.deepEqual(blockBuckets(f, original, ok), ['check', 'decide'], 'Undo restores both sides');
  const keptPr = f.result.replace(/<<<<<<< feature\nexport function three[\s\S]*?>>>>>>> main\n/, three);
  assert.deepEqual(blockBuckets(f, keptPr, ok), ['merged', 'decided']);
  // A draft edited outside its conflicts can't be split into them. Fail closed: a proposal that needs a choice may still
  // be in it untouched, so it waits (Reset file is the way back); one the checks Merged doesn't.
  assert.deepEqual(blockBuckets(f, `// edited\n${keptPr}`, ok), ['decided', 'decided']);
  assert.deepEqual(blockBuckets(f, `// edited\n${keptPr}`, undefined), ['check', 'decided']);
  assert.deepEqual(unchosenConflicts(f, `// edited\n${keptPr}`, undefined), [0]);
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
    markers: 0,
    local: 0,
    review: 0,
  });
  assert.equal(
    summarySentence(summary),
    '3 files have conflicts. 3 of 6 conflicts are merged and checked. 3 need you: 2 to check, 1 to decide.'
  );
  const reviewed = bucketSummary([{ buckets: blockBuckets(c, c.result, check), verdict: check, reviewed: true }]);
  assert.equal(summarySentence(reviewed), '1 file has conflicts. Nothing needs you.');
  const checking = bucketSummary([
    { buckets: blockBuckets(b, b.result, undefined), verdict: undefined, reviewed: false },
  ]);
  assert.equal(summarySentence(checking), '1 file has conflicts. Checking 2 results…');
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
      markers: 0,
      local: 0,
      review: 0,
    }),
    '3 files have conflicts. 7 of 9 conflicts are merged and checked. 2 to decide.'
  );
  // Whole-file proposals are named as proposals to check.
  const passed = { merged: false, passed: true, note: '' };
  const whole = { buckets: ['check'] as const, verdict: passed, reviewed: false, whole: true };
  assert.equal(summarySentence(bucketSummary([whole])), '1 file has conflicts. 1 whole-file proposal to check.');
  assert.equal(
    summarySentence(bucketSummary([whole, { buckets: ['decide'], verdict: undefined, reviewed: false }])),
    '2 files have conflicts. 2 need you: 1 whole-file proposal to check, 1 to decide.'
  );
  // One proposal that covers two conflicts says so, and the totals stay per conflict.
  const covering = { ...whole, buckets: ['check', 'check'] as const };
  assert.equal(
    summarySentence(bucketSummary([covering])),
    '1 file has conflicts. 1 whole-file proposal to check for 2 conflicts.'
  );
  assert.equal(
    summarySentence(bucketSummary([covering, { buckets: ['decide'], verdict: undefined, reviewed: false }])),
    '2 files have conflicts. 3 need you: 1 whole-file proposal to check for 2 conflicts, 1 to decide.'
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
  const missing = { merged: false, note: "import { c } from './c'; from main is missing from the result." };
  assert.deepEqual(verdict, { ...missing, blocks: [missing, { merged: false, note: SAME_LINES }] });
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

void test('review probe: carrying a draft forward uses the fresh proposal for a new conflict it cannot carry', () => {
  const proposals = [merged(imports), merged(three + four)];
  const next = file(proposals);
  // The earlier draft resolved only an older version of the second conflict, and left the first open.
  const old = file([null, null], { original: original.replace('return 3;', 'return 30;') });
  old.result = old.original.replace(/<<<<<<< feature\nexport[\s\S]*?>>>>>>> main\n/, three.replace('3', '30'));
  const carried = carryFile(old, next, true);
  // The second conflict is new: its fresh proposal. The first was open before and stays open (#528).
  assert.equal(carried.file.result, withProposals(original, [null, proposals[1]]));
  assert.equal(carried.file.resolved, false);
  assert.deepEqual(carried.file.proposals, proposals);
});

void test('review probe: a check result belongs to the proposals it checked', () => {
  // The workspace keys each result by this fingerprint, so a pass for earlier proposals never marks new ones Merged.
  const before = file([merged(imports), merged(three + four)]);
  const after = file([merged(imports), merged(three)]);
  assert.notEqual(proposalKey(before), proposalKey(after));
  assert.equal(proposalKey(before), proposalKey(file([merged(imports), merged(three + four)])));
  // The path and the three versions the checks read count too (#464); the type check's key leaves them out as before.
  const same = file([merged(imports), merged(three + four)]);
  for (const field of ['path', 'base', 'ours', 'theirs'] as const)
    assert.notEqual(proposalKey(before), proposalKey({ ...same, [field]: `${same[field]} ` }), field);
  // The type check's key has the draft (#499), and no sides.
  assert.equal(
    typeCheckKey(before),
    proposalKey({ original: before.original, proposals: before.proposals, wholeFile: before.wholeFile, result: before.result })
  );
  assert.equal(typeCheckKey(before), typeCheckKey(Object.assign({ ...same }, { base: `${same.base} ` })));
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

void test('resolver audit: a result that swaps lines either side put in order is not Merged', () => {
  // The PR changed the second line and main the first: the two changes are in the ancestor's order.
  const adjacent = {
    base: 'for (const item of items) sum += item;\nconst tax = sum * 0.2;\n',
    ours: 'for (const item of items) sum += item;\nconst tax = Math.round(sum * 0.2);\n',
    theirs: 'for (const item of items) sum += Math.abs(item);\nconst tax = sum * 0.2;\n',
  };
  const both = 'for (const item of items) sum += Math.abs(item);\nconst tax = Math.round(sum * 0.2);\n';
  assert.equal(accountLines(adjacent, both, false), undefined);
  assert.equal(
    accountLines(adjacent, both.split('\n').reverse().join('\n').slice(1) + '\n', false),
    'The proposal changes the order of lines from the PR or main.'
  );
  // Two lines one side wrote, swapped, with the other side's identical line elsewhere to stand in for one of them.
  const functions = {
    base: '',
    ours: 'function beta() {\n  total = 2;\n  scaled = total * 2;\n}\n',
    theirs: 'function gamma() {\n  total = 3;\n  scaled = total * 2;\n}\n',
  };
  const kept = functions.ours + functions.theirs;
  const swapped = kept.replace('  total = 2;\n  scaled = total * 2;\n', '  scaled = total * 2;\n  total = 2;\n');
  // Both sides inserted at one place: Check in either order. Read as a union (the PR's lines first), the swap shows.
  assert.equal(accountLines(functions, kept, false), SAME_LINES);
  assert.equal(accountLines(functions, functions.theirs + functions.ours, false), SAME_LINES);
  assert.equal(accountLines(functions, swapped, false), SAME_LINES);
  assert.equal(accountLines(functions, kept, false, true), undefined);
  assert.equal(
    accountLines(functions, swapped, false, true),
    'The proposal changes the order of lines from the PR or main.'
  );
  const members = { base: 'RED = 1,\n', ours: 'RED = 1,\nBLUE = 3,\n', theirs: 'RED = 1,\nYELLOW = 4,\n' };
  assert.equal(accountLines(members, 'RED = 1,\nYELLOW = 4,\nBLUE = 3,\n', false), SAME_LINES);
  assert.equal(
    accountLines(members, 'BLUE = 3,\nRED = 1,\nYELLOW = 4,\n', false),
    'The proposal changes the order of lines from the PR or main.'
  );
});

void test('resolver audit round 2: one side’s line moved inside the other side’s lines is not Merged', () => {
  // Both sides inserted at one point: main's `stop();` may come before or after the PR's block, never inside it.
  const inserted = {
    base: 'start();\nfinish();\n',
    ours: 'start();\nif (ready) {\n    go();\n  }\nfinish();\n',
    theirs: 'start();\nstop();\nfinish();\n',
  };
  // Since #476: no order of two insertions at one place passes the line checks.
  for (const result of [
    'start();\nif (ready) {\n    go();\n  }\nstop();\nfinish();\n',
    'start();\nstop();\nif (ready) {\n    go();\n  }\nfinish();\n',
    'start();\nif (ready) {\n  stop();\n    go();\n  }\nfinish();\n',
  ])
    assert.equal(accountLines(inserted, result, false), SAME_LINES, result);
  // Next to a change: the PR wrapped `go();` in an if, main appended `stop();` after it. Counted with indentation, the
  // PR's change is one block of several lines, and main's insertion touches it: whether `stop();` belongs inside the if
  // or after it is not something the ancestor says, so neither layout is Merged.
  const wrapped = {
    base: 'start();\ngo();\n',
    ours: 'start();\nif (ready) {\n  go();\n}\n',
    theirs: 'start();\ngo();\nstop();\n',
  };
  assert.equal(accountLines(wrapped, 'start();\nif (ready) {\n  go();\n}\nstop();\n', true), SAME_LINES);
  assert.equal(accountLines(wrapped, 'start();\nif (ready) {\n  go();\nstop();\n}\n', true), SAME_LINES);
});

void test('resolver audit: with a side that does not parse, a result whose error reaches a proposal is not Merged', async () => {
  // main's side has a stray `= ;` far from the conflict, so the parse check can't clear the file.
  const sides = {
    path: 'src/limits.ts',
    base: 'export const LIMITS = {\n  timeout: 30_000,\n};\n',
    ours: 'export const LIMITS = {\n  timeout: 60_000,\n};\n',
    theirs: 'export const LIMITS = {\n  timeout: 45_000,\n};\n\nexport const pending = ;\n',
    original:
      'export const LIMITS = {\n<<<<<<< feature\n  timeout: 60_000,\n||||||| ancestor\n  timeout: 30_000,\n=======\n  timeout: 45_000,\n>>>>>>> main\n};\n\nexport const pending = ;\n',
  };
  const remembered = (text: string) => verifyProposals({ ...sides, proposals: [{ source: 'rerere', text }] }, analyse);
  const good = await remembered('  timeout: 60_000,\n');
  assert.equal(good.merged, true, good.note);
  const broken = await remembered('  timeout: 60_000 45_000,\n');
  assert.equal(broken.merged, false);
  assert.equal(broken.note, 'This proposal doesn’t parse.');
});

void test('resolver audit round 2: an error that is the side’s own does not demote a correct earlier resolution', async () => {
  // main left an unclosed `if (debug) {` around the conflict: the error reaches the proposal, but it is main's.
  const sides = {
    path: 'src/run.ts',
    base: 'export function run() {\n  const limit = 30;\n  return limit;\n}\n',
    ours: 'export function run() {\n  const limit = 60;\n  return limit;\n}\n',
    theirs: 'export function run() {\n  if (debug) {\n  const limit = 45;\n  return limit;\n}\n',
    original:
      'export function run() {\n  if (debug) {\n<<<<<<< feature\n  const limit = 60;\n||||||| ancestor\n  const limit = 30;\n=======\n  const limit = 45;\n>>>>>>> main\n  return limit;\n}\n',
  };
  const remembered = (text: string) => verifyProposals({ ...sides, proposals: [{ source: 'rerere', text }] }, analyse);
  const good = await remembered('  const limit = 60;\n');
  assert.equal(good.merged, true, good.note);
  for (const text of ['  const limit = 60 45;\n', '  const limit = 60;\n)]}\n']) {
    const broken = await remembered(text);
    assert.equal(broken.merged, false, text);
    assert.match(broken.note, /doesn’t parse/);
  }
});

void test('order per ancestor place: insertions stay on their side of a changed line', () => {
  const ORDER = 'The proposal changes the order of lines from the PR or main.';
  // The PR logs before and after go(1); main changes it to go(2).
  const around = { base: '  go(1);\n', ours: "  log('before');\n  go(1);\n  log('after');\n", theirs: '  go(2);\n' };
  assert.equal(accountLines(around, "  log('before');\n  go(2);\n  log('after');\n", false), undefined);
  assert.equal(accountLines(around, "  log('before');\n  log('after');\n  go(2);\n", false), ORDER);
  assert.equal(accountLines(around, "  go(2);\n  log('before');\n  log('after');\n", false), ORDER);
  // The mirror: main adds around the line the PR changed.
  const mirror = { base: around.base, ours: around.theirs, theirs: around.ours };
  assert.equal(accountLines(mirror, "  log('before');\n  go(2);\n  log('after');\n", false), undefined);
  // X changed on one side, Y inserted after X on the other: Y comes after X′, never before it.
  const after = { base: 'x();\nz();\n', ours: 'x2();\nz();\n', theirs: 'x();\ny();\nz();\n' };
  assert.equal(accountLines(after, 'x2();\ny();\nz();\n', false), undefined);
  assert.equal(accountLines(after, 'y();\nx2();\nz();\n', false), ORDER);
});

void test('with a side that does not parse, an error no proposal accounts for fails the file', async () => {
  const block = (cond: string, n: number) => `  if (${cond}) {\n    go(${n});\n  }\n`;
  const wrap = (head: string, body: string) => `${head}export function run(a: boolean) {\n${body}}\n`;
  // main has `const z = ;`; the remembered resolution drops `if (...) {` and keeps its brace.
  const dropped = {
    path: 'src/run.ts',
    base: wrap('const z = 1;\n', block('a', 1)),
    ours: wrap('const z = 1;\n', block('a || b', 2)),
    theirs: wrap('const z = ;\n', block('a && b', 3)),
    original: wrap(
      'const z = ;\n',
      `<<<<<<< feature\n${block('a || b', 2)}||||||| ancestor\n${block('a', 1)}=======\n${block('a && b', 3)}>>>>>>> main\n`
    ),
  };
  const remember = (file: typeof dropped, text: string) =>
    verifyProposals({ ...file, proposals: [{ source: 'rerere', text }] }, analyse);
  assert.equal((await remember(dropped, block('a || b', 2))).merged, true);
  assert.deepEqual(await remember(dropped, '    go(2);\n  }\n'), { merged: false, note: 'With the proposals in place, the file doesn’t parse.' });
  // main left `if (debug) {` unclosed; two extra closing braces move the error outside the conflict.
  const debug = {
    path: 'src/run.ts',
    base: 'export function run() {\n  const limit = 30;\n  return limit;\n}\n',
    ours: 'export function run() {\n  const limit = 60;\n  return limit;\n}\n',
    theirs: 'export function run() {\n  if (debug) {\n  const limit = 45;\n  return limit;\n}\n',
    original:
      'export function run() {\n  if (debug) {\n<<<<<<< feature\n  const limit = 60;\n||||||| ancestor\n  const limit = 30;\n=======\n  const limit = 45;\n>>>>>>> main\n  return limit;\n}\n',
  };
  assert.equal((await remember(debug, '  const limit = 60;\n')).merged, true);
  assert.equal((await remember(debug, '  const limit = 60;\n}\n}\n')).merged, false);
});

void test('a side’s parse error over a proposal leaves it unchecked, unless it is that side’s lines', async () => {
  // main's `foo(` at the top doesn't parse, and its error covers the whole file: the parser can't vouch for anything.
  const sides = {
    path: 'src/limits.ts',
    base: 'export const LIMITS = {\n  timeout: 30_000,\n  retries: 3,\n};\n',
    ours: 'export const LIMITS = {\n  timeout: 60_000,\n  retries: 3,\n};\n',
    theirs: 'foo(\nexport const LIMITS = {\n  timeout: 45_000,\n  retries: 3,\n};\n',
    original:
      'foo(\nexport const LIMITS = {\n<<<<<<< feature\n  timeout: 60_000,\n||||||| ancestor\n  timeout: 30_000,\n=======\n  timeout: 45_000,\n>>>>>>> main\n  retries: 3,\n};\n',
  };
  const remembered = (text: string) => verifyProposals({ ...sides, proposals: [{ source: 'rerere', text }] }, analyse);
  const own = await remembered('  timeout: 60_000,\n');
  assert.equal(own.merged, true, own.note);
  assert.equal(own.note, 'Main doesn’t parse; the proposal adds no parse errors of its own.');
  for (const text of ['  timeout: 60_000 45_000,\n', '  timeout: 50_000,\n', '  timeout: 60_000\n'])
    assert.equal((await remembered(text)).merged, false, text);
  // main closes the function early with a stray `}`; a resolution that leaves `if (...) {` open makes the file parse
  // again. It changed how the file parses, so it is not Merged.
  const wrap = (pre: string, body: string) =>
    `export function run(a: boolean) {\n${pre}  const limit = 30;\n${body}  return limit;\n}\n`;
  const b = '  if (a) {\n    go(1);\n  }\n';
  const o = '  if (a || b) {\n    go(1);\n  }\n';
  const t = '  if (a) {\n    go(3);\n  }\n';
  const stray = {
    path: 'src/run.ts',
    base: wrap('', b),
    ours: wrap('', o),
    theirs: wrap('  }\n', t),
    original: wrap('  }\n', `<<<<<<< feature\n${o}||||||| ancestor\n${b}=======\n${t}>>>>>>> main\n`),
  };
  const reopened = await verifyProposals(
    { ...stray, proposals: [{ source: 'rerere', text: '  if (a || b) {\n' }] },
    analyse
  );
  assert.equal(reopened.merged, false, reopened.note);
});

void test('an insertion next to the other side’s change of several lines is Check, either way round', () => {
  const block = {
    base: '    one();\n',
    ours: '    one(1);\n  }\n  if (b) {\n    two();\n',
    theirs: '    one();\n    x();\n',
  };
  assert.equal(accountLines(block, '    one(1);\n  }\n  if (b) {\n    two();\n    x();\n', false), SAME_LINES);
  assert.equal(accountLines(block, '    one(1);\n    x();\n  }\n  if (b) {\n    two();\n', false), SAME_LINES);
});

void test('since #476: both sides inserting at one place is never Merged on the line checks', () => {
  // After run() inside `if (ok)`, the PR adds log() and main adds an else branch. In main-first order, log() lands in
  // the else; in PR-first order the merge is right. Neither passes the line checks alone.
  const block = {
    base: '    run();\n',
    ours: '    run();\n    log();\n',
    theirs: '    run();\n  } else {\n    skip();\n',
  };
  for (const result of [
    '    run();\n  } else {\n    skip();\n    log();\n',
    '    run();\n    log();\n  } else {\n    skip();\n',
  ])
    assert.equal(accountLines(block, result, false), SAME_LINES, result);
});

void test('with one side broken, a result that loses that side’s error fails every proposal that isn’t a side’s lines', async () => {
  // main leaves a stray `}`; the PR opens a block that closes there. With the PR's lines the file parses, so only main's
  // filling says what main's error is, and the result no longer has it.
  const sides = {
    path: 'src/run.ts',
    base: 'export function run() {\n  a();\n  b();\n  d();\n  c();\n}\n',
    ours: 'export function run() {\n  {\n  a(1);\n  b();\n  }\n  d();\n  c(1);\n}\n',
    theirs: 'export function run() {\n  a(2);\n  b();\n  }\n  d();\n  c(2);\n}\n',
    original:
      'export function run() {\n<<<<<<< feature\n  {\n  a(1);\n||||||| ancestor\n  a();\n=======\n  a(2);\n>>>>>>> main\n  b();\n  }\n  d();\n<<<<<<< feature\n  c(1);\n||||||| ancestor\n  c();\n=======\n  c(2);\n>>>>>>> main\n}\n',
  };
  const verdict = await verifyProposals(
    {
      ...sides,
      proposals: [
        { source: 'rerere', text: '  {\n  a(1);\n' },
        { source: 'rerere', text: '  c(1, 2);\n' },
      ],
    },
    analyse
  );
  const [first, second] = verdict.blocks ?? [];
  assert.ok(first);
  assert.equal(first.merged, true, 'The PR’s lines exactly');
  assert.notEqual(first.note, 'Main doesn’t parse; the proposal adds no parse errors of its own.');
  assert.deepEqual(second, {
    merged: false,
    note: 'Main doesn’t parse here, and with the proposal the file parses differently. Check it.',
  });
});

/** One conflict where both sides inserted at one place, between `head` and `tail`, checked with a structural merge. */
const samePlace = (path: string, head: string, tail: string, ours: string, theirs: string, text: string) =>
  verifyProposals(
    {
      path,
      base: head + tail,
      ours: head + ours + tail,
      theirs: head + theirs + tail,
      original: `${head}<<<<<<< feature\n${ours}||||||| ancestor\n=======\n${theirs}>>>>>>> main\n${tail}`,
      proposals: [{ source: 'mergiraf', text }],
    },
    analyse
  );

void test('#476: both sides adding order-free members or imports at one place can be Merged, on the syntax trees’ word', async () => {
  const head = 'export class Cart {\n  total() {\n    return 0;\n  }\n';
  const tail = '}\n';
  const add = '  add(item: string) {\n    return item;\n  }\n';
  const remove = '  remove(id: number) {\n    return id;\n  }\n';
  const cart = (ours: string, theirs: string, text: string) => samePlace('src/cart.ts', head, tail, ours, theirs, text);
  // Two methods in one class: Merged, either side first.
  for (const text of [add + remove, remove + add]) {
    const verdict = await cart(add, remove, text);
    assert.equal(verdict.merged, true, verdict.note);
    assert.match(verdict.note, /different members here, and their order doesn’t matter/);
  }
  // One side's method inside the other's body: Check.
  const inside = '  add(item: string) {\n  remove(id: number) {\n    return id;\n  }\n    return item;\n  }\n';
  assert.equal((await cart(add, remove, inside)).merged, false);
  // A method beside a field (its initializer runs in order): Check.
  assert.equal((await cart(add, '  count = 0;\n', add + '  count = 0;\n')).merged, false);
  // A decorated method: Check.
  const memo = '  @memo\n  remove(id: number) {\n    return id;\n  }\n';
  assert.equal((await cart(add, memo, add + memo)).merged, false);
  // The same method name on both sides: Check.
  const again = '  add(id: number) {\n    return id;\n  }\n';
  assert.equal((await cart(add, again, add + again)).merged, false);
  // Statements in a function body: Check.
  const body = (text: string) =>
    samePlace('src/run.ts', 'export function run() {\n  start();\n', '}\n', '  log();\n', '  stop();\n', text);
  assert.equal((await body('  log();\n  stop();\n')).merged, false);
  // TypeScript imports run module code in order: Check.
  const ts = await samePlace(
    'src/index.ts',
    "import { a } from './a';\n",
    '\nexport const x = 1;\n',
    "import { b } from './b';\n",
    "import { c } from './c';\n",
    "import { b } from './b';\nimport { c } from './c';\n"
  );
  assert.equal(ts.merged, false);
  // Go imports: Merged.
  const go = await samePlace(
    'main.go',
    'package main\n\nimport (\n\t"fmt"\n',
    ')\n\nfunc main() {\n\tfmt.Println(os.Args, strings.ToUpper(""))\n}\n',
    '\t"os"\n',
    '\t"strings"\n',
    '\t"os"\n\t"strings"\n'
  );
  assert.equal(go.merged, true, go.note);
  assert.match(go.note, /different imports here/);
  // Fields of any kind: Check. Layout, derived ordering, serialization and positional literals follow their order.
  const struct = (ours: string, theirs: string) =>
    samePlace('options.go', 'package lab\n\ntype Options struct {\n\tWidth int\n', '}\n', ours, theirs, ours + theirs);
  assert.equal((await struct('\tDepth int\n', '\tWeight int\n')).merged, false);
  const rust = await samePlace(
    'options.rs',
    '#[derive(PartialOrd)]\nstruct Options {\n    width: u32,\n',
    '}\n',
    '    depth: u32,\n',
    '    weight: u32,\n',
    '    depth: u32,\n    weight: u32,\n'
  );
  assert.equal(rust.merged, false);
  const java = (ours: string, theirs: string) =>
    samePlace('Options.java', 'class Options {\n  int width;\n', '}\n', ours, theirs, ours + theirs);
  assert.equal((await java('  int depth;\n', '  int weight;\n')).merged, false);
  const method = (name: string) => `  void ${name}() {\n  }\n`;
  assert.equal((await java(method('grow'), method('shrink'))).merged, true);
  assert.equal((await java(method('grow'), `  @Override\n${method('shrink')}`)).merged, false, 'Annotated');
  // TypeScript interface members are types only: Merged.
  const shape = await samePlace(
    'src/options.ts',
    'export interface Options {\n  width: number;\n',
    '}\n',
    '  depth: number;\n',
    '  weight: number;\n',
    '  depth: number;\n  weight: number;\n'
  );
  assert.equal(shape.merged, true, shape.note);
  // A method named by a string, a number or a computed key, or a getter: Check. `'add'() {}` and `add() {}` are one name.
  for (const spelled of [
    "  'remove'(id: number) {\n    return id;\n  }\n",
    '  [Symbol.iterator]() {\n    return [][Symbol.iterator]();\n  }\n',
    '  get size() {\n    return 0;\n  }\n',
  ])
    assert.equal((await cart(add, spelled, add + spelled)).merged, false, spelled);
  assert.equal(
    (
      await cart(
        add,
        "  'add'(id: number) {\n    return id;\n  }\n",
        add + "  'add'(id: number) {\n    return id;\n  }\n"
      )
    ).merged,
    false
  );
  // Python: default values and annotations run when `def` runs, in order; postponed annotations don't.
  const py = (ours: string, theirs: string, head = '') =>
    samePlace(
      'lab/cart.py',
      `${head}class Cart:\n    def total(self):\n        return 0\n`,
      '',
      ours,
      theirs,
      ours + theirs
    );
  const plain = '\n    def add(self, item):\n        return item\n';
  const other = '\n    def remove(self, id):\n        return id\n';
  assert.equal((await py(plain, other)).merged, true);
  assert.equal((await py(plain, '\n    def remove(self, id=log("x")):\n        return id\n')).merged, false);
  const typed = '\n    def remove(self, id: Id) -> Id:\n        return id\n';
  assert.equal((await py(plain, typed)).merged, false);
  // Postponed annotations are no exception: a `__future__` line inside a docstring postpones nothing.
  assert.equal((await py(plain, typed, '"""Notes.\n\nfrom __future__ import annotations\n"""\n\n')).merged, false);
  assert.equal((await py(plain, typed, 'from __future__ import annotations\n\n')).merged, false);
  // A `__name` is mangled with its class: `__helper` in Cart is `_Cart__helper`.
  const mangled = '\n    def __helper(self):\n        return 1\n';
  const spelledOut = '\n    def _Cart__helper(self):\n        return 2\n';
  assert.equal((await py(mangled, spelledOut)).merged, false);
  assert.equal((await py(plain, spelledOut)).merged, false);
  // A blank line inside a docstring is the docstring's text: the result must keep it.
  const doc = '\n    def add(self, item):\n        """Add.\n\n        More."""\n        return item\n';
  const docResult = (doc + other).replace('Add.\n\n', 'Add.\n');
  assert.equal(
    (await samePlace('lab/cart.py', 'class Cart:\n    def total(self):\n        return 0\n', '', doc, other, docResult))
      .merged,
    false
  );
  // A decorator or attribute just above the insertion point attaches to whichever node comes first there.
  const above = await samePlace(
    'src/cart.ts',
    `${head}  @memo\n`,
    '  later() {\n    return 1;\n  }\n}\n',
    add,
    remove,
    add + remove
  );
  assert.equal(above.merged, false);
  const cfg = await samePlace(
    'cart.rs',
    'struct Cart;\nimpl Cart {\n    fn total(&self) -> u32 {\n        0\n    }\n    #[cfg(test)]\n',
    '    fn later(&self) -> u32 {\n        1\n    }\n}\n',
    '    fn add(&self) -> u32 {\n        2\n    }\n',
    '    fn remove(&self) -> u32 {\n        3\n    }\n',
    '    fn add(&self) -> u32 {\n        2\n    }\n    fn remove(&self) -> u32 {\n        3\n    }\n'
  );
  assert.equal(cfg.merged, false);
  const impl = await samePlace(
    'cart.rs',
    'struct Cart;\nimpl Cart {\n    fn total(&self) -> u32 {\n        0\n    }\n',
    '}\n',
    '    fn add(&self) -> u32 {\n        2\n    }\n',
    '    fn remove(&self) -> u32 {\n        3\n    }\n',
    '    fn add(&self) -> u32 {\n        2\n    }\n    fn remove(&self) -> u32 {\n        3\n    }\n'
  );
  assert.equal(impl.merged, true, impl.note);
  // Go: an import beside a function is two kinds; plain functions are not order-free; methods are.
  const goFile = (ours: string, theirs: string) =>
    samePlace('lab/lab.go', 'package lab\n\nimport "fmt"\n', '\nvar _ = fmt.Sprint\n', ours, theirs, ours + theirs);
  assert.equal((await goFile('import "os"\n', 'func helper() {}\n')).merged, false);
  assert.equal((await goFile('func a() {}\n', 'func b() {}\n')).merged, false);
  assert.equal((await goFile('func (t T) A() {}\n', 'func (t T) B() {}\n')).merged, true);
  // C#: `global using`, `using static` and aliases change names elsewhere; plain usings are order-free.
  const usings = (ours: string, theirs: string) =>
    samePlace('Program.cs', 'using System;\n', '\nclass P {}\n', ours, theirs, ours + theirs);
  assert.equal((await usings('using System.Linq;\n', 'using System.Text;\n')).merged, true);
  for (const odd of ['global using System.Text;\n', 'using static System.Math;\n', 'using Text = System.Text;\n'])
    assert.equal((await usings('using System.Linq;\n', odd)).merged, false, odd);
  // The if (ok) / else case: statements, so still Check.
  const ok = await samePlace(
    'src/run.ts',
    'export function run(ok: boolean) {\n  if (ok) {\n    run();\n',
    '  }\n}\n',
    '    log();\n',
    '  } else {\n    skip();\n',
    '    log();\n  } else {\n    skip();\n'
  );
  assert.equal(ok.merged, false);
});

void test('#476: package.json dependency lists are order-free; other JSON keys and every enum are Check', async () => {
  const pkg = (owner: string, path = 'package.json') =>
    samePlace(
      path,
      `{\n  "${owner}": {\n    "a": "1",\n`,
      '    "z": "26"\n  }\n}\n',
      '    "b": "2",\n',
      '    "c": "3",\n',
      '    "b": "2",\n    "c": "3",\n'
    );
  for (const owner of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const verdict = await pkg(owner);
    assert.equal(verdict.merged, true, `${owner}: ${verdict.note}`);
  }
  // Scripts (run-s globs), exports, any other file's keys (jest's moduleNameMapper matches in order): Check.
  assert.equal((await pkg('scripts')).merged, false);
  assert.equal((await pkg('exports')).merged, false);
  assert.equal((await pkg('moduleNameMapper', 'jest.config.json')).merged, false);
  assert.equal((await pkg('dependencies', 'config.json')).merged, false);
  // The same package on both sides, or one the list already has: Check.
  const twice = await samePlace(
    'package.json',
    '{\n  "dependencies": {\n    "a": "1",\n',
    '    "z": "26"\n  }\n}\n',
    '    "b": "2",\n',
    '    "z": "3",\n',
    '    "b": "2",\n    "z": "3",\n'
  );
  assert.equal(twice.merged, false);
  // Appended at the end: both sides add the comma to the last key, the same change.
  const end = await verifyProposals(
    {
      path: 'package.json',
      base: '{\n  "dependencies": {\n    "a": "1"\n  }\n}\n',
      ours: '{\n  "dependencies": {\n    "a": "1",\n    "b": "2"\n  }\n}\n',
      theirs: '{\n  "dependencies": {\n    "a": "1",\n    "c": "3"\n  }\n}\n',
      original:
        '{\n  "dependencies": {\n<<<<<<< feature\n    "a": "1",\n    "b": "2"\n||||||| ancestor\n    "a": "1"\n=======\n    "a": "1",\n    "c": "3"\n>>>>>>> main\n  }\n}\n',
      proposals: [{ source: 'mergiraf', text: '    "a": "1",\n    "b": "2",\n    "c": "3"\n' }],
    },
    analyse
  );
  assert.equal(end.merged, true, end.note);
  // YAML keys: Check.
  const yaml = await samePlace('ci.yml', 'jobs:\n  a: 1\n', '  z: 26\n', '  b: 2\n', '  c: 3\n', '  b: 2\n  c: 3\n');
  assert.equal(yaml.merged, false);
  // Enums, even with explicit values, numbers or strings: Check.
  const tsEnum = (ours: string, theirs: string) =>
    samePlace('src/color.ts', "export enum Color {\n  Red = 'red',\n", '}\n', ours, theirs, ours + theirs);
  assert.equal((await tsEnum("  Green = 'green',\n", "  Blue = 'blue',\n")).merged, false);
  assert.equal((await tsEnum('  Green = 2,\n', '  Blue = 3,\n')).merged, false);
  const cs = await samePlace(
    'Color.cs',
    'enum Color\n{\n    Red = 1,\n',
    '}\n',
    '    Green = 2,\n',
    '    Blue = 3,\n',
    '    Green = 2,\n    Blue = 3,\n'
  );
  assert.equal(cs.merged, false);
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
    note: 'Structural merge moved lines outside the conflict. The proposal parses and keeps every change from both sides. Read it, then use it.',
  });
  // The note names what wrote the whole-file proposal, never Mergiraf for another source.
  const other = await verifyWholeFile(sides, { source: 'rerere', text: [fn('beta'), fn('alpha', 'value + 10')].join('\n') }, analyse);
  assert.match(other.note, /^Gnosis’s rule moved lines outside the conflict\./);
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
    note: 'alpha in the proposal doesn’t match main’s change to it. Read it before you use it, or resolve conflict by conflict.',
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

void test('a definition both sides changed is never called verified, and lines both sides added count twice', async () => {
  const fn = (name: string, total = 'value + 1', back = 'total * 2') =>
    `function ${name}(value) {\n  const total = ${total};\n  return ${back};\n}\n`;
  // Review probe: the PR moves alpha and edits its return; main edits its first line. The edits can be swapped
  // between alpha and beta and every line is still there.
  const sides = {
    path: 'src/order.js',
    base: [fn('alpha'), fn('beta')].join('\n'),
    ours: [fn('beta'), fn('alpha', 'value + 1', 'total * 20')].join('\n'),
    theirs: [fn('alpha', 'value + 10'), fn('beta')].join('\n'),
  };
  const swapped = [fn('beta', 'value + 10'), fn('alpha', 'value + 1', 'total * 20')].join('\n');
  const verdict = await verifyWholeFile(sides, merged(swapped), analyse);
  assert.deepEqual(verdict, {
    merged: false,
    note: 'Both sides changed alpha. Check it yourself. Read it before you use it, or resolve conflict by conflict.',
  });
  const whole = file([], { proposals: undefined, wholeFile: merged(swapped) });
  assert.deepEqual(blockBuckets(whole, original, verdict), ['decide', 'decide'], 'The conflicts stay in view');
  assert.equal(proposalReady(whole, original, blockBuckets(whole, original, verdict)), false, 'No Proposal ready');
  const passed = { merged: false, passed: true, note: '' };
  assert.equal(proposalReady(whole, original, blockBuckets(whole, original, passed)), true);
  // Review probe: each side adds a function after a move. Its closing brace is new on both sides, so it is there twice.
  const added = {
    path: 'src/order.js',
    base: [fn('alpha'), fn('beta')].join('\n'),
    ours: [fn('beta'), fn('alpha'), fn('gamma')].join('\n'),
    theirs: [fn('alpha', 'value + 10'), fn('beta'), fn('delta')].join('\n'),
  };
  const right = [fn('beta'), fn('alpha', 'value + 10'), fn('gamma'), fn('delta')].join('\n');
  assert.equal(accountWholeFile(added, right, false), undefined);
  assert.equal((await verifyWholeFile(added, merged(right), analyse)).passed, true);
});

void test('one file status for the file list, the header, the footer and the summary', () => {
  const ok = { merged: true, note: '' };
  const check = { merged: false, note: 'x' };
  const passed = { merged: false, passed: true, note: '' };
  const status = (f: ConflictFile, draft: string, verdict: typeof check | undefined) => {
    const buckets = blockBuckets(f, draft, verdict);
    const value = fileStatus(f, draft, conflictFileStage(f, draft), buckets);
    return { value, parts: fileStatusParts(value).map((p) => `${p.tone}:${p.text}`), line: fileStatusLine(value) };
  };
  // Merged only: both conflicts merged and checked, and the file still waits for Mark reviewed.
  const both = file([merged(imports), merged(three + four)]);
  assert.deepEqual(status(both, both.result, ok), {
    value: { kind: 'buckets', decide: 0, check: 0, merged: 2 },
    parts: ['merged:2 merged'],
    line: undefined,
  });
  // Check: no markers are left, but proposals wait to be read. Never "Resolved · needs review" (#99).
  assert.deepEqual(status(both, both.result, check), {
    value: { kind: 'buckets', decide: 0, check: 2, merged: 0 },
    parts: ['check:2 to check'],
    line: undefined,
  });
  // Decide beside Check.
  const one = file([merged(imports), null]);
  assert.deepEqual(status(one, one.result, check).parts, ['decide:1 to decide', 'check:1 to check']);
  // Your own choice for every conflict: only now does the file wait for Mark reviewed.
  const chosen = parseConflicts(original)
    .map((s) => (s.kind === 'text' ? s.text : s.block.ours))
    .join('');
  assert.deepEqual(status(one, chosen, check), {
    value: { kind: 'resolved' },
    parts: ['resolved:Resolved · needs review'],
    line: undefined,
  });
  // Reviewed: the saved result is marked resolved, whatever its buckets.
  assert.deepEqual(status({ ...one, result: chosen, resolved: true }, chosen, check).value, { kind: 'reviewed' });
  assert.deepEqual(status({ ...both, resolved: true }, both.result, check).value, { kind: 'reviewed' });
  // A whole-file proposal: Proposal ready, then Resolved once you use it.
  const whole = file([], { proposals: undefined, wholeFile: merged(ours), result: original });
  assert.deepEqual(status(whole, original, passed), {
    value: { kind: 'proposal' },
    parts: ['proposal:Whole file to check'],
    line: undefined,
  });
  assert.deepEqual(status(whole, ours, passed).value, { kind: 'resolved' }, 'After Use the proposal for this file');
  // One that failed its checks: its conflicts are to decide.
  assert.deepEqual(status(whole, original, check).parts, ['decide:2 to decide']);
  assert.deepEqual(fileStatus({ ...whole, unsupported: 'Binary file' }, original, 'conflicted', ['decide']), {
    kind: 'unsupported',
  });
  // Conflict markers and no bucket to show: the count of conflicts.
  assert.deepEqual(fileStatusParts(fileStatus(file([]), original, 'conflicted', [])), [
    { tone: 'conflicted', text: '2 conflicts' },
  ]);
  // The summary uses the file list's words.
  const summary = bucketSummary([{ buckets: blockBuckets(both, both.result, check), verdict: check, reviewed: false }]);
  assert.equal(summarySentence(summary), '1 file has conflicts. 2 to check.');
});

/** The user's case (oddur/gnosis-conflict-lab #99): the PR reformats a call, main changes one argument. */
const csharp = (call: string) =>
  `public static class Lab\n{\n    public static int alpha(int value)\n    {\n        var total = value + 1;\n${call}    }\n}\n`;
const oneLine = (last: string) => `        return combine(value, total, value * 2, ${last});\n`;
const split = (last: string, total = 'total') =>
  `        return combine(\n            value,\n            ${total},\n            value * 2,\n            ${last}\n        );\n`;
const reformatFile = (oursCall: string, theirsCall: string, proposal: string): ConflictFile => {
  const [head, tail] = csharp('@').split('@');
  return {
    path: 'lab/reformat-vs-edit.cs',
    mode: '100644',
    base: csharp(oneLine('4')),
    ours: csharp(oursCall),
    theirs: csharp(theirsCall),
    original: `${head}<<<<<<< feature\n${oursCall}||||||| ancestor\n${oneLine('4')}=======\n${theirsCall}>>>>>>> main\n${tail}`,
    result: csharp(proposal),
    resolved: false,
    source: 'mergiraf',
    proposals: [merged(proposal)],
  };
};
const equivalent: Equivalent = (language, before, after) => engine.equivalent(language, before, after);

void test('a side that only reformatted the lines the other side changed: Merged only when the tree is right', async () => {
  // The PR's layout with main's argument: the same program as main's, laid out as the PR's.
  const right = reformatFile(split('4'), oneLine('5'), split('5'));
  assert.deepEqual(await verifyProposals(right, analyse, false, equivalent), {
    merged: true,
    note: 'The PR only reformatted these lines and main changed them; the proposal keeps main’s change in the PR’s formatting. The file parses.',
  });
  // Main reformatted and the PR changed the argument: the same, the other way round.
  const mirrored = await verifyProposals(
    reformatFile(oneLine('5'), split('4'), split('5')),
    analyse,
    false,
    equivalent
  );
  assert.equal(mirrored.merged, true);
  assert.match(
    mirrored.note,
    /^Main only reformatted these lines and the PR changed them; the proposal keeps the PR’s change in main’s formatting\./
  );
  // Without the formatting comparison, it stays in Check, with a reason that fits a combined proposal.
  assert.deepEqual(await verifyProposals(right, analyse), { merged: false, note: SAME_LINES });
  // Main's change is lost.
  assert.deepEqual(
    await verifyProposals(reformatFile(split('4'), oneLine('5'), split('4')), analyse, false, equivalent),
    {
      merged: false,
      note: 'The PR only reformatted these lines and main changed them. The proposal doesn’t match main’s change. Check it.',
    }
  );
  // The right program in main's layout: not the PR's formatting, so Check.
  assert.deepEqual(
    await verifyProposals(reformatFile(split('4'), oneLine('5'), oneLine('5')), analyse, false, equivalent),
    {
      merged: false,
      note: 'The PR only reformatted these lines and main changed them. The proposal keeps main’s change, but not in the PR’s layout. Check it.',
    }
  );
  // Trap: the "formatting" side also changed a token. Both sides changed the code, so nothing is Merged, whatever the
  // proposal says.
  for (const proposal of [split('5', 'total + 1'), split('5'), split('4', 'total + 1')]) {
    const trap = reformatFile(split('4', 'total + 1'), oneLine('5'), proposal);
    assert.deepEqual(
      await verifyProposals(trap, analyse, false, equivalent),
      { merged: false, note: SAME_LINES },
      proposal
    );
  }
  // A comparison that fails (the language is off) keeps it in Check.
  const failing: Equivalent = () => Promise.reject(new Error('This language is off in Settings'));
  assert.deepEqual(await verifyProposals(right, analyse, false, failing), { merged: false, note: SAME_LINES });
});

/** Review probes (#454): the formatting side's reformat must survive in the result, not only its line count. */
const greet = (call: string) =>
  `export function hello(name: string) {\n  const prefix = 'Hello';\n  ${call}\n}\n\nexport function bye() {\n  return 'bye';\n}\n`;
const greetFile = (oursCall: string, proposal: string): ConflictFile => {
  const [head, tail] = greet('@').split('  @\n');
  const line = (call: string) => `  ${call}\n`;
  const [base, theirs] = ["return greet(prefix, 'hi', 4);", "return greet(prefix, 'hi', 5);"];
  return {
    path: 'src/greet.ts',
    mode: '100644',
    base: greet(base),
    ours: greet(oursCall),
    theirs: greet(theirs),
    original: `${head}<<<<<<< feature\n${line(oursCall)}||||||| ancestor\n${line(base)}=======\n${line(theirs)}>>>>>>> main\n${tail}`,
    result: greet(proposal),
    resolved: false,
    source: 'mergiraf',
    proposals: [merged(line(proposal))],
  };
};

void test('the reformatting side’s quotes and spacing must survive: a matching line count is not enough', async () => {
  const layout =
    'The PR only reformatted these lines and main changed them. The proposal keeps main’s change, but not in the PR’s layout. Check it.';
  // Quotes: the PR's double quotes with main's argument is Merged; main's line word for word is not.
  const quotes = 'return greet(prefix, "hi", 4);';
  assert.equal(
    (await verifyProposals(greetFile(quotes, 'return greet(prefix, "hi", 5);'), analyse, false, equivalent)).merged,
    true
  );
  assert.deepEqual(
    await verifyProposals(greetFile(quotes, "return greet(prefix, 'hi', 5);"), analyse, false, equivalent),
    {
      merged: false,
      note: layout,
    }
  );
  // Spacing inside one line: the line count, and the whitespace-blind line accounting, can't tell.
  const spaced = "return greet( prefix, 'hi', 4 );";
  for (const proposal of ["return greet(prefix, 'hi', 5);", "return greet( prefix, 'hi', 5);"])
    assert.deepEqual(
      await verifyProposals(greetFile(spaced, proposal), analyse, false, equivalent),
      { merged: false, note: layout },
      proposal
    );
  assert.equal(
    (await verifyProposals(greetFile(spaced, "return greet( prefix, 'hi', 5 );"), analyse, false, equivalent)).merged,
    true
  );
  // Without the formatting comparison, a spacing-only side is still two changes to the same lines: Check.
  assert.deepEqual(await verifyProposals(greetFile(spaced, "return greet(prefix, 'hi', 5);"), analyse), {
    merged: false,
    note: SAME_LINES,
  });
  // The layout check on its own: main's token change, with its spaces, applied to the PR's text and nothing else.
  const block = { base: 'f(a, 4)', edited: 'f(a, 5)', formatted: 'f( a, 4 )' };
  assert.equal(keepsLayout(block, 'f( a, 5 )'), true);
  assert.equal(keepsLayout(block, 'f(a, 5)'), false);
  assert.equal(keepsLayout(block, 'f( a,5 )'), false);
  assert.equal(
    keepsLayout({ base: 'f(a)', edited: 'f(a or 30)', formatted: 'f(\n  a,\n)' }, 'f(\n  a or 30,\n)'),
    true
  );
});

void test('a stray marker line is named, every ======= line is a marker, and a reviewed file needs nothing', () => {
  // One strict predicate: every line of `=======` is a marker, in every file. A Markdown setext heading's underline
  // too: the file says "Conflict marker left" instead of "0 conflicts", and nothing is pushed until it changes.
  const status = (f: ConflictFile, draft: string) =>
    fileStatusParts(fileStatus(f, draft, conflictFileStage(f, draft), blockBuckets(f, draft, undefined)));
  const markerLeft = [{ tone: 'conflicted', text: 'Conflict marker left' }];
  const readme = (heading: string, body: string) => `${heading}\n=======\n\n${body}\n`;
  const md: ConflictFile = {
    ...file([]),
    path: 'README.md',
    base: readme('Usage', 'Run it.'),
    ours: readme('Usage', 'Run it with npm.'),
    theirs: readme('Usage', 'Run it with node.'),
    // Review probe (#454): the PR's lines end with the heading, so Git's separator sits right under it.
    original: '<<<<<<< feature\nUsage\n||||||| ancestor\nUsage\n=======\nGuide\n>>>>>>> main\n=======\n\nRun it.\n',
    proposals: undefined,
  };
  const heading = readme('Usage', 'Run it with npm and node.');
  assert.equal(hasConflictMarkers(heading), true);
  assert.equal(conflictFileStage({ ...md, result: heading }, heading), 'conflicted');
  assert.deepEqual(status(md, heading), markerLeft, 'A setext heading shows Conflict marker left');
  // The reviewer's case: only the opening, ancestor and closing lines removed. Git's separator under the PR's heading
  // is a marker, so Mark reviewed and the push stay blocked (they use the same predicate).
  const separator = 'Usage\nUsage\n=======\nGuide\n=======\n\nRun it.\n';
  assert.equal(hasConflictMarkers(separator), true);
  assert.equal(conflictFileStage({ ...md, result: separator, resolved: true }, separator), 'conflicted');
  assert.deepEqual(status(md, separator), markerLeft);
  // In a .ts file, a leftover `=======` between both sides is the same.
  const ts = file([merged(imports), merged(three + four)]);
  const leftover = `${ts.result}export const a = 1;\n=======\nexport const a = 2;\n`;
  assert.deepEqual(status(ts, leftover), markerLeft);
  // A file with a marker left needs you: the summary never says "Nothing needs you." beside it.
  const markerSummary = bucketSummary([
    { buckets: blockBuckets(ts, leftover, undefined), verdict: undefined, reviewed: false, marker: true },
    { buckets: ['merged'], verdict: { merged: true, note: '' }, reviewed: true },
  ]);
  assert.equal(markerSummary.needs, 1);
  assert.equal(
    summarySentence(markerSummary),
    '2 files have conflicts. 1 of 3 conflicts are merged and checked. 1 file with a conflict marker left.'
  );
  assert.equal(
    summarySentence(
      bucketSummary([
        { buckets: [], verdict: undefined, reviewed: false, marker: true },
        { buckets: ['decide'], verdict: undefined, reviewed: false },
      ])
    ),
    '2 files have conflicts. 2 need you: 1 to decide, 1 file with a conflict marker left.'
  );
  assert.equal(hasConflictMarkers('a\n>>>>>>> main\n'), true);
  assert.equal(hasConflictMarkers('a\n||||||| ancestor\n'), true);
  // A marker line outside any whole conflict: no "0 conflicts".
  const stray = file([merged(imports), merged(three + four)]);
  const draft = `${stray.result}>>>>>>> main\n`;
  const strayStatus = fileStatus(stray, draft, conflictFileStage(stray, draft), blockBuckets(stray, draft, undefined));
  assert.deepEqual(strayStatus, { kind: 'marker' });
  assert.deepEqual(fileStatusParts(strayStatus), [{ tone: 'conflicted', text: 'Conflict marker left' }]);
  assert.equal(fileStatusLine(strayStatus), 'A conflict marker is left in the file. Check the result');
  // A reviewed file adds nothing to what needs you, even with conflicts to decide or check left in its buckets.
  const summary = bucketSummary([
    { buckets: ['decide', 'check', 'merged'], verdict: undefined, reviewed: true },
    { buckets: ['decide'], verdict: undefined, reviewed: false },
  ]);
  assert.deepEqual(
    { needs: summary.needs, decide: summary.decide, checking: summary.checking, merged: summary.merged },
    { needs: 1, decide: 1, checking: 0, merged: 1 }
  );
  assert.equal(
    summarySentence(summary),
    '2 files have conflicts. 1 of 4 conflicts are merged and checked. 1 to decide.'
  );
});

void test('a Keep choice is yours even when its text equals the proposal', () => {
  // The imports proposal is both sides; the functions proposal is the PR side, which drops main's function: Check.
  const f = file([merged(imports), merged(three)]);
  const check = { merged: false, passed: false, note: 'four is missing' };
  assert.deepEqual(blockBuckets(f, f.result, check), ['check', 'check']);
  // Keep both on the first and Keep PR change on the second give the proposals' own text: the draft is unchanged.
  const picks = ['both', 'ours'] as const;
  assert.deepEqual(blockBuckets(f, f.result, check, picks), ['decided', 'decided']);
  assert.deepEqual(conflictModel(f.original, f.result, f.proposals, picks).choices, ['both', 'ours']);
  // A pick whose text is not the block's text never stands in for the proposal.
  assert.deepEqual(blockBuckets(f, f.result, check, ['theirs', 'theirs']), ['check', 'check']);
  // Merged proposals too: Undo, then Keep both, is a choice you made.
  const both = file([merged(imports), merged(three + four)]);
  const ok = { merged: true, passed: true, note: '' };
  assert.deepEqual(blockBuckets(both, both.result, ok), ['merged', 'merged']);
  assert.deepEqual(blockBuckets(both, both.result, ok, ['both']), ['decided', 'merged']);
  // Keep both where one side is empty reads as the other side's text; it is still Keep both.
  const empty = '<<<<<<< feature\n||||||| ancestor\na\n=======\nb\n>>>>>>> main\n';
  assert.deepEqual(conflictModel(empty, 'b\n').choices, ['theirs']);
  assert.deepEqual(conflictModel(empty, 'b\n', undefined, ['both']).choices, ['both']);
  // The original conflict back in place: picks have nothing to stand in for, and each proposal waits on its card.
  assert.deepEqual(blockBuckets(both, both.original, ok, ['both', 'both']), ['check', 'check']);
});

void test('the summary says what is left: review, a local merge tool, or nothing', () => {
  const f = file([merged(imports), merged(three + four)]);
  const ok = { merged: true, passed: true, note: '' };
  const buckets = blockBuckets(f, f.result, ok);
  const status = fileStatus(f, f.result, conflictFileStage(f), buckets);
  assert.ok(allMerged(buckets));
  assert.ok(waitsForReview(status, buckets, true));
  assert.equal(waitsForReview(status, buckets, false), false, 'Reviewed for you with the setting off');
  // "Review Merged-only files myself" on: the Merged file waits for Mark reviewed, and the summary says so.
  assert.equal(
    summarySentence(bucketSummary([{ buckets, verdict: ok, reviewed: false, review: true }])),
    '1 file has conflicts. 2 of 2 conflicts are merged and checked. 1 file is ready for review.'
  );
  assert.equal(
    summarySentence(bucketSummary([{ buckets, verdict: ok, reviewed: true, review: true }])),
    '1 file has conflicts. 2 of 2 conflicts are merged and checked. Nothing needs you.'
  );
  const local = { buckets: ['decide' as const], verdict: undefined, reviewed: false, unsupported: true };
  assert.equal(
    summarySentence(bucketSummary([local, local, local])),
    '3 files have conflicts. 3 files need a local merge tool.'
  );
  assert.equal(
    summarySentence(bucketSummary([local, { buckets: ['decide'], verdict: undefined, reviewed: false }])),
    '2 files have conflicts. 2 need you: 1 to decide, 1 file needs a local merge tool.'
  );
  // The file list and the file header show the same badge for a file Gnosis can't merge.
  const unsupported = fileStatus({ ...f, unsupported: 'rename' }, '', 'conflicted', ['decide']);
  assert.deepEqual(fileStatusParts(unsupported), [{ tone: 'unsupported', text: 'Needs a local merge tool' }]);
  assert.equal(fileStatusLine(unsupported), 'Gnosis can’t merge this file. Merge the PR on your computer');
  // With several such files, the footer names them all, never "this file".
  assert.equal(fileStatusLine(unsupported, 3), 'Gnosis can’t merge these 3 files. Merge the PR on your computer');
});

void test('a choice or an edit beside a Merged conflict is never all-Merged: it is shown before Mark reviewed', () => {
  const f = file([merged(imports), merged(three + four)]);
  const ok = { merged: true, passed: true, note: '' };
  // Keep PR change on the second conflict, beside the first one Merged.
  const kept = f.result.replace(three + four, three);
  const buckets = blockBuckets(f, kept, ok);
  assert.deepEqual(buckets, ['merged', 'decided']);
  assert.equal(allMerged(buckets), false);
  const status = fileStatus(f, kept, conflictFileStage(f, kept), buckets);
  // On or off, the file waits for your review, and the summary says so instead of "Nothing needs you.".
  for (const showMerged of [true, false]) {
    const review = waitsForReview(status, buckets, showMerged);
    assert.equal(review, true);
    assert.equal(
      summarySentence(bucketSummary([{ buckets, verdict: ok, reviewed: false, review }])),
      '1 file has conflicts. 1 of 2 conflicts are merged and checked. 1 file is ready for review.'
    );
  }
  // A Keep pick equal to the proposal counts as yours too.
  const picked = blockBuckets(f, f.result, ok, [undefined, undefined]);
  assert.ok(allMerged(picked));
  assert.equal(allMerged(blockBuckets(f, f.result, ok, ['both'])), false);
  assert.equal(allMerged([]), false);
});

void test('a draft past the splitter’s limits keeps an untouched proposal in Check, waiting for you (#507 round 2)', () => {
  // Two conflicts separated by one blank line, with a 100-line tail: the splitter gives up (SPLIT_ENDS), so the draft
  // can't be told apart into its conflicts.
  const tail = '\n'.repeat(100);
  const conflictText = '<<<<<<< pr\na\n=======\nb\n>>>>>>> main\n\n<<<<<<< pr\nc\n=======\nd\n>>>>>>> main\n' + tail;
  const proposals = [null, { source: 'union' as const, text: 'c\nd\n' }];
  // You typed text in the first conflict; the second still holds its untouched, unchecked proposal.
  const draft = 'typed\n\nc\nd\n' + tail;
  const f = { original: conflictText, proposals, unsupported: undefined, wholeFile: undefined };
  assert.equal(blockResolutions(parseConflicts(conflictText), draft), undefined, 'The splitter gave up');
  assert.deepEqual(blockBuckets(f, draft, undefined), ['decided', 'check']);
  assert.deepEqual(unchosenConflicts(f, draft, undefined), [1], 'It blocks Mark reviewed and the reviewed save');
  assert.equal(withoutUnchosen({ ...f, result: draft }, undefined), undefined, 'Nothing can be stripped safely');
  assert.equal(waitingHint(f, draft, 1), UNSPLIT_HINT, 'The way back is Reset file');
  // A Merged one (or your own remembered resolution) needs no choice even here.
  assert.deepEqual(unchosenConflicts(f, draft, { merged: true, note: '', blocks: [undefined, { merged: true, note: '' }] }), []);
});
