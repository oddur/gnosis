import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DRIFT_SAMPLE_INTERVAL_MS,
  SYNC_HEALTH_LIMITS,
  classifyDrift,
  emptySyncHealth,
  groundTruthFrom,
  normalizeSyncHealth,
  pickDriftSample,
  recordSample,
  type GnosisView,
  type GroundTruth,
  type GroundTruthContext,
  type GroundTruthPull,
  type Finding,
} from '../lib/sync-health';
import { createDriftDetector, DRIFT_FIRST_SAMPLE_MS, SYNC_HEALTH_KEY } from '../src/drift-detector';
import { createRefreshThrottle, freshnessLabel } from '../lib/focus-refresh';
import type { StateStorage } from '../src/app-data-store';

const url = (n = 1) => `https://github.com/acme/app/pull/${n}`;
const head = 'a'.repeat(40);
const T0 = Date.parse('2026-11-15T12:00:00Z');
const minutes = (n: number) => n * 60_000;
const iso = (ms: number) => new Date(ms).toISOString().replace('.000Z', 'Z');

function truth(patch: Partial<GroundTruth> = {}): GroundTruth {
  return {
    url: url(),
    readAt: T0,
    updatedAt: iso(T0 - minutes(30)),
    state: 'open',
    isDraft: false,
    headSha: head,
    reviewDecision: 'APPROVED',
    mergeState: 'CLEAN',
    rollup: 'SUCCESS',
    checks: { state: 'success', failed: 0, running: 0, total: 3, changedAt: T0 - minutes(40) },
    unresolvedThreads: 0,
    totalComments: 4,
    approvals: 1,
    changesRequested: 0,
    changesRequestedBy: [],
    ...patch,
  };
}
const member0: NonNullable<GnosisView['member']> = {
  updatedAt: iso(T0 - minutes(30)),
  state: 'open',
  isDraft: false,
  headSha: head,
};
const signals0: NonNullable<GnosisView['signals']> = {
  checkedAt: T0 - minutes(2),
  headSha: head,
  reviewDecision: 'APPROVED',
  mergeState: 'CLEAN',
  checks: 'success',
  comments: 4,
};
function view(patch: Partial<GnosisView> = {}): GnosisView {
  return {
    url: url(),
    member: member0,
    signals: signals0,
    status: { checkedAt: T0 - minutes(2), headSha: head, approvals: 1, changesRequested: 0 },
    threads: { checkedAt: T0 - minutes(2), unresolved: 0 },
    ...patch,
  };
}
const only = (findings: Finding[]) =>
  findings.map(({ field, kind, gnosis, github }) => ({ field, kind, gnosis, github }));

// ── Classification: drift versus staleness ──

