import assert from 'node:assert/strict';
import { test } from 'node:test';
import { confirmCount, confirmGroups, needsYou, patchNote, wholeNote } from '../lib/conflict-confirm';
import { blockBuckets, fileStatus, type Verdict } from '../lib/conflict-verify';
import type { BlockPicks } from '../lib/conflict-blocks';
import { conflictFileStage, type ConflictFile, type ConflictProposal } from '../lib/conflict-resolution';

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
const entry = (f: ConflictFile, verdict: Verdict | undefined, picks?: BlockPicks) => ({
  file: f,
  buckets: blockBuckets(f, f.result, verdict, picks),
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

void test('Use the proposal after another choice is yours; only a proposal you never touched is Merged', () => {
  const f = file('a = 11\nb = 2\nx = 5\nc = 3031\n', proposal);
  // Keep main's change on conflict 2, then Use the proposal: the pick is `proposal`, the draft is the proposal's.
  const groups = confirmGroups([entry(f, merged, ['theirs', 'proposal'])], []);
  assert.deepEqual(groups.counts, { decided: 2, merged: 0, mainFiles: 1 });
  assert.deepEqual(groups.decided[0].items, [
    { index: 0, how: 'theirs' },
    { index: 1, how: 'used', source: 'mergiraf' },
  ]);
  // The bucket stays Merged in the Conflicts view: the pick changes only who the confirmation says decided it.
  assert.deepEqual(blockBuckets(f, f.result, merged, ['theirs', 'proposal']), ['decided', 'merged']);
  // A `proposal` pick whose draft no longer holds the proposal is whatever the draft reads as.
  const kept = file('a = 11\nb = 2\nx = 5\nc = 31\n', proposal);
  assert.deepEqual(
    confirmGroups([entry(kept, merged, ['theirs', 'proposal'])], []).decided[0].items.map((i) => i.how),
    ['theirs', 'theirs']
  );
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

void test('a file edited by hand is yours, Merged proposals included, and its note says what produced it', () => {
  const f = file('a = 11\nb = 2\nx = 5\nc = 3031\n// note\n', proposal);
  const groups = confirmGroups([entry(f, merged, ['theirs'])], []);
  assert.deepEqual(groups.counts, { decided: 2, merged: 0, mainFiles: 1 });
  assert.equal(groups.decided[0].whole, 'manual');
  assert.equal(groups.decided[0].before, 'a = 10\nb = 2\nx = 5\nc = 30\n');
  assert.equal(wholeNote('manual', 2, 'main'), 'You edited this file, so its 2 conflicts are yours.');
  // A suggestion or a remembered resolution is not your edit: the note names what produced the draft.
  for (const source of ['agent', 'rerere', 'mergiraf'] as const) {
    const g = confirmGroups([entry({ ...f, source }, merged, ['theirs'])], []);
    assert.equal(g.decided[0].whole, source);
    assert.doesNotMatch(wholeNote(source, 2, 'main'), /You edited/);
  }
  assert.match(wholeNote('rerere', 1, 'main'), /remembered resolution/);
  assert.match(wholeNote('agent', 1, 'main'), /suggestion/);
});

void test('a reviewed file without markers is never stuck, even when its conflicts read as Decide', () => {
  // Two conflicts separated by a blank line, both rewritten by hand: the draft can't be split into the blocks.
  const two = '<<<<<<< pr\na\n=======\nb\n>>>>>>> main\n\n<<<<<<< pr\nc\n=======\nd\n>>>>>>> main\n';
  const f = file('x\n\ny\n', undefined, { original: two, ours: 'a\n\nc\n', theirs: 'b\n\nd\n' });
  const buckets = blockBuckets(f, f.result, undefined);
  assert.deepEqual(buckets, ['decide', 'decide'], 'The buckets alone would say it needs you');
  // One rule: reviewed and marker-free is decided, in the file list and in the confirmation.
  assert.equal(needsYou(f), false);
  assert.equal(fileStatus(f, f.result, conflictFileStage(f), buckets).kind, 'reviewed');
  const groups = confirmGroups([{ file: f, buckets }], []);
  assert.deepEqual(groups.pending, []);
  assert.deepEqual(groups.counts, { decided: 2, merged: 0, mainFiles: 0 });
  assert.equal(groups.decided[0].whole, 'manual');
});

void test('a PR file without a final line feed shows no phantom change from main', () => {
  // The conflict ends the file and the PR's version has no final line feed; Git's markers add one.
  const eof = '<<<<<<< pr\na = 10\n=======\na = 11\n>>>>>>> main\n';
  const f = file('a = 11\n', undefined, { original: eof, ours: 'a = 10', theirs: 'a = 11\n' });
  const groups = confirmGroups([entry(f, undefined, ['theirs'])], []);
  assert.deepEqual(groups.main, [], 'main brings nothing outside the conflict');
  assert.equal(groups.decided[0].before, 'a = 10');
  assert.equal(groups.decided[0].after, 'a = 11\n');
  // Kept as the PR's side, the diff shows the line feed the draft really adds, under You decided.
  const kept = file('a = 10\n', undefined, { original: eof, ours: 'a = 10', theirs: 'a = 11\n' });
  const k = confirmGroups([entry(kept, undefined, ['ours'])], []);
  assert.deepEqual(k.main, []);
  assert.deepEqual([k.decided[0].before, k.decided[0].after], ['a = 10', 'a = 10\n']);
});

void test('files Git merged on its own arrive from main; main’s rename of a conflicted file counts there too', () => {
  const f = file('a = 11\nb = 2\nx = 5\nc = 31\n');
  const preview = [{ name: 'src/a.ts' }, { name: 'src/clock.ts' }, { name: 'src/new.ts', prevName: 'src/a.ts' }];
  const groups = confirmGroups([entry(f, undefined, ['theirs', 'theirs'])], preview);
  assert.deepEqual(groups.incoming, [{ name: 'src/clock.ts' }]);
  assert.equal(groups.counts.mainFiles, 2, 'main’s lines in src/a.ts, and src/clock.ts');
  // main renamed the conflicted file: every part's header shows the rename, and Arriving from main counts it.
  const renamed = file('a = 11\nb = 2\nx = 0\nc = 31\n', undefined, {
    path: 'src/b.ts',
    original: original.replace('x = 5', 'x = 0'),
  });
  const r = confirmGroups([entry(renamed, undefined, ['theirs', 'theirs'])], [{ name: 'src/b.ts', prevName: 'src/a.ts' }]);
  assert.deepEqual(r.incoming, []);
  assert.equal(r.main.length, 1, 'the rename alone, with no lines from main');
  assert.equal(r.main[0].previousPath, 'src/a.ts');
  assert.equal(r.main[0].before, r.main[0].after);
  assert.equal(r.decided[0].previousPath, 'src/a.ts');
  assert.equal(r.counts.mainFiles, 1);
  // A clean merge: only main's files.
  const clean = confirmGroups([], [{ name: 'src/clock.ts' }, { name: 'src/retry.ts' }]);
  assert.deepEqual(clean.counts, { decided: 0, merged: 0, mainFiles: 2 });
});

void test('binary and mode-only files say what changed instead of an empty diff', async () => {
  const { parsePatchFiles } = await import('@pierre/diffs');
  const patch = [
    'diff --git a/img.png b/img.png',
    'index 1111111..2222222 100644',
    'GIT binary patch',
    'literal 3',
    'Kcmd;LKmY&$0RR91',
    '',
    'literal 3',
    'Kcmd;LKmY&$0RR91',
    '',
    '',
    'diff --git a/run.sh b/run.sh',
    'old mode 100644',
    'new mode 100755',
    '',
    'diff --git a/src/a.ts b/src/a.ts',
    'index 1111111..2222222 100644',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1 +1 @@',
    '-a',
    '+b',
    '',
  ].join('\n');
  assert.deepEqual(
    parsePatchFiles(patch)
      .flatMap((p) => p.files)
      .map((f) => patchNote(f)),
    ['Binary file changed', 'Mode 100644 → 100755', undefined]
  );
});

void test('anything that still needs you is pending, and no group counts it', () => {
  const open = file(original, proposal, { resolved: false });
  const notReviewed = file('a = 11\nb = 2\nx = 5\nc = 3031\n', proposal, { resolved: false });
  const local = file(original, undefined, { unsupported: 'Renamed on both sides', resolved: true });
  // Marked reviewed, but a marker is left: never counted.
  const marker = file(original, proposal, { resolved: true });
  const groups = confirmGroups(
    [entry(open, merged), entry(notReviewed, merged, ['theirs']), entry(local, undefined), entry(marker, merged)],
    []
  );
  assert.equal(groups.pending.length, 4);
  assert.ok([open, notReviewed, local, marker].every((f) => needsYou(f)));
  assert.deepEqual(groups.counts, { decided: 0, merged: 0, mainFiles: 0 });
  assert.deepEqual([groups.decided, groups.merged, groups.main], [[], [], []]);
});

void test('confirmCount', () => {
  assert.equal(confirmCount(1, 1), '1 conflict in 1 file');
  assert.equal(confirmCount(3, 2), '3 conflicts in 2 files');
  assert.equal(confirmCount(0, 1), '1 file');
  assert.equal(confirmCount(0, 0), 'none');
});
