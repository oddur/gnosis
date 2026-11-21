import assert from 'node:assert/strict';
import test from 'node:test';
import { blockResolutions, carryFile, relabelMarkers, revisionChange } from '../lib/conflict-carry';
import { parseConflicts } from '../lib/conflict-blocks';
import { describeBaseMove, describeConflictError } from '../lib/conflict-flow';
import type { ConflictFile } from '../lib/conflict-resolution';

const draft = {
  headSha: 'a'.repeat(40),
  baseSha: 'b'.repeat(40),
  headRepo: 'klang/seed',
  headBranch: 'feat/l10n-guidance-prompts',
  baseBranch: 'develop',
  baseRepo: 'klang/seed',
};
const live = { ...draft, repository: draft.baseRepo };

void test('only new PR commits or a new target block publishing; new base commits do not', () => {
  assert.equal(revisionChange(draft, live), 'none');
  assert.equal(revisionChange(draft, { ...live, baseSha: 'c'.repeat(40) }), 'base-moved');
  assert.equal(revisionChange(draft, { ...live, headSha: 'c'.repeat(40) }), 'head-moved');
  assert.equal(
    revisionChange(draft, { ...live, headSha: 'c'.repeat(40), baseSha: 'd'.repeat(40) }),
    'head-moved',
    'Someone else’s commits on the PR always win over a moved base'
  );
  assert.equal(revisionChange(draft, { ...live, headBranch: 'renamed' }), 'head-moved');
  assert.equal(revisionChange(draft, { ...live, headRepo: null }), 'head-moved');
  assert.equal(revisionChange(draft, { ...live, baseBranch: 'main' }), 'retargeted');
  assert.equal(revisionChange(draft, { ...live, repository: 'klang/other' }), 'retargeted');
});

/** Git labels markers with commit IDs; the base label changes whenever develop moves. */
const block = (ours: string, base: string, theirs: string, label = 'b'.repeat(40)) =>
  `<<<<<<< ${'a'.repeat(40)}\n${ours}||||||| ${'e'.repeat(12)}\n${base}=======\n${theirs}>>>>>>> ${label}\n`;
const file = (original: string, result = original, resolved = false): ConflictFile => ({
  path: 'src/prompts.ts',
  mode: '100644',
  base: '',
  ours: '',
  theirs: '',
  original,
  result,
  resolved,
  source: 'manual',
});

void test('unchanged conflicts reuse the user’s result even though Git’s labels changed', () => {
  const a = block('a = 1;\n', 'a = 0;\n', 'a = 2;\n');
  const b = block('b = 1;\n', 'b = 0;\n', 'b = 2;\n');
  const old = file(`head\n${a}middle\n${b}tail\n`, 'head\na = 1;\nmiddle\nb = 1;\nb = 2;\ntail\n', true);
  const moved = 'c'.repeat(40);
  const next = file(
    `head\n${block('a = 1;\n', 'a = 0;\n', 'a = 2;\n', moved)}middle changed by develop\n${block('b = 1;\n', 'b = 0;\n', 'b = 2;\n', moved)}tail\n`
  );
  const carried = carryFile(old, next, true);
  assert.equal(carried.reused, 2);
  assert.equal(carried.open, 0);
  assert.equal(carried.file.result, 'head\na = 1;\nmiddle changed by develop\nb = 1;\nb = 2;\ntail\n');
  assert.equal(carried.file.resolved, true, 'Nothing new to review: the file stays reviewed');
  assert.equal(carryFile(old, next, false).file.resolved, false, 'After new PR commits the file is reviewed again');
});

void test('a block whose text changed reopens; the others keep their results', () => {
  const old = file(
    `${block('a = 1;\n', 'a = 0;\n', 'a = 2;\n')}x\n${block('b = 1;\n', 'b = 0;\n', 'b = 2;\n')}`,
    'a = 3;\nx\nb = 1;\n',
    true
  );
  const changed = block('b = 1;\n', 'b = 0;\n', 'b = 5;\n', 'c'.repeat(40));
  const added = block('z = 1;\n', 'z = 0;\n', 'z = 2;\n', 'c'.repeat(40));
  const next = file(`${block('a = 1;\n', 'a = 0;\n', 'a = 2;\n', 'c'.repeat(40))}x\n${changed}y\n${added}`);
  const carried = carryFile(old, next, true);
  assert.equal(carried.reused, 1);
  assert.equal(carried.open, 2, 'A changed block and a brand-new block are both new conflicts');
  assert.equal(carried.file.resolved, false);
  assert.equal(carried.file.result, `a = 3;\nx\n${changed}y\n${added}`);
  // A new file has nothing to carry.
  assert.deepEqual(
    { reused: carryFile(undefined, next, true).reused, open: carryFile(undefined, next, true).open },
    { reused: 0, open: 3 }
  );
});

