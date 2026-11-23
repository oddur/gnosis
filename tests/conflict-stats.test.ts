import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STATS_CAP,
  applyConflictStats,
  blockFingerprints,
  choiceEvent,
  countOpened,
  countPushed,
  emptyConflictStats,
  markChoice,
  mergedUndoRate,
  normalizeConflictStats,
  preparedBuckets,
  carryStatsBlocks,
  validChoice,
} from '../lib/conflict-stats';
import { CONFLICT_STATS_NAME, STATS_LOADING, createConflictStatsStore } from '../src/conflict-stats-store';
import { createMemoryStorage } from '../src/app-data-store';
import { verdictKey } from '../lib/conflict-verdict-key';
import { withProposals } from '../lib/conflict-carry';
import type { ConflictFile, ConflictSession } from '../lib/conflict-resolution';

const SECRET = 'src/secret-plans/launch-codes.ts';
const block = (ours: string, theirs: string) =>
  `<<<<<<< feature/secret\n${ours}\n||||||| ancestor\nbase\n=======\n${theirs}\n>>>>>>> main\n`;
const LAUNCH = block('const launch = 1;', 'const launch = 2;');
const CODE = block('const code = "hunter2";', 'const code = "swordfish";');
/** Two conflicts: the first with a proposal, the second without one. */
function file(merged: boolean | undefined, overrides: Partial<ConflictFile> = {}): ConflictFile {
  const original = overrides.original ?? `${LAUNCH}middle\n${CODE}`;
  const proposals = overrides.proposals ?? [{ source: 'mergiraf' as const, text: 'const launch = 3;\n' }, null];
  const f: ConflictFile = {
    path: SECRET,
    mode: '100644',
    base: 'base\n',
    ours: 'ours\n',
    theirs: 'theirs\n',
    resolved: false,
    source: 'mergiraf',
    ...overrides,
    original,
    proposals,
    result: overrides.result ?? withProposals(original, proposals),
  };
  if (merged !== undefined)
    f.verdict = { key: verdictKey({ ...f }, []), verdict: { merged, note: merged ? 'The file parses.' : 'Check it.' } };
  return f;
}
function session(files: ConflictFile[], overrides: Partial<ConflictSession> = {}): ConflictSession {
  return {
    id: 'a'.repeat(64),
    account: 'secret-account',
    url: 'https://github.com/secret-org/secret-repo/pull/9',
    title: 'Secret title',
    headRepo: 'secret-org/secret-repo',
    baseRepo: 'secret-org/secret-repo',
    headBranch: 'feature/secret',
    baseBranch: 'main',
    headSha: 'a'.repeat(40),
    baseSha: 'b'.repeat(40),
    tree: 'c'.repeat(40),
    files,
    version: 1,
    status: 'editing',
    ...overrides,
  };
}
const opened = (s: ConflictSession, before?: ConflictSession, request = { restart: false, keep: false }) =>
  countOpened(before, s, request, []);
/** The file's second conflict decided as main's side, the first left as it is. */
const decideSecond = (f: ConflictFile) => {
  f.result = f.result.replace(CODE, 'const code = "swordfish";\n');
  return f;
};

void test('counts start at zero, increment, and stop at the cap', () => {
  const empty = emptyConflictStats();
  assert.deepEqual(empty.buckets.merged, { shown: 0, accepted: 0, undone: 0, rechosen: 0 });
  assert.deepEqual(empty.sessions, { started: 0, startedOver: 0, pushed: 0 });
  assert.equal(mergedUndoRate(empty), undefined, 'No rate before any Merged conflict');
  const next = applyConflictStats(empty, [
    { kind: 'bucket', bucket: 'merged', count: 'shown', by: 4 },
    { kind: 'bucket', bucket: 'merged', count: 'undone' },
    { kind: 'session', count: 'started' },
  ]);
  assert.equal(next.buckets.merged.shown, 4);
  assert.equal(mergedUndoRate(next), 0.25);
  assert.equal(empty.buckets.merged.shown, 0, 'The earlier record is unchanged');
  // Running counts: the record never grows, and a counter at the cap stays there.
  const full = normalizeConflictStats({ buckets: { merged: { shown: STATS_CAP, undone: STATS_CAP } }, sessions: { started: STATS_CAP } });
  const after = applyConflictStats(full, [
    { kind: 'bucket', bucket: 'merged', count: 'shown', by: 1000 },
    { kind: 'bucket', bucket: 'merged', count: 'undone' },
    { kind: 'session', count: 'started' },
  ]);
  assert.equal(after.buckets.merged.shown, STATS_CAP);
  assert.equal(after.buckets.merged.undone, STATS_CAP);
  assert.equal(after.sessions.started, STATS_CAP);
  assert.equal(JSON.stringify(after).length, JSON.stringify(full).length);
});

