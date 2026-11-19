import assert from 'node:assert/strict';
import test from 'node:test';
import {
  groupSubjects,
  briefingModel,
  snapshot,
  fingerprint,
  attentionFor,
  updatedSinceReview,
  type GitHubOwnReview,
  coverageKey,
  sourceForPath,
  memberPrefix,
  type ReviewMember,
} from '../lib/workbench';
import { buildAllChecksPrompt } from '../lib/all-checks-prompt';
import { namespaceDiff } from '../lib/stack-source';
import { buildArchive, parseArchive } from '../lib/review-archive';
import type { ReviewGuide } from '../lib/types';

function member(n: number, base = 'main', head = `branch-${n}`, repo = 'owner/repo'): ReviewMember {
  return {
    number: n,
    repo,
    headRepo: repo,
    baseRepo: repo,
    url: `https://github.com/${repo}/pull/${n}`,
    title: `Change ${n}`,
    description: 'Intent',
    author: 'reviewer',
    role: 'review-requested',
    baseBranch: base,
    headBranch: head,
    baseSha: 'base',
    headSha: `sha-${n}`,
    merged: false,
    state: 'open',
    createdAt: '2026-10-20',
    updatedAt: '2026-10-22',
    labels: [],
    mergeable: true,
    isDraft: false,
    commitCount: 1,
    requestedReviewers: ['reviewer'],
    requestedTeams: [],
    mergeableState: 'clean',
    autoMerge: null,
    milestone: null,
  };
}
function reviewFor(members: ReviewMember[]): ReviewGuide {
  const subject = groupSubjects(members)[0];
  return {
    snapshot: snapshot(subject),
    prUrl: members[0].url,
    prTitle: 'Combined change',
    prDescription: '',
    author: 'reviewer',
    summary: '',
    riskLevel: 'low',
    riskRationale: '',
    totalFilesChanged: 1,
    totalLinesChanged: 2,
    slides: [
      {
        id: 'topic',
        slideNumber: 1,
        title: 'Queue',
        slideType: 'feature',
        narrative: 'Explanation',
        reviewFocus: null,
        dependsOn: [],
        contextSnippets: [],
        affectedFiles: ['queue.ts'],
        diffHunks: [
          {
            filePath: members.length > 1 ? memberPrefix(members[1]) + 'queue.ts' : 'queue.ts',
            hunkHeader: '@@ -1 +1 @@',
            content: '-before\n+after',
            language: 'typescript',
            renderedHtml: '',
          },
        ],
      },
    ],
  };
}
test('a stack becomes one ordered subject while standalone PRs retain full identity', () => {
  const result = groupSubjects([member(3, 'branch-2'), member(1), member(4), member(2, 'branch-1')]);
  assert.equal(result.length, 2);
  const stack = result.find((s) => s.kind === 'stack')!;
  assert.deepEqual(
    stack.members.map((m) => m.number),
    [1, 2, 3]
  );
  assert.equal(result.find((s) => s.kind === 'pr')!.id, member(4).url);
});
test('same branch name across forks is not dependency evidence', () => {
  const child = { ...member(2, 'branch-1'), baseRepo: 'upstream/repo' };
  assert.equal(groupSubjects([member(1), child]).length, 2);
});
test('ambiguous parents and cycles are not silently ordered', () => {
  const candidates = groupSubjects([member(1, 'main', 'shared'), member(2, 'main', 'shared'), member(3, 'shared')]);
  assert.equal(candidates.length, 3);
  assert.match(candidates.find((s) => s.id === member(3).url)!.warnings[0], /Multiple/);
  const cycle = groupSubjects([member(1, 'branch-2'), member(2, 'branch-1')]);
  assert.equal(cycle.length, 2);
  assert.ok(cycle.every((s) => s.warnings.length));
});
test('user correction and merged-parent lineage survive discovery', () => {
  const a = member(1),
    b = member(2, 'branch-1');
  const old = groupSubjects([a, b]);
  const merged = { ...a, merged: true, state: 'closed' as const };
  const current = groupSubjects([merged, { ...b, baseBranch: 'main' }], [], old);
  assert.equal(current[0].id, old[0].id);
  assert.equal(current[0].members.length, 2);
  const separated = groupSubjects([a, b], [{ parent: a.url, child: b.url, action: 'unlink' }], old);
  assert.equal(separated.length, 2);
});
test('base-only changes and descriptions invalidate the snapshot', () => {
  const r = reviewFor([member(1)]);
  const subject = r.snapshot!.subject;
  assert.notEqual(
    fingerprint({ ...subject, members: [{ ...member(1), baseSha: 'new-base' }] }),
    r.snapshot!.fingerprint
  );
  assert.notEqual(
    fingerprint({ ...subject, members: [{ ...member(1), description: 'New intent' }] }),
    r.snapshot!.fingerprint
  );
  assert.equal(fingerprint({ ...subject, members: [{ ...member(1), updatedAt: 'later' }] }), r.snapshot!.fingerprint);
  assert.equal(
    attentionFor(
      { ...subject, members: [{ ...member(1), baseSha: 'new-base' }] },
      { id: 'x', prTitle: '', prUrl: r.prUrl, author: '', riskLevel: 'low', savedAt: '', snapshot: r.snapshot }
    ),
    'updated'
  );
});
test('progress preserves unchanged own hunks but invalidates changed ancestors', () => {
  const r = reviewFor([member(1), member(2, 'branch-1')]);
  const key = coverageKey(r, r.slides[0]);
  const unchanged = structuredClone(r);
  unchanged.snapshot!.subject.members[1].headSha = 'other-file-edit';
  unchanged.slides[0].narrative = 'Reworded';
  assert.equal(coverageKey(unchanged, unchanged.slides[0]), key);
  const upstream = structuredClone(r);
  upstream.snapshot!.subject.members[0].headSha = 'changed-parent';
  assert.notEqual(coverageKey(upstream, upstream.slides[0]), key);
  const changed = structuredClone(r);
  changed.slides[0].diffHunks[0].content += '+changed';
  assert.notEqual(coverageKey(changed, changed.slides[0]), key);
});
test('repeated filenames retain distinct PR identities and real comment paths', () => {
  const a = member(1),
    b = member(2, 'branch-1');
  const r = reviewFor([a, b]);
  const prefix = memberPrefix(b);
  const diff = namespaceDiff(
    'diff --git a/queue.ts b/queue.ts\n--- a/queue.ts\n+++ b/queue.ts\n@@ -1 +1 @@\n-old\n+new',
    prefix
  );
  assert.match(diff, new RegExp(`--- a/${prefix}queue.ts`));
  assert.equal(sourceForPath(r, prefix + 'queue.ts').member!.url, b.url);
  assert.equal(sourceForPath(r, prefix + 'queue.ts').path, 'queue.ts');
  assert.notEqual(memberPrefix(member(1, 'main', 'head', 'other/repo')), memberPrefix(a));
});
test('stack snapshots survive archive export and import', () => {
  const review = reviewFor([member(1), member(2, 'branch-1')]);
  const archive = buildArchive({
    review,
    history: {
      id: 'r',
      prTitle: 'Stack',
      prUrl: review.prUrl,
      author: 'author',
      riskLevel: 'low',
      savedAt: 'now',
      snapshot: review.snapshot,
    },
  });
  assert.deepEqual(parseArchive(archive).review.snapshot, review.snapshot);
});

