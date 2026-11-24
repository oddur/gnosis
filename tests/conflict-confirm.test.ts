import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  confirmCount,
  confirmEdited,
  confirmGroups,
  confirmWritten,
  editedNote,
  needsYou,
  patchNote,
  wholeNote,
} from '../lib/conflict-confirm';
import {
  blockBuckets,
  fileStatus,
  unchosenConflicts,
  waitingHint,
  startsOver,
  wholeEdited,
  withTypeError,
  type Verdict,
} from '../lib/conflict-verify';
import type { BlockPicks } from '../lib/conflict-blocks';
import { conflictFileStage } from '../lib/conflict-markers';
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
  // Lines a resolver wrote (#445 item 10): Mergiraf's combined line is marked in its diff; your Keep and main's lines
  // are never marked.
  assert.deepEqual(auto.written, [4]);
  assert.deepEqual(decided.written, []);
  assert.deepEqual(main.written, []);
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
  // A proposal you used is still a resolver's lines: marked where you decided.
  assert.deepEqual(groups.decided[0].written, [4]);
  // Use the proposal is your decision in the Conflicts view too: only a proposal nobody chose is Merged.
  assert.deepEqual(blockBuckets(f, f.result, merged, ['theirs', 'proposal']), ['decided', 'decided']);
  assert.deepEqual(blockBuckets(f, f.result, merged, ['theirs']), ['decided', 'merged']);
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
  // Its one line neither side had is marked.
  assert.deepEqual(confirmWritten(groups.decided[0]), [5]);
  // The moved-code rule's whole file (#483) says so, not structural merge (#491).
  const moved = file(whole, undefined, { wholeFile: { source: 'moved', text: whole }, source: 'manual' });
  const byMove = confirmGroups([entry(moved, { merged: false, passed: true, note: '' })], []).decided[0];
  assert.equal(byMove.whole, 'whole-moved');
  assert.equal(
    wholeNote(byMove.whole!, 2, 'main'),
    'You used the proposal for this file, where one side moved code and the other edited it. It covers 2 conflicts and main’s other lines in it.'
  );
  assert.doesNotMatch(wholeNote(byMove.whole!, 2, 'main'), /structural merge/);
});