void test('a saved record keeps only known whole counts, and a choice is checked before main uses it', () => {
  const stats = normalizeConflictStats({
    path: SECRET,
    buckets: { merged: { shown: 3.7, undone: -2, accepted: 'many', rechosen: Infinity, file: SECRET }, secret: { shown: 1 } },
    sessions: { started: 2, pushed: 1e20, url: 'https://github.com/secret-org/secret-repo/pull/9' },
  });
  assert.deepEqual(stats.buckets.merged, { shown: 3, accepted: 0, undone: 0, rechosen: 0 });
  assert.deepEqual(stats.sessions, { started: 2, startedOver: 0, pushed: STATS_CAP });
  assert.equal(JSON.stringify(stats).includes('secret'), false);
  const key = blockFingerprints(LAUNCH)[0];
  const choice = { id: 'a'.repeat(64), path: SECRET, key, count: 'undone' };
  assert.deepEqual(validChoice({ ...choice, bucket: 'merged', text: 'x' }), choice, 'Only the four fields');
  for (const bad of [{ ...choice, id: 'x' }, { ...choice, count: 'shown' }, { ...choice, key: 'const launch' }, { ...choice, path: '' }, 'undone'])
    assert.equal(validChoice(bad), undefined);
});

void test('item 10 and storage: counts persist, Reset writes before it forgets, and no content is saved', () => {
  const saved = new Map<string, string>();
  const store = createConflictStatsStore(createMemoryStorage(saved));
  const s = session([file(true)]);
  store.record(opened(s).events);
  const undone = markChoice(s, { path: SECRET, key: blockFingerprints(s.files[0].original)[0], count: 'undone' });
  assert.ok(undone);
  store.record([undone]);
  store.record(countPushed(s));
  const stats = createConflictStatsStore(createMemoryStorage(saved)).get();
  assert.equal(stats.buckets.merged.shown, 1);
  assert.equal(stats.buckets.decide.shown, 1);
  assert.equal(stats.buckets.merged.undone, 1);
  assert.deepEqual(stats.sessions, { started: 1, startedOver: 0, pushed: 1 });
  // Nothing of the file, the PR or the account is in the saved record.
  const text = saved.get(CONFLICT_STATS_NAME) ?? '';
  for (const secret of ['secret', 'launch', 'hunter2', 'swordfish', 'github.com', 'feature', '.ts'])
    assert.equal(text.includes(secret), false, `The saved stats contain "${secret}"`);
  assert.equal(saved.size, 1, 'One record for the whole app');
  // Reset zeroes the counts and starts the next epoch.
  assert.deepEqual(store.reset(), { ...emptyConflictStats(), epoch: 1 });
  assert.deepEqual(createConflictStatsStore(createMemoryStorage(saved)).get(), { ...emptyConflictStats(), epoch: 1 });
  // Saved data not loaded: Reset is refused and writes nothing; a count is dropped, never written as zeros.
  let loaded = false;
  const writes: unknown[] = [];
  const loading = createConflictStatsStore({
    read: () => {
      if (!loaded) throw new Error('Saved work is still loading');
      return { sessions: { started: 7 } };
    },
    write: (_name, value) => writes.push(value),
  });
  assert.throws(() => loading.reset(), new RegExp(STATS_LOADING.slice(0, 20)));
  assert.throws(() => loading.get(), /still loading/);
  assert.doesNotThrow(() => loading.record([{ kind: 'session', count: 'pushed' }]));
  assert.deepEqual(writes, []);
  loaded = true;
  loading.record([{ kind: 'session', count: 'pushed' }]);
  assert.equal(loading.get().sessions.started, 7, 'The counts saved before stay');
  // A failed write keeps the counts in memory as they were.
  const failing = createConflictStatsStore({
    read: () => ({ sessions: { started: 3 } }),
    write: () => {
      throw new Error('disk full');
    },
  });
  assert.throws(() => failing.reset(), /disk full/);
  assert.equal(failing.get().sessions.started, 3);
});