test('adding downstream work preserves completed ancestor coverage', () => {
  const r = reviewFor([member(1), member(2, 'branch-1')]);
  const key = coverageKey(r, r.slides[0]);
  r.snapshot = snapshot(groupSubjects([...r.snapshot!.subject.members, member(3, 'branch-2')])[0]);
  assert.equal(coverageKey(r, r.slides[0]), key);
});

test('bulk check prompts keep the real member source and revision', () => {
  const r = reviewFor([member(1), member(2, 'branch-1')]);
  r.slides[0].reviewChecks = [
    { text: 'Check cancellation', filePath: memberPrefix(member(2)) + 'queue.ts', startLine: 1 },
  ];
  const { prompt } = buildAllChecksPrompt(r);
  assert.match(prompt, /queue.ts/);
  assert.match(prompt, /pull\/2 at sha-2/);
  assert.doesNotMatch(prompt, /PR-owner/);
});

test('local stack names survive membership updates without changing explanation identity', () => {
  const original = groupSubjects([member(1), member(2, 'branch-1')])[0];
  const named = { ...original, name: 'Queue redesign', title: 'Queue redesign' };
  assert.equal(fingerprint(named), fingerprint(original));
  const next = groupSubjects([member(1), member(2, 'branch-1'), member(3, 'branch-2')], [], [named]);
  assert.equal(next[0].id, original.id);
  assert.equal(next[0].title, 'Queue redesign');
  const remaining = groupSubjects([member(2, 'main')], [], [named]);
  assert.equal(remaining[0].kind, 'stack');
  assert.equal(remaining[0].id, original.id);
  assert.equal(remaining[0].name, 'Queue redesign');
});