void test('agreeing views produce no findings', () => {
  assert.deepEqual(classifyDrift(view(), truth()).findings, []);
});
void test('a field GitHub has not changed since Gnosis read it is drift', () => {
  const result = classifyDrift(view({ signals: { ...signals0, checks: 'failure' } }), truth());
  assert.deepEqual(only(result.findings), [{ field: 'checks', kind: 'drift', gnosis: 'failure', github: 'success' }]);
  assert.equal(result.findings[0].ageMs, minutes(2));
});
void test('a field GitHub changed after Gnosis read it is staleness, not drift', () => {
  // The last check finished one minute ago; Gnosis read two minutes ago.
  const fresh = truth({ checks: { state: 'success', failed: 0, running: 0, total: 3, changedAt: T0 - minutes(1) } });
  const result = classifyDrift(view({ signals: { ...signals0, checks: 'pending' } }), fresh);
  assert.deepEqual(only(result.findings), [{ field: 'checks', kind: 'stale', gnosis: 'pending', github: 'success' }]);
  // updatedAt moved after the read: a new comment explains a different count.
  const moved = classifyDrift(
    view({ signals: { ...signals0, comments: 3 } }),
    truth({ updatedAt: iso(T0 - minutes(1)) })
  );
  assert.equal(moved.findings[0].kind, 'stale');
});
void test('a change within the clock-skew margin of Gnosis’s read counts as after it', () => {
  const close = truth({
    checks: { state: 'success', failed: 0, running: 0, total: 3, changedAt: T0 - minutes(2) - 30_000 },
  });
  assert.equal(classifyDrift(view({ signals: { ...signals0, checks: 'pending' } }), close).findings[0].kind, 'stale');
  const clear = truth({ checks: { state: 'success', failed: 0, running: 0, total: 3, changedAt: T0 - minutes(4) } });
  assert.equal(classifyDrift(view({ signals: { ...signals0, checks: 'pending' } }), clear).findings[0].kind, 'drift');
});
void test('queue member fields compare GitHub’s own updatedAt, so no clock is involved', () => {
  const draft = view({ member: { ...member0, isDraft: true } });
  assert.deepEqual(only(classifyDrift(draft, truth()).findings), [
    { field: 'draft', kind: 'drift', gnosis: 'yes', github: 'no' },
  ]);
  const older = view({ member: { ...member0, isDraft: true, updatedAt: iso(T0 - minutes(90)) } });
  assert.equal(classifyDrift(older, truth()).findings[0].kind, 'stale');
});
void test('signals and status for another head are not compared; the head itself is', () => {
  const pushed = truth({
    headSha: 'b'.repeat(40),
    updatedAt: iso(T0 - minutes(1)),
    checks: { state: 'pending', failed: 0, running: 2, total: 2 },
  });
  const result = classifyDrift(view(), pushed);
  assert.deepEqual(only(result.findings), [{ field: 'head', kind: 'stale', gnosis: 'aaaaaaa', github: 'bbbbbbb' }]);
});
void test('review counts compare latest opinionated reviews; attention compares GitHub’s decision', () => {
  const requested = truth({
    approvals: 0,
    changesRequested: 1,
    changesRequestedBy: ['bob'],
    reviewDecision: 'CHANGES_REQUESTED',
  });
  const result = classifyDrift(
    view({
      signals: { ...signals0, reviewDecision: 'CHANGES_REQUESTED' },
      attention: { checkedAt: T0 - minutes(2), headSha: head, checksFailed: false, changesRequested: false },
    }),
    requested
  );
  assert.deepEqual(
    only(result.findings)
      .map(({ field, kind }) => `${field}:${kind}`)
      .sort(),
    ['approvals:drift', 'attention:changes-requested:drift', 'changes-requested:drift']
  );
});
void test('fields without a change time wait for a second read after Gnosis read again', () => {
  const blocked = truth({ mergeState: 'BLOCKED' });
  const first = classifyDrift(view(), blocked);
  assert.deepEqual(only(first.findings), [
    { field: 'merge-state', kind: 'unconfirmed', gnosis: 'CLEAN', github: 'BLOCKED' },
  ]);
  assert.equal(first.suspects.length, 1);
  // Gnosis has not read the PR since: still unconfirmed, and the first read time is kept.
  const again = classifyDrift(view(), { ...blocked, readAt: T0 + minutes(15) }, first.suspects);
  assert.equal(again.findings[0].kind, 'unconfirmed');
  assert.equal(again.suspects[0].readAt, T0);
  // Gnosis read the PR after the first ground truth and still shows CLEAN: drift.
  const reread = view({ signals: { ...signals0, checkedAt: T0 + minutes(5) } });
  const confirmed = classifyDrift(reread, { ...blocked, readAt: T0 + minutes(15) }, first.suspects);
  assert.equal(confirmed.findings[0].kind, 'drift');
  assert.deepEqual(confirmed.suspects, []);
  // GitHub moved to another value meanwhile: a new suspect, not drift.
  const other = classifyDrift(reread, { ...truth({ mergeState: 'BEHIND' }), readAt: T0 + minutes(15) }, first.suspects);
  assert.equal(other.findings[0].kind, 'unconfirmed');
});
void test('UNKNOWN merge state is GitHub computing, never a mismatch', () => {
  assert.deepEqual(classifyDrift(view(), truth({ mergeState: 'UNKNOWN' })).findings, []);
});
void test('comments compare totalCommentsCount with the badge: signals first, else the REST counts', () => {
  // Signals carry totalCommentsCount since #347: 24 matches.
  assert.deepEqual(
    classifyDrift(view({ signals: { ...signals0, comments: 24 } }), truth({ totalComments: 24 })).findings,
    []
  );
  // Without signals the badge adds the REST conversation and inline counts; the queue copy's revision decides.
  const fallback = view({ signals: undefined, member: { ...member0, comments: 4 } });
  assert.deepEqual(only(classifyDrift(fallback, truth({ totalComments: 24 })).findings), [
    { field: 'comments', kind: 'drift', gnosis: '4', github: '24' },
  ]);
  const older = view({ signals: undefined, member: { ...member0, comments: 4, updatedAt: iso(T0 - minutes(90)) } });
  assert.equal(
    classifyDrift(older, truth({ totalComments: 24 })).findings.find((f) => f.field === 'comments')?.kind,
    'stale'
  );
  // With signals for this head, the REST fallback is not what Gnosis shows, so it is not compared.
  assert.deepEqual(classifyDrift(view({ member: { ...member0, comments: 4 } }), truth()).findings, []);
});

