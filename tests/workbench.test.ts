import assert from 'node:assert/strict';
import test from 'node:test';
import {
  groupSubjects,
  briefingModel,
  snapshot,
  fingerprint,
  attentionFor,
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
  const p = { provider: 'codex', model: 'gpt-6.1-sol', effort: 'ultra' } as const;
  assert.equal(briefingModel(p).effort, 'low');
  assert.equal(briefingModel({ ...p, proactiveThinking: true }).effort, 'low');
  assert.equal(briefingModel({ ...p, proactiveEffort: 'medium' }).effort, 'medium');
  assert.equal(briefingModel({ ...p, proactiveEffort: 'ultra', proactiveReviewOverrides: true,
    proactiveProvider: 'claude', proactiveModel: 'claude-sonnet-5-5' }).effort, 'max');
});