test('splitting a named stack does not copy its identity or name into two stacks', () => {
  const original = groupSubjects([member(1), member(2, 'branch-1'), member(3, 'branch-2'), member(4, 'branch-3')])[0];
  const named = { ...original, name: 'Queue redesign', title: 'Queue redesign' };
  const split = groupSubjects(original.members, [{ parent: member(2).url, child: member(3).url, action: 'unlink' }], [named]);
  assert.equal(split.length, 2);
  assert.equal(new Set(split.map(s => s.id)).size, 2);
  assert.equal(split.filter(s => s.name === named.name).length, 1);
});

void test('briefing effort is independent of explanation effort and normalized for its model', () => {
  const p = { provider: 'codex', model: 'gpt-6.2-sol', effort: 'ultra' } as const;
  assert.equal(briefingModel(p).effort, 'low');
  assert.equal(briefingModel({ ...p, proactiveThinking: true }).effort, 'low');
  assert.equal(briefingModel({ ...p, proactiveEffort: 'medium' }).effort, 'medium');
  assert.equal(briefingModel({ ...p, proactiveEffort: 'ultra', proactiveReviewOverrides: true,
    proactiveProvider: 'claude', proactiveModel: 'claude-sonnet-5-5' }).effort, 'max');
});

// "Updated since your review": your latest review is the newer of the saved Gnosis review and your GitHub review.
const savedAt = (members: ReviewMember[], capturedAt: string) => {
  const saved = reviewFor(members).snapshot;
  assert.ok(saved);
  return { snapshot: { ...saved, capturedAt } };
};
const moved = (m: ReviewMember, headSha: string): ReviewMember => ({ ...m, headSha });
const onGitHub = (reviews: Record<string, GitHubOwnReview>) => (m: ReviewMember) => reviews[m.url];

void test('an approval on GitHub at the current head clears "updated" from an older Gnosis review', () => {
  // The Gnosis review predates a push; the GitHub approval came later, at the head the PR still has.
  const review = savedAt([member(1)], '2026-11-10T09:00:00Z');
  const subject = groupSubjects([moved(member(1), 'sha-merge')])[0];
  assert.deepEqual(Object.keys(updatedSinceReview(subject, review)), [member(1).url], 'Without the GitHub review, as before');
  const github = onGitHub({ [member(1).url]: { submittedAt: '2026-11-19T12:47:19Z', headSha: 'sha-merge' } });
  const since = updatedSinceReview(subject, review, github);
  assert.deepEqual(since, {});
  assert.equal(attentionFor(subject, { id: 'x', prTitle: '', prUrl: member(1).url, author: '', riskLevel: 'low', savedAt: '', ...review }, since), 'requested');
});

void test('an approval on GitHub at an older head keeps "updated" once new commits arrive, counting from that commit', () => {
  const subject = groupSubjects([moved(member(1), 'sha-new')])[0];
  const github = onGitHub({ [member(1).url]: { submittedAt: '2026-11-19T12:47:19Z', headSha: 'sha-approved' } });
  assert.deepEqual(updatedSinceReview(subject, undefined, github), { [member(1).url]: { from: 'sha-approved' } });
  // Newer than an older Gnosis review too: the count starts at the approval.
  const review = savedAt([member(1)], '2026-11-10T09:00:00Z');
  assert.deepEqual(updatedSinceReview(subject, review, github), { [member(1).url]: { from: 'sha-approved' } });
  // A review whose commit is unknown is current when submitted after the head was committed.
  const unknown = (headCommittedAt?: string) =>
    onGitHub({ [member(1).url]: { submittedAt: '2026-11-19T12:47:19Z', headSha: null, ...(headCommittedAt ? { headCommittedAt } : {}) } });
  assert.deepEqual(updatedSinceReview(subject, undefined, unknown('2026-11-16T08:59:59Z')), {});
  assert.deepEqual(updatedSinceReview(subject, undefined, unknown('2026-11-19T13:00:00Z')), { [member(1).url]: { from: null } });
  assert.deepEqual(updatedSinceReview(subject, undefined, unknown()), { [member(1).url]: { from: null } });
});

