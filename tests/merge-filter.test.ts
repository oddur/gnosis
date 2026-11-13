import test from 'node:test';
import assert from 'node:assert/strict';
import {
  activeQueueFilterCount,
  countBriefings,
  DEFAULT_QUEUE_FILTERS,
  describeQueueFilters,
  matchesQueueFilters,
  mergeFilterCandidates,
  normalizeQueueFilters,
  prioritizeBriefings,
  type QueueFilters,
} from '../lib/queue-filters';
import {
  countUnsettled,
  mergeConflictState,
  mergeStates,
  mergeStateSignature,
  parseMergeStateSignature,
  type MergeConflictState,
} from '../lib/merge-conflicts';
import { applyViewAction, activeViewFilters, normalizeViews, viewIsModified } from '../lib/saved-views';
import { matchingStackMembers } from '../lib/stack-workspace';
import { groupSubjects, type QueueItem, type ReviewMember } from '../lib/workbench';
import { queueSignalKey, type QueueSignalOptions, type QueueSignalRequest, type QueueSignals } from '../lib/queue-signals';
import { createGitHubClientPool } from '../lib/github-client';
import { createQueueSignalsService } from '../src/queue-signals-service';
import { signalValue } from '../lib/queue-signal-store';
import { loadMergeSignals } from '../lib/use-queue-signals';

const now = Date.parse('2026-11-13T12:00:00Z');
const member = (n: number, patch: Partial<ReviewMember> = {}): ReviewMember => ({
  number: n,
  repo: 'owner/repo',
  baseRepo: 'owner/repo',
  headRepo: 'owner/repo',
  url: `https://github.com/owner/repo/pull/${n}`,
  title: `PR ${n}`,
  description: '',
  author: 'alice',
  role: 'watched',
  baseBranch: 'main',
  headBranch: `pr-${n}`,
  baseSha: 'base',
  headSha: `head-${n}`,
  merged: false,
  state: 'open',
  createdAt: '2026-11-12T12:00:00Z',
  updatedAt: '2026-11-13T10:00:00Z',
  labels: [],
  mergeable: true,
  isDraft: false,
  commitCount: 1,
  requestedReviewers: [],
  requestedTeams: [],
  mergeableState: 'clean',
  autoMerge: null,
  milestone: null,
  ...patch,
});
const item = (members: ReviewMember[]): QueueItem => ({ subject: groupSubjects(members)[0], attention: 'other' });
const signals = (m: Pick<ReviewMember, 'url' | 'headSha'>, mergeable: string, mergeState: string): QueueSignals => ({
  url: m.url,
  headSha: m.headSha,
  checkedAt: now,
  comments: 0,
  checks: { state: 'success', passed: 1, total: 1 },
  readiness: { state: 'OPEN', isDraft: false, mergeable, mergeState, reviewDecision: null, baseBranch: 'main', baseSha: 'base', behindBy: 0, mergeQueue: false, queueState: null },
});
const states = (entries: [ReviewMember, MergeConflictState][]) =>
  new Map(entries.map(([m, state]) => [queueSignalKey(m), state]));
const conflicts: QueueFilters = { ...DEFAULT_QUEUE_FILTERS, merge: 'conflicts' };

void test('merge filter parses, defaults to any, counts as active and has a removable chip', () => {
  assert.equal(DEFAULT_QUEUE_FILTERS.merge, 'all');
  assert.equal(normalizeQueueFilters(undefined).merge, 'all');
  assert.equal(normalizeQueueFilters({ merge: 'conflicts' }).merge, 'conflicts');
  assert.equal(normalizeQueueFilters({ merge: 'CONFLICTING' }).merge, 'all', 'Unknown values fall back to any');
  assert.equal(normalizeQueueFilters({ merge: true }).merge, 'all');
  assert.equal(activeQueueFilterCount(DEFAULT_QUEUE_FILTERS), 0);
  assert.equal(activeQueueFilterCount(conflicts), 1);
  assert.deepEqual(describeQueueFilters(conflicts), [{ key: 'merge', label: 'Merge conflicts' }]);
  assert.deepEqual(describeQueueFilters(DEFAULT_QUEUE_FILTERS), []);
});

