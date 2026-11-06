import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareReviewSource } from '../src/review-start-source';
import type { DiffSource } from '../lib/diffSource';
import type { GenerateReviewRequest } from '../lib/types';
import type { ReviewMember, ReviewSubject, WorkbenchQueue } from '../lib/workbench';
import { DEFAULT_CLAUDE_MODEL } from '../lib/models';

const url = 'https://github.com/example/repo/pull/1';
const member: ReviewMember = {
  url,
  number: 1,
  repo: 'example/repo',
  headRepo: 'example/repo',
  baseRepo: 'example/repo',
  title: 'Review a PR outside the queue',
  description: '',
  author: 'author',
  labels: [],
  baseBranch: 'main',
  headBranch: 'feature',
  baseSha: 'base',
  headSha: 'head',
  state: 'open',
  merged: false,
  role: 'watched',
  createdAt: '2026-11-06',
  updatedAt: '2026-11-06',
  isDraft: false,
  commitCount: 1,
  requestedReviewers: [],
  requestedTeams: [],
  mergeable: null,
  mergeableState: null,
  autoMerge: null,
  milestone: null,
};
const request: GenerateReviewRequest = {
  prUrl: url,
  subjectId: url,
  standalone: true,
  provider: 'claude',
  model: DEFAULT_CLAUDE_MODEL,
};
function fixture() {
  const calls: string[] = [];
  const source: DiffSource = {
    kind: 'github',
    key: url,
    getMetadata: () => {
      calls.push('metadata');
      return Promise.resolve(member);
    },
    getDiff: () => Promise.resolve(''),
    getChangedFiles: () => Promise.resolve([]),
    getFileContent: () => Promise.resolve(null),
    getFileMetadata: () => Promise.resolve([]),
    getNeighborFiles: () => Promise.resolve({}),
    getProjectClaudeContext: () => Promise.resolve(null),
  };
  const queue: WorkbenchQueue = { items: [], warnings: [], remaining: 0 };
  const deps = {
    token: 'test',
    workbench: {
      mutedUrls: () => new Set<string>(),
      queue: () => {
        calls.push('queue');
        return Promise.resolve(queue);
      },
      subject: (): ReviewSubject | undefined => undefined,
      fresh: (subject: ReviewSubject) => {
        calls.push('fresh');
        return Promise.resolve(subject);
      },
    },
    checkAccess: (value: string) => {
      calls.push(`access:${value}`);
      return Promise.resolve();
    },
    prSource: (value: string) => {
      calls.push(`source:${value}`);
      return Promise.resolve(source);
    },
    stackSource: () => {
      calls.push('stack');
      return source;
    },
  };
  return { calls, deps, source, queue };
}

void test('an explicit PR absent from the queue loads directly and keeps single-PR scope', async () => {
  const f = fixture();
  const result = await prepareReviewSource(request, f.deps);
  assert.equal(result.prData.url, url);
  assert.equal(result.reviewSnapshot?.subject.scope, 'single');
  assert.deepEqual(
    result.reviewSnapshot.subject.members.map((m) => m.url),
    [url]
  );
  assert.deepEqual(f.calls, [`access:${url}`, `source:${url}`, 'metadata']);
});

void test('a PR URL subject ID is explicit even without the standalone flag', async () => {
  const f = fixture();
  f.deps.workbench.queue = () => Promise.reject(new Error('Unrelated discovery is paused'));
  const result = await prepareReviewSource({ ...request, standalone: false }, f.deps);
  assert.equal(result.reviewSnapshot?.subject.scope, 'single');
  assert.equal(result.reviewSnapshot.subject.members[0].headSha, 'head');
});

const stack: ReviewSubject = {
  id: `stack:${url}`,
  kind: 'stack',
  title: 'Two changes',
  members: [member, { ...member, url: url + '0', number: 10 }],
  edges: [],
  warnings: [],
};
void test('an explicit PR does not expand into its cached parent stack', async () => {
  const f = fixture();
  f.deps.workbench.subject = () => {
    throw new Error('Explicit PRs must not resolve through the queue');
  };
  f.queue.items = [{ subject: stack, attention: 'other' }];
  const result = await prepareReviewSource(request, f.deps);
  assert.equal(result.source, f.source);
  assert.equal(result.reviewSnapshot?.subject.members.length, 1);
  assert.ok(!f.calls.includes('stack'));
});

void test('whole-stack requests preserve scope and verify every member before loading', async () => {
  const f = fixture();
  f.deps.workbench.subject = () => stack;
  const result = await prepareReviewSource({ ...request, standalone: false, subjectId: stack.id }, f.deps);
  assert.equal(result.reviewSnapshot?.subject.kind, 'stack');
  assert.equal(result.reviewSnapshot.subject.members.length, 2);
  assert.deepEqual(f.calls, [`access:${url}`, 'queue', `access:${url}0`, 'fresh', 'stack', 'metadata']);
});

void test('a missing stack never silently becomes a single-PR explanation', async () => {
  const f = fixture();
  await assert.rejects(
    prepareReviewSource({ ...request, standalone: false, subjectId: stack.id }, f.deps),
    /This stack has changed/
  );
  assert.deepEqual(f.calls, [`access:${url}`, 'queue']);
});

void test('legacy unscoped requests still discover the current stack once', async () => {
  const f = fixture();
  f.queue.items = [{ subject: stack, attention: 'other' }];
  const result = await prepareReviewSource({ ...request, standalone: false, subjectId: undefined }, f.deps);
  assert.equal(result.reviewSnapshot?.subject.kind, 'stack');
  assert.equal(f.calls.filter((call) => call === 'queue').length, 1);
});

void test('muted PRs and denied access stop before metadata or generation', async () => {
  const muted = fixture();
  muted.deps.workbench.mutedUrls = () => new Set([url]);
  await assert.rejects(prepareReviewSource(request, muted.deps), /This PR is muted/);
  assert.deepEqual(muted.calls, []);
  const denied = fixture();
  denied.deps.checkAccess = () => Promise.reject(new Error('GitHub denied access'));
  await assert.rejects(prepareReviewSource(request, denied.deps), /GitHub denied access/);
  assert.deepEqual(denied.calls, []);
});

void test('a missing or unavailable PR reports its loader failure, not a queue error', async () => {
  const f = fixture();
  f.source.getMetadata = () => Promise.reject(new Error('GitHub could not load this PR'));
  await assert.rejects(prepareReviewSource(request, f.deps), /GitHub could not load this PR/);
  assert.deepEqual(f.calls, [`access:${url}`, `source:${url}`]);
});

void test('local reviews retain their local source without GitHub or queue lookup', async () => {
  const f = fixture();
  const local = 'local:/repo#main..HEAD';
  const result = await prepareReviewSource({ ...request, prUrl: local, subjectId: undefined }, f.deps);
  assert.equal(result.reviewSnapshot, undefined);
  assert.deepEqual(f.calls, [`source:${local}`, 'metadata']);
});

void test('contradictory single-PR and stack identifiers fail before loading', async () => {
  const f = fixture();
  await assert.rejects(prepareReviewSource({ ...request, subjectId: stack.id }, f.deps), /scope do not match/);
  assert.deepEqual(f.calls, []);
});
