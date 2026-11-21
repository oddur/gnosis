import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConflictPrecompute, type ConflictPrecomputeDeps } from '../src/conflict-precompute';
import { BACKGROUND_YIELDED, NO_PERMISSION } from '../src/conflict-resolution-service';
import { conflictHeader, conflictHeaderLine, NO_PUSH_LINE } from '../lib/conflict-header';
import { verdictKey } from '../lib/conflict-verdict-key';
import type { ConflictFile, ConflictSession } from '../lib/conflict-resolution';

const A = 'https://github.com/o/r/pull/1';
const B = 'https://github.com/o/r/pull/2';
const C = 'https://github.com/o/r/pull/3';
const sha = (n: number) => String(n).repeat(40);

/** A conflict with a proposal, Merged when `merged`, else in Check. */
function proposed(path: string, merged: boolean): ConflictFile {
  const original = `a\n<<<<<<< pr\nb\n||||||| base\nx\n=======\nc\n>>>>>>> main\nd\n`;
  const file: ConflictFile = {
    path,
    mode: '100644',
    base: 'a\nx\nd\n',
    ours: 'a\nb\nd\n',
    theirs: 'a\nc\nd\n',
    original,
    result: 'a\nbc\nd\n',
    resolved: false,
    source: 'mergiraf',
    proposals: [{ source: 'mergiraf', text: 'bc\n' }],
  };
  file.verdict = { key: verdictKey({ ...file }, []), verdict: { merged, note: merged ? 'Checked.' : 'Check it.' } };
  return file;
}
/** A conflict structural merge left: Decide. */
function open(path: string): ConflictFile {
  const original = `<<<<<<< pr\nb\n||||||| base\nx\n=======\nc\n>>>>>>> main\n`;
  return {
    path,
    mode: '100644',
    base: 'x\n',
    ours: 'b\n',
    theirs: 'c\n',
    original,
    result: original,
    resolved: false,
    source: 'manual',
  };
}

void test('the header line reads a prepared draft with the conflict dialog’s own status and summary (#445)', () => {
  const mixed = conflictHeader([proposed('a.ts', true), proposed('b.ts', true), open('c.ts')]);
  assert.deepEqual(mixed, {
    state: 'ready',
    sentence: '3 files have conflicts. 2 of 3 conflicts are merged and checked. 1 to decide.',
    merged: false,
  });
  // Every conflict Merged, but "Show me every merged conflict" is on: they are still to review, so no Review and push….
  const merged = conflictHeader([proposed('a.ts', true), proposed('b.ts', true)]);
  assert.equal(merged.state === 'ready' && merged.merged, false);
  assert.equal(
    conflictHeaderLine(merged),
    '2 files have conflicts. 2 of 2 conflicts are merged and checked. 2 files are ready for review.'
  );
  // With it off, Merged files are reviewed for you: nothing is left to review.
  const trusted = conflictHeader([proposed('a.ts', true), proposed('b.ts', true)], [], false);
  assert.equal(trusted.state === 'ready' && trusted.merged, true);
  // A file you reviewed leaves nothing either; one in Check does.
  const reviewed = { ...proposed('a.ts', true), resolved: true };
  const header = conflictHeader([reviewed]);
  assert.equal(header.state === 'ready' && header.merged, true);
  const toCheck = conflictHeader([proposed('a.ts', false)], [], false);
  assert.equal(toCheck.state === 'ready' && toCheck.merged, false);
  // A verdict for other proposals does not count. Nothing runs checks for a header, so the proposal is to check,
  // never "Checking…".
  const stale = proposed('a.ts', true);
  stale.proposals = [{ source: 'mergiraf', text: 'cb\n' }];
  stale.result = 'a\ncb\nd\n';
  assert.deepEqual(conflictHeader([stale]), {
    state: 'ready',
    sentence: '1 file has conflicts. 1 to check.',
    merged: false,
  });
  assert.equal(conflictHeaderLine({ state: 'checking', files: 3 }), 'Checking 3 files…');
  assert.equal(conflictHeaderLine({ state: 'checking', files: 1 }), 'Checking 1 file…');
  assert.equal(conflictHeaderLine({ state: 'checking' }), 'Checking conflicts…');
  assert.equal(conflictHeaderLine({ state: 'no-permission' }), NO_PUSH_LINE);
});

