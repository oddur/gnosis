import assert from 'node:assert/strict';
import { test } from 'node:test';
import { confirmCount, confirmGroups } from '../lib/conflict-confirm';
import { blockBuckets, type Verdict } from '../lib/conflict-verify';
import type { BlockPicks } from '../lib/conflict-blocks';
import type { ConflictFile, ConflictProposal } from '../lib/conflict-resolution';

/** The push confirmation's groups (#445 item 12): You decided, Merged for you, Arriving from main. */
const original =
  '<<<<<<< pr\na = 10\n=======\na = 11\n>>>>>>> main\nb = 2\nx = 5\n<<<<<<< pr\nc = 30\n=======\nc = 31\n>>>>>>> main\n';
const ours = 'a = 10\nb = 2\nx = 0\nc = 30\n';
const merged: Verdict = { merged: true, note: 'Every check passed.' };
const check: Verdict = { merged: false, note: 'The result changes a line neither side wrote.' };
function file(result: string, proposals?: (ConflictProposal | null)[], extra: Partial<ConflictFile> = {}) {
  return {
    path: 'src/a.ts',
    mode: '100644',
    base: 'a = 1\nb = 2\nx = 0\nc = 3\n',
    ours,
    theirs: 'a = 11\nb = 2\nx = 5\nc = 31\n',
    original,
    result,
    resolved: true,
    source: 'manual',
    ...(proposals ? { proposals } : {}),
    ...extra,
  } satisfies ConflictFile;
}
const entry = (f: ConflictFile, verdict: Verdict | undefined, picks?: BlockPicks, reviewed = true) => ({
  file: f,
  buckets: blockBuckets(f, f.result, verdict, picks),
  reviewed,
  picks,
});
const proposal: (ConflictProposal | null)[] = [null, { source: 'mergiraf', text: 'c = 3031\n' }];

void test('a Keep is yours and an untouched Merged proposal is merged for you; the three diffs chain to the draft', () => {
  const f = file('a = 11\nb = 2\nx = 5\nc = 3031\n', proposal);
  const groups = confirmGroups([entry(f, merged, ['theirs'])], []);
  assert.deepEqual(groups.pending, []);
  assert.deepEqual(groups.counts, { decided: 1, merged: 1, mainFiles: 1 });
  const [main] = groups.main;
  const [decided] = groups.decided;
  const [auto] = groups.merged;
  // main's line outside the conflicts, then your Keep, then the Merged proposal.
  assert.equal(main.before, ours);
  assert.equal(main.after, 'a = 10\nb = 2\nx = 5\nc = 30\n');
  assert.equal(decided.before, main.after);
  assert.equal(decided.after, 'a = 11\nb = 2\nx = 5\nc = 30\n');
  assert.deepEqual(decided.items, [{ index: 0, how: 'theirs' }]);
  assert.deepEqual(decided.blocks, [{ index: 0, start: 1, end: 1, anchor: 1 }]);
  assert.equal(auto.before, decided.after);
  assert.equal(auto.after, f.result);
  assert.deepEqual(auto.items, [{ index: 1, how: 'merged', source: 'mergiraf' }]);
  assert.deepEqual(auto.blocks, [{ index: 1, start: 4, end: 4, anchor: 4 }]);
});

void test('a Keep whose text equals the Merged proposal is yours, never Merged', () => {
  const same: (ConflictProposal | null)[] = [{ source: 'mergiraf', text: 'a = 10\n' }, null];
  const f = file('a = 10\nb = 2\nx = 5\nc = 31\n', same);
  const groups = confirmGroups([entry(f, merged, ['ours', 'theirs'])], []);
  assert.equal(groups.counts.merged, 0);
  assert.equal(groups.counts.decided, 2);
  assert.deepEqual(
    groups.decided[0].items.map((i) => i.how),
    ['ours', 'theirs']
  );
  // Without the Keep, the same text is the proposal, and Merged.
  const untouched = confirmGroups([entry(f, merged, [undefined, 'theirs'])], []);
  assert.deepEqual(untouched.counts, { decided: 1, merged: 1, mainFiles: 1 });
});

