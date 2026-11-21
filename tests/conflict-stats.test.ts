import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STATS_CAP,
  applyConflictStats,
  choiceEvent,
  conflictFingerprint,
  countOpened,
  countPushed,
  createChoiceCounter,
  emptyConflictStats,
  mergedUndoRate,
  normalizeConflictStats,
  preparedBuckets,
  validChoiceEvents,
  type ConflictChoiceEvent,
} from '../lib/conflict-stats';
import { CONFLICT_STATS_NAME, createConflictStatsStore } from '../src/conflict-stats-store';
import { createMemoryStorage } from '../src/app-data-store';
import { verdictKey } from '../lib/conflict-verdict-key';
import { withProposals } from '../lib/conflict-carry';
import type { ConflictFile, ConflictSession } from '../lib/conflict-resolution';

const SECRET = 'src/secret-plans/launch-codes.ts';
const block = (ours: string, theirs: string) =>
  `<<<<<<< feature/secret\n${ours}\n||||||| ancestor\nbase\n=======\n${theirs}\n>>>>>>> main\n`;
/** Two conflicts: the first with a proposal, the second without one. */
function file(merged: boolean | undefined, overrides: Partial<ConflictFile> = {}): ConflictFile {
  const original = `${block('const launch = 1;', 'const launch = 2;')}middle\n${block('const code = "hunter2";', 'const code = "swordfish";')}`;
  const proposals = [{ source: 'mergiraf' as const, text: 'const launch = 3;\n' }, null];
  const f: ConflictFile = {
    path: SECRET,
    mode: '100644',
    base: 'base\n',
    ours: 'ours\n',
    theirs: 'theirs\n',
    original,
    result: withProposals(original, proposals),
    resolved: false,
    source: 'mergiraf',
    proposals,
    ...overrides,
  };
  if (merged !== undefined && f.proposals)
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

void test('counts start at zero, increment, and stop at the cap', () => {
  const empty = emptyConflictStats();
  assert.deepEqual(empty.buckets.merged, { shown: 0, accepted: 0, undone: 0, rechosen: 0 });
  assert.deepEqual(empty.sessions, { started: 0, startedOver: 0, pushed: 0 });
  assert.equal(mergedUndoRate(empty), undefined, 'No rate before any Merged conflict');
  const next = applyConflictStats(empty, [
    { kind: 'bucket', bucket: 'merged', count: 'shown', by: 4 },
    { kind: 'bucket', bucket: 'merged', count: 'undone' },
    { kind: 'bucket', bucket: 'decide', count: 'rechosen' },
    { kind: 'session', count: 'started' },
    { kind: 'session', count: 'startedOver' },
    { kind: 'session', count: 'pushed' },
  ]);
  assert.equal(next.buckets.merged.shown, 4);
  assert.equal(next.buckets.merged.undone, 1);
  assert.equal(next.buckets.decide.rechosen, 1);
  assert.deepEqual(next.sessions, { started: 1, startedOver: 1, pushed: 1 });
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
  assert.equal(mergedUndoRate(normalizeConflictStats({ buckets: { merged: { shown: 1, undone: 5 } } })), 1, 'At most 100%');
});

void test('a saved record keeps only known whole counts', () => {
  const stats = normalizeConflictStats({
    version: 7,
    path: SECRET,
    buckets: {
      merged: { shown: 3.7, undone: -2, accepted: 'many', rechosen: Infinity, file: SECRET },
      check: null,
      secret: { shown: 1 },
    },
    sessions: { started: 2, pushed: 1e20, url: 'https://github.com/secret-org/secret-repo/pull/9' },
  });
  assert.deepEqual(stats, {
    version: 1,
    buckets: {
      merged: { shown: 3, accepted: 0, undone: 0, rechosen: 0 },
      check: { shown: 0, accepted: 0, undone: 0, rechosen: 0 },
      decide: { shown: 0, accepted: 0, undone: 0, rechosen: 0 },
    },
    sessions: { started: 2, startedOver: 0, pushed: STATS_CAP },
  });
  assert.deepEqual(normalizeConflictStats('garbage'), emptyConflictStats());
  // Only Undo and re-choice come from the renderer, and only a bucket and a counter name.
  assert.deepEqual(
    validChoiceEvents([
      { bucket: 'merged', count: 'undone', path: SECRET },
      { bucket: 'merged', count: 'shown' },
      { bucket: 'secret', count: 'undone' },
      { bucket: 'check', count: 'rechosen' },
      'merged',
    ]),
    [
      { bucket: 'merged', count: 'undone' },
      { bucket: 'check', count: 'rechosen' },
    ]
  );
  assert.deepEqual(validChoiceEvents({ bucket: 'merged' }), []);
  assert.equal(validChoiceEvents(Array.from({ length: 1000 }, () => ({ bucket: 'merged', count: 'undone' }))).length, 64);
});

void test('the store persists counts across a restart, resets, and saves no content', () => {
  const saved = new Map<string, string>();
  const store = createConflictStatsStore(createMemoryStorage(saved));
  const f = file(true);
  const s = session([f]);
  store.record(countOpened(undefined, s, { restart: false, keep: false }, []).events);
  store.record(validChoiceEvents([{ bucket: 'merged', count: 'undone' }]).map((e) => ({ kind: 'bucket' as const, ...e })));
  store.record(countPushed(s, []));
  const restarted = createConflictStatsStore(createMemoryStorage(saved));
  const stats = restarted.get();
  assert.equal(stats.buckets.merged.shown, 1);
  assert.equal(stats.buckets.decide.shown, 1);
  assert.equal(stats.buckets.merged.undone, 1);
  assert.deepEqual(stats.sessions, { started: 1, startedOver: 0, pushed: 1 });
  // Nothing of the file, the PR or the account is in the saved record: its keys are the counters alone.
  const text = saved.get(CONFLICT_STATS_NAME) ?? '';
  for (const secret of ['secret', 'launch', 'hunter2', 'swordfish', 'github.com', 'feature', '.ts'])
    assert.equal(text.includes(secret), false, `The saved stats contain "${secret}"`);
  assert.deepEqual(
    [...text.matchAll(/"([^"]+)":/g)].map((m) => m[1]).sort(),
    ['accepted', 'buckets', 'check', 'decide', 'merged', 'pushed', 'rechosen', 'sessions', 'shown', 'started', 'startedOver', 'undone', 'version']
      .flatMap((key) => (['accepted', 'rechosen', 'shown', 'undone'].includes(key) ? [key, key, key] : [key]))
      .sort()
  );
  assert.deepEqual(saved.size, 1, 'One record for the whole app');
  // Reset: zero, and saved as zero.
  assert.deepEqual(restarted.reset(), emptyConflictStats());
  assert.deepEqual(createConflictStatsStore(createMemoryStorage(saved)).get(), emptyConflictStats());
  // A count never throws, also when saved data is not ready yet.
  const broken = createConflictStatsStore({
    read: () => {
      throw new Error('Saved work is still loading');
    },
    write: () => {},
  });
  assert.deepEqual(broken.get(), emptyConflictStats());
  assert.doesNotThrow(() => broken.record([{ kind: 'session', count: 'started' }]));
});

void test('prepared buckets need the checks, and count once per conflict and session', () => {
  assert.equal(preparedBuckets(file(undefined), []), undefined, 'Not counted while the checks run');
  assert.deepEqual(preparedBuckets(file(true), []), ['merged', 'decide']);
  assert.deepEqual(preparedBuckets(file(false), []), ['check', 'decide']);
  assert.deepEqual(preparedBuckets(file(undefined, { proposals: undefined, source: 'manual', result: file(true).original }), []), ['decide', 'decide']);
  assert.equal(preparedBuckets(file(true, { unsupported: 'A binary file' }), []), undefined);
  // A verdict for other languages off does not count.
  const python = file(true);
  python.path = 'tool.py';
  assert.equal(preparedBuckets(python, ['python']), undefined);

  const first = session([file(true)]);
  const opened = countOpened(undefined, first, { restart: false, keep: false }, []);
  assert.equal(opened.changed, true);
  assert.deepEqual(opened.events, [
    { kind: 'bucket', bucket: 'merged', count: 'shown', by: 1 },
    { kind: 'bucket', bucket: 'decide', count: 'shown', by: 1 },
    { kind: 'session', count: 'started' },
  ]);
  assert.deepEqual(first.files[0].statsBuckets, { key: conflictFingerprint(first.files[0].original), buckets: ['merged', 'decide'] });
  // A reopen counts nothing again.
  assert.deepEqual(countOpened(first, structuredClone(first), { restart: false, keep: false }, []), { events: [], changed: false });
  // Load latest changes keeps the counted conflicts; a new file in it counts as shown, not as a new session.
  const reloaded = session([file(true), file(false, { path: 'other.ts' })]);
  const kept = countOpened(first, reloaded, { restart: true, keep: true }, []);
  assert.deepEqual(kept.events, [
    { kind: 'bucket', bucket: 'check', count: 'shown', by: 1 },
    { kind: 'bucket', bucket: 'decide', count: 'shown', by: 1 },
  ]);
  assert.deepEqual(reloaded.files[0].statsBuckets, first.files[0].statsBuckets);
  // Start over: a fresh merge, counted again, and one start over.
  const fresh = countOpened(first, session([file(true)]), { restart: true, keep: false }, []);
  assert.deepEqual(fresh.events.slice(-2), [{ kind: 'session', count: 'started' }, { kind: 'session', count: 'startedOver' }]);
  // A published or stale session, or one whose checks have not run, counts nothing.
  assert.deepEqual(countOpened(undefined, session([file(true)], { status: 'published' }), { restart: false, keep: false }, []).events, []);
  assert.deepEqual(countOpened(undefined, session([file(true)], { stale: true }), { restart: false, keep: false }, []).events, []);
  assert.deepEqual(countOpened(undefined, session([file(undefined)]), { restart: false, keep: false }, []).events, []);
  // Saved buckets belong to their conflict: another conflict in the file does not use them.
  const moved = file(true);
  moved.statsBuckets = { key: conflictFingerprint('other'), buckets: ['merged', 'decide'] };
  assert.equal(countOpened(undefined, session([moved]), { restart: false, keep: false }, []).events.length, 3);
});

void test('a push counts the session and each proposal pushed as is', () => {
  const s = session([file(true)]);
  countOpened(undefined, s, { restart: false, keep: false }, []);
  // You decide the second conflict; the first keeps its proposal.
  s.files[0].result = s.files[0].result.replace(/<<<<<<< feature\/secret\nconst code[\s\S]*?>>>>>>> main\n/, 'const code = "swordfish";\n');
  assert.match(s.files[0].result, /const launch = 3;\nmiddle\nconst code = "swordfish";\n$/);
  s.files[0].verdict = { key: verdictKey({ ...s.files[0] }, []), verdict: { merged: true, note: '' } };
  assert.deepEqual(countPushed(s, []), [
    { kind: 'session', count: 'pushed' },
    { kind: 'bucket', bucket: 'merged', count: 'accepted', by: 1 },
  ]);
  // The proposal replaced by a Keep is not accepted as is, also a Keep whose text equals the proposal.
  const kept = structuredClone(s);
  kept.files[0].result = kept.files[0].result.replace('const launch = 3;', 'const launch = 1;');
  assert.deepEqual(countPushed(kept, []), [{ kind: 'session', count: 'pushed' }]);
  const same = structuredClone(s);
  same.files[0].proposals = [{ source: 'mergiraf', text: 'const launch = 1;\n' }, null];
  same.files[0].result = kept.files[0].result;
  same.files[0].statsBuckets = s.files[0].statsBuckets;
  same.files[0].verdict = { key: verdictKey({ ...same.files[0] }, []), verdict: { merged: true, note: '' } };
  assert.equal(countPushed(same, []).length, 2, 'The same text without a Keep is the proposal');
  same.files[0].picks = ['ours', 'theirs'];
  assert.deepEqual(countPushed(same, []), [{ kind: 'session', count: 'pushed' }]);
  // A session never counted as shown (a restack, an older draft) is not counted at the push either.
  assert.deepEqual(countPushed(session([file(true)]), []), []);
});

void test('choices: Undo and a different option count once per conflict, in the bucket it first had', () => {
  assert.equal(choiceEvent('proposal', undefined), 'undone');
  assert.equal(choiceEvent('ours', undefined), 'undone');
  assert.equal(choiceEvent(undefined, 'ours'), undefined, 'A first choice is no change');
  assert.equal(choiceEvent(undefined, 'proposal'), undefined);
  assert.equal(choiceEvent('proposal', 'theirs'), 'rechosen');
  assert.equal(choiceEvent('ours', 'proposal'), 'rechosen');
  assert.equal(choiceEvent('ours', 'ours'), undefined);
  const sent: ConflictChoiceEvent[] = [];
  const counter = createChoiceCounter((events) => sent.push(...events));
  const f = file(true);
  f.statsBuckets = { key: conflictFingerprint(f.original), buckets: ['merged', 'decide'] };
  // Merged: Undo, Use the proposal, Undo again. One undo, and the bucket stays Merged though the screen says Check.
  counter.choice(f, 0, 'proposal', undefined, 'merged');
  counter.choice(f, 0, undefined, 'proposal', 'decide');
  counter.choice(f, 0, 'proposal', undefined, 'check');
  // Decide: a first Keep, then another: re-chosen.
  counter.choice(f, 1, undefined, 'ours', 'decide');
  counter.choice(f, 1, 'ours', 'theirs', 'decide');
  counter.choice(f, 1, 'theirs', 'both', 'decide');
  assert.deepEqual(sent, [
    { bucket: 'merged', count: 'undone' },
    { bucket: 'decide', count: 'rechosen' },
  ]);
  // Without saved buckets, the bucket on screen at the first choice.
  const unsaved = file(true, { path: 'b.ts' });
  counter.choice(unsaved, 0, 'proposal', 'ours', 'check');
  assert.deepEqual(sent.at(-1), { bucket: 'check', count: 'rechosen' });
  // Start over clears what was counted.
  counter.clear();
  counter.choice(f, 0, 'proposal', undefined, 'merged');
  assert.equal(sent.filter((e) => e.count === 'undone').length, 2);
  // Nothing of the file is sent.
  assert.equal(JSON.stringify(sent).includes('secret'), false);
  // A failing send never stops the choice.
  const failing = createChoiceCounter(() => {
    throw new Error('IPC closed');
  });
  assert.doesNotThrow(() => failing.choice(f, 0, 'proposal', undefined, 'merged'));
});
