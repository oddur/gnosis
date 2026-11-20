import test from 'node:test';
import assert from 'node:assert/strict';
import { createCommentEventReader } from '../lib/comment-event-reads';
import { COMMENT_READS_PER_POLL } from '../lib/notification-comments';
import type { CommentCandidate } from '../lib/notification-comments';

const candidate = (n: number, since = 100): CommentCandidate =>
  ({ url: `https://github.com/o/r/pull/${n}`, reason: 'mention', since, updatedAt: since + 1 }) as CommentCandidate;
const limit = { rateLimited: true };

void test('a rate-limited discussion is read again later; the ones that were read are delivered now', async () => {
  let now = 0;
  const delivered: string[] = [];
  const timers: { run: () => void; at: number }[] = [];
  let limitedUrls = new Set([candidate(2).url, candidate(3).url]);
  const reads: string[][] = [];
  const read = createCommentEventReader<string>({
    read: (urls) => {
      reads.push(urls);
      return Promise.resolve(
        urls.map((url) =>
          limitedUrls.has(url) ? { status: 'rejected' as const, reason: limit } : { status: 'fulfilled' as const, value: url }
        )
      );
    },
    deliver: (c, discussion) => delivered.push(`${c.url}@${c.since}:${discussion}`),
    retryAt: (...args: unknown[]) => (args.length && args[0] === limit ? 60_000 : undefined),
    account: () => 'alice',
    schedule: (run, delay) => timers.push({ run, at: now + delay }),
    now: () => now,
  });
  await read([candidate(1), candidate(2), candidate(3)]);
  assert.deepEqual(delivered.map((d) => d.split('@')[0].split('/').pop()), ['1']);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].at, 60_000, 'waits for the limit to lift');
  // A newer page names #2 again with a later cursor: the earlier cursor is kept, so no comment is skipped.
  await read([candidate(2, 200)]);
  assert.equal(timers.length, 1, 'one retry is scheduled');
  now = 60_000;
  limitedUrls = new Set();
  timers[0].run();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(reads.at(-1)?.map((u) => u.split('/').pop()).sort(), ['2', '3']);
  assert.ok(delivered.includes(`${candidate(2).url}@100:${candidate(2).url}`));
  assert.ok(delivered.some((d) => d.startsWith(`${candidate(3).url}@`)));
});

void test('a paused GitHub API defers every candidate instead of dropping it', async () => {
  const timers: (() => void)[] = [];
  let paused = true;
  const delivered: string[] = [];
  const read = createCommentEventReader<string>({
    read: (urls) => Promise.resolve(urls.map((url) => ({ status: 'fulfilled' as const, value: url }))),
    deliver: (c) => delivered.push(c.url),
    retryAt: (...args: unknown[]) => (args.length ? undefined : paused ? 30_000 : undefined),
    account: () => 'alice',
    schedule: (run) => timers.push(run),
    now: () => 0,
  });
  await read([candidate(1)]);
  assert.deepEqual(delivered, []);
  paused = false;
  timers[0]();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(delivered, [candidate(1).url]);
});

void test('other read failures are logged and dropped, as before', async () => {
  const warned: string[] = [];
  const timers: unknown[] = [];
  const read = createCommentEventReader<string>({
    read: (urls) => Promise.resolve(urls.map(() => ({ status: 'rejected' as const, reason: new Error('Gone') }))),
    deliver: () => assert.fail('nothing to deliver'),
    retryAt: () => undefined,
    account: () => 'alice',
    schedule: (run) => timers.push(run),
    warn: (message) => warned.push(message),
  });
  await read([candidate(1)]);
  assert.equal(warned.length, 1);
  assert.equal(timers.length, 0);
});

const settle = () => new Promise((resolve) => setImmediate(resolve));

void test('after a sign-out or account switch nothing is delivered and nothing waiting is read', async () => {
  let account: string | undefined = 'alice';
  let limited = true;
  const reads: string[][] = [];
  const delivered: string[] = [];
  const timers: (() => void)[] = [];
  let release: () => void = () => {};
  const read = createCommentEventReader<string>({
    read: async (urls) => {
      reads.push(urls);
      if (!limited) await new Promise<void>((resolve) => (release = resolve));
      return urls.map((url) => (limited ? { status: 'rejected' as const, reason: limit } : { status: 'fulfilled' as const, value: url }));
    },
    deliver: (c) => delivered.push(c.url),
    retryAt: (...args: unknown[]) => (args.length && args[0] === limit ? 60_000 : undefined),
    account: () => account,
    schedule: (run) => timers.push(run),
    now: () => 0,
  });
  // Alice's candidate waits for a rate limit; Bob signs in before the retry.
  await read([candidate(1)]);
  account = 'bob';
  timers[0]();
  await settle();
  assert.equal(reads.length, 1, 'Alice’s waiting candidate is not read for Bob');
  // A read that finishes after the switch delivers nothing.
  limited = false;
  const running = read([candidate(2)]);
  await settle();
  account = undefined;
  release();
  await running;
  assert.deepEqual(delivered, []);
});

void test('a delivery that throws does not stop the others or the retry', async () => {
  const delivered: string[] = [];
  const timers: (() => void)[] = [];
  const warned: string[] = [];
  const read = createCommentEventReader<string>({
    read: (urls) =>
      Promise.resolve(urls.map((url) => (url.endsWith('/3') ? { status: 'rejected' as const, reason: limit } : { status: 'fulfilled' as const, value: url }))),
    deliver: (c) => {
      if (c.url.endsWith('/1')) throw new Error('Window closed');
      delivered.push(c.url);
    },
    retryAt: (...args: unknown[]) => (args.length && args[0] === limit ? 60_000 : undefined),
    account: () => 'alice',
    schedule: (run) => timers.push(run),
    warn: (message) => warned.push(message),
    now: () => 0,
  });
  await read([candidate(1), candidate(2), candidate(3)]);
  assert.deepEqual(delivered, [candidate(2).url]);
  assert.equal(timers.length, 1, '#3 still waits for its retry');
  assert.equal(warned.length, 1);
});

void test('a retry reads at most one poll’s worth of candidates; the rest wait their turn', async () => {
  const reads: string[][] = [];
  const timers: (() => void)[] = [];
  let limited = true;
  const read = createCommentEventReader<string>({
    read: (urls) => {
      reads.push(urls);
      return Promise.resolve(urls.map((url) => (limited ? { status: 'rejected' as const, reason: limit } : { status: 'fulfilled' as const, value: url })));
    },
    deliver: () => {},
    retryAt: (...args: unknown[]) => (args.length && args[0] === limit ? 60_000 : undefined),
    account: () => 'alice',
    schedule: (run) => timers.push(run),
    now: () => 0,
  });
  await read(Array.from({ length: COMMENT_READS_PER_POLL * 2 + 1 }, (_, i) => candidate(i + 1)));
  limited = false;
  timers.shift()?.();
  await settle();
  assert.equal(reads.at(-1)?.length, COMMENT_READS_PER_POLL);
  timers.shift()?.();
  await settle();
  assert.equal(reads.at(-1)?.length, COMMENT_READS_PER_POLL);
  timers.shift()?.();
  await settle();
  assert.equal(reads.at(-1)?.length, 1);
  assert.equal(timers.length, 0, 'nothing left waiting');
});