// ── Ground truth ──

const run = (id: number, workflow = 7, event = 'pull_request') => ({
  workflowRun: { databaseId: id, event, workflow: { databaseId: workflow } },
});
const check = (conclusion: string | null, suite = run(2), at = '2026-11-15T11:00:00Z'): GroundTruthContext => ({
  __typename: 'CheckRun',
  status: conclusion ? 'COMPLETED' : 'IN_PROGRESS',
  conclusion,
  startedAt: at,
  completedAt: conclusion ? at : null,
  checkSuite: suite,
});
function pull(contexts: GroundTruthContext[], patch: Partial<GroundTruthPull> = {}): GroundTruthPull {
  return {
    updatedAt: '2026-11-15T10:00:00Z',
    state: 'OPEN',
    merged: false,
    isDraft: false,
    headRefOid: head,
    reviewDecision: null,
    mergeStateStatus: 'CLEAN',
    totalCommentsCount: 24,
    reviewThreads: { totalCount: 3, nodes: [{ isResolved: false }, { isResolved: true }, { isResolved: false }] },
    latestOpinionatedReviews: {
      nodes: [
        { state: 'CHANGES_REQUESTED', author: { login: 'bob' } },
        { state: 'APPROVED', author: { login: 'eve' } },
      ],
    },
    commits: {
      nodes: [
        {
          commit: {
            oid: head,
            statusCheckRollup: { state: 'FAILURE', contexts: { totalCount: contexts.length, nodes: contexts } },
          },
        },
      ],
    },
    ...patch,
  };
}
void test('ground truth leaves out superseded workflow runs and reads GitHub’s own counts', () => {
  const value = groundTruthFrom(
    url(),
    pull([
      check('CANCELLED', run(1)),
      check('FAILURE', run(1)),
      check('SUCCESS', run(2), '2026-11-15T11:30:00Z'),
      { __typename: 'StatusContext', state: 'SUCCESS', createdAt: '2026-11-15T09:00:00Z' },
    ]),
    T0
  );
  assert.equal(value.rollup, 'FAILURE');
  assert.deepEqual(value.checks, {
    state: 'success',
    failed: 0,
    running: 0,
    total: 2,
    changedAt: Date.parse('2026-11-15T11:30:00Z'),
  });
  assert.equal(value.unresolvedThreads, 2);
  assert.equal(value.totalComments, 24);
  assert.deepEqual([value.approvals, value.changesRequested, value.changesRequestedBy], [1, 1, ['bob']]);
  assert.equal(groundTruthFrom(url(), pull([check(null)]), T0).checks?.state, 'pending');
  assert.equal(groundTruthFrom(url(), pull([], { state: 'MERGED', merged: true }), T0).state, 'merged');
});
void test('over 100 checks or threads, ground truth claims only what it can see', () => {
  const partial = (state: string) =>
    pull([], {
      reviewThreads: { totalCount: 120, nodes: [{ isResolved: false }] },
      commits: {
        nodes: [
          {
            commit: {
              oid: head,
              statusCheckRollup: { state, contexts: { totalCount: 140, nodes: [check('FAILURE')] } },
            },
          },
        ],
      },
    });
  const value = groundTruthFrom(url(), partial('FAILURE'), T0);
  assert.equal(value.checks, undefined);
  assert.equal(value.unresolvedThreads, undefined);
  assert.equal(groundTruthFrom(url(), partial('SUCCESS'), T0).checks?.state, 'success');
});

// ── Sampling limits ──