void test('a file edited by hand is yours, Merged proposals included, and its note says what produced it', () => {
  const f = file('a = 11\nb = 2\nx = 5\nc = 3031\n// note\n', proposal);
  const groups = confirmGroups([entry(f, merged, ['theirs'])], []);
  assert.deepEqual(groups.counts, { decided: 2, merged: 0, mainFiles: 1 });
  assert.equal(groups.decided[0].whole, 'manual');
  // Your own edit is yours: the line you typed is never marked, and Mergiraf's combined line still is.
  assert.deepEqual(confirmWritten(groups.decided[0]), [4]);
  assert.equal(groups.decided[0].before, 'a = 10\nb = 2\nx = 5\nc = 30\n');
  assert.equal(wholeNote('manual', 2, 'main'), 'You edited this file, so its 2 conflicts are yours.');
  // A suggestion or a remembered resolution is not your edit: the note names what produced the draft.
  for (const source of ['agent', 'rerere', 'mergiraf'] as const) {
    const g = confirmGroups([entry({ ...f, source, resolverText: f.result }, merged, ['theirs'])], []);
    assert.equal(g.decided[0].whole, source);
    // A resolver's whole file: every line of its text neither side had is marked, its note line and Mergiraf's alike.
    assert.deepEqual(confirmWritten(g.decided[0]), [4, 5]);
    assert.doesNotMatch(wholeNote(source, 2, 'main'), /You edited/);
  }
  assert.match(wholeNote('rerere', 1, 'main'), /Your earlier resolution of this file was reused/);
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
  // main renamed the conflicted file: Arriving from main's header shows the rename and counts it. The parts after it
  // are at the new path already, so they show no rename of their own (#491).
  const renamed = file('a = 11\nb = 2\nx = 0\nc = 31\n', undefined, {
    path: 'src/b.ts',
    original: original.replace('x = 5', 'x = 0'),
  });
  const r = confirmGroups([entry(renamed, undefined, ['theirs', 'theirs'])], [{ name: 'src/b.ts', prevName: 'src/a.ts' }]);
  assert.deepEqual(r.incoming, []);
  assert.equal(r.main.length, 1, 'the rename alone, with no lines from main');
  assert.equal(r.main[0].previousPath, 'src/a.ts');
  assert.equal(r.main[0].before, r.main[0].after);
  assert.equal(r.decided[0].previousPath, undefined);
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
  // An empty file has an index line and no hunks too: its blob is Git's empty one, so it is empty, not binary (#491).
  const empty = [
    'diff --git a/src/empty.ts b/src/empty.ts',
    'new file mode 100644',
    'index 0000000..e69de29',
    'diff --git a/src/gone.ts b/src/gone.ts',
    'deleted file mode 100644',
    'index e69de29..0000000',
    'diff --git a/logo.bin b/logo.bin',
    'new file mode 100644',
    'index 0000000..3b18e51',
    'Binary files /dev/null and b/logo.bin differ',
    '',
  ].join('\n');
  assert.deepEqual(
    parsePatchFiles(empty)
      .flatMap((p) => p.files)
      .map((f) => patchNote(f)),
    ['Empty file added', 'Empty file deleted', 'Binary file added']
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

void test('Edit whole file: the whole file is yours, its Merged proposal too, and every line you changed is listed (#503)', () => {
  // Before the edit: a Keep and a Merged proposal. The edit adds an import above them and changes a line between them.
  const before = 'a = 11\nb = 2\nx = 5\nc = 3031\n';
  const kept = file(before, proposal, { resolved: false, picks: ['theirs', null] });
  assert.deepEqual(blockBuckets(kept, kept.result, merged, ['theirs']), ['decided', 'merged']);
  const draft = 'import { x } from "./x";\na = 11\nb = 3\nx = 5\nc = 3031\n';
  const edited = file(draft, proposal, {
    wholeEdit: { result: before, resolved: false, source: 'manual', picks: ['theirs', null] },
  });
  assert.equal(wholeEdited(edited), true);
  assert.deepEqual(blockBuckets(edited, draft, merged), ['decided', 'decided'], 'Every conflict is yours');
  assert.deepEqual(unchosenConflicts(edited, draft, merged), [], 'Nothing waits for a choice');
  assert.deepEqual(unchosenConflicts(edited, draft, check), [1], 'An unproven proposal left as it was still waits');
  const groups = confirmGroups([entry(edited, merged)], []);
  assert.deepEqual(groups.counts, { decided: 2, merged: 0, mainFiles: 1 });
  assert.deepEqual(groups.merged, [], 'Nothing in a file you edited is Merged for you');
  const [part] = groups.decided;
  assert.equal(part.whole, 'manual');
  assert.equal(part.before, groups.main[0].after, 'The diffs still chain: main’s lines, then your file');
  assert.equal(part.after, draft);
  assert.equal(part.edited, before);
  assert.match(wholeNote('manual', part.conflicts, 'main'), /You edited this file, so its 2 conflicts are yours/);
  // The lines you changed, outside the conflicts too, by their line in the draft.
  const lines = confirmEdited(part);
  assert.deepEqual(lines, { lines: [1, 3], removed: 0 });
  assert.equal(editedNote(lines), 'With Edit whole file you changed lines 1 and 3.');
  assert.equal(editedNote({ lines: [2, 3, 4, 9], removed: 1 }), 'With Edit whole file you changed lines 2–4 and 9 and removed 1 line.');
  assert.equal(editedNote({ lines: [], removed: 2 }), 'With Edit whole file you removed 2 lines.');
  assert.match(editedNote('unknown') ?? '', /Read the whole diff/);
  assert.deepEqual(confirmEdited({ after: 'a\nc\n', edited: 'a\nb\nc\n' }), { lines: [], removed: 1 });
  // Three lines replaced by one: the line is changed and the other two are removed, never left out.
  assert.deepEqual(confirmEdited({ after: 'a\nz\ne\n', edited: 'a\nb\nc\nd\ne\n' }), { lines: [2], removed: 2 });
  // Any other file has no such note.
  assert.equal(confirmEdited(groups.main[0]), undefined);
});

void test('Edit whole file: a draft that splits into its conflicts again is told apart again; a marker keeps a conflict open', () => {
  const before = 'a = 11\nb = 2\nx = 5\nc = 3031\n';
  const wholeEdit = { result: before, resolved: false, source: 'manual' as const };
  // A line between the conflicts changed: this draft can't be split into them.
  const draft = 'a = 11\nb = 3\nx = 5\nc = 3031\n';
  const edited = file(draft, proposal, { wholeEdit });
  // Only your Reset file ends the edit, once the service saves it (`reset`): text alone never does (#533). Until then
  // its conflicts show markers and wait; after it, the per-conflict rules apply, and nothing is yours by default.
  assert.equal(wholeEdited(edited), true);
  assert.equal(startsOver(edited, original), true);
  assert.equal(startsOver(edited, draft), false);
  assert.deepEqual(blockBuckets(edited, original, check), ['decide', 'decide']);
  assert.deepEqual(blockBuckets(file(draft, proposal), original, check), ['decide', 'check']);
  // A marker left in your edit: that conflict is still to decide, and the file is conflicted.
  const open = `import { x } from "./x";\n${original}`;
  const marked = file(open, proposal, { wholeEdit, resolved: false });
  assert.deepEqual(blockBuckets(marked, open, merged), ['decide', 'decide']);
  const one = 'import { x } from "./x";\na = 11\nb = 2\nx = 5\n<<<<<<< pr\nc = 30\n=======\nc = 31\n>>>>>>> main\n';
  // Decide goes to the conflict that still shows its markers, here the second one (#532 review).
  assert.deepEqual(blockBuckets(file(one, proposal, { wholeEdit }), one, merged), ['decided', 'decide']);
  const first = 'import { x } from "./x";\n<<<<<<< pr\na = 10\n=======\na = 11\n>>>>>>> main\nb = 2\nx = 5\nc = 3031\n';
  assert.deepEqual(blockBuckets(file(first, proposal, { wholeEdit }), first, merged), ['decide', 'decided']);
  // Markers whose sides match no conflict (edited, or typed): every conflict waits.
  const typedMarkers = 'a = 11\nb = 3\n<<<<<<< mine\nx = 5\n=======\nx = 6\n>>>>>>> theirs\nc = 3031\n';
  assert.deepEqual(blockBuckets(file(typedMarkers, proposal, { wholeEdit }), typedMarkers, merged), ['decide', 'decide']);
  assert.deepEqual(confirmGroups([entry(marked, merged)], []).pending, [{ path: 'src/a.ts', conflicts: 2 }]);
  // Without the service's mark, the same draft is only a draft edited around its conflicts: the unproven proposal waits.
  assert.deepEqual(blockBuckets(file(draft, proposal), draft, check), ['decided', 'check']);
});

void test('Edit whole file: a proposal the edit left as it was stays in Check; only what you changed is yours (#503)', () => {
  // The type check demoted the Merged proposal; you add only the import it asked for.
  const before = 'a = 11\nb = 2\nx = 5\nc = 3031\n';
  const demoted = withTypeError(merged, { note: 'The type check found a new error in src/a.ts:1 (TS2304).' });
  const draft = 'a = 11\nb = 2\nimport { x } from "./x";\nx = 5\nc = 3031\n';
  const wholeEdit = { result: before, resolved: false, source: 'manual' as const, picks: ['theirs' as const, null] };
  const edited = file(draft, proposal, { wholeEdit, resolved: false });
  assert.deepEqual(blockBuckets(edited, draft, demoted), ['decided', 'check'], 'Your Keep is yours; the proposal is not');
  assert.deepEqual(unchosenConflicts(edited, draft, demoted), [1], 'Mark reviewed waits');
  assert.match(waitingHint(edited, draft, 1), /Your edit left the proposal for a conflict in Check as it was/);
  // Without the demotion the proposal is Merged, and the whole file is yours.
  assert.deepEqual(blockBuckets(edited, draft, merged), ['decided', 'decided']);
  // A proposal you used before the edit is yours already.
  const used = file(draft, proposal, { wholeEdit: { ...wholeEdit, picks: ['theirs', 'proposal'] } });
  assert.deepEqual(blockBuckets(used, draft, demoted), ['decided', 'decided']);
  // Lines of the conflict you changed are yours.
  const changed = draft.replace('c = 3031', 'c = 30 + 31');
  assert.deepEqual(blockBuckets(file(changed, proposal, { wholeEdit }), changed, demoted), ['decided', 'decided']);
});