void test('prepared buckets need the checks', () => {
  assert.equal(preparedBuckets(file(undefined), []), undefined, 'Not counted while the checks run');
  assert.deepEqual(preparedBuckets(file(true), []), ['merged', 'decide']);
  assert.deepEqual(preparedBuckets(file(false), []), ['check', 'decide']);
  assert.equal(preparedBuckets(file(true, { unsupported: 'A binary file' }), []), undefined);
  const python = file(true, { path: 'tool.py' });
  assert.equal(preparedBuckets(python, ['python']), undefined, 'A verdict for other languages off does not count');
  const first = session([file(true)]);
  assert.deepEqual(opened(first).events, [
    { kind: 'bucket', bucket: 'merged', count: 'shown', by: 1 },
    { kind: 'bucket', bucket: 'decide', count: 'shown', by: 1 },
    { kind: 'session', count: 'started' },
  ]);
  assert.deepEqual(opened(structuredClone(first), first), { events: [], changed: false }, 'A reopen counts nothing');
  assert.deepEqual(opened(session([file(true)], { stale: true })).events, []);
  assert.deepEqual(opened(session([file(true)], { status: 'published' })).events, []);
  // Start over: a fresh merge, counted again, and one start over.
  assert.deepEqual(opened(session([file(true)]), first, { restart: true, keep: false }).events.slice(-2), [
    { kind: 'session', count: 'started' },
    { kind: 'session', count: 'startedOver' },
  ]);
});

void test('item 4: Load latest changes is never a new session', () => {
  const first = session([file(true)]);
  opened(first);
  // Load latest with every conflict new (none carried): shown, but not started.
  const changed = session([file(true, { original: `${block('a', 'b')}middle\n${CODE}` })]);
  const events = opened(changed, first, { restart: true, keep: true }).events;
  assert.equal(events.some((e) => e.kind === 'session'), false);
  assert.deepEqual(events, [{ kind: 'bucket', bucket: 'merged', count: 'shown', by: 1 }]);
});

void test('item 5: buckets are saved per conflict block, so Load latest counts only the conflicts that changed', () => {
  const first = session([file(true)]);
  opened(first);
  const [launch, code] = blockFingerprints(first.files[0].original);
  assert.deepEqual(first.files[0].statsBlocks, [
    { key: launch, bucket: 'merged' },
    { key: code, bucket: 'decide' },
  ]);
  markChoice(first, { path: SECRET, key: launch, count: 'undone' });
  // main moved: the first conflict changed, the second is the same, under new marker labels.
  const moved = `${block('const launch = 1;', 'const launch = 9;')}middle\n${CODE.replace('ancestor', 'abc123def456')}`;
  const next = session([file(false, { original: moved })]);
  const { events } = opened(next, first, { restart: true, keep: true });
  assert.deepEqual(events, [{ kind: 'bucket', bucket: 'check', count: 'shown', by: 1 }], 'Only the changed conflict');
  assert.deepEqual(next.files[0].statsBlocks?.[1], { key: code, bucket: 'decide' });
  assert.notEqual(next.files[0].statsBlocks[0]?.key, launch, 'The changed conflict has its own block');
  // Start over drops what Load latest keeps.
  assert.equal(opened(session([file(true)]), first, { restart: true, keep: false }).events.length, 4);
  // A block whose checks have not run waits, uncounted; the next open counts it.
  const waiting = session([file(undefined)]);
  assert.deepEqual(opened(waiting).events, [{ kind: 'bucket', bucket: 'decide', count: 'shown', by: 1 }, { kind: 'session', count: 'started' }]);
  assert.equal(waiting.files[0].statsBlocks?.[0], null);
  const checked = file(true);
  checked.statsBlocks = waiting.files[0].statsBlocks;
  assert.deepEqual(opened(session([checked])).events, [{ kind: 'bucket', bucket: 'merged', count: 'shown', by: 1 }]);
});