void test('a sample takes at most three PRs: suspects, then recently seen, then the queue', () => {
  const candidates = [
    ...Array.from({ length: 10 }, (_, i) => ({ url: url(i + 1), inQueue: true })),
    { url: url(20), inQueue: false, seenAt: T0 - minutes(5) },
    { url: url(21), inQueue: true, seenAt: T0 - minutes(1) },
  ];
  const suspects = [{ url: url(7), field: 'merge-state' as const, github: 'BLOCKED', readAt: T0 - minutes(20) }];
  assert.deepEqual(pickDriftSample({ candidates, sampledAt: { [url(7)]: T0 - minutes(20) }, suspects, now: T0 }), [
    url(7),
    url(21),
    url(20),
  ]);
  assert.equal(pickDriftSample({ candidates, sampledAt: {}, suspects: [], now: T0, limit: 5 }).length, 5);
  // Sampled within the hour: skipped, so the queue is covered over time.
  const sampledAt = Object.fromEntries(candidates.slice(0, 9).map((candidate) => [candidate.url, T0 - minutes(10)]));
  assert.deepEqual(pickDriftSample({ candidates: candidates.slice(0, 10), sampledAt, suspects: [], now: T0 }), [
    url(10),
  ]);
  assert.deepEqual(pickDriftSample({ candidates: [], sampledAt: {}, suspects, now: T0 }), []);
  // A suspect is confirmed only after a pause, never in the same breath.
  assert.deepEqual(
    pickDriftSample({
      candidates: [{ url: url(7), inQueue: true }],
      sampledAt: { [url(7)]: T0 - minutes(1) },
      suspects,
      now: T0,
    }),
    []
  );
});

// ── Store bounds ──

const finding = (n: number, field: Finding['field'] = 'checks'): Finding => ({
  url: url(n),
  field,
  source: 'signals',
  gnosis: 'failure',
  github: 'success',
  ageMs: 1000,
  kind: 'drift',
});
void test('the saved state stays within its limits and repeats update their row', () => {
  let state = emptySyncHealth();
  for (let i = 0; i < 70; i++)
    state = recordSample(state, { at: T0 + i, trigger: 'background', cost: 3 }, [
      {
        url: url(i * 3 + 1),
        readAt: T0 + i,
        findings: [finding(i * 3 + 1), { ...finding(i * 3 + 1, 'merge-state'), kind: 'unconfirmed' }],
        suspects: [{ url: url(i * 3 + 1), field: 'merge-state', github: 'BLOCKED', readAt: T0 }],
      },
      {
        url: url(i * 3 + 2),
        readAt: T0 + i,
        findings: [finding(i * 3 + 2), { ...finding(i * 3 + 2, 'comments'), kind: 'stale' }],
      },
      { url: url(i * 3 + 3), readAt: T0 + i },
    ]);
  assert.equal(state.drifts.length, SYNC_HEALTH_LIMITS.drifts);
  assert.equal(state.stale.length, SYNC_HEALTH_LIMITS.stale);
  assert.equal(state.runs.length, SYNC_HEALTH_LIMITS.runs);
  assert.equal(state.suspects.length, SYNC_HEALTH_LIMITS.suspects);
  assert.equal(Object.keys(state.sampledAt).length, SYNC_HEALTH_LIMITS.sampled);
  assert.deepEqual(state.runs[0], {
    at: T0 + 69,
    trigger: 'background',
    cost: 3,
    sampled: 3,
    drift: 2,
    stale: 2,
    failed: 1,
  });
  assert.equal(state.drifts[0].url, url(209), 'Newest first');
  // The same mismatch again: one row, counted.
  const again = recordSample(state, { at: T0 + 100, trigger: 'manual', cost: 1 }, [
    { url: url(209), readAt: T0 + 100, findings: [finding(209)] },
  ]);
  assert.equal(again.drifts.length, SYNC_HEALTH_LIMITS.drifts);
  assert.deepEqual(
    [again.drifts[0].count, again.drifts[0].lastSeenAt, again.drifts[0].firstSeenAt],
    [2, T0 + 100, T0 + 69]
  );
  // Reading a PR again replaces its suspects.
  const suspect = again.suspects.find((item) => item.url === url(208));
  assert.ok(suspect);
  const cleared = recordSample(again, { at: T0 + 200, trigger: 'manual', cost: 1 }, [
    { url: url(208), readAt: T0 + 200, findings: [], suspects: [] },
  ]);
  assert.equal(
    cleared.suspects.some((item) => item.url === url(208)),
    false
  );
});
void test('saved state is validated and cut to its limits', () => {
  const saved = recordSample(emptySyncHealth(), { at: T0, trigger: 'manual', cost: 1 }, [
    { url: url(), readAt: T0, findings: [finding(1)] },
  ]);
  assert.deepEqual(normalizeSyncHealth(JSON.parse(JSON.stringify(saved))), saved);
  const hostile = {
    ...saved,
    enabled: false,
    drifts: [
      ...saved.drifts,
      { ...saved.drifts[0], url: 'https://evil.example/pull/1' },
      { ...saved.drifts[0], field: 'nope' },
      ...Array.from({ length: 300 }, () => saved.drifts[0]),
    ],
  };
  const normalized = normalizeSyncHealth(hostile);
  assert.equal(normalized.enabled, false);
  assert.equal(normalized.drifts.length, SYNC_HEALTH_LIMITS.drifts);
  assert.ok(normalized.drifts.every((row) => row.url === url()));
  assert.deepEqual(normalizeSyncHealth({ version: 2 }), emptySyncHealth());
  assert.deepEqual(normalizeSyncHealth('junk'), emptySyncHealth());
});

