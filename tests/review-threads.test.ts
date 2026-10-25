import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGitHubClientPool } from '../lib/github-client';
import { createReviewThreadService } from '../src/review-thread-service';
import { threadPlacementReason, threadSource, type GitHubReviewThread } from '../lib/review-threads';
import { memberPrefix, type ReviewMember } from '../lib/workbench';
import { review, slide } from './fixtures/explainer';

const comment = {
  id: 'C1',
  databaseId: 101,
  body: 'Check cancellation.',
  createdAt: '2026-10-23T12:00:00Z',
  url: 'https://github.com/o/r/pull/1#discussion_r101',
  author: { login: 'reviewer', avatarUrl: '' },
};
const thread: GitHubReviewThread = {
  id: 'T1',
  path: 'queue.ts',
  line: 1,
  startLine: null,
  diffSide: 'RIGHT',
  isResolved: false,
  isOutdated: false,
  viewerCanResolve: true,
  viewerCanUnresolve: false,
  comments: [comment],
};
const page = <T>(nodes: T[], cursor: string | null = null) => ({
  nodes,
  pageInfo: { hasNextPage: !!cursor, endCursor: cursor },
});
const response = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
function harness(
  handler: (query: string, variables: Record<string, unknown>, url: string, body: Record<string, unknown>) => Response
) {
  const calls: string[] = [];
  const pool = createGitHubClientPool({
    minSpacingMs: 0,
    fetch: ((url: string, init: RequestInit) => {
      const body = JSON.parse(typeof init.body === 'string' ? init.body : '{}') as Record<string, unknown>;
      calls.push(url);
      return Promise.resolve(
        handler(
          typeof body.query === 'string' ? body.query : '',
          (body.variables ?? {}) as Record<string, unknown>,
          url,
          body
        )
      );
    }) as typeof fetch,
  });
  return { calls, pool };
}
const pr = (threads: unknown) => ({
  data: { repository: { pullRequest: { headRefOid: 'head', baseRefOid: 'base', reviewThreads: threads } } },
});

void test('threads and replies paginate fully, coalesce file reads, cache briefly, and isolate accounts', async () => {
  const h = harness((query, vars) => {
    if (query.includes('ThreadReplies'))
      return response({ data: { node: { comments: page([{ ...comment, id: 'C2', databaseId: 102 }]) } } });
    return response(
      pr(
        vars.cursor
          ? page([{ ...thread, id: 'T2', comments: page([comment]) }])
          : page([{ ...thread, comments: page([comment], 'reply-page') }], 'thread-page')
      )
    );
  });
  let now = 0;
  const service = createReviewThreadService(() => now);
  const client = h.pool.client('one');
  const [a, b] = await Promise.all([service.list(client, review.prUrl), service.list(client, review.prUrl)]);
  assert.equal(h.calls.length, 3);
  assert.equal(a.threads.length, 2);
  assert.equal(a.threads[0].comments.length, 2);
  a.threads[0].comments.pop();
  assert.equal(b.threads[0].comments.length, 2);
  await service.list(client, review.prUrl);
  assert.equal(h.calls.length, 3);
  await service.list(h.pool.client('two'), review.prUrl);
  assert.equal(h.calls.length, 6);
  now = 60_001;
  await service.list(client, review.prUrl);
  assert.equal(h.calls.length, 9);
});

