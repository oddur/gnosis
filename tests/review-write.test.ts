import test from 'node:test';
import assert from 'node:assert/strict';
import { createGitHubClientPool } from '../lib/github-client';
import { createReviewComment, submitPrReview } from '../src/review-write-service';
const request = {
  prUrl: 'https://github.com/o/r/pull/2',
  headSha: 'head',
  baseSha: 'base',
  baseBranch: 'main',
  path: 'queue.ts',
  side: 'RIGHT' as const,
  line: 4,
  startLine: 3,
  body: 'Preserve the retry boundary.',
};
function harness() {
  let head = 'head',
    reads = 0,
    fail = false,
    race = false;
  const writes: Record<string, unknown>[] = [];
  const headers: Headers[] = [];
  const client = createGitHubClientPool({
    minSpacingMs: 0,
    fetch: ((url: string, init: RequestInit) => {
      headers.push(new Headers(init.headers));
      const body = JSON.parse(typeof init.body === 'string' ? init.body : '{}') as Record<string, unknown>;
      let data: unknown;
      if (init.method === 'POST') {
        writes.push(body);
        if (fail)
          return Promise.resolve(
            new Response(JSON.stringify({ message: 'Forbidden' }), {
              status: 403,
              headers: { 'content-type': 'application/json' },
            })
          );
        data = { html_url: 'https://github.com/o/r/pull/2#review' };
      } else if (url.includes('/files'))
        data = [
          { filename: 'queue.ts', patch: '@@ -2,3 +2,3 @@\n context\n-old\n+new\n end\n@@ -10 +10 @@\n-old\n+new' },
        ];
      else {
        reads++;
        data = {
          title: 'Test',
          user: { login: 'author' },
          base: { ref: 'main', sha: 'base', repo: { full_name: 'o/r' } },
          head: { ref: 'feature', sha: race && reads > 1 ? 'moved' : head, repo: { full_name: 'o/r' } },
          state: 'open',
          merged: false,
        };
      }
      return Promise.resolve(new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } }));
    }) as typeof fetch,
  }).client('test');
  return {
    client,
    writes,
    headers,
    move: () => {
      head = 'moved';
    },
    fail: () => {
      fail = true;
    },
    race: () => {
      race = true;
    },
  };
}
void test('immediate comments pin the owning revision and preserve multiline coordinates', async () => {
  const h = harness();
  await createReviewComment(h.client, request);
  assert.deepEqual(h.writes, [
    {
      commit_id: 'head',
      path: 'queue.ts',
      line: 4,
      side: 'RIGHT',
      body: request.body,
      start_line: 3,
      start_side: 'RIGHT',
    },
  ]);
  assert.ok(h.headers.slice(0, 3).every((h) => h.get('cache-control') === 'no-cache'));
});
void test('stale revisions and updates during validation never post comments or approval', async () => {
  for (const race of [false, true]) {
    const h = harness();
    if (race) h.race();
    else h.move();
    await assert.rejects(createReviewComment(h.client, request), /changed/);
    assert.equal(h.writes.length, 0);
  }
  const h = harness();
  h.move();
  await assert.rejects(
    submitPrReview(h.client, { ...request, event: 'APPROVE', body: '', comments: [] }, false),
    /changed/
  );
  assert.equal(h.writes.length, 0);
});
void test('immediate comments reject unknown files, invalid sides, omitted ranges and empty text', async () => {
  for (const patch of [
    { path: 'wrong.ts' },
    { startLine: 4, line: 10 },
    { startLine: 0 },
    { startLine: 5, line: 4 },
    { body: ' ' },
    { line: 999 },
  ]) {
    const h = harness();
    await assert.rejects(createReviewComment(h.client, { ...request, ...patch }));
    assert.equal(h.writes.length, 0);
  }
});
void test('review sends inline ranges and folds unsupported lines into its body without losing feedback', async () => {
  const h = harness();
  const result = await submitPrReview(
    h.client,
    {
      ...request,
      event: 'COMMENT',
      body: 'Summary',
      comments: [request, { ...request, line: 99, startLine: undefined, body: 'Outside' }],
    },
    true
  );
  assert.equal(result.droppedCommentCount, 1);
  assert.deepEqual(h.writes[0].comments, [
    { path: 'queue.ts', line: 4, side: 'RIGHT', body: request.body, start_line: 3, start_side: 'RIGHT' },
  ]);
  assert.match(String(h.writes[0].body), /Outside/);
  assert.match(String(h.writes[0].body), /gnosis.to/);
});
void test('failed comment writes are never automatically replayed', async () => {
  const h = harness();
  h.fail();
  await assert.rejects(createReviewComment(h.client, request), /Forbidden/);
  assert.equal(h.writes.length, 1);
});