// ── The detector: rare, bounded, never while idle ──

function memoryStorage(initial?: unknown): StateStorage & { saved: Map<string, unknown> } {
  const saved = new Map<string, unknown>(initial === undefined ? [] : [[SYNC_HEALTH_KEY, initial]]);
  return {
    saved,
    read: (name) => structuredClone(saved.get(name)),
    take: (name) => saved.get(name),
    write: (name, value) => {
      saved.set(name, structuredClone(value));
    },
    patch: () => {},
    flush: () => Promise.resolve(),
  };
}
function detector(options: { active?: boolean; queue?: string[]; enabled?: boolean } = {}) {
  let now = T0,
    active = options.active ?? true;
  const reads: { url: string; trigger: string }[] = [];
  const lines: string[] = [];
  const storage = memoryStorage(options.enabled === false ? { ...emptySyncHealth(), enabled: false } : undefined);
  const d = createDriftDetector({
    storage,
    now: () => now,
    active: () => active,
    available: () => true,
    queue: () => options.queue ?? Array.from({ length: 8 }, (_, i) => url(i + 1)),
    view: (target) => Promise.resolve(view({ url: target, signals: { ...signals0, checks: 'failure' } })),
    read: (target, trigger) => {
      reads.push({ url: target, trigger });
      return Promise.resolve({ truth: truth({ url: target, readAt: now }), cost: 1 });
    },
    log: (line) => lines.push(line),
  });
  return {
    d,
    reads,
    lines,
    storage,
    time: (ms: number) => {
      now = ms;
    },
    active: (value: boolean) => {
      active = value;
    },
  };
}
void test('nothing runs while sync is idle, before the first delay or before the interval', async () => {
  const f = detector({ active: false });
  await f.d.tick();
  f.time(T0 + DRIFT_FIRST_SAMPLE_MS + 1);
  await f.d.tick();
  await f.d.tick();
  assert.equal(f.reads.length, 0, 'Idle: no reads even when due');
  f.active(true);
  f.time(T0 + 1000);
  const early = detector();
  await early.d.tick();
  assert.equal(early.reads.length, 0, 'Not before the first delay');
  early.time(T0 + DRIFT_FIRST_SAMPLE_MS);
  await early.d.tick();
  assert.equal(early.reads.length, 3, 'At most three PRs per sample');
  assert.ok(early.reads.every((read) => read.trigger === 'background'));
  early.time(T0 + DRIFT_FIRST_SAMPLE_MS + DRIFT_SAMPLE_INTERVAL_MS - 1);
  await early.d.tick();
  assert.equal(early.reads.length, 3, 'Not again before the interval');
  early.time(T0 + DRIFT_FIRST_SAMPLE_MS + DRIFT_SAMPLE_INTERVAL_MS);
  await early.d.tick();
  assert.equal(early.reads.length, 6);
  assert.equal(new Set(early.reads.map((read) => read.url)).size, 6, 'The next sample takes other PRs');
});
void test('a disabled detector never samples in the background; Check now still works', async () => {
  const f = detector({ enabled: false });
  f.time(T0 + DRIFT_FIRST_SAMPLE_MS * 10);
  await f.d.tick();
  assert.equal(f.reads.length, 0);
  const snapshot = await f.d.checkNow([url(42)]);
  assert.deepEqual(f.reads.map((read) => [read.url, read.trigger])[0], [url(42), 'manual']);
  assert.equal(f.reads.length, 3);
  assert.equal(snapshot.runs[0].trigger, 'manual');
  assert.equal(snapshot.drifts.length, 3);
  assert.ok(
    f.lines.some((line) => /Drift acme\/app#42 Checks: Gnosis failure, GitHub success/.test(line)),
    'Each mismatch is logged'
  );
  const saved = normalizeSyncHealth(f.storage.saved.get(SYNC_HEALTH_KEY));
  assert.equal(saved.drifts.length, 3, 'Saved locally');
});
void test('a failed read is recorded without findings and does not stop the sample', async () => {
  const storage = memoryStorage();
  let calls = 0;
  const d = createDriftDetector({
    storage,
    now: () => T0,
    active: () => true,
    available: () => true,
    queue: () => [url(1), url(2)],
    view: (target) => Promise.resolve(view({ url: target })),
    read: (target) =>
      ++calls === 1
        ? Promise.reject(new Error('rate limited'))
        : Promise.resolve({ truth: truth({ url: target }), cost: 1 }),
    log: () => {},
  });
  const snapshot = await d.checkNow();
  assert.deepEqual([snapshot.runs[0].sampled, snapshot.runs[0].failed, snapshot.runs[0].cost], [2, 1, 1]);
});

// ── Freshness ──

void test('the open PR refreshes at most every 30 seconds per PR', () => {
  let now = 0;
  const throttle = createRefreshThrottle(30_000, () => now);
  assert.deepEqual(throttle.take([url(1)]), [url(1)]);
  now = 10_000;
  assert.deepEqual(throttle.take([url(1), url(2)]), [url(2)]);
  now = 29_999;
  assert.deepEqual(throttle.take([url(1)]), []);
  now = 30_000;
  assert.deepEqual(throttle.take([url(1), url(1)]), [url(1)]);
});
void test('freshness labels', () => {
  assert.equal(freshnessLabel(T0, T0 + 20_000), 'Checked just now');
  assert.equal(freshnessLabel(T0, T0 + minutes(2)), 'Checked 2m ago');
  assert.equal(freshnessLabel(T0, T0 + minutes(125)), 'Checked 2h ago');
  assert.equal(freshnessLabel(T0, T0 + minutes(60 * 50)), 'Checked 2d ago');
  assert.equal(freshnessLabel(T0 + 5000, T0), 'Checked just now', 'A clock step backwards is not negative');
});
void test('the detector waits for saved work to load and never overwrites it before then', async () => {
  const saved = recordSample(emptySyncHealth(), { at: T0, trigger: 'manual', cost: 1 }, [
    { url: url(), readAt: T0, findings: [finding(1)] },
  ]);
  const storage = memoryStorage(saved);
  let ready = false;
  const reads: string[] = [];
  const d = createDriftDetector({
    storage: {
      ...storage,
      read: (name) => {
        if (!ready) throw new Error('Saved work is still loading');
        return storage.read(name);
      },
    },
    now: () => T0 + DRIFT_FIRST_SAMPLE_MS,
    active: () => true,
    available: () => true,
    queue: () => [url(2)],
    view: (target) => Promise.resolve(view({ url: target })),
    read: (target) => {
      reads.push(target);
      return Promise.resolve({ truth: truth({ url: target }), cost: 1 });
    },
    log: () => {},
  });
  assert.equal(d.snapshot().drifts.length, 0);
  await d.tick();
  await d.checkNow();
  d.setEnabled(false);
  assert.deepEqual(reads, []);
  assert.deepEqual(normalizeSyncHealth(storage.saved.get(SYNC_HEALTH_KEY)), saved, 'Untouched while loading');
  ready = true;
  assert.equal(d.snapshot().drifts.length, 1);
  await d.checkNow();
  assert.deepEqual(reads, [url(2)]);
  assert.equal(normalizeSyncHealth(storage.saved.get(SYNC_HEALTH_KEY)).runs.length, 2, 'The saved runs are kept');
});