void test('reply and resolution target the owning PR, invalidate reads, and never replay failed writes', async () => {
  let resolved = false;
  let fail = false;
  const h = harness((query, vars) => {
    if (query.includes('ReplyToThread')) {
      assert.equal(vars.id, 'T1');
      assert.equal(vars.body, 'Agreed');
      return fail
        ? response({ message: 'Forbidden' }, 403)
        : response({
            data: { addPullRequestReviewThreadReply: { comment: { ...comment, id: 'C2', body: 'Agreed' } } },
          });
    }
    if (query.startsWith('mutation')) {
      assert.equal(vars.id, 'T1');
      resolved = !resolved;
      return response({
        data: {
          [resolved ? 'resolveReviewThread' : 'unresolveReviewThread']: {
            thread: { isResolved: resolved, viewerCanResolve: !resolved, viewerCanUnresolve: resolved },
          },
        },
      });
    }
    return response(
      pr(
        page([
          {
            ...thread,
            isResolved: resolved,
            viewerCanResolve: !resolved,
            viewerCanUnresolve: resolved,
            comments: page([comment]),
          },
        ])
      )
    );
  });
  const service = createReviewThreadService();
  const client = h.pool.client('one');
  const req = { prUrl: 'https://github.com/test/repo/pull/1', threadId: 'T1' };
  assert.equal((await service.act(client, { ...req, action: 'reply', body: 'Agreed' })).comments.length, 2);
  assert.equal((await service.act(client, { ...req, action: 'resolve' })).isResolved, true);
  assert.equal((await service.act(client, { ...req, action: 'unresolve' })).isResolved, false);
  await assert.rejects(
    service.act(client, { ...req, threadId: 'another-pr-thread', action: 'resolve' }),
    /does not belong/
  );
  fail = true;
  const before = h.calls.length;
  await assert.rejects(service.act(client, { ...req, action: 'reply', body: 'Agreed' }), /Forbidden/);
  assert.equal(h.calls.length, before + 1);
});

void test('partial GraphQL errors and revision changes during pagination never become cached success', async () => {
  let failed = true;
  const h = harness((_q, vars) =>
    failed
      ? response({ ...pr(page([])), errors: [{ message: 'Missing permission' }] })
      : response({
          data: {
            repository: {
              pullRequest: {
                headRefOid: vars.cursor ? 'new-head' : 'head',
                baseRefOid: 'base',
                reviewThreads: page([], vars.cursor ? null : 'next'),
              },
            },
          },
        })
  );
  const service = createReviewThreadService();
  await assert.rejects(service.list(h.pool.client('one'), review.prUrl), /Missing permission/);
  failed = false;
  await assert.rejects(service.list(h.pool.client('one'), review.prUrl), /PR changed/);
});

void test('line placement requires matching revisions and keeps outdated or absent lines off saved code', () => {
  const hunk = { ...slide.diffHunks[0], hunkHeader: '@@ -1,2 +1,2 @@', content: '-old\n+new\n context' };
  const revision = { headSha: 'head', baseSha: 'base' };
  assert.equal(threadPlacementReason(thread, revision, revision, [hunk]), null);
  assert.match(threadPlacementReason({ ...thread, isOutdated: true }, revision, revision, [hunk]) ?? '', /Outdated/);
  assert.match(threadPlacementReason(thread, revision, { headSha: 'old' }, [hunk]) ?? '', /revision/);
  assert.match(
    threadPlacementReason({ ...thread, diffSide: 'LEFT' }, revision, { headSha: 'head' }, [hunk]) ?? '',
    /revision/
  );
  assert.equal(threadPlacementReason({ ...thread, diffSide: 'LEFT' }, revision, revision, [hunk]), null);
  assert.match(threadPlacementReason({ ...thread, line: 999 }, revision, revision, [hunk]) ?? '', /outside/);
});

void test('stack paths select the owning PR even when two PRs change the same file', () => {
  const member = (number: number) =>
    ({
      number,
      repo: 'o/r',
      url: `https://github.com/o/r/pull/${number}`,
      headSha: `head-${number}`,
      baseSha: `base-${number}`,
    }) as ReviewMember;
  const first = member(1),
    second = member(2);
  const stack = {
    ...review,
    snapshot: {
      version: 1 as const,
      capturedAt: '',
      fingerprint: '',
      subject: {
        id: 'stack',
        kind: 'stack' as const,
        title: 'Stack',
        members: [first, second],
        edges: [],
        warnings: [],
      },
    },
  };
  assert.equal(threadSource(stack, memberPrefix(first) + 'queue.ts')?.prUrl, first.url);
  assert.equal(threadSource(stack, memberPrefix(second) + 'queue.ts')?.headSha, 'head-2');
  assert.equal(threadSource(stack, 'unknown/queue.ts'), null);
  assert.equal(threadSource({ ...review, prUrl: 'local://repo' }, 'queue.ts'), null);
});