void test('GitHub merge fields map to conflict states, including DIRTY while mergeable is UNKNOWN', () => {
  const m = member(1);
  assert.equal(mergeConflictState(signals(m, 'CONFLICTING', 'DIRTY')), 'conflicts');
  assert.equal(mergeConflictState(signals(m, 'UNKNOWN', 'DIRTY')), 'conflicts');
  assert.equal(mergeConflictState(signals(m, 'CONFLICTING', 'UNKNOWN')), 'conflicts');
  assert.equal(mergeConflictState(signals(m, 'UNKNOWN', 'UNKNOWN')), 'computing');
  assert.equal(mergeConflictState(signals(m, 'MERGEABLE', 'BLOCKED')), 'clear');
  assert.equal(mergeConflictState(signals(m, 'MERGEABLE', 'BEHIND')), 'clear');
  assert.equal(mergeConflictState(undefined), 'unchecked');
  assert.equal(mergeConflictState({ ...signals(m, 'MERGEABLE', 'CLEAN'), readiness: undefined }), 'unchecked', 'Older cache entries have no readiness');
  const other = member(2);
  const map = mergeStates([m, other], [signals(m, 'UNKNOWN', 'DIRTY'), signals({ ...other, headSha: 'old' }, 'CONFLICTING', 'DIRTY')]);
  assert.equal(map.get(queueSignalKey(m)), 'conflicts');
  assert.equal(map.get(queueSignalKey(other)), 'unchecked', 'A previous revision never decides the current one');
});

void test('a PR matches only when GitHub reports conflicts for its current revision', () => {
  const m = member(1);
  const pr = item([m]);
  assert.equal(matchesQueueFilters(pr, conflicts, now, null, states([[m, 'conflicts']])), true);
  assert.equal(matchesQueueFilters(pr, conflicts, now, null, states([[m, 'clear']])), false);
  assert.equal(matchesQueueFilters(pr, conflicts, now, null, states([[m, 'computing']])), false, 'Unknown is not listed');
  assert.equal(matchesQueueFilters(pr, conflicts, now, null, states([[m, 'unchecked']])), false);
  assert.equal(matchesQueueFilters(pr, conflicts, now, null), false, 'Without loaded states nothing is known to conflict');
  assert.equal(matchesQueueFilters(pr, DEFAULT_QUEUE_FILTERS, now, null), true, 'Off, merge state is ignored');
  const closed = item([member(3, { state: 'closed' })]);
  assert.equal(matchesQueueFilters(closed, { ...conflicts, starredOnly: true }, now, null, states([[closed.subject.members[0], 'conflicts']])), false, 'A closed PR has nothing to merge');
});

void test('a stack with one conflicting open member matches and stays whole; a clean stack does not', () => {
  const [a, b, c] = [member(1), member(2, { baseBranch: 'pr-1' }), member(3, { baseBranch: 'pr-2' })];
  const stack = item([a, b, c]);
  assert.equal(stack.subject.kind, 'stack');
  const merge = states([[a, 'clear'], [b, 'conflicts'], [c, 'computing']]);
  assert.equal(matchesQueueFilters(stack, conflicts, now, null, merge), true);
  assert.equal(stack.subject.members.length, 3, 'The whole stack stays visible');
  assert.deepEqual(matchingStackMembers(stack, conflicts, null, now, merge), [b.url]);
  assert.equal(matchesQueueFilters(stack, conflicts, now, null, states([[a, 'clear'], [b, 'clear'], [c, 'computing']])), false);
  // One open PR must match every filter: the conflicting PR is bob's, so alice's clean PR cannot carry it.
  const mixed = item([member(4), member(5, { baseBranch: 'pr-4', author: 'bob' })]);
  const mixedStates = states([[mixed.subject.members[0], 'clear'], [mixed.subject.members[1], 'conflicts']]);
  assert.equal(matchesQueueFilters(mixed, { ...conflicts, author: 'alice' }, now, null, mixedStates), false);
  assert.equal(matchesQueueFilters(mixed, { ...conflicts, author: 'bob' }, now, null, mixedStates), true);
});