void test('item 6: fingerprints are computed once per file version', () => {
  const original = `${LAUNCH}middle\n${CODE}`;
  const keys = blockFingerprints(original);
  assert.equal(keys.length, 2);
  assert.equal(blockFingerprints(original.slice()), keys, 'The same array for the same text');
  assert.notEqual(blockFingerprints(LAUNCH)[0], keys[1]);
});

void test('item 2: a push counts a proposal as accepted only when provably unchanged', () => {
  const s = session([decideSecond(file(true))]);
  s.files[0].statsBlocks = blockFingerprints(s.files[0].original).map((key, i) => ({ key, bucket: i ? 'decide' : 'merged' }));
  assert.deepEqual(countPushed(s), [
    { kind: 'session', count: 'pushed' },
    { kind: 'bucket', bucket: 'merged', count: 'accepted', by: 1 },
  ]);
  // A Keep in its place, also a Keep whose text equals the proposal, is not accepted.
  const kept = structuredClone(s);
  kept.files[0].result = kept.files[0].result.replace('const launch = 3;', 'const launch = 1;');
  assert.deepEqual(countPushed(kept), [{ kind: 'session', count: 'pushed' }]);
  const same = structuredClone(s);
  same.files[0].proposals = [{ source: 'mergiraf', text: 'const launch = 1;\n' }, null];
  same.files[0].result = kept.files[0].result;
  assert.equal(countPushed(same).length, 2, 'The same text without a Keep is the proposal');
  same.files[0].picks = ['ours', 'theirs'];
  assert.deepEqual(countPushed(same), [{ kind: 'session', count: 'pushed' }]);
  // The proposal picked again (#489) is not a Keep: it is still accepted as is.
  const repicked = structuredClone(s);
  repicked.files[0].picks = ['proposal', 'theirs'];
  assert.equal(countPushed(repicked).length, 2);
  // A result edited around the conflicts cannot be split: nothing counts for it.
  const edited = structuredClone(s);
  edited.files[0].result = edited.files[0].result.replace('middle', 'edited by hand');
  assert.deepEqual(countPushed(edited), [{ kind: 'session', count: 'pushed' }]);
  // A session never counted as shown (a restack, an older draft) is not counted at the push either.
  assert.deepEqual(countPushed(session([file(true)])), []);
});

void test('item 3: a whole-file proposal pushed as proposed counts its conflicts as accepted in Check', () => {
  const wholeFile = { source: 'mergiraf' as const, text: 'const launch = 3;\nmiddle\nconst code = "both";\n' };
  const f = file(true, { proposals: undefined, wholeFile });
  delete f.proposals;
  f.result = f.original;
  f.verdict = { key: verdictKey({ ...f }, []), verdict: { merged: false, passed: true, note: '' } };
  const s = session([f]);
  assert.deepEqual(opened(s).events.slice(0, 1), [{ kind: 'bucket', bucket: 'check', count: 'shown', by: 2 }]);
  s.files[0].result = wholeFile.text;
  assert.deepEqual(countPushed(s), [
    { kind: 'session', count: 'pushed' },
    { kind: 'bucket', bucket: 'check', count: 'accepted', by: 2 },
  ]);
  s.files[0].result = wholeFile.text.replace('both', 'mine');
  assert.deepEqual(countPushed(s), [{ kind: 'session', count: 'pushed' }]);
});

void test('item 9: a push needs no checks to count', () => {
  const s = session([decideSecond(file(true))]);
  s.files[0].statsBlocks = blockFingerprints(s.files[0].original).map((key, i) => ({ key, bucket: i ? 'decide' : 'check' }));
  delete s.files[0].verdict;
  assert.deepEqual(countPushed(s).at(-1), { kind: 'bucket', bucket: 'check', count: 'accepted', by: 1 });
});