void test('a Gnosis review newer than the GitHub review decides as before', () => {
  const review = savedAt([member(1)], '2026-11-20T09:00:00Z');
  // GitHub's older approval was at the current head; the Gnosis review still sees the description change.
  const github = onGitHub({ [member(1).url]: { submittedAt: '2026-11-19T12:47:19Z', headSha: 'sha-1' } });
  const edited = groupSubjects([{ ...member(1), description: 'New intent' }])[0];
  assert.deepEqual(updatedSinceReview(edited, review, github), { [member(1).url]: { from: 'sha-1' } });
  const pushed = groupSubjects([moved(member(1), 'sha-new')])[0];
  assert.deepEqual(updatedSinceReview(pushed, review, github), { [member(1).url]: { from: 'sha-1' } });
  // Unchanged since the Gnosis review: not updated, whatever the older GitHub review was on.
  const same = groupSubjects([member(1)])[0];
  assert.deepEqual(updatedSinceReview(same, review, onGitHub({ [member(1).url]: { submittedAt: '2026-11-19T12:47:19Z', headSha: 'sha-0' } })), {});
  // No GitHub review at all: exactly the fingerprint, as before.
  for (const subject of [edited, pushed, same])
    assert.equal(Object.keys(updatedSinceReview(subject, review)).length > 0, review.snapshot.fingerprint !== fingerprint(subject));
});

void test('in a stack, each PR is updated since your own latest review of it', () => {
  const parent = member(1);
  const child = member(2, 'branch-1');
  // Gnosis explained the whole stack; then both PRs got new commits.
  const review = savedAt([parent, child], '2026-11-10T09:00:00Z');
  const subject = groupSubjects([moved(parent, 'sha-1b'), moved(child, 'sha-2b')])[0];
  assert.equal(subject.kind, 'stack');
  assert.deepEqual(Object.keys(updatedSinceReview(subject, review)).sort(), [parent.url, child.url].sort());
  // You approved the parent on GitHub at its new head; the child moved past your Gnosis review.
  const github = onGitHub({ [parent.url]: { submittedAt: '2026-11-19T12:47:19Z', headSha: 'sha-1b' } });
  assert.deepEqual(updatedSinceReview(subject, review, github), { [child.url]: { from: 'sha-2' } });
  // Approve the child at its head too, and nothing in the stack changed since your review.
  const both = onGitHub({
    [parent.url]: { submittedAt: '2026-11-19T12:47:19Z', headSha: 'sha-1b' },
    [child.url]: { submittedAt: '2026-11-19T12:50:00Z', headSha: 'sha-2b' },
  });
  assert.deepEqual(updatedSinceReview(subject, review, both), {});
  // The child then moves again: only the child.
  const again = groupSubjects([moved(parent, 'sha-1b'), moved(child, 'sha-2c')])[0];
  assert.deepEqual(updatedSinceReview(again, review, both), { [child.url]: { from: 'sha-2b' } });
  // Only the parent moved, and you approved it at its head: the child the Gnosis review covers is unchanged.
  const parentOnly = groupSubjects([moved(parent, 'sha-1b'), child])[0];
  assert.deepEqual(updatedSinceReview(parentOnly, review, github), {});
  // Without that approval, the saved review covers the whole stack, as its fingerprint does: both PRs.
  assert.deepEqual(updatedSinceReview(parentOnly, review), { [parent.url]: { from: 'sha-1' }, [child.url]: { from: 'sha-2' } });
  // The parent moved past your GitHub approval: it is updated, and so is the child the older Gnosis review decides.
  const past = onGitHub({ [parent.url]: { submittedAt: '2026-11-19T12:47:19Z', headSha: 'sha-1a' } });
  assert.deepEqual(updatedSinceReview(parentOnly, review, past), { [parent.url]: { from: 'sha-1a' }, [child.url]: { from: 'sha-2' } });
});