void test('free-text results map to their blocks; edits around the blocks need the text merge', () => {
  const original = `one\n${block('a = 1;\n', 'a = 0;\n', 'a = 2;\n')}two\n${block('b = 1;\n', 'b = 0;\n', 'b = 2;\n')}three\n`;
  const segments = parseConflicts(original);
  assert.deepEqual(blockResolutions(segments, 'one\nmerged a\nand more\ntwo\nb = 2;\nthree\n'), [
    'merged a\nand more\n',
    'b = 2;\n',
  ]);
  assert.deepEqual(blockResolutions(segments, original), [undefined, undefined], 'Open blocks have no result');
  assert.equal(blockResolutions(segments, 'ONE\nmerged\ntwo\nb\nthree\n'), undefined);
  assert.equal(carryFile(file(original, 'ONE\nmerged\ntwo\nb\nthree\n', true), file(original), true).mapped, false);
});

void test('relabelled markers let a text merge see only real changes', () => {
  const old = block('a = 1;\n', 'a = 0;\n', 'a = 2;\n');
  const next = block('a = 1;\n', 'a = 0;\n', 'a = 2;\n', 'c'.repeat(40));
  assert.equal(relabelMarkers(old, next), next);
  assert.equal(relabelMarkers('no markers\n', next), 'no markers\n');
});

void test('base-move copy says what happened in one line and names the next step', () => {
  const move = { from: 'b'.repeat(40), to: 'c'.repeat(40), conflicts: 0, files: [] };
  assert.equal(
    describeBaseMove(move, { baseBranch: 'develop', stage: 'push' }),
    'develop moved while you worked, so the merge commit includes its latest changes. Your resolutions still applied.'
  );
  assert.equal(
    describeBaseMove(move, { baseBranch: 'develop', stage: 'preview' }),
    'develop moved while you worked. Gnosis updated the merge; your resolutions still apply.'
  );
  assert.equal(
    describeBaseMove({ ...move, conflicts: 1, files: ['src/prompts.ts'] }, { baseBranch: 'develop', stage: 'push' }),
    'develop moved and brought a new conflict in src/prompts.ts. Nothing was pushed. Your other resolutions are kept.'
  );
  assert.match(
    describeBaseMove({ ...move, conflicts: 3, files: ['a', 'b'] }, { baseBranch: 'develop', stage: 'push' }),
    /brought 3 new conflicts in 2 files\./
  );
});

void test('blocked publishing names Load latest changes, the button that recovers', () => {
  const ctx = { stage: 'other' as const, headBranch: 'feat/l10n-guidance-prompts', baseBranch: 'develop' };
  const head = describeConflictError(
    "Error invoking remote method 'conflict-resolution': Error: The PR branch has new commits since you started. Nothing was pushed.",
    ctx
  );
  assert.equal(head.title, 'Someone pushed to feat/l10n-guidance-prompts after you started.');
  assert.match(head.body, /Select Load latest changes/);
  assert.equal(head.recovery, 'load-latest');
  const retarget = describeConflictError('The PR now targets a different base branch. Nothing was pushed.', ctx);
  assert.equal(retarget.recovery, 'load-latest');
  assert.match(retarget.body, /Load latest changes/);
  const moving = describeConflictError(
    'The base branch kept moving while Gnosis merged it again. Nothing was pushed.',
    { ...ctx, stage: 'push' }
  );
  assert.equal(moving.title, 'develop kept changing while Gnosis updated the merge.');
  assert.match(moving.body, /Select Push merge commit again/);
  assert.equal(moving.recovery, undefined, 'Never resend a push on the user’s behalf');
  for (const copy of [head, retarget, moving]) assert.doesNotMatch(copy.body, /Load the latest|Start over/);
});

void test('carry keeps your Keep choice on each block it reuses, and drops it only on blocks that changed', () => {
  const one = block('a\n', 'o\n', 'b\n');
  const two = block('c\n', 'p\n', 'd\n');
  const original = `x\n${one}y\n${two}z\n`;
  // You kept the PR's side on both blocks.
  const old = { ...file(original, 'x\na\ny\nc\nz\n'), picks: ['ours' as const, 'ours' as const] };
  // Main moved: block 1 is the same conflict, block 2 changed on main's side.
  const next = file(`x\n${block('a\n', 'o\n', 'b\n', 'f'.repeat(40))}y\n${block('c\n', 'p\n', 'e\n', 'f'.repeat(40))}z\n`);
  const carried = carryFile(old, next, false);
  assert.equal(carried.reused, 1);
  assert.deepEqual(carried.file.picks, ['ours', null]);
  // Nothing reused: no choices at all.
  assert.equal(carryFile({ ...old, picks: [null, null] }, next, false).file.picks, undefined);
});