void test('item 8: undone means Undo removed the untouched proposal', () => {
  assert.equal(choiceEvent('proposal', undefined), 'undone');
  assert.equal(choiceEvent('ours', undefined), undefined, 'Undoing your own Keep is no Merged undo');
  assert.equal(choiceEvent(undefined, 'ours'), undefined, 'A first choice is no change');
  assert.equal(choiceEvent(undefined, 'proposal'), undefined);
  assert.equal(choiceEvent('proposal', 'theirs'), 'rechosen');
  assert.equal(choiceEvent('ours', 'proposal'), 'rechosen');
  assert.equal(choiceEvent('ours', 'ours'), undefined);
  // The proposal picked again after another choice (#489) is yours: changing to it is re-chosen, undoing it is nothing.
  assert.equal(choiceEvent('ours', 'proposal', 'ours'), 'rechosen');
  assert.equal(choiceEvent('proposal', undefined, 'proposal'), undefined);
  assert.equal(choiceEvent('proposal', 'theirs', 'proposal'), 'rechosen');
});

void test('item 1: undone and re-chosen count once per conflict, saved on the draft', () => {
  const s = session([file(true)]);
  opened(s);
  const [launch, code] = blockFingerprints(s.files[0].original);
  assert.deepEqual(markChoice(s, { path: SECRET, key: launch, count: 'undone' }), { kind: 'bucket', bucket: 'merged', count: 'undone' });
  // The flag is on the draft: a copy (a reopen, a second window, a restart) does not count it again.
  const reopened = structuredClone(s);
  assert.equal(markChoice(reopened, { path: SECRET, key: launch, count: 'undone' }), undefined);
  assert.deepEqual(reopened.files[0].statsBlocks?.[0], { key: launch, bucket: 'merged', undone: true });
  assert.deepEqual(markChoice(reopened, { path: SECRET, key: launch, count: 'rechosen' }), { kind: 'bucket', bucket: 'merged', count: 'rechosen' });
  assert.deepEqual(markChoice(reopened, { path: SECRET, key: code, count: 'rechosen' }), { kind: 'bucket', bucket: 'decide', count: 'rechosen' });
  // Unknown conflicts count nothing: another file, a changed conflict, or one never counted as shown.
  assert.equal(markChoice(reopened, { path: 'other.ts', key: launch, count: 'undone' }), undefined);
  assert.equal(markChoice(reopened, { path: SECRET, key: 'abc:12', count: 'undone' }), undefined);
  assert.equal(markChoice(session([file(true)]), { path: SECRET, key: launch, count: 'undone' }), undefined);
});

void test('#490 1: a choice counts on the conflict at its index, also among identical conflicts', () => {
  const s = session([file(true, { original: `${LAUNCH}middle\n${LAUNCH}`, proposals: [null, null] })]);
  opened(s);
  const [first, second] = blockFingerprints(s.files[0].original);
  assert.equal(first, second);
  assert.deepEqual(markChoice(s, { path: SECRET, key: second, index: 1, count: 'rechosen' }), {
    kind: 'bucket',
    bucket: 'decide',
    count: 'rechosen',
  });
  assert.deepEqual(s.files[0].statsBlocks?.map((b) => !!b?.rechosen), [false, true]);
  // The first is its own conflict: it still counts once.
  assert.ok(markChoice(s, { path: SECRET, key: first, index: 0, count: 'rechosen' }));
  // A stale index, whose conflict has another fingerprint, falls back to the first conflict with the fingerprint.
  const [launch, code] = blockFingerprints(session([file(true)]).files[0].original);
  const other = session([file(true)]);
  opened(other);
  assert.deepEqual(markChoice(other, { path: SECRET, key: launch, index: 1, count: 'undone' }), { kind: 'bucket', bucket: 'merged', count: 'undone' });
  assert.equal(other.files[0].statsBlocks?.[0]?.undone, true);
  assert.ok(markChoice(other, { path: SECRET, key: code, index: 1, count: 'rechosen' }));
  // The renderer's index is checked like the rest of the choice.
  const id = 'a'.repeat(64);
  assert.deepEqual(validChoice({ id, path: SECRET, key: launch, index: 1, count: 'undone' }), { id, path: SECRET, key: launch, index: 1, count: 'undone' });
  assert.equal(validChoice({ id, path: SECRET, key: launch, index: -1, count: 'undone' }), undefined);
  assert.equal(validChoice({ id, path: SECRET, key: launch, index: 1.5, count: 'undone' }), undefined);
});