void test('a Check proposal in a file you marked reviewed is yours', () => {
  const f = file('a = 11\nb = 2\nx = 5\nc = 3031\n', proposal);
  const groups = confirmGroups([entry(f, check, ['theirs'])], []);
  assert.equal(groups.counts.merged, 0);
  assert.deepEqual(groups.decided[0].items, [
    { index: 0, how: 'theirs' },
    { index: 1, how: 'proposal', source: 'mergiraf' },
  ]);
  assert.equal(groups.decided[0].after, f.result);
  // Checks that have not finished are not Merged either.
  assert.equal(confirmGroups([entry(f, undefined, ['theirs'])], []).counts.merged, 0);
});

void test('a whole-file proposal you used is yours as one file, with every conflict it covers', () => {
  const whole = 'a = 11\nb = 2\nx = 5\nc = 31\n// tidied\n';
  const f = file(whole, undefined, { wholeFile: { source: 'mergiraf', text: whole }, source: 'mergiraf' });
  const groups = confirmGroups([entry(f, { merged: false, passed: true, note: '' })], []);
  assert.deepEqual(groups.counts, { decided: 2, merged: 0, mainFiles: 0 });
  assert.equal(groups.decided[0].whole, 'whole-file');
  assert.equal(groups.decided[0].before, ours);
  assert.equal(groups.decided[0].after, whole);
  assert.deepEqual(groups.main, [], 'main’s lines are inside the proposal: never counted twice');
});

void test('a file edited by hand is yours, Merged proposals included', () => {
  const f = file('a = 11\nb = 2\nx = 5\nc = 3031\n// note\n', proposal);
  const groups = confirmGroups([entry(f, merged, ['theirs'])], []);
  assert.deepEqual(groups.counts, { decided: 2, merged: 0, mainFiles: 1 });
  assert.equal(groups.decided[0].whole, 'edited');
  assert.equal(groups.decided[0].before, 'a = 10\nb = 2\nx = 5\nc = 30\n');
});

void test('files Git merged on its own arrive from main; a conflicted file’s rename keeps it out', () => {
  const f = file('a = 11\nb = 2\nx = 5\nc = 31\n');
  const preview = [{ name: 'src/a.ts' }, { name: 'src/clock.ts' }, { name: 'src/new.ts', prevName: 'src/a.ts' }];
  const groups = confirmGroups([entry(f, undefined, ['theirs', 'theirs'])], preview);
  assert.deepEqual(groups.incoming, [{ name: 'src/clock.ts' }]);
  assert.equal(groups.counts.mainFiles, 2, 'main’s lines in src/a.ts, and src/clock.ts');
  // A clean merge: only main's files.
  const clean = confirmGroups([], [{ name: 'src/clock.ts' }, { name: 'src/retry.ts' }]);
  assert.deepEqual(clean.counts, { decided: 0, merged: 0, mainFiles: 2 });
});

void test('anything that still needs you is pending, and no group counts it', () => {
  const open = file(original, proposal, { resolved: false });
  const notReviewed = file('a = 11\nb = 2\nx = 5\nc = 3031\n', proposal, { resolved: false });
  const local = file(original, undefined, { unsupported: 'Renamed on both sides' });
  const groups = confirmGroups(
    [
      entry(open, merged, undefined, false),
      entry(notReviewed, merged, ['theirs'], false),
      { ...entry(local, undefined), reviewed: true },
      // Reviewed, but a marker is left: never counted.
      { ...entry(open, merged), reviewed: true },
    ],
    []
  );
  assert.equal(groups.pending.length, 4);
  assert.deepEqual(groups.counts, { decided: 0, merged: 0, mainFiles: 0 });
  assert.deepEqual([groups.decided, groups.merged, groups.main], [[], [], []]);
});

void test('confirmCount', () => {
  assert.equal(confirmCount(1, 1), '1 conflict in 1 file');
  assert.equal(confirmCount(3, 2), '3 conflicts in 2 files');
  assert.equal(confirmCount(0, 1), '1 file');
  assert.equal(confirmCount(0, 0), 'none');
});
