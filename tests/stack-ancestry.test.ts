import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Octokit } from '@octokit/rest';
import { attentionItems } from '../lib/attention';
import { rebaseWords } from '../lib/morning';
import { mergedParent, stackConflictPlan } from '../lib/stack-conflict-plan';
import {
  ANCESTRY_PER_QUERY,
  ancestryRequests,
  readAncestry,
  unanswered,
  withParentHead,
  type AncestryAnswer,
} from '../lib/stack-ancestry';
import type { QueueItem, ReviewMember, ReviewSubject } from '../lib/workbench';
import { LOGIN, T0, mine, signals } from './notification-fixtures';

const stack = (parent: ReviewMember, child: ReviewMember): ReviewSubject => ({
  id: `stack-${parent.number}`,
  kind: 'stack',
  title: parent.title,
  members: [parent, child],
  edges: [{ parent: parent.url, child: child.url, evidence: 'branch' }],
  warnings: [],
});
// #101 was squash-merged into main and its branch deleted; GitHub moved #102 onto main.
const parent = mine(101, { merged: true, state: 'closed', headRefDeleted: true, headSha: 'parent-head' });
const moved = mine(102, { baseBranch: 'main', headSha: 'child-head' });
const carried = { headSha: 'child-head', baseBranch: 'main', parentHeadSha: 'parent-head' };

/** A fake GraphQL client: each alias answers with the PR's head, base and commit ids. */
function client(prs: Partial<Record<number, { headRefOid?: string; baseRefName?: string; oids: string[]; totalCount?: number }>>, fail?: Error) {
  const queries: string[] = [];
  const octokit = {
    graphql: (query: string) => {
      queries.push(query);
      if (fail) return Promise.reject(fail);
      const data: Record<string, unknown> = {};
      for (const [, alias, number] of query.matchAll(/(a\d+): repository\([^)]*\) \{ pullRequest\(number:(\d+)\)/g)) {
        const pr = prs[Number(number)];
        data[alias] = {
          pullRequest: pr
            ? {
                headRefOid: pr.headRefOid ?? `child-head`,
                baseRefName: pr.baseRefName ?? 'main',
                commits: { totalCount: pr.totalCount ?? pr.oids.length, nodes: pr.oids.map((oid) => ({ commit: { oid } })) },
              }
            : null,
        };
      }
      return Promise.resolve(data);
    },
  } as unknown as Octokit;
  return { octokit, queries };
}

void test('a PR GitHub moved onto main after a squash merge needs to move while it carries the parent head (#468)', () => {
  // Without an ancestry answer: not flagged (fail closed).
  assert.equal(mergedParent(stack(parent, moved), moved), undefined);
  const carrying = { ...moved, parentHeadInPr: carried };
  const subject = stack(parent, carrying);
  const found = mergedParent(subject, carrying);
  assert.deepEqual([found?.parent.number, found?.onto], [101, 'main']);
  assert.equal(stackConflictPlan(subject, () => undefined)?.step.text, '#101 merged. #102 needs to move onto main.');
  assert.equal(rebaseWords(subject, carrying), 'needs to move onto main after #101 merged');
  // The menu bar row, on your own PR.
  const item: QueueItem = { subject, attention: 'other' };
  const [row] = attentionItems({ items: [item], signals: () => signals(carrying), login: LOGIN, enabled: () => true, now: T0 });
  assert.deepEqual(row.kinds, ['restack']);
  assert.equal(row.detail, 'Parent #101 merged');
  // An answer for another head, base or parent head says nothing about this one.
  for (const stale of [{ headSha: 'old' }, { baseBranch: 'develop' }, { parentHeadSha: 'other' }]) {
    const pr = { ...moved, parentHeadInPr: { ...carried, ...stale } };
    assert.equal(mergedParent(stack(parent, pr), pr), undefined, JSON.stringify(stale));
  }
  // Pushed after the move: the new head clears the row until it is read again.
  const restacked = { ...carrying, headSha: 'new-head' };
  assert.equal(mergedParent(stack(parent, restacked), restacked), undefined);
  // The same rules as any merged parent: a long-lived branch that is still there is not a stack parent.
  const release = { ...parent, headBranch: 'develop', headRefDeleted: false, mergedAt: '2026-11-10T00:00:00Z' };
  assert.equal(mergedParent(stack(release, carrying), carrying), undefined);
  // Another repository's main is not the parent's base.
  const fork = { ...carrying, baseRepo: 'other/r' };
  assert.equal(mergedParent(stack(parent, fork), fork), undefined);
});