/** Fake service: each preparation waits until the test settles it. */
function harness(options: Partial<ConflictPrecomputeDeps> = {}) {
  const drafts = new Map<string, ConflictSession>();
  const pending = new Map<
    string,
    { resolve: () => void; reject: (error: Error) => void; files: (n: number) => void }
  >();
  const started: string[] = [];
  const aborted: string[] = [];
  const forgotten: string[] = [];
  const changed: string[] = [];
  let battery = false;
  let trims = 0;
  const wanted = new Set([A, B, C]);
  let account = 'oddur';
  let settings = '';
  const deps: ConflictPrecomputeDeps = {
    prepare: (url, signal, files) =>
      new Promise<ConflictSession | undefined>((resolve, reject) => {
        started.push(url);
        signal.addEventListener('abort', () => {
          aborted.push(url);
          reject(signal.reason as Error);
        });
        pending.set(url, {
          files,
          reject,
          resolve: () => {
            const session = {
              url,
              headSha: heads.get(url),
              files: [proposed('a.ts', true)],
              background: 1,
            } as ConflictSession;
            drafts.set(url, session);
            resolve(session);
          },
        });
      }),
    draft: (url, headSha) => (drafts.get(url)?.headSha === headSha ? drafts.get(url) : undefined),
    forget: (url) => {
      forgotten.push(url);
      if (drafts.get(url)?.background) drafts.delete(url);
      return Promise.resolve();
    },
    trim: () => {
      trims++;
      return Promise.resolve();
    },
    account: () => account,
    settingsKey: () => settings,
    onBattery: () => battery,
    changed: (url) => changed.push(url),
    ...options,
  };
  const heads = new Map<string, string>();
  const precompute = createConflictPrecompute(deps);
  const observe = (url: string, head: string, state: Parameters<typeof precompute.observe>[2]) => {
    heads.set(url, head);
    precompute.observe(url, head, state, wanted.has(url));
  };
  /** You look at the PR's header. */
  const open = (url: string, head: string) => {
    heads.set(url, head);
    precompute.opened(url, head);
  };
  /** Lets the run's promise chain finish. */
  const settle = async (url: string) => {
    pending.get(url)?.resolve();
    await precompute.settle(url);
  };
  return {
    precompute,
    observe,
    open,
    settle,
    signIn: (login: string) => {
      account = login;
    },
    setSettings: (value: string) => {
      settings = value;
    },
    deps,
    pending,
    started,
    aborted,
    forgotten,
    changed,
    wanted,
    drafts,
    trims: () => trims,
    setBattery: (value: boolean) => {
      battery = value;
      precompute.power();
    },
  };
}

void test('background preparation runs one PR at a time for PRs you wrote or starred, and opening reuses it', async () => {
  const h = harness();
  h.wanted.delete(C);
  h.observe(A, sha(1), 'conflicts');
  h.observe(B, sha(2), 'conflicts');
  h.observe(C, sha(3), 'conflicts');
  h.observe(A, sha(1), 'computing');
  assert.deepEqual(h.started, [A], 'One at a time; a PR you did not write or star waits for you to open it');
  assert.deepEqual(h.precompute.header(A, sha(1)), { state: 'checking', files: undefined });
  h.pending.get(A)?.files(3);
  assert.deepEqual(h.precompute.header(A, sha(1)), { state: 'checking', files: 3 });
  assert.deepEqual(
    h.precompute.header(B, sha(2)),
    { state: 'checking', files: undefined },
    'Queued counts as checking'
  );
  await h.settle(A);
  assert.deepEqual(h.started, [A, B], 'The next starts when one finishes');
  assert.equal(h.trims(), 1, 'Stored drafts are capped after each one');
  assert.equal(h.precompute.header(A, sha(1))?.state, 'ready');
  // The same head again: nothing runs twice.
  h.observe(A, sha(1), 'conflicts');
  assert.deepEqual(h.started, [A, B]);
  // Looking at C's header counts as opening it.
  h.open(C, sha(3));
  await h.settle(B);
  assert.deepEqual(h.started, [A, B, C]);
  await h.settle(C);
  assert.ok(h.changed.includes(C), 'Windows hear when a line changes');
});

void test('a new head replaces the background draft without dropping it first; a clean merge removes it', async () => {
  const h = harness();
  h.observe(A, sha(1), 'conflicts');
  h.observe(A, sha(4), 'conflicts');
  assert.deepEqual(h.aborted, [A]);
  assert.deepEqual(h.forgotten, [], 'Nothing is dropped: the new head’s preparation replaces the draft');
  // The cap holds until the stopped run has finished.
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(h.started, [A, A], 'The new head is prepared');
  await h.settle(A);
  assert.equal(h.precompute.header(A, sha(4))?.state, 'ready');
  assert.equal(h.precompute.header(A, sha(1)), undefined, 'Nothing for the old head');
  // Another head over a ready background draft: prepared, and its line shows.
  h.observe(A, sha(5), 'conflicts');
  assert.deepEqual(h.started, [A, A, A]);
  assert.equal(h.precompute.header(A, sha(5))?.state, 'checking');
  await h.settle(A);
  assert.equal(h.precompute.header(A, sha(5))?.state, 'ready');
  assert.deepEqual(h.forgotten, []);
  h.observe(A, sha(5), 'clear');
  assert.deepEqual(h.forgotten, [A]);
  assert.equal(h.drafts.has(A), false);
  assert.equal(h.precompute.header(A, sha(4)), undefined);
});