void test('candidates are open PRs that match every other filter, and none while the filter is off', () => {
  const items = [item([member(1)]), item([member(2, { author: 'bob' })]), item([member(3, { state: 'closed' })]), item([member(4, { headSha: '' })])];
  assert.equal(mergeFilterCandidates(items, DEFAULT_QUEUE_FILTERS, now).length, 0);
  assert.deepEqual(mergeFilterCandidates(items, conflicts, now).map((request) => request.url), [member(1).url, member(2).url]);
  assert.deepEqual(mergeFilterCandidates(items, { ...conflicts, author: 'bob' }, now).map((request) => request.url), [member(2).url]);
});

void test('unknown PRs are counted, not listed, and briefing counts use the same states as the list', () => {
  const [a, b, c, d] = [member(1), member(2), member(3), member(4)];
  const items = [item([a]), item([b]), item([c]), item([d])];
  items[0].briefing = { key: 'a', status: 'ready', updatedAt: '' };
  items[1].briefing = { key: 'b', status: 'failed', updatedAt: '' };
  const merge = states([[a, 'conflicts'], [b, 'conflicts'], [c, 'computing']]);
  assert.deepEqual(countUnsettled([a, b, c, d], merge), { computing: 1, unchecked: 1 });
  const listed = items.filter((entry) => matchesQueueFilters(entry, conflicts, now, null, merge));
  assert.equal(listed.length, 2);
  const counts = countBriefings(items, { ...conflicts, briefing: 'ready' }, now, null, merge);
  assert.equal(counts.all, 2);
  assert.equal(counts.ready, 1);
  assert.equal(counts.failed, 1);
  assert.deepEqual(prioritizeBriefings(items, conflicts, now, null, [], merge).map((entry) => entry.subject.id), listed.map((entry) => entry.subject.id));
});

void test('the state signature changes only when a state changes', () => {
  const [a, b] = [member(1), member(2)];
  const values = new Map([[queueSignalKey(a), signals(a, 'CONFLICTING', 'DIRTY')]]);
  const first = mergeStateSignature([a, b], (request) => values.get(queueSignalKey(request)));
  values.set(queueSignalKey(a), { ...signals(a, 'CONFLICTING', 'DIRTY'), checkedAt: now + 60_000, comments: 4 });
  assert.equal(mergeStateSignature([a, b], (request) => values.get(queueSignalKey(request))), first, 'A status refresh with the same state renders nothing');
  values.set(queueSignalKey(b), signals(b, 'UNKNOWN', 'UNKNOWN'));
  const second = mergeStateSignature([a, b], (request) => values.get(queueSignalKey(request)));
  assert.notEqual(second, first);
  assert.deepEqual([...parseMergeStateSignature([a, b], second).values()], ['conflicts', 'computing']);
});

void test('saved views keep the merge filter through storage', () => {
  let id = 0;
  let state = normalizeViews(null, { merge: 'conflicts', author: 'alice' });
  state = applyViewAction(state, { type: 'create', name: 'Conflicts' }, () => String(++id));
  const restored = normalizeViews(JSON.parse(JSON.stringify(state)));
  assert.equal(activeViewFilters(restored).merge, 'conflicts');
  assert.equal(restored.views[0].filters.merge, 'conflicts');
  assert.equal(viewIsModified(restored.views[0]), false);
  const legacy = normalizeViews({ views: [{ id: 'old', name: 'Old', filters: { author: 'bob' } }], activeId: 'old' });
  assert.equal(activeViewFilters(legacy).merge, 'all', 'Views saved before the filter existed keep showing every PR');
});