void test('ancestry requests cover only open PRs on their merged parent base, and reuse saved answers', () => {
  const onParent = mine(103, { baseBranch: 'feature-101' });
  const openParent = mine(104);
  const child = mine(105, { headSha: 'c5' });
  const requests = ancestryRequests([stack(parent, moved), stack(parent, onParent), stack(openParent, child), stack(parent, { ...moved, number: 106, url: moved.url.replace('102', '106'), state: 'closed' })]);
  assert.deepEqual(requests, [{ url: moved.url, ...carried }]);
  const saved: Record<string, AncestryAnswer> = { [moved.url]: { ...carried, contains: false } };
  assert.deepEqual(unanswered(requests, saved), []);
  assert.deepEqual(unanswered(requests, { [moved.url]: { ...carried, headSha: 'old', contains: true } }), requests);
});

void test('one aliased query answers up to 25 PRs, and only for the head and base it was asked about', async () => {
  const count = ANCESTRY_PER_QUERY + 2;
  const requests = Array.from({ length: count }, (_, i) => ({
    url: `https://github.com/o/r/pull/${200 + i}`,
    headSha: 'child-head',
    baseBranch: 'main',
    parentHeadSha: 'parent-head',
  }));
  const prs = Object.fromEntries(
    requests.map((_, i) => [
      200 + i,
      i === 0
        ? { oids: ['parent-1', 'parent-head', 'child-head'] } // squash-merged parent: still carried
        : i === 1
          ? { oids: ['child-head'] } // merge commit, or already moved: the parent head is on main
          : i === 2
            ? { oids: ['parent-head'], headRefOid: 'pushed-since' } // another head
            : i === 3
              ? { oids: ['x'], totalCount: 300 } // too many commits to tell
              : i === 4
                ? { oids: ['parent-head'], baseRefName: 'develop' } // another base
                : { oids: [] },
    ])
  );
  delete prs[205]; // GitHub returned no PR
  const { octokit, queries } = client(prs);
  const answers = await readAncestry(octokit, requests);
  assert.equal(queries.length, 2);
  assert.equal((queries[0].match(/pullRequest\(/g) ?? []).length, ANCESTRY_PER_QUERY);
  assert.equal(answers.get(requests[0].url)?.contains, true);
  assert.equal(answers.get(requests[1].url)?.contains, false);
  assert.equal(answers.has(requests[2].url), false);
  assert.equal(answers.get(requests[3].url)?.contains, null);
  assert.equal(answers.has(requests[4].url), false);
  assert.equal(answers.has(requests[5].url), false);
  assert.equal(answers.get(requests[6].url)?.contains, false);
});

void test('a failed ancestry query rejects, so the caller keeps no answer and flags nothing', async () => {
  const { octokit } = client({}, new Error('rate limited'));
  await assert.rejects(readAncestry(octokit, [{ url: moved.url, ...carried }]));
  assert.deepEqual(await readAncestry(client({}).octokit, []), new Map());
});

void test('withParentHead sets the fact only for a carried answer on the current head, and keeps identity', () => {
  const yes: Record<string, AncestryAnswer> = { [moved.url]: { ...carried, contains: true } };
  const flagged = withParentHead(moved, yes);
  assert.deepEqual(flagged.parentHeadInPr, carried);
  assert.equal(withParentHead(flagged, yes), flagged);
  assert.equal(withParentHead(moved, undefined), moved);
  for (const answer of [{ ...carried, contains: false }, { ...carried, contains: null }, { ...carried, headSha: 'old', contains: true }]) {
    const cleared = withParentHead(flagged, { [moved.url]: answer });
    assert.equal(cleared.parentHeadInPr, undefined);
    assert.equal('parentHeadInPr' in cleared, false);
  }
});