void test('on battery nothing starts, a running preparation stops, and it starts again on power', async () => {
  const h = harness();
  h.setBattery(true);
  h.observe(A, sha(1), 'conflicts');
  assert.deepEqual(h.started, []);
  assert.equal(h.precompute.header(A, sha(1)), undefined, 'A paused run shows no line');
  h.setBattery(false);
  assert.deepEqual(h.started, [A]);
  h.setBattery(true);
  assert.deepEqual(h.aborted, [A]);
  // The stopped run settles back into the queue.
  await new Promise<void>((resolve) => setImmediate(resolve));
  h.setBattery(false);
  assert.deepEqual(h.started, [A, A]);
  await h.settle(A);
  assert.equal(h.precompute.header(A, sha(1))?.state, 'ready');
});

void test('a PR you cannot push to says so, and opening the conflicts drops a queued run', async () => {
  const h = harness({ prepare: () => Promise.reject(new Error(NO_PERMISSION)) });
  h.observe(A, sha(1), 'conflicts');
  await h.precompute.settle(A);
  assert.deepEqual(h.precompute.header(A, sha(1)), { state: 'no-permission' });
  const queued = harness();
  queued.observe(A, sha(1), 'conflicts');
  queued.observe(B, sha(2), 'conflicts');
  await queued.precompute.settle(B);
  await queued.settle(A);
  assert.deepEqual(queued.started, [A], 'Your own open prepares B; the background run is dropped');
  // A draft you discarded is not prepared again in the background for the same head.
  const dismissed = harness();
  dismissed.precompute.dismiss(A, sha(1));
  dismissed.observe(A, sha(1), 'conflicts');
  assert.deepEqual(dismissed.started, []);
  dismissed.observe(A, sha(2), 'conflicts');
  assert.deepEqual(dismissed.started, [A], 'A new head is');
});

void test('the header never moves a run to its head, another account starts afresh, and cancel works while you wait', async () => {
  const h = harness();
  h.observe(A, sha(1), 'conflicts');
  // The header's head lags behind the status reads: it neither cancels the run nor prepares its own head.
  h.open(A, sha(9));
  assert.deepEqual(h.aborted, []);
  assert.deepEqual(h.started, [A]);
  // Waiting for a run to finish stops when you cancel the open.
  const controller = new AbortController();
  const waiting = h.precompute.settle(A, controller.signal);
  controller.abort();
  await assert.rejects(waiting);
  assert.deepEqual(h.aborted, [], 'The background run goes on');
  // No permission is the signed-in account's: another account's header starts afresh.
  await h.settle(A);
  const denied = harness({ prepare: () => Promise.reject(new Error(NO_PERMISSION)) });
  denied.observe(A, sha(1), 'conflicts');
  await denied.precompute.settle(A);
  assert.deepEqual(denied.precompute.header(A, sha(1)), { state: 'no-permission' });
  denied.signIn('someone-else');
  assert.equal(denied.precompute.header(A, sha(1)), undefined);
  // Only a change to the settings a line reads reads it again.
  h.changed.length = 0;
  h.precompute.header(A, sha(1));
  h.precompute.settingsChanged();
  assert.deepEqual(h.changed, [], 'Another setting changed');
  h.setSettings('yaml off');
  h.precompute.settingsChanged();
  assert.deepEqual(h.changed, [A]);
});

void test('a run that found the PR busy, or gave way to you, is tried again on the next look', async () => {
  let busy = true;
  const h = harness();
  const prepare = h.deps.prepare;
  h.deps.prepare = (url, signal, files) => (busy ? Promise.resolve(undefined) : prepare(url, signal, files));
  h.observe(A, sha(1), 'conflicts');
  await h.precompute.settle(A);
  assert.equal(h.precompute.header(A, sha(1)), undefined, 'Not "Checking…" while it waits for the next look');
  busy = false;
  h.open(A, sha(1));
  assert.equal(h.precompute.header(A, sha(1))?.state, 'checking');
  await h.settle(A);
  assert.equal(h.precompute.header(A, sha(1))?.state, 'ready');
  // A run that gave way to a request of yours is tried again too.
  const yielded = harness();
  yielded.deps.prepare = () => Promise.reject(new Error(BACKGROUND_YIELDED));
  yielded.observe(B, sha(2), 'conflicts');
  await yielded.precompute.settle(B);
  yielded.observe(B, sha(2), 'conflicts');
  assert.equal(yielded.precompute.header(B, sha(2))?.state, 'checking');
});