/** A GitHub GraphQL fake that answers every aliased PR in a batch and records each request. */
function fakeGitHub(mergeable: (number: number, attempt: number) => string) {
  const batches: { numbers: number[]; query: string }[] = [];
  const attempts = new Map<number, number>();
  // The client paces requests by sleeping; the fake clock advances instead of waiting.
  let clock = now;
  const pool = createGitHubClientPool({
    now: () => clock,
    sleep: (ms) => { clock += ms; return Promise.resolve(); },
    fetch: ((_url, init) => {
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as { query?: string }) : {};
      const query = body.query ?? '';
      const data: Record<string, unknown> = { rateLimit: { cost: 1 } };
      const numbers: number[] = [];
      for (const match of query.matchAll(/(p\d+): repository\(owner:"[^"]+",name:"[^"]+"\) \{ pullRequest\(number:(\d+)\) \{[\s\S]*?compare\(headRef:"([^"]+)"\)/g)) {
        const number = Number(match[2]);
        numbers.push(number);
        const attempt = (attempts.get(number) ?? 0) + 1;
        attempts.set(number, attempt);
        const state = mergeable(number, attempt);
        data[match[1]] = {
          pullRequest: {
            headRefOid: match[3], state: 'OPEN', isDraft: false, mergeable: state,
            mergeStateStatus: state === 'CONFLICTING' ? 'DIRTY' : state === 'UNKNOWN' ? 'UNKNOWN' : 'CLEAN',
            reviewDecision: null, baseRefName: 'main', baseRefOid: 'base', baseRef: { compare: { behindBy: 0 } },
            mergeQueue: null, mergeQueueEntry: null, comments: { totalCount: 0 }, reviews: { nodes: [] },
            commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
          },
        };
      }
      batches.push({ numbers, query });
      return Promise.resolve(new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } }));
    }) as typeof fetch,
  });
  const client = pool.client(`fixture-${Math.random()}`);
  const service = createQueueSignalsService(() => clock);
  const calls: { requests: QueueSignalRequest[]; options?: QueueSignalOptions }[] = [];
  // The renderer reaches the service through IPC; this stands in for the preload bridge.
  Object.assign(globalThis, {
    window: {
      electronAPI: {
        getQueueSignals: (requests: QueueSignalRequest[], options?: QueueSignalOptions) => {
          calls.push({ requests, options });
          return service(client, requests, options);
        },
      },
    },
  });
  return { batches, calls };
}
let scopes = 0;
const scope = () => `merge-filter-${++scopes}`;
const queue = (count: number) => Array.from({ length: count }, (_, i) => item([member(i + 1)]));

void test('status loads for every candidate only while the filter is on, in batches of 25', async () => {
  const github = fakeGitHub((number) => (number % 10 === 0 ? 'CONFLICTING' : 'MERGEABLE'));
  const items = queue(60);
  const account = scope();
  const run = (filters: QueueFilters) =>
    loadMergeSignals(account, mergeFilterCandidates(items, filters, now), { cancelled: () => false, rechecked: new Set(), delay: () => Promise.resolve() });

  await run(DEFAULT_QUEUE_FILTERS);
  assert.equal(github.batches.length, 0, 'Off: no GitHub requests at all');
  assert.equal(github.calls.length, 0, 'Off: not even a saved-status read');

  await run(conflicts);
  assert.equal(github.batches.length, 3, 'On: 60 PRs in ceil(60 / 25) GraphQL requests');
  assert.ok(github.batches.every((batch) => batch.numbers.length <= 25));
  assert.deepEqual(github.batches.flatMap((batch) => batch.numbers).sort((a, b) => a - b), Array.from({ length: 60 }, (_, i) => i + 1));
  const merge = mergeStates(items.flatMap((entry) => entry.subject.members), items.flatMap((entry) => entry.subject.members.flatMap((m) => signalValue(account, m) ?? [])));
  assert.equal(items.filter((entry) => matchesQueueFilters(entry, conflicts, now, null, merge)).length, 6);

  await run(conflicts);
  assert.equal(github.batches.length, 3, 'Loaded revisions are not requested again');
  const pushed = items.map((entry, i) => (i === 0 ? item([member(1, { headSha: 'force-pushed' })]) : entry));
  await loadMergeSignals(account, mergeFilterCandidates(pushed, conflicts, now), { cancelled: () => false, rechecked: new Set(), delay: () => Promise.resolve() });
  assert.deepEqual(github.batches.slice(3).map((batch) => batch.numbers), [[1]], 'A new head SHA loads just that PR');
});