void test('#490 3: after the base moved, each unchanged conflict keeps its counted block and flags', () => {
  const old = session([file(true)]);
  opened(old);
  const [launch] = blockFingerprints(old.files[0].original);
  assert.ok(markChoice(old, { path: SECRET, key: launch, count: 'undone' }));
  // Main moved: the second conflict changed, the first is the same.
  const moved = file(true, { original: `${LAUNCH}middle\n${block('const code = 1;', 'const code = 3;')}` });
  carryStatsBlocks(moved, old.files[0]);
  assert.deepEqual(moved.statsBlocks, [{ key: launch, bucket: 'merged', undone: true }, null]);
  // The undo is not counted again, and the changed conflict counts as shown on the next open.
  const next = session([moved]);
  assert.equal(markChoice(next, { path: SECRET, key: launch, count: 'undone' }), undefined);
  assert.deepEqual(opened(next).events, [{ kind: 'bucket', bucket: 'decide', count: 'shown', by: 1 }]);
  // No conflict in common: nothing carried.
  const fresh = file(true, { original: block('a', 'b') });
  carryStatsBlocks(fresh, old.files[0]);
  assert.equal(fresh.statsBlocks, undefined);
});

void test('#490 4: a whole-file proposal counts each conflict as accepted in the bucket it was shown in, never Decide', () => {
  const wholeFile = { source: 'mergiraf' as const, text: 'const launch = 3;\nmiddle\nconst code = "both";\n' };
  const f = file(true, { wholeFile });
  const [launch, code] = blockFingerprints(f.original);
  f.statsBlocks = [
    { key: launch, bucket: 'merged' },
    { key: code, bucket: 'decide' },
  ];
  f.result = wholeFile.text;
  assert.deepEqual(countPushed(session([f])), [
    { kind: 'session', count: 'pushed' },
    { kind: 'bucket', bucket: 'merged', count: 'accepted', by: 1 },
  ]);
});

void test('#490 5: after Reset, conflicts counted before count nothing more, and count as shown again', () => {
  const s = session([file(true)]);
  opened(s);
  const [launch] = blockFingerprints(s.files[0].original);
  // Reset: epoch 1. The old blocks are no longer counted ones.
  assert.equal(markChoice(structuredClone(s), { path: SECRET, key: launch, count: 'undone' }, 1), undefined);
  assert.deepEqual(countPushed(structuredClone(s), 1), [], 'Nothing pushed counts against a reset');
  const again = countOpened(undefined, s, { restart: false, keep: false }, [], 1);
  assert.deepEqual(again.events.filter((e) => e.kind === 'bucket'), [
    { kind: 'bucket', bucket: 'merged', count: 'shown', by: 1 },
    { kind: 'bucket', bucket: 'decide', count: 'shown', by: 1 },
  ]);
  assert.deepEqual(s.files[0].statsBlocks?.map((b) => b?.epoch), [1, 1]);
  assert.deepEqual(markChoice(s, { path: SECRET, key: launch, count: 'undone' }, 1), { kind: 'bucket', bucket: 'merged', count: 'undone' });
  // Undone never goes above shown: once per conflict in the epoch.
  assert.equal(markChoice(s, { path: SECRET, key: launch, count: 'undone' }, 1), undefined);
});

void test('#490 6: an Undo never counts under Decide', () => {
  const s = session([file(true)]);
  opened(s);
  const [, code] = blockFingerprints(s.files[0].original);
  assert.equal(s.files[0].statsBlocks?.[1]?.bucket, 'decide');
  assert.equal(markChoice(s, { path: SECRET, key: code, index: 1, count: 'undone' }), undefined);
  assert.equal(s.files[0].statsBlocks[1].undone, undefined);
  assert.ok(markChoice(s, { path: SECRET, key: code, index: 1, count: 'rechosen' }));
});