void test('complete discussion snapshots survive restart, expire, and respect explicit refresh and mutations', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gnosis-thread-cache-'));
  const file = path.join(dir, 'budget.json');
  let now = 1000;
  let resolved = false;
  const handler = (query: string) =>
    query.startsWith('mutation')
      ? response({
          data: {
            resolveReviewThread: {
              thread: { isResolved: (resolved = true), viewerCanResolve: false, viewerCanUnresolve: true },
            },
          },
        })
      : response(pr(page([{ ...thread, isResolved: resolved, comments: page([comment]) }])));
  try {
    const first = harness(handler);
    first.pool.setStorage(file);
    await createReviewThreadService(() => now).list(first.pool.client('one'), review.prUrl);
    const restarted = harness(handler);
    restarted.pool.setStorage(file);
    const service = createReviewThreadService(() => now);
    const client = restarted.pool.client('one');
    assert.equal((await service.list(client, review.prUrl)).threads.length, 1);
    assert.equal(restarted.calls.length, 0);
    await service.list(client, review.prUrl, true);
    assert.equal(restarted.calls.length, 1);
    now += 60_001;
    await service.list(client, review.prUrl);
    assert.equal(restarted.calls.length, 2);
    await service.list(restarted.pool.client('two'), review.prUrl);
    assert.equal(restarted.calls.length, 3, 'A different credential must fetch its own discussions');
    await service.act(client, { prUrl: review.prUrl, threadId: 'T1', action: 'resolve' });
    const afterWrite = harness(handler);
    afterWrite.pool.setStorage(file);
    assert.equal(
      (await createReviewThreadService(() => now).list(afterWrite.pool.client('one'), review.prUrl)).threads[0]
        .isResolved,
      true
    );
    assert.equal(afterWrite.calls.length, 1, 'The pre-mutation snapshot was removed from disk');
    afterWrite.pool.forget('one');
    const afterLogout = harness(handler);
    afterLogout.pool.setStorage(file);
    await createReviewThreadService(() => now).list(afterLogout.pool.client('one'), review.prUrl);
    assert.equal(afterLogout.calls.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

void test('a failed discussion page never persists an incomplete thread snapshot', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gnosis-thread-partial-'));
  const file = path.join(dir, 'budget.json');
  try {
    const first = harness((_query, vars) =>
      vars.cursor
        ? response({ errors: [{ message: 'Unavailable page' }] })
        : response(pr(page([{ ...thread, comments: page([comment]) }], 'next')))
    );
    first.pool.setStorage(file);
    await assert.rejects(createReviewThreadService().list(first.pool.client('one'), review.prUrl), /Unavailable page/);
    const restart = harness(() => response(pr(page([{ ...thread, comments: page([comment]) }]))));
    restart.pool.setStorage(file);
    await createReviewThreadService().list(restart.pool.client('one'), review.prUrl);
    assert.equal(restart.calls.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

void test('editing and deleting enforce PR membership and comment permissions before mutation', async () => {
  const writes: string[] = [];
  const h = harness((query, vars) => {
    if (query.startsWith('mutation')) {
      writes.push(query);
      assert.equal(vars.id, comment.id);
      return query.includes('EditReviewComment')
        ? response({
            data: { updatePullRequestReviewComment: { pullRequestReviewComment: { ...comment, body: vars.body } } },
          })
        : response({ data: { deletePullRequestReviewComment: { clientMutationId: null } } });
    }
    return response(
      pr(
        page([
          {
            ...thread,
            comments: page([
              { ...comment, viewerCanUpdate: true, viewerCanDelete: true },
              { ...comment, id: 'other', viewerCanUpdate: false, viewerCanDelete: false },
            ]),
          },
        ])
      )
    );
  });
  const service = createReviewThreadService(),
    client = h.pool.client('one');
  const req = { prUrl: review.prUrl, threadId: thread.id, commentId: comment.id };
  await assert.rejects(service.comment(client, { ...req, commentId: 'missing', action: 'delete' }), /does not belong/);
  await assert.rejects(
    service.comment(client, { ...req, commentId: 'other', action: 'edit', body: 'No' }),
    /cannot edit/
  );
  await assert.rejects(service.comment(client, { ...req, commentId: 'other', action: 'delete' }), /cannot delete/);
  assert.equal(writes.length, 0);
  const edited = await service.comment(client, { ...req, action: 'edit', body: 'Updated' });
  assert.equal(edited.comments[0].body, 'Updated');
  const deleted = await service.comment(client, { ...req, action: 'delete' });
  assert.equal(deleted.comments.length, 1);
  assert.equal(deleted.comments[0].id, 'other');
});