void test('saved status for the current revision is reused without GitHub', async () => {
  const first = fakeGitHub(() => 'MERGEABLE');
  const items = queue(5);
  await loadMergeSignals(scope(), mergeFilterCandidates(items, conflicts, now), { cancelled: () => false, rechecked: new Set(), delay: () => Promise.resolve() });
  assert.equal(first.batches.length, 1);
  // A fresh renderer store: saved status comes from the main-process cache as a cached-only read.
  const calls = first.calls.length;
  await loadMergeSignals(scope(), mergeFilterCandidates(items, conflicts, now), { cancelled: () => false, rechecked: new Set(), delay: () => Promise.resolve() });
  assert.equal(first.batches.length, 1, 'Saved status needs no GitHub request');
  assert.ok(first.calls.slice(calls).every((call) => call.options?.cachedOnly), 'Only cached-only reads');
});

void test('PRs GitHub is still computing are re-checked once after a delay, then counted', async () => {
  const github = fakeGitHub((number, attempt) => (number <= 3 ? (number === 1 && attempt > 1 ? 'CONFLICTING' : 'UNKNOWN') : 'MERGEABLE'));
  const items = queue(30);
  const account = scope();
  const candidates = mergeFilterCandidates(items, conflicts, now);
  const phases: string[] = [];
  const delays: number[] = [];
  const rechecked = new Set<string>();
  const options = { cancelled: () => false, rechecked, onPhase: (phase: string) => phases.push(phase), delay: (ms: number) => { delays.push(ms); return Promise.resolve(); } };
  await loadMergeSignals(account, candidates, options);
  assert.deepEqual(phases, ['loading', 'waiting', 'rechecking', 'done']);
  assert.equal(delays.length, 1);
  assert.ok(delays[0] > 0 && delays[0] <= 30_000, 'A short delay');
  assert.deepEqual(github.batches.map((batch) => batch.numbers.length), [25, 5, 3], 'The re-check asks only for the 3 unknown PRs');
  assert.ok(github.calls.at(-1)?.options?.recheckMerge);
  const states = mergeStates(candidates, candidates.flatMap((request) => signalValue(account, request) ?? []));
  assert.deepEqual(countUnsettled(candidates, states), { computing: 2, unchecked: 0 });
  assert.equal(states.get(queueSignalKey(candidates[0])), 'conflicts', 'A PR GitHub finished computing joins the list');

  phases.length = 0;
  await loadMergeSignals(account, candidates, options);
  assert.equal(github.batches.length, 3, 'Each PR is re-checked at most once per filter session');
  assert.deepEqual(phases, ['loading', 'done']);
});

void test('the service re-checks only revisions GitHub was still computing', async () => {
  const github = fakeGitHub((number, attempt) => (number === 1 && attempt === 1 ? 'UNKNOWN' : 'MERGEABLE'));
  const requests = [member(1), member(2)].map(({ url, headSha }) => ({ url, headSha }));
  const get = (globalThis as unknown as { window: { electronAPI: { getQueueSignals: (r: QueueSignalRequest[], o?: QueueSignalOptions) => Promise<QueueSignals[]> } } }).window.electronAPI.getQueueSignals;
  await get(requests);
  await get(requests);
  assert.equal(github.batches.length, 1, 'Fresh status is reused, including UNKNOWN, without the option');
  const values = await get(requests, { recheckMerge: true });
  assert.deepEqual(github.batches.map((batch) => batch.numbers), [[1, 2], [1]]);
  assert.equal(values.find((value) => value.url === requests[0].url)?.readiness?.mergeable, 'MERGEABLE');
});
